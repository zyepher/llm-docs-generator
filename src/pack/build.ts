/**
 * `sync` (spec 2.5, 2.6, 5): bring every pack in line with its recipe.
 *
 * Per pack: resolve the recipe; skip when the manifest's recipeHash matches,
 * the pack files verify, the index still lists the current guides, and local
 * sources are unchanged; otherwise acquire, select, convert, and write a
 * staging pack, verify it in place, and swap it in atomically, carrying the
 * agent-owned `guides/` across. The whole run holds an advisory lock in the
 * packs directory, and `afterSync` (Phase 4: managed agent-file blocks) runs
 * last.
 */

import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix, sep } from 'node:path';

import {
  ConfigError,
  loadProjectConfig,
  resolvePackRecipe,
  type DependencyVersionResolver,
  type LoadedProjectConfig,
  type ResolvedPack,
  type ResolvedPackRecipe,
  type TransformName,
} from '../config/project.js';
import {
  acquireSource,
  assertSourceSupported,
  selectPackFiles,
  sourceUsesNetwork,
  type PackSelection,
  type SelectedConversion,
  type SelectedFile,
  type SourceAcquisition,
} from '../sources/acquire.js';
import {
  createDocumentConverter,
  type DocumentConverter,
  type ManifestConverter,
} from '../sources/convert.js';
import { isSameOrDescendant, resolveEffectiveOutputPath } from '../utils/fs-path.js';
import { errorMessage, isFileNotFoundError, isRecord } from '../utils/guards.js';
import { sha256Prefixed } from '../utils/hash.js';
import { readJsonFile } from '../utils/json.js';
import { writeTextFileSafely } from '../utils/safe-write.js';
import { compareStringsByCodeUnit } from '../utils/sort.js';
import { estimateTokenCount } from '../utils/text-metrics.js';
import { walkBoundedDirectoryTree } from '../utils/traversal.js';
import { renderIndexPage, type IndexGuide } from './index-page.js';
import {
  licenseStatusFor,
  MANIFEST_FILE_NAME,
  ManifestError,
  readPackManifest,
  TOOL_NAME,
  TOOL_VERSION,
  writePackManifest,
  type ManifestOutputEntry,
  type ManifestSourceEntry,
  type PackManifest,
} from './manifest.js';
import { collectHeadings, convertMarkdownPage, createPackLinkRewriter } from './markdown.js';
import { verifyPackFiles } from './verify.js';

const STAGING_DIR = '.staging';
const LOCK_FILE = '.llm-docs.lock';
const PACKS_GITIGNORE = `${STAGING_DIR}/\n${LOCK_FILE}\n`;
const LOCK_STALE_MS = 60 * 60 * 1000;
const INDEX_FILE = 'index.md';

export type PackSyncStatus = 'unchanged' | 'built' | 'would-build' | 'failed';

export interface PackSyncResult {
  id: string;
  status: PackSyncStatus;
  /** Why the pack was (or would be) rebuilt. */
  reason?: string;
  /** The failure, one line. */
  error?: string;
  /** 2 for a config or recipe problem, 3 for a runtime failure. */
  exitCode?: 2 | 3;
  warnings: string[];
}

export type OrphanStatus = 'orphan' | 'pruned' | 'would-prune' | 'kept';

export interface OrphanResult {
  id: string;
  status: OrphanStatus;
  reason?: string;
}

export interface AfterSyncResult {
  changed: boolean;
  messages: string[];
}

export interface AfterSyncContext {
  loaded: LoadedProjectConfig;
  packs: readonly PackSyncResult[];
  /** Report what would change, write nothing. */
  check: boolean;
}

/** Runs last in every sync, under the lock. Phase 4 writes the managed agent-file blocks here. */
export type AfterSyncStep = (context: AfterSyncContext) => Promise<AfterSyncResult>;

export interface SyncOptions {
  /** Write nothing; report what would change. */
  check?: boolean;
  /** Refuse to acquire network sources. */
  offline?: boolean;
  /** Delete pack directories that are not in the config. */
  prune?: boolean;
  resolveDependencyVersion?: DependencyVersionResolver | undefined;
  afterSync?: AfterSyncStep | undefined;
  /** Clock for `acquiredAt` (tests pin it). */
  now?: () => Date;
  /** Recorded in the lock file. */
  command?: string;
}

export interface SyncReport {
  check: boolean;
  /** Something changed (or, under `check`, would change). */
  changed: boolean;
  packs: PackSyncResult[];
  orphans: OrphanResult[];
  afterSync: AfterSyncResult | null;
}

/** Another sync holds the packs directory lock: a runtime failure (exit 3). */
export class SyncLockedError extends Error {
  override name = 'SyncLockedError';
}

// ---------------------------------------------------------------------------
// File-system helpers
// ---------------------------------------------------------------------------

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * rename with bounded retries: Windows reports EPERM or EBUSY while an
 * indexer or antivirus briefly holds a file in the directory.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : '';
      if (!RETRYABLE_RENAME_CODES.has(code) || attempt >= 7) {
        throw error;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25 * 2 ** attempt));
    }
  }
}

function randomSuffix(): string {
  return randomBytes(6).toString('hex');
}

/** Create `packsDir` and its `.gitignore` for the staging and lock files (spec 2.6). */
export async function ensurePacksDir(packsDir: string): Promise<void> {
  await mkdir(packsDir, { recursive: true });
  const gitignore = join(packsDir, '.gitignore');
  let current = '';

  try {
    current = await readFile(gitignore, 'utf-8');
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      throw error;
    }
  }

  const lines = current.split(/\r?\n/).map((line) => line.trim());
  const missing = PACKS_GITIGNORE.trimEnd()
    .split('\n')
    .filter((line) => !lines.includes(line));

  if (missing.length > 0) {
    const prefix = current === '' || current.endsWith('\n') ? current : `${current}\n`;
    await writeTextFileSafely(gitignore, `${prefix}${missing.join('\n')}\n`);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

async function lockIsStale(path: string): Promise<{ stale: boolean; holder: string }> {
  let raw: unknown;

  try {
    raw = await readJsonFile(path);
  } catch {
    // Unreadable or half-written: stale once it is old enough not to be mid-write.
    const age = Date.now() - (await stat(path)).mtimeMs;
    return { stale: age > 5_000, holder: 'an unknown process' };
  }

  const pid = isRecord(raw) && typeof raw.pid === 'number' ? raw.pid : undefined;
  const startedAt = isRecord(raw) && typeof raw.startedAt === 'string' ? raw.startedAt : '';
  const command = isRecord(raw) && typeof raw.command === 'string' ? raw.command : 'llm-docs';
  const started = Date.parse(startedAt);
  const stale =
    pid === undefined ||
    !isProcessAlive(pid) ||
    Number.isNaN(started) ||
    Date.now() - started > LOCK_STALE_MS;

  return { stale, holder: `'${command}' (pid ${pid ?? '?'}, started ${startedAt || 'unknown'})` };
}

/** Take the advisory lock with exclusive create; a stale lock is replaced once. */
async function acquireLock(packsDir: string, command: string): Promise<() => Promise<void>> {
  const path = join(packsDir, LOCK_FILE);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, 'wx');
      try {
        await handle.writeFile(
          `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), command })}\n`
        );
      } finally {
        await handle.close();
      }
      return () => rm(path, { force: true });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
        throw error;
      }

      const { stale, holder } = await lockIsStale(path);

      if (!stale || attempt > 0) {
        throw new SyncLockedError(
          `Another llm-docs run holds ${join(packsDir, LOCK_FILE)}: ${holder}. Wait for it to finish, or delete the lock file if that process is gone.`
        );
      }

      await rm(path, { force: true });
    }
  }

  throw new SyncLockedError(`Could not take the lock in ${packsDir}.`);
}

async function manifestPackId(dir: string): Promise<string | undefined> {
  try {
    return (await readPackManifest(dir)).pack.id;
  } catch {
    return undefined;
  }
}

/**
 * Remove leftover staging directories from interrupted syncs. A crash during
 * a swap can leave the old pack renamed aside or the guides moved into a
 * staging pack; both are put back before the leftovers are deleted, so an
 * interruption never loses a pack or its guides.
 */
async function recoverStaging(packsDir: string): Promise<string[]> {
  const stagingRoot = join(packsDir, STAGING_DIR);
  let entries: string[];

  try {
    entries = await readdir(stagingRoot);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return [];
    }
    throw error;
  }

  const warnings: string[] = [];
  const parsed = entries.map((name) => {
    const old = /^(.+)-old-[0-9a-f]{12}$/.exec(name);
    const staged = /^(.+)-[0-9a-f]{12}$/.exec(name);
    return { name, kind: old !== null ? 'old' : 'staging', id: old?.[1] ?? staged?.[1] };
  });
  parsed.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'old' ? -1 : 1));

  for (const entry of parsed) {
    const dir = join(stagingRoot, entry.name);

    if (entry.id !== undefined && (await manifestPackId(dir)) === entry.id) {
      const target = join(packsDir, entry.id);

      if (entry.kind === 'old' && !(await exists(target))) {
        await renameWithRetry(dir, target);
        warnings.push(`Restored pack "${entry.id}" left aside by an interrupted sync.`);
        continue;
      }

      if (
        entry.kind === 'staging' &&
        (await exists(join(dir, 'guides'))) &&
        (await exists(target)) &&
        !(await exists(join(target, 'guides')))
      ) {
        await renameWithRetry(join(dir, 'guides'), join(target, 'guides'));
        warnings.push(`Restored the guides of pack "${entry.id}" from an interrupted sync.`);
      }
    }

    await rm(dir, { recursive: true, force: true });
  }

  await rm(stagingRoot, { recursive: true, force: true });
  return warnings;
}

/** Swap a verified staging pack into place (spec 2.6). */
async function swapIntoPlace(packsDir: string, id: string, stagingDir: string): Promise<void> {
  const target = join(packsDir, id);

  if (!(await exists(target))) {
    await renameWithRetry(stagingDir, target);
    return;
  }

  if (await exists(join(target, 'guides'))) {
    await renameWithRetry(join(target, 'guides'), join(stagingDir, 'guides'));
  }

  const oldDir = join(packsDir, STAGING_DIR, `${id}-old-${randomSuffix()}`);
  await renameWithRetry(target, oldDir);
  await renameWithRetry(stagingDir, target);
  await rm(oldDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Guides and the index
// ---------------------------------------------------------------------------

function fileStem(path: string): string {
  const name = posix.basename(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Markdown guides under `<packDir>/guides`, with their first-H1 titles. */
async function listGuides(packDir: string): Promise<IndexGuide[]> {
  const root = join(packDir, 'guides');

  if (!(await exists(root))) {
    return [];
  }

  const guides: IndexGuide[] = [];

  for await (const event of walkBoundedDirectoryTree({
    root,
    maxDepth: 16,
    maxEntries: 10_000,
    maxFiles: 10_000,
    skipDirectoryNames: false,
  })) {
    if (event.kind !== 'file' || !/\.md$/i.test(event.entry.name)) {
      continue;
    }

    const path = `guides/${event.relativePath.split(sep).join('/')}`;
    const text = await readFile(event.absolutePath, 'utf-8');
    const h1 = collectHeadings(text).find((heading) => heading.level === 1);
    guides.push({ path, title: h1?.text || fileStem(path) });
  }

  return guides.sort((a, b) => compareStringsByCodeUnit(a.path, b.path));
}

function renderIndexFor(
  manifest: Omit<PackManifest, 'outputs'>,
  outputs: readonly ManifestOutputEntry[],
  guides: readonly IndexGuide[]
): string {
  return renderIndexPage({
    pack: manifest.pack,
    recipe: manifest.recipe,
    origins: manifest.origins,
    acquiredAt: manifest.acquiredAt,
    license: manifest.license,
    sources: manifest.sources,
    pages: outputs.filter((output) => output.kind === 'page'),
    guides,
  });
}

// ---------------------------------------------------------------------------
// Building one pack
// ---------------------------------------------------------------------------

interface SyncContext {
  loaded: LoadedProjectConfig;
  /** Realpath'd project root. */
  projectRoot: string;
  options: SyncOptions;
}

type ExistingPack =
  | { kind: 'absent' }
  | { kind: 'pack'; manifest: PackManifest }
  | { kind: 'corrupt'; message: string };

async function inspectExistingPack(packsDir: string, id: string): Promise<ExistingPack> {
  const dir = join(packsDir, id);

  if (!(await exists(dir))) {
    return { kind: 'absent' };
  }

  try {
    const manifest = await readPackManifest(dir);
    if (manifest.pack.id !== id) {
      throw new ConfigError(
        `${dir} holds pack "${manifest.pack.id}", not "${id}"; move it away before syncing "${id}".`
      );
    }
    return { kind: 'pack', manifest };
  } catch (error) {
    if (!(error instanceof ManifestError)) {
      throw error;
    }
    if (error.reason === 'other-version') {
      throw new ConfigError(`${dir}: ${error.message}`);
    }
    if (error.reason === 'missing') {
      throw new ConfigError(
        `${dir} exists but is not an llm-docs pack (no ${MANIFEST_FILE_NAME}); move it away before syncing "${id}".`
      );
    }
    return { kind: 'corrupt', message: error.message };
  }
}

/** Fail early for anything this build cannot produce yet. */
function assertBuildable(recipe: ResolvedPackRecipe): void {
  for (const source of recipe.sources) {
    assertSourceSupported(source);
  }

  if (recipe.layout.combined) {
    throw new ConfigError(
      'The combined layout is not supported yet; set "layout.combined" to false.'
    );
  }
}

/** One entry per acquired file, including the `.md` an agent wrote for a converted original. */
function manifestSourceEntries(selection: PackSelection): ManifestSourceEntry[] {
  return selection.files.flatMap((selected) => {
    const files =
      selected.kind === 'convert' && selected.agentOutput !== undefined
        ? [selected.file, selected.agentOutput]
        : [selected.file];
    return files.map((file) => ({
      source: selected.sourceIndex,
      path: file.path,
      ...(file.url === undefined ? {} : { url: file.url }),
      sha256: file.sha256,
      bytes: file.bytes,
      ...(file.fetch === undefined ? {} : { fetch: file.fetch }),
    }));
  });
}

function sourceKey(entry: Pick<ManifestSourceEntry, 'source' | 'path' | 'sha256'>): string {
  return `${entry.source}\u0000${entry.path}\u0000${entry.sha256}`;
}

function sameSourceSet(
  a: readonly ManifestSourceEntry[],
  b: readonly ManifestSourceEntry[],
  only?: ReadonlySet<number>
): boolean {
  const keys = (entries: readonly ManifestSourceEntry[]): string =>
    entries
      .filter((entry) => only === undefined || only.has(entry.source))
      .map(sourceKey)
      .sort(compareStringsByCodeUnit)
      .join('\n');
  return keys(a) === keys(b);
}

async function acquireAll(
  context: SyncContext,
  recipe: ResolvedPackRecipe,
  workRoot: string,
  filter: (index: number) => boolean
): Promise<(SourceAcquisition | null)[]> {
  const acquisitions: (SourceAcquisition | null)[] = [];

  for (const [index, source] of recipe.sources.entries()) {
    if (!filter(index)) {
      acquisitions.push(null);
      continue;
    }
    const workDir = join(workRoot, `source-${index}`);
    await mkdir(workDir, { recursive: true });
    acquisitions.push(
      await acquireSource(source, {
        projectRoot: context.projectRoot,
        packsDir: context.loaded.packsDir,
        workDir,
        maxFileBytes: recipe.limits.maxFileBytes,
      })
    );
  }

  return acquisitions;
}

/** Placeholder acquisitions for sources not acquired, so selection indexes line up. */
function withPlaceholders(
  acquisitions: readonly (SourceAcquisition | null)[]
): SourceAcquisition[] {
  return acquisitions.map(
    (acquisition) => acquisition ?? { origin: { type: 'urls' }, files: [], warnings: [] }
  );
}

/** Why `existing` is out of date, or undefined when the pack can be skipped. */
async function staleReason(
  context: SyncContext,
  resolved: ResolvedPack,
  existing: ExistingPack,
  local: readonly (SourceAcquisition | null)[]
): Promise<string | undefined> {
  if (existing.kind === 'absent') {
    return 'not built yet';
  }
  if (existing.kind === 'corrupt') {
    return `the manifest is unreadable (${existing.message})`;
  }

  const { manifest } = existing;

  if (manifest.recipeHash !== resolved.recipeHash) {
    return 'the recipe changed';
  }

  const packDir = join(context.loaded.packsDir, resolved.id);
  const integrity = await verifyPackFiles(resolved.id, packDir, manifest, {
    checks: ['outputs', 'unlisted-files'],
  });

  if (integrity.some((entry) => entry.status === 'fail')) {
    return 'the pack files differ from the manifest';
  }

  const index = manifest.outputs.find((output) => output.path === INDEX_FILE);
  const expectedIndex = renderIndexFor(manifest, manifest.outputs, await listGuides(packDir));

  if (index === undefined || index.sha256 !== sha256Prefixed(expectedIndex)) {
    return 'the guides changed';
  }

  const localIndexes = new Set(
    local.flatMap((acquisition, sourceIndex) => (acquisition === null ? [] : [sourceIndex]))
  );

  if (localIndexes.size > 0) {
    const selection = await selectPackFiles(resolved.recipe, withPlaceholders(local));
    if (!sameSourceSet(manifestSourceEntries(selection), manifest.sources, localIndexes)) {
      return 'source files changed';
    }
  }

  return undefined;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

async function readUtf8(selected: SelectedFile): Promise<string> {
  try {
    return utf8.decode(await readFile(selected.file.absolutePath));
  } catch (error) {
    throw new ConfigError(
      `${selected.file.sourceLabel} is not valid UTF-8 text (${errorMessage(error)}); exclude it or carry it with "passthrough".`
    );
  }
}

const UNSUPPORTED_FORMATS: Readonly<Record<string, string>> = {
  rst: 'reStructuredText',
  html: 'HTML',
  openapi: 'OpenAPI',
};

async function writeStagedFile(
  stagingDir: string,
  path: string,
  write: (target: string) => Promise<void>
): Promise<void> {
  const target = join(stagingDir, ...path.split('/'));
  if (!isSameOrDescendant(stagingDir, target)) {
    throw new Error(`Refusing to write ${path} outside the staging pack.`);
  }
  await mkdir(dirname(target), { recursive: true });
  await write(target);
}

function summarizeVerification(failures: readonly { path?: string; message: string }[]): string {
  const shown = failures
    .slice(0, 3)
    .map((finding) => `${finding.path === undefined ? '' : `${finding.path}: `}${finding.message}`);
  const more = failures.length > 3 ? ` (and ${failures.length - 3} more)` : '';
  return `${shown.join('; ')}${more}`;
}

/**
 * Build `resolved` into a staging directory, verify it, and swap it in.
 * Converters write under `workRoot`. Returns warnings.
 */
async function buildPack(
  context: SyncContext,
  resolved: ResolvedPack,
  existing: ExistingPack,
  acquisitions: readonly SourceAcquisition[],
  workRoot: string
): Promise<string[]> {
  const { recipe } = resolved;
  const packsDir = context.loaded.packsDir;
  const packDir = join(packsDir, resolved.id);
  const selection = await selectPackFiles(recipe, acquisitions);
  const baseSources = manifestSourceEntries(selection);
  const previous = existing.kind === 'pack' ? existing.manifest : undefined;
  const acquiredAt =
    previous !== undefined && sameSourceSet(previous.sources, baseSources)
      ? previous.acquiredAt
      : (context.options.now?.() ?? new Date()).toISOString();
  const origins = acquisitions.map((acquisition) => acquisition.origin);
  const pages = selection.files.filter((selected) => selected.kind === 'page');
  const passthrough = selection.files.filter((selected) => selected.kind === 'passthrough');
  const conversions = selection.files.filter(
    (selected): selected is SelectedConversion => selected.kind === 'convert'
  );
  const fileRef = (selected: SelectedFile) => ({
    sourceIndex: selected.sourceIndex,
    sourcePath: selected.file.path,
    outputPath: selected.outputPath,
  });
  const rewriteLinks = createPackLinkRewriter({
    recipe,
    origins,
    pages: [...pages, ...conversions].map(fileRef),
    passthrough: passthrough.map(fileRef),
  });

  for (const page of pages) {
    const name = UNSUPPORTED_FORMATS[page.format];
    if (name !== undefined) {
      throw new ConfigError(
        `${page.file.sourceLabel}: ${name} pages are not supported yet; exclude the file or carry it with "passthrough".`
      );
    }
  }

  await mkdir(join(packsDir, STAGING_DIR), { recursive: true });
  const stagingDir = join(packsDir, STAGING_DIR, `${resolved.id}-${randomSuffix()}`);
  await mkdir(stagingDir);
  let swapped = false;

  try {
    const outputs: ManifestOutputEntry[] = [];
    const warnings = [
      ...acquisitions.flatMap((acquisition) => acquisition.warnings),
      ...selection.warnings,
    ];
    const transformCounts = new Map<TransformName, number>(
      recipe.sources.flatMap((source) => source.transforms.map((name) => [name, 0] as const))
    );
    const unknownComponents = new Map<string, number>();
    const links: PackManifest['links'] = { rewritten: 0, external: 0, unresolved: [] };
    let plainTextConversions = 0;

    // Markdown, MDX, and converted documents all go through the Markdown page path.
    const writePage = async (
      page: SelectedFile,
      text: string,
      syntax: 'markdown' | 'mdx',
      extraSources: readonly string[]
    ): Promise<void> => {
      const source = recipe.sources[page.sourceIndex];
      if (source === undefined) {
        throw new Error(`Page ${page.outputPath} has no source.`);
      }

      const result = convertMarkdownPage({
        text,
        syntax,
        sourceIndex: page.sourceIndex,
        sourcePath: page.file.path,
        outputPath: page.outputPath,
        transforms: source.transforms,
        provenance: { packId: resolved.id, version: recipe.version, source: page.file.sourceLabel },
        rewriteLinks,
      });

      await writeStagedFile(stagingDir, page.outputPath, (target) =>
        writeTextFileSafely(target, result.text)
      );
      outputs.push({
        path: page.outputPath,
        kind: 'page',
        sha256: sha256Prefixed(result.text),
        bytes: Buffer.byteLength(result.text, 'utf-8'),
        tokens: estimateTokenCount(result.text),
        title: result.title,
        sources: [`${page.sourceIndex}:${page.file.path}`, ...extraSources],
      });

      for (const name of result.changedBy) {
        transformCounts.set(name, (transformCounts.get(name) ?? 0) + 1);
      }
      for (const [component, count] of result.unknownComponents) {
        unknownComponents.set(component, (unknownComponents.get(component) ?? 0) + count);
      }
      links.rewritten += result.links.rewritten;
      links.external += result.links.external;
      links.unresolved.push(
        ...result.links.unresolved.map((entry) => ({ page: page.outputPath, ...entry }))
      );
      plainTextConversions += result.links.plainTextConversions;
    };

    for (const page of pages) {
      await writePage(page, await readUtf8(page), page.format === 'mdx' ? 'mdx' : 'markdown', []);
    }

    // One converter per source, resolved (tool on PATH, version) on first use.
    const converters = new Map<number, DocumentConverter>();
    const converterBySource = new Map<string, ManifestConverter>();

    for (const conversion of conversions) {
      const spec = recipe.sources[conversion.sourceIndex]?.convert;
      if (spec === undefined || spec === null) {
        throw new Error(`Conversion ${conversion.outputPath} has no converter.`);
      }

      let converter = converters.get(conversion.sourceIndex);
      if (converter === undefined) {
        converter = await createDocumentConverter(spec, {
          projectRoot: context.projectRoot,
          workDir: join(workRoot, `convert-${conversion.sourceIndex}`),
        });
        converters.set(conversion.sourceIndex, converter);
        warnings.push(...converter.warnings);
      }

      const converted = await converter.convert(
        conversion,
        previous?.sources.find(
          (entry) => entry.source === conversion.sourceIndex && entry.path === conversion.file.path
        )
      );
      warnings.push(...converted.warnings);
      converterBySource.set(
        `${conversion.sourceIndex}:${conversion.file.path}`,
        converted.converter
      );
      await writePage(
        conversion,
        converted.markdown,
        'markdown',
        converted.agentOutputPath === undefined
          ? []
          : [`${conversion.sourceIndex}:${converted.agentOutputPath}`]
      );
    }

    const sources = baseSources.map((entry) => {
      const converter = converterBySource.get(`${entry.source}:${entry.path}`);
      return converter === undefined ? entry : { ...entry, converter };
    });

    for (const file of passthrough) {
      await writeStagedFile(stagingDir, file.outputPath, (target) =>
        copyFile(file.file.absolutePath, target, constants.COPYFILE_EXCL)
      );
      outputs.push({
        path: file.outputPath,
        kind: 'passthrough',
        sha256: file.file.sha256,
        bytes: file.file.bytes,
        sources: [`${file.sourceIndex}:${file.file.path}`],
      });
    }

    if (unknownComponents.size > 0) {
      const detail = [...unknownComponents.entries()]
        .sort(([a], [b]) => compareStringsByCodeUnit(a, b))
        .map(([name, count]) => `${name} (${count})`)
        .join(', ');
      warnings.push(`Pages keep MDX components the tool does not unwrap: ${detail}.`);
    }
    if (plainTextConversions > 0) {
      warnings.push(
        `${plainTextConversions} unresolvable relative link${plainTextConversions === 1 ? ' was' : 's were'} converted to plain text.`
      );
    }

    const declared = recipe.license;
    const manifestWithoutOutputs: Omit<PackManifest, 'outputs'> = {
      schemaVersion: 3,
      tool: { name: TOOL_NAME, version: TOOL_VERSION },
      pack: { id: resolved.id, title: recipe.title, version: recipe.version },
      dependency: recipe.dependency,
      recipe,
      recipeHash: resolved.recipeHash,
      acquiredAt,
      origins,
      // Phase 2c: license detection for git sources fills `detected` (spec 4.10).
      license: { declared, detected: null, status: licenseStatusFor(declared) },
      sources,
      links,
      transforms: [...transformCounts.entries()].map(([name, count]) => ({ name, pages: count })),
      warnings,
    };

    const indexText = renderIndexFor(manifestWithoutOutputs, outputs, await listGuides(packDir));
    await writeStagedFile(stagingDir, INDEX_FILE, (target) =>
      writeTextFileSafely(target, indexText)
    );
    outputs.push({
      path: INDEX_FILE,
      kind: 'index',
      sha256: sha256Prefixed(indexText),
      bytes: Buffer.byteLength(indexText, 'utf-8'),
      tokens: estimateTokenCount(indexText),
      title: `${recipe.title} ${recipe.version}`,
    });

    const manifest: PackManifest = { ...manifestWithoutOutputs, outputs };
    await writePackManifest(stagingDir, manifest);

    const verification = await verifyPackFiles(resolved.id, stagingDir, manifest, {
      guidesRoot: packDir,
    });
    const failures = verification.flatMap((entry) =>
      entry.findings.filter((finding) => finding.status === 'fail')
    );

    if (failures.length > 0) {
      throw new ConfigError(
        `The built pack does not verify: ${summarizeVerification(failures)}. Exclude the page, or carry missing link targets with "passthrough".`
      );
    }

    await swapIntoPlace(packsDir, resolved.id, stagingDir);
    swapped = true;

    const statusWarning =
      manifest.license.status === 'unknown'
        ? 'License unknown: set "license" in the recipe once you know the terms.'
        : manifest.license.status === 'proprietary'
          ? 'License is proprietary: check the terms before sharing this pack.'
          : undefined;

    return [
      ...[...new Set(warnings)].sort(compareStringsByCodeUnit),
      ...(statusWarning === undefined ? [] : [statusWarning]),
    ];
  } finally {
    if (!swapped) {
      await rm(stagingDir, { recursive: true, force: true });
    }
  }
}

async function syncOnePack(context: SyncContext, id: string): Promise<PackSyncResult> {
  const resolved = await resolvePackRecipe(context.loaded.config, id, {
    resolveDependencyVersion: context.options.resolveDependencyVersion,
  });
  assertBuildable(resolved.recipe);
  const existing = await inspectExistingPack(context.loaded.packsDir, id);
  const workRoot = await mkdtemp(join(tmpdir(), 'llm-docs-'));

  try {
    const local = await acquireAll(context, resolved.recipe, workRoot, (index) => {
      const source = resolved.recipe.sources[index];
      return source !== undefined && !sourceUsesNetwork(source);
    });
    const reason = await staleReason(context, resolved, existing, local);

    if (reason === undefined) {
      return { id, status: 'unchanged', warnings: [] };
    }
    if (context.options.check === true) {
      return { id, status: 'would-build', reason, warnings: [] };
    }

    const needsNetwork = local.some((acquisition) => acquisition === null);
    if (needsNetwork && context.options.offline === true) {
      throw new ConfigError(
        `Pack "${id}" needs to acquire network sources (${reason}), and --offline is set.`
      );
    }

    const rest = await acquireAll(
      context,
      resolved.recipe,
      workRoot,
      (index) => local[index] === null
    );
    const acquisitions = local.map((acquisition, index) => {
      const acquired = acquisition ?? rest[index];
      if (acquired === null || acquired === undefined) {
        throw new Error(`Source ${index} of pack "${id}" was not acquired.`);
      }
      return acquired;
    });
    const warnings = await buildPack(context, resolved, existing, acquisitions, workRoot);
    return { id, status: 'built', reason, warnings };
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}

async function handleOrphans(
  loaded: LoadedProjectConfig,
  options: SyncOptions
): Promise<OrphanResult[]> {
  let entries: string[];

  try {
    entries = (await readdir(loaded.packsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort(compareStringsByCodeUnit);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return [];
    }
    throw error;
  }

  const results: OrphanResult[] = [];

  for (const id of entries) {
    if (Object.hasOwn(loaded.config.packs, id)) {
      continue;
    }

    const dir = join(loaded.packsDir, id);

    if (options.prune !== true) {
      results.push({ id, status: 'orphan' });
      continue;
    }

    if (!(await exists(join(dir, MANIFEST_FILE_NAME)))) {
      results.push({ id, status: 'kept', reason: 'not an llm-docs pack (no manifest.json)' });
      continue;
    }

    if ((await listGuides(dir)).length > 0) {
      results.push({
        id,
        status: 'kept',
        reason: 'it holds guides; move them, then delete the pack',
      });
      continue;
    }

    if (options.check === true) {
      results.push({ id, status: 'would-prune' });
      continue;
    }

    await rm(dir, { recursive: true, force: true });
    results.push({ id, status: 'pruned' });
  }

  return results;
}

/**
 * Sync `ids` (default: every configured pack). Per-pack failures are
 * reported in the result, not thrown; an invalid config, an unknown id, or a
 * held lock throws.
 */
export async function syncPacks(
  projectRoot: string,
  ids: readonly string[] | undefined,
  options: SyncOptions = {}
): Promise<SyncReport> {
  const loaded = await loadProjectConfig(projectRoot);
  const check = options.check === true;
  const selected =
    ids === undefined || ids.length === 0 ? Object.keys(loaded.config.packs) : [...new Set(ids)];

  for (const id of selected) {
    if (!Object.hasOwn(loaded.config.packs, id)) {
      throw new ConfigError(`No pack "${id}" in llm-docs.json; add it with 'llm-docs add ${id}'.`);
    }
  }

  const context: SyncContext = {
    loaded,
    projectRoot: await resolveEffectiveOutputPath(loaded.projectRoot),
    options,
  };
  let release: (() => Promise<void>) | undefined;

  if (!check) {
    await ensurePacksDir(loaded.packsDir);
    release = await acquireLock(loaded.packsDir, options.command ?? 'llm-docs sync');
  }

  try {
    const recoveryWarnings = check ? [] : await recoverStaging(loaded.packsDir);
    const packs: PackSyncResult[] = [];

    for (const id of selected) {
      try {
        packs.push(await syncOnePack(context, id));
      } catch (error) {
        packs.push({
          id,
          status: 'failed',
          error: errorMessage(error),
          exitCode: error instanceof ConfigError ? 2 : 3,
          warnings: [],
        });
      }
    }

    if (recoveryWarnings.length > 0) {
      packs[0]?.warnings.unshift(...recoveryWarnings);
    }

    const orphans =
      ids === undefined || ids.length === 0 ? await handleOrphans(loaded, options) : [];
    if (!check) {
      // Every build has swapped in or cleaned up its own staging directory by now.
      await rm(join(loaded.packsDir, STAGING_DIR), { recursive: true, force: true });
    }

    const afterSync =
      options.afterSync === undefined ? null : await options.afterSync({ loaded, packs, check });
    const changed =
      packs.some((pack) => pack.status === 'built' || pack.status === 'would-build') ||
      orphans.some((orphan) => orphan.status === 'pruned' || orphan.status === 'would-prune') ||
      afterSync?.changed === true;

    return { check, changed, packs, orphans, afterSync };
  } finally {
    await release?.();
  }
}

export interface PackPreview {
  files: { outputPath: string; kind: SelectedFile['kind']; source: string }[];
  warnings: string[];
}

/** The files a recipe would acquire and where they would land, writing nothing (`add --dry-run`). */
export async function previewPack(
  loaded: LoadedProjectConfig,
  resolved: ResolvedPack
): Promise<PackPreview> {
  assertBuildable(resolved.recipe);
  const context: SyncContext = {
    loaded,
    projectRoot: await resolveEffectiveOutputPath(loaded.projectRoot),
    options: {},
  };
  const workRoot = await mkdtemp(join(tmpdir(), 'llm-docs-'));

  try {
    const acquisitions = withPlaceholders(
      await acquireAll(context, resolved.recipe, workRoot, () => true)
    );
    const selection = await selectPackFiles(resolved.recipe, acquisitions);
    return {
      files: selection.files.map((selected) => ({
        outputPath: selected.outputPath,
        kind: selected.kind,
        source: selected.file.sourceLabel,
      })),
      warnings: [
        ...acquisitions.flatMap((acquisition) => acquisition.warnings),
        ...selection.warnings,
      ],
    };
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}
