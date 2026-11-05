/**
 * The acquisition seam (spec 4.1 and 4.2): a per-type acquirer registry that
 * turns a resolved source into origin metadata plus a list of acquired files,
 * and the shared selection step that classifies those files (page, converted
 * document, passthrough), applies the caps, and checks output paths.
 *
 * Phase 2c registers the `git`, `urls`, and `llms-txt` acquirers in
 * ACQUIRERS. Each writes into `context.workDir` (a fresh temp directory the
 * caller removes, also on failure) and reports files with origin-relative
 * POSIX paths. Phase 2d acts on the `convert` selections.
 */

import { readFile, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { posix, relative, resolve, sep } from 'node:path';

import picomatch from 'picomatch';

import {
  ConfigError,
  PACK_LIMITS,
  SOURCE_TYPES,
  type ResolvedPackRecipe,
  type ResolvedSource,
  type ResolvedSourceOfType,
  type SourceType,
} from '../config/project.js';
import { captureGitState } from '../core/git-state.js';
import type { ManifestFetch, ManifestOrigin } from '../pack/manifest.js';
import { isSameOrDescendant } from '../utils/fs-path.js';
import { errorMessage } from '../utils/guards.js';
import { sha256File } from '../utils/hash.js';
import { compareStringsByCodeUnit } from '../utils/sort.js';
import { walkBoundedDirectoryTree } from '../utils/traversal.js';

export interface AcquiredFile {
  /** Origin-relative POSIX path: what include/exclude match and output paths derive from. */
  path: string;
  /** Where the bytes are: inside the temp work dir, or in place (read-only) for local sources. */
  absolutePath: string;
  sha256: string;
  bytes: number;
  /** Upstream URL of this file (git blob URL, fetched URL); absent for local files. */
  url?: string;
  /** What a page's provenance line names as `source:`: the URL, or the project-relative path. */
  sourceLabel: string;
  /** HTTP metadata for fetched files. */
  fetch?: ManifestFetch;
}

export interface SourceAcquisition {
  origin: ManifestOrigin;
  files: AcquiredFile[];
  warnings: string[];
}

export interface AcquireContext {
  /** Absolute, realpath'd project root. */
  projectRoot: string;
  /** Absolute packs directory, never read as source material. */
  packsDir: string;
  /** Empty temp directory for this source's downloads; the caller removes it. */
  workDir: string;
  maxFileBytes: number;
}

export interface SourceAcquirer<S extends ResolvedSource> {
  /**
   * True when acquisition reads the network: refused under `--offline`.
   * Non-network sources are re-acquired on every sync so local edits are seen.
   */
  readonly network: boolean;
  acquire(source: S, context: AcquireContext): Promise<SourceAcquisition>;
}

type AcquirerRegistry = { [K in SourceType]: SourceAcquirer<ResolvedSourceOfType<K>> | null };

/** Phase 2c fills `git`, `urls`, and `llms-txt` (spec 4.1). */
const ACQUIRERS: AcquirerRegistry = {
  local: { network: false, acquire: acquireLocal },
  git: null,
  urls: null,
  'llms-txt': null,
};

function notSupportedError(type: SourceType): ConfigError {
  return new ConfigError(
    `"${type}" sources are not supported yet; only "local" sources can be synced in this build.`
  );
}

function requireAcquirer<S extends ResolvedSource>(
  acquirer: SourceAcquirer<S> | null,
  type: SourceType
): SourceAcquirer<S> {
  if (acquirer === null) {
    throw notSupportedError(type);
  }
  return acquirer;
}

/** Source types with a registered acquirer, for `capabilities`. */
export function supportedSourceTypes(): SourceType[] {
  return SOURCE_TYPES.filter((type) => ACQUIRERS[type] !== null);
}

/** Throws the "not supported yet" error for a source this build cannot acquire. */
export function assertSourceSupported(source: ResolvedSource): void {
  if (ACQUIRERS[source.type] === null) {
    throw notSupportedError(source.type);
  }
}

export function sourceUsesNetwork(source: ResolvedSource): boolean {
  return ACQUIRERS[source.type]?.network ?? true;
}

export async function acquireSource(
  source: ResolvedSource,
  context: AcquireContext
): Promise<SourceAcquisition> {
  switch (source.type) {
    case 'local':
      return requireAcquirer(ACQUIRERS.local, source.type).acquire(source, context);
    case 'git':
      return requireAcquirer(ACQUIRERS.git, source.type).acquire(source, context);
    case 'urls':
      return requireAcquirer(ACQUIRERS.urls, source.type).acquire(source, context);
    case 'llms-txt':
      return requireAcquirer(ACQUIRERS['llms-txt'], source.type).acquire(source, context);
  }
}

// ---------------------------------------------------------------------------
// Matching and classification
// ---------------------------------------------------------------------------

export type FileClass = 'excluded' | 'passthrough' | 'convert' | 'include' | 'ignored';

/** Compile a list of globs into one predicate over origin-relative POSIX paths. */
export function compileGlobs(globs: readonly string[]): (path: string) => boolean {
  if (globs.length === 0) {
    return () => false;
  }
  // windows: false keeps matching POSIX-only on every platform (paths here are always POSIX).
  return picomatch([...globs], { dot: false, windows: false });
}

/**
 * Classify one origin-relative path for a source. Exclude wins over
 * everything; then passthrough, then a converter's include, then include.
 */
export function createSourceMatcher(source: ResolvedSource): (path: string) => FileClass {
  const excluded = compileGlobs(source.exclude);
  const passthrough = compileGlobs(source.passthrough);
  const converted = compileGlobs(source.convert?.include ?? []);
  const included = compileGlobs(source.include);

  return (path) => {
    if (excluded(path)) {
      return 'excluded';
    }
    if (passthrough(path)) {
      return 'passthrough';
    }
    if (source.convert !== null && converted(path)) {
      return 'convert';
    }
    return included(path) ? 'include' : 'ignored';
  };
}

export type PageFormat = 'markdown' | 'mdx' | 'rst' | 'html' | 'openapi';

const FORMAT_BY_EXTENSION: Readonly<Record<string, PageFormat>> = {
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'mdx',
  rst: 'rst',
  html: 'html',
  htm: 'html',
};

const OPENAPI_CANDIDATE_EXTENSIONS = new Set(['json', 'yaml', 'yml']);

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** An OpenAPI or Swagger document, detected by its top-level `openapi:` / `swagger:` key. */
async function isOpenApiDocument(file: AcquiredFile): Promise<boolean> {
  const head = (await readFile(file.absolutePath, 'utf-8')).slice(0, 64 * 1024);
  return /^\s*\{?\s*["']?(?:openapi|swagger)["']?\s*:/m.test(head);
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

interface SelectedBase {
  sourceIndex: number;
  file: AcquiredFile;
  /** Pack-relative POSIX output path. */
  outputPath: string;
}

export interface SelectedPage extends SelectedBase {
  kind: 'page';
  format: PageFormat;
}

export interface SelectedPassthrough extends SelectedBase {
  kind: 'passthrough';
}

/** A document a converter turns into a page (Phase 2d, spec 4.6). */
export interface SelectedConversion extends SelectedBase {
  kind: 'convert';
}

export type SelectedFile = SelectedPage | SelectedPassthrough | SelectedConversion;

export interface PackSelection {
  /** Every selected file, sorted by output path. */
  files: SelectedFile[];
  warnings: string[];
}

function replaceExtension(path: string, extension: string): string {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  return dot > slash + 1 ? `${path.slice(0, dot)}${extension}` : `${path}${extension}`;
}

function mounted(root: 'pages' | 'files', mount: string, path: string): string {
  return posix.join(root, mount, path);
}

/**
 * Classify every acquired file, derive output paths, and enforce the caps
 * and output-path rules (spec 4.2). Files that match include but have no
 * handler are skipped with one warning per extension.
 */
export async function selectPackFiles(
  recipe: ResolvedPackRecipe,
  acquisitions: readonly SourceAcquisition[]
): Promise<PackSelection> {
  const files: SelectedFile[] = [];
  const unhandled = new Map<string, number>();

  for (const [sourceIndex, acquisition] of acquisitions.entries()) {
    const source = recipe.sources[sourceIndex];

    if (source === undefined) {
      throw new Error(`Acquisition ${sourceIndex} has no source in the recipe.`);
    }

    const classify = createSourceMatcher(source);

    for (const file of acquisition.files) {
      assertSafeRelativePath(file.path, `source ${sourceIndex}`);
      const fileClass = classify(file.path);

      if (fileClass === 'excluded' || fileClass === 'ignored') {
        continue;
      }

      if (fileClass === 'passthrough') {
        files.push({
          kind: 'passthrough',
          sourceIndex,
          file,
          outputPath: mounted('files', source.mount, file.path),
        });
        continue;
      }

      if (fileClass === 'convert') {
        files.push({
          kind: 'convert',
          sourceIndex,
          file,
          outputPath: mounted('pages', source.mount, replaceExtension(file.path, '.md')),
        });
        continue;
      }

      const extension = extensionOf(file.path);
      let format = FORMAT_BY_EXTENSION[extension];

      if (
        format === undefined &&
        OPENAPI_CANDIDATE_EXTENSIONS.has(extension) &&
        (await isOpenApiDocument(file))
      ) {
        format = 'openapi';
      }

      if (format === undefined) {
        const key = extension === '' ? '(no extension)' : `.${extension}`;
        unhandled.set(key, (unhandled.get(key) ?? 0) + 1);
        continue;
      }

      // OpenAPI expands to one page per tag under this directory (Phase 2b).
      const outputPath =
        format === 'openapi'
          ? mounted('pages', source.mount, posix.join(replaceExtension(file.path, ''), 'index.md'))
          : mounted('pages', source.mount, replaceExtension(file.path, '.md'));
      files.push({ kind: 'page', format, sourceIndex, file, outputPath });
    }
  }

  files.sort((a, b) => compareStringsByCodeUnit(a.outputPath, b.outputPath));
  assertWithinCaps(files);
  assertPortableOutputPaths(files);

  const warnings: string[] = [];

  if (unhandled.size > 0) {
    const total = [...unhandled.values()].reduce((sum, count) => sum + count, 0);
    const detail = [...unhandled.entries()]
      .sort(([a], [b]) => compareStringsByCodeUnit(a, b))
      .map(([extension, count]) => `${extension}: ${count}`)
      .join(', ');
    warnings.push(
      `Skipped ${total} included file${total === 1 ? '' : 's'} with no page handler (${detail}); list them under "passthrough" to carry them byte-identical.`
    );
  }

  return { files, warnings };
}

function assertSafeRelativePath(path: string, label: string): void {
  const segments = path.split('/');

  if (path === '' || path.startsWith('/') || segments.some((s) => s === '' || s === '..')) {
    throw new Error(`${label} produced an unsafe file path "${path}".`);
  }
}

function assertWithinCaps(files: readonly SelectedFile[]): void {
  if (files.length > PACK_LIMITS.maxFiles) {
    throw new ConfigError(
      `The pack would hold ${files.length} files, more than the ${PACK_LIMITS.maxFiles} file cap; narrow "include" or add "exclude" globs.`
    );
  }

  const totalBytes = files.reduce((sum, selected) => sum + selected.file.bytes, 0);

  if (totalBytes > PACK_LIMITS.maxTotalBytes) {
    throw new ConfigError(
      `The pack's files total ${totalBytes} bytes, more than the ${PACK_LIMITS.maxTotalBytes} byte cap; narrow "include" or add "exclude" globs.`
    );
  }
}

const WINDOWS_RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
const WINDOWS_INVALID_CHARACTER = /[<>:"|?*\\\p{Cc}]/u;

/** Why a path segment cannot exist on Windows, or undefined when it can. */
export function windowsSegmentProblem(segment: string): string | undefined {
  const base = segment.split('.')[0] ?? segment;

  if (WINDOWS_RESERVED_NAME.test(base)) {
    return `"${segment}" is a reserved name on Windows`;
  }
  if (WINDOWS_INVALID_CHARACTER.test(segment)) {
    return `"${segment}" contains a character Windows does not allow in file names`;
  }
  if (/[. ]$/.test(segment)) {
    return `"${segment}" ends with a dot or space, which Windows strips`;
  }
  return undefined;
}

function describeSelected(selected: SelectedFile): string {
  return `${selected.sourceIndex}:${selected.file.path}`;
}

/**
 * Output paths must be distinct on case-insensitive file systems (macOS,
 * Windows) and valid on Windows, so a pack checks out identically everywhere.
 */
function assertPortableOutputPaths(files: readonly SelectedFile[]): void {
  const byFoldedPath = new Map<string, SelectedFile>();

  for (const selected of files) {
    for (const segment of selected.outputPath.split('/')) {
      const problem = windowsSegmentProblem(segment);

      if (problem !== undefined) {
        throw new ConfigError(
          `Output path ${selected.outputPath} (from ${describeSelected(selected)}): ${problem}; exclude the file or rename it upstream.`
        );
      }
    }

    const folded = selected.outputPath.normalize('NFC').toLowerCase();
    const previous = byFoldedPath.get(folded);

    if (previous !== undefined) {
      throw new ConfigError(
        `${describeSelected(previous)} and ${describeSelected(selected)} would both be written to ${previous.outputPath} (paths that differ only by case or extension collide); exclude one of them or give a source a different "mount".`
      );
    }

    byFoldedPath.set(folded, selected);
  }
}

// ---------------------------------------------------------------------------
// Local sources
// ---------------------------------------------------------------------------

const LOCAL_WALK_MAX_DEPTH = 64;
const LOCAL_WALK_MAX_ENTRIES = 200_000;

export const ALLOW_TEMP_SOURCES_ENV = 'LLM_DOCS_ALLOW_TEMP_SOURCES';

/** Realpaths of the OS temp directories a local source must not live in. */
async function temporaryRoots(): Promise<string[]> {
  const candidates = [tmpdir()];

  if (process.platform !== 'win32') {
    candidates.push('/tmp', '/var/tmp');
  }

  const roots: string[] = [];

  for (const candidate of candidates) {
    try {
      roots.push(await realpath(candidate));
    } catch {
      // A missing temp directory cannot contain the source.
    }
  }

  return roots;
}

/**
 * A local source must resolve (through symlinks) inside the project and
 * outside the OS temp directory: a pack pinned to a scratch directory loses
 * its origin when the OS cleans it (spec 2.3). Returns the source realpath.
 */
async function resolveLocalSourcePath(
  source: ResolvedSourceOfType<'local'>,
  projectRoot: string
): Promise<string> {
  const lexical = resolve(projectRoot, ...source.path.split('/'));
  let real: string;

  try {
    real = await realpath(lexical);
  } catch {
    throw new ConfigError(
      `Local source "${source.path}" does not exist in the project; create it or fix "path".`
    );
  }

  if (!isSameOrDescendant(projectRoot, real)) {
    throw new ConfigError(
      `Local source "${source.path}" resolves outside the project (${real}); local sources must stay inside the project.`
    );
  }

  if (process.env[ALLOW_TEMP_SOURCES_ENV] !== '1') {
    for (const root of await temporaryRoots()) {
      if (isSameOrDescendant(root, real)) {
        throw new ConfigError(
          `Local source "${source.path}" is in the OS temp directory (${root}), which the OS may delete at any time; move the project or the docs to a durable directory (or set ${ALLOW_TEMP_SOURCES_ENV}=1 for a throwaway experiment).`
        );
      }
    }
  }

  return real;
}

async function acquireLocal(
  source: ResolvedSourceOfType<'local'>,
  context: AcquireContext
): Promise<SourceAcquisition> {
  const root = await resolveLocalSourcePath(source, context.projectRoot);
  const rootStats = await stat(root);
  const classify = createSourceMatcher(source);
  const files: AcquiredFile[] = [];
  const warnings: string[] = [];
  const sourceLabel = (path: string): string =>
    rootStats.isDirectory() ? posix.join(source.path, path) : source.path;

  const addFile = async (path: string, absolutePath: string, bytes: number): Promise<void> => {
    if (bytes > context.maxFileBytes) {
      throw new ConfigError(
        `${sourceLabel(path)} is ${bytes} bytes, over the ${context.maxFileBytes} byte per-file limit; exclude it or raise "limits.maxFileBytes".`
      );
    }
    files.push({
      path,
      absolutePath,
      sha256: await sha256File(absolutePath),
      bytes,
      sourceLabel: sourceLabel(path),
    });
  };

  if (rootStats.isFile()) {
    const name = root.slice(root.lastIndexOf(sep) + 1);
    const fileClass = classify(name);

    if (fileClass !== 'excluded' && fileClass !== 'ignored') {
      await addFile(name, root, rootStats.size);
    }
  } else if (rootStats.isDirectory()) {
    const packsDirReal = await realpath(context.packsDir).catch(() => resolve(context.packsDir));
    const skippedDirectoryPaths = new Set<string>();

    if (isSameOrDescendant(packsDirReal, root)) {
      throw new ConfigError(
        `Local source "${source.path}" is inside the packs directory, which holds generated packs; point "path" at the original docs.`
      );
    }

    if (isSameOrDescendant(root, packsDirReal)) {
      skippedDirectoryPaths.add(relative(root, packsDirReal).split(sep).join('/'));
    }

    const ignoredSymlinks: string[] = [];

    for await (const event of walkBoundedDirectoryTree({
      root,
      maxDepth: LOCAL_WALK_MAX_DEPTH,
      maxEntries: LOCAL_WALK_MAX_ENTRIES,
      maxFiles: LOCAL_WALK_MAX_ENTRIES,
      skipDirectoryNames: true,
      skippedDirectoryPaths,
    })) {
      switch (event.kind) {
        case 'file': {
          const path = event.relativePath.split(sep).join('/');
          const fileClass = classify(path);

          if (fileClass !== 'excluded' && fileClass !== 'ignored') {
            await addFile(path, event.absolutePath, (await stat(event.absolutePath)).size);
          }
          break;
        }
        case 'symlink': {
          const path = event.relativePath.split(sep).join('/');
          const fileClass = classify(path);

          if (fileClass === 'excluded') {
            break;
          }
          if (fileClass !== 'ignored') {
            throw new ConfigError(
              `${sourceLabel(path)} is a symbolic link; symlinks are never followed, so exclude it or replace it with the file.`
            );
          }
          ignoredSymlinks.push(path);
          break;
        }
        case 'entries-exhausted':
          throw new ConfigError(
            `Local source "${source.path}" has more than ${LOCAL_WALK_MAX_ENTRIES} entries; point "path" at the docs directory.`
          );
        case 'unreadable-directory':
          throw new Error(
            `Cannot read ${sourceLabel(event.relativePath.split(sep).join('/'))}: ${errorMessage(event.error)}`
          );
        case 'depth-pruned':
          warnings.push(
            `Skipped ${sourceLabel(event.relativePath.split(sep).join('/'))}: deeper than ${LOCAL_WALK_MAX_DEPTH} levels.`
          );
          break;
        case 'skipped-directory':
        case 'files-exhausted':
          break;
      }
    }

    if (ignoredSymlinks.length > 0) {
      warnings.push(
        `Ignored ${ignoredSymlinks.length} symbolic link${ignoredSymlinks.length === 1 ? '' : 's'} in "${source.path}" (symlinks are never followed): ${ignoredSymlinks.slice(0, 5).join(', ')}${ignoredSymlinks.length > 5 ? ', ...' : ''}.`
      );
    }
  } else {
    throw new ConfigError(`Local source "${source.path}" is neither a file nor a directory.`);
  }

  const gitState = await captureGitState(root);

  return {
    origin: {
      type: 'local',
      path: source.path,
      hostCommit: gitState?.commit ?? null,
      hostDirty: gitState?.dirty ?? null,
    },
    files,
    warnings,
  };
}
