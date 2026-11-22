/**
 * `sync` (spec 2.5, 2.6, 5): bring every pack in line with its recipe.
 *
 * Per pack: resolve the recipe; skip when the manifest's recipeHash matches,
 * the pack files verify, and local sources are unchanged; otherwise acquire,
 * select, convert, and write a staging pack, verify it in place, and swap it
 * in atomically, carrying the agent-owned `guides/` across. The whole run
 * holds an advisory lock in the packs directory, and the managed agent-file
 * blocks are updated last.
 */

import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';

import { syncAgentBlocks, type AgentBlockOutcome } from '../agent/block.js';
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
import { projectDependencies } from '../deps/lockfiles.js';
import {
  acquireSource,
  assertSourceSupported,
  selectPackFiles,
  sourceUsesNetwork,
  type PackSelection,
  type SelectedConversion,
  type SelectedFile,
  type SelectedPage,
  type SourceAcquisition,
} from '../sources/acquire.js';
import {
  createDocumentConverter,
  type DocumentConverter,
  type ManifestConverter,
} from '../sources/convert.js';
import { isSameOrDescendant, resolveEffectiveOutputPath } from '../utils/fs-path.js';
import { errorMessage, isFileNotFoundError } from '../utils/guards.js';
import { sha256Prefixed } from '../utils/hash.js';
import { writeTextFileSafely } from '../utils/safe-write.js';
import { compareStringsByCodeUnit } from '../utils/sort.js';
import { estimateTokenCount } from '../utils/text-metrics.js';
import { renderCombinedPack } from './combined.js';
import { renderIndexPage, type ReadFirstLink } from './index-page.js';
import {
  listGuides,
  reviewGuidesAfterBuild,
  reviewGuidesForRefreshCheck,
  type GuideReviewReport,
} from './guides.js';
import { createPackLinkRewriter } from './links.js';
import { resolvePackLicense } from './license.js';
import {
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
import { convertMarkdownPage, headingSlugs, type PackFileRef } from './markdown.js';
import { diffRefresh, type ConverterIdentity, type RefreshReport } from './refresh.js';
import { renderSourcePage } from './render-ir.js';
import { LOCK_FILE, withPacksLock } from './lock.js';
import { verifyPackFiles } from './verify.js';

const STAGING_DIR = '.staging';
const PACKS_GITIGNORE = `${STAGING_DIR}/\n${LOCK_FILE}\n`;
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
  /** What a refresh found upstream (`refresh` only). */
  refresh?: RefreshReport;
  /**
   * Guides whose stamped citations a rebuild changed (section-exact), or,
   * under `refresh --check`, whose cited pages changed upstream (page-level).
   * Absent when there is nothing to re-review.
   */
  guideReview?: GuideReviewReport;
}

export type OrphanStatus = 'orphan' | 'pruned' | 'would-prune' | 'kept';

export interface OrphanResult {
  id: string;
  status: OrphanStatus;
  reason?: string;
}

export interface SyncOptions {
  /** Write nothing; report what would change. */
  check?: boolean;
  /** Refuse to acquire network sources. */
  offline?: boolean;
  /** Delete pack directories that are not in the config. */
  prune?: boolean;
  /**
   * Re-acquire every source, network ones included, at the recorded recipe
   * and report what changed upstream (spec 5 `refresh`); `check` then writes
   * nothing. Without it, network sources are acquired only when the recipe
   * changed or the pack files no longer verify.
   */
  refresh?: boolean;
  /** Overrides the project's lockfile scan (tests pin a lockfile answer with it). */
  resolveDependencyVersion?: DependencyVersionResolver | undefined;
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
  /** One entry per resolved agent file; empty with `agentFiles: []`. */
  agentBlocks: AgentBlockOutcome[];
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
// The index
// ---------------------------------------------------------------------------

function renderIndexFor(
  manifest: Omit<PackManifest, 'outputs'>,
  outputs: readonly ManifestOutputEntry[],
  readFirst: readonly ReadFirstLink[]
): string {
  return renderIndexPage({
    pack: manifest.pack,
    recipe: manifest.recipe,
    origins: manifest.origins,
    acquiredAt: manifest.acquiredAt,
    license: manifest.license,
    sources: manifest.sources,
    pages: outputs.filter((output) => output.kind === 'page'),
    readFirst,
  });
}

// ---------------------------------------------------------------------------
// Read-first targets
// ---------------------------------------------------------------------------

const READ_FIRST_HINTS = 5;

function splitReadFirstTarget(target: string): { path: string; fragment: string | null } {
  const hash = target.indexOf('#');
  return hash === -1
    ? { path: target, fragment: null }
    : { path: target.slice(0, hash), fragment: target.slice(hash + 1) };
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current.push(Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitution));
    }
    previous = current;
  }

  return previous[b.length] ?? 0;
}

/**
 * The candidates closest to `wanted`: those containing it (or contained in
 * it) first, since a truncated slug or path is the usual typo, then by edit
 * distance, ties in code-unit order.
 */
function nearest(wanted: string, candidates: readonly string[]): string[] {
  return [...new Set(candidates)]
    .map((candidate) => ({
      candidate,
      overlap: candidate.includes(wanted) || wanted.includes(candidate) ? 0 : 1,
      distance: editDistance(wanted, candidate),
    }))
    .sort(
      (a, b) =>
        a.overlap - b.overlap ||
        a.distance - b.distance ||
        compareStringsByCodeUnit(a.candidate, b.candidate)
    )
    .slice(0, READ_FIRST_HINTS)
    .map((entry) => entry.candidate);
}

function readFirstError(id: string, index: number, target: string, why: string): ConfigError {
  return new ConfigError(
    `packs.${id}.readFirst[${index}] "${target}" does not resolve: ${why}. Edit packs.${id}.readFirst in llm-docs.json.`
  );
}

/**
 * Resolve `recipe.readFirst` against the staged pack (spec 4.8): each target
 * must name a page or passthrough output, and a fragment must be the GitHub
 * slug of a heading on that Markdown file. Any miss fails the build as a
 * config error naming the nearest paths or slugs; nothing is partly accepted.
 */
async function resolveReadFirst(
  id: string,
  targets: readonly string[],
  outputs: readonly ManifestOutputEntry[],
  stagingDir: string
): Promise<ReadFirstLink[]> {
  const files = outputs.filter((output) => output.kind === 'page' || output.kind === 'passthrough');
  const links: ReadFirstLink[] = [];

  for (const [index, target] of targets.entries()) {
    const { path, fragment } = splitReadFirstTarget(target);
    const output = files.find((entry) => entry.path === path);

    if (output === undefined) {
      const hints = nearest(
        path,
        files.map((entry) => entry.path)
      );
      throw readFirstError(
        id,
        index,
        target,
        `no page or passthrough file in the built pack has this path${hints.length === 0 ? '' : ` (nearest: ${hints.join(', ')})`}`
      );
    }

    const title = output.title === undefined || output.title === '' ? path : output.title;

    if (fragment === null) {
      links.push({ path, fragment, title, heading: null });
      continue;
    }

    if (!/\.md$/i.test(path)) {
      throw readFirstError(id, index, target, 'a fragment only resolves on a Markdown file');
    }

    const headings = headingSlugs(await readFile(join(stagingDir, ...path.split('/')), 'utf-8'));
    const heading = headings.find((entry) => entry.slug === fragment);

    if (heading === undefined) {
      const hints = nearest(
        fragment,
        headings.map((entry) => entry.slug)
      );
      throw readFirstError(
        id,
        index,
        target,
        hints.length === 0
          ? `${path} has no headings`
          : `no heading on ${path} has the slug "${fragment}" (nearest: ${hints.map((slug) => `#${slug}`).join(', ')})`
      );
    }

    links.push({ path, fragment, title, heading: heading.text });
  }

  return links;
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
  const fileRef = (selected: SelectedFile): PackFileRef => ({
    sourceIndex: selected.sourceIndex,
    sourcePath: selected.file.path,
    outputPath: selected.outputPath,
    url: selected.file.url,
    localPath:
      recipe.sources[selected.sourceIndex]?.type === 'local'
        ? selected.file.sourceLabel
        : undefined,
  });

  // Render every page first: an OpenAPI document expands to pages named after
  // its tags, and links anywhere in the pack may point at them. Each of those
  // pages answers links by its own path (`<spec stem>/<tag>.md`), as if it
  // were a file at the origin.
  // Markdown, MDX, rendered formats, and converted documents all become units
  // that go through the Markdown page path below.
  const units: {
    page: SelectedPage | SelectedConversion;
    ref: PackFileRef;
    text: string;
    syntax: 'markdown' | 'mdx';
    extraSources: readonly string[];
  }[] = [];
  const renderWarnings: string[] = [];
  for (const page of pages) {
    if (page.format === 'markdown' || page.format === 'mdx') {
      units.push({
        page,
        ref: fileRef(page),
        text: await readUtf8(page),
        syntax: page.format,
        extraSources: [],
      });
      continue;
    }

    const rendered = await renderSourcePage(page);
    renderWarnings.push(...rendered.warnings);
    for (const unit of rendered.pages) {
      const ref = fileRef(page);
      if (page.format === 'openapi') {
        const mountRoot = posix.join('pages', recipe.sources[page.sourceIndex]?.mount ?? '');
        const sourcePath = posix.relative(mountRoot, unit.outputPath);
        const base = ref.localPath?.slice(0, ref.localPath.length - ref.sourcePath.length);
        Object.assign(ref, {
          sourcePath,
          url: undefined,
          localPath: base === undefined ? undefined : `${base}${sourcePath}`,
        });
      }
      units.push({
        page,
        ref: { ...ref, outputPath: unit.outputPath },
        text: unit.text,
        syntax: 'markdown',
        extraSources: [],
      });
    }
  }

  // Convert documents before links are rewritten, so links to a converted
  // document resolve to its page. One converter per source, resolved (tool on
  // PATH, version) on first use.
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
      renderWarnings.push(...converter.warnings);
    }

    const converted = await converter.convert(
      conversion,
      previous?.sources.find(
        (entry) => entry.source === conversion.sourceIndex && entry.path === conversion.file.path
      )
    );
    renderWarnings.push(...converted.warnings);
    converterBySource.set(`${conversion.sourceIndex}:${conversion.file.path}`, converted.converter);
    units.push({
      page: conversion,
      ref: fileRef(conversion),
      text: converted.markdown,
      syntax: 'markdown',
      extraSources:
        converted.agentOutputPath === undefined
          ? []
          : [`${conversion.sourceIndex}:${converted.agentOutputPath}`],
    });
  }

  const rewriteLinks = createPackLinkRewriter({
    recipe,
    origins,
    // The OpenAPI document itself stays a link target too (its index page).
    pages: [
      ...pages.filter((page) => page.format === 'openapi').map(fileRef),
      ...units.map((unit) => unit.ref),
    ],
    passthrough: passthrough.map(fileRef),
    inventories: acquisitions.map((acquisition) => acquisition.inventory),
  });

  await mkdir(join(packsDir, STAGING_DIR), { recursive: true });
  const stagingDir = join(packsDir, STAGING_DIR, `${resolved.id}-${randomSuffix()}`);
  await mkdir(stagingDir);
  let swapped = false;

  try {
    const outputs: ManifestOutputEntry[] = [];
    const warnings = [
      ...acquisitions.flatMap((acquisition) => acquisition.warnings),
      ...selection.warnings,
      ...renderWarnings,
    ];
    const transformCounts = new Map<TransformName, number>(
      recipe.sources.flatMap((source) => source.transforms.map((name) => [name, 0] as const))
    );
    const unknownComponents = new Map<string, number>();
    const links: PackManifest['links'] = { rewritten: 0, external: 0, unresolved: [] };
    let plainTextConversions = 0;
    const writtenPages: { path: string; text: string }[] = [];
    // Selection cannot see the tag pages of an OpenAPI document: check those
    // paths against every other page here.
    const pagePaths = new Map<string, string>();

    for (const { page, ref: unit, text, syntax, extraSources } of units) {
      const source = recipe.sources[page.sourceIndex];
      if (source === undefined) {
        throw new Error(`Page ${page.outputPath} has no source.`);
      }

      const folded = unit.outputPath.normalize('NFC').toLowerCase();
      const previous = pagePaths.get(folded);
      if (previous !== undefined) {
        throw new ConfigError(
          `${previous} and ${page.file.sourceLabel} would both be written to ${unit.outputPath}; exclude one of them or give a source a different "mount".`
        );
      }
      pagePaths.set(folded, page.file.sourceLabel);

      const result = convertMarkdownPage({
        text,
        syntax,
        sourceIndex: page.sourceIndex,
        sourcePath: unit.sourcePath,
        outputPath: unit.outputPath,
        transforms: source.transforms,
        provenance: {
          packId: resolved.id,
          version: recipe.version,
          source: page.file.sourceLabel,
        },
        rewriteLinks,
      });

      await writeStagedFile(stagingDir, unit.outputPath, (target) =>
        writeTextFileSafely(target, result.text)
      );
      writtenPages.push({ path: unit.outputPath, text: result.text });
      outputs.push({
        path: unit.outputPath,
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
        ...result.links.unresolved.map((entry) => ({ page: unit.outputPath, ...entry }))
      );
      plainTextConversions += result.links.plainTextConversions;
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

    const license = resolvePackLicense(
      recipe.license,
      acquisitions.map((acquisition) => acquisition.license)
    );
    warnings.push(...license.warnings);
    const manifestWithoutOutputs: Omit<PackManifest, 'outputs'> = {
      schemaVersion: 3,
      tool: { name: TOOL_NAME, version: TOOL_VERSION },
      pack: { id: resolved.id, title: recipe.title, version: recipe.version },
      dependency: recipe.dependency,
      recipe,
      recipeHash: resolved.recipeHash,
      acquiredAt,
      origins,
      license: license.license,
      sources,
      links,
      transforms: [...transformCounts.entries()].map(([name, count]) => ({ name, pages: count })),
      warnings,
    };

    const readFirst = await resolveReadFirst(
      resolved.id,
      recipe.readFirst ?? [],
      outputs,
      stagingDir
    );
    const indexText = renderIndexFor(manifestWithoutOutputs, outputs, readFirst);
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

    if (recipe.layout.combined) {
      const combinedPath = `${resolved.id}.full.md`;
      const combinedText = renderCombinedPack({ indexText, pages: writtenPages });
      await writeStagedFile(stagingDir, combinedPath, (target) =>
        writeTextFileSafely(target, combinedText)
      );
      outputs.push({
        path: combinedPath,
        kind: 'combined',
        sha256: sha256Prefixed(combinedText),
        bytes: Buffer.byteLength(combinedText, 'utf-8'),
        tokens: estimateTokenCount(combinedText),
        title: `${recipe.title} ${recipe.version}`,
      });
    }

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

/** Re-acquire every source of a built pack, report the upstream changes, and rebuild unless `check`. */
async function refreshOnePack(
  context: SyncContext,
  resolved: ResolvedPack,
  existing: ExistingPack,
  workRoot: string
): Promise<PackSyncResult> {
  const { id, recipe } = resolved;

  if (existing.kind !== 'pack') {
    throw new ConfigError(
      `Pack "${id}" has no readable manifest to refresh; run 'llm-docs sync ${id}'.`
    );
  }
  if (existing.manifest.recipeHash !== resolved.recipeHash) {
    throw new ConfigError(
      `The recipe of pack "${id}" changed since its last sync, so there is no recorded recipe to refresh; run 'llm-docs sync ${id}'.`
    );
  }

  const acquisitions = withPlaceholders(await acquireAll(context, recipe, workRoot, () => true));
  const selection = await selectPackFiles(recipe, acquisitions);
  // Resolving a converter only reads its version; nothing is converted here.
  const converters = new Map<number, ConverterIdentity>();
  for (const index of new Set(
    selection.files.flatMap((selected) =>
      selected.kind === 'convert' ? [selected.sourceIndex] : []
    )
  )) {
    const spec = recipe.sources[index]?.convert;
    if (spec !== undefined && spec !== null && spec.tool !== 'agent') {
      const converter = await createDocumentConverter(spec, {
        projectRoot: context.projectRoot,
        workDir: join(workRoot, `convert-${index}`),
      });
      converters.set(index, { tool: converter.tool, version: converter.version });
    }
  }
  const report = diffRefresh(
    existing.manifest,
    selection,
    acquisitions.map((acquisition) => acquisition.origin),
    converters
  );

  if (!report.changed) {
    return { id, status: 'unchanged', warnings: [], refresh: report };
  }

  const onlyConverters =
    report.converters.length > 0 &&
    report.refs.length === 0 &&
    report.files.every((file) => file.status === 'unchanged');
  const reason = onlyConverters ? 'a converter version changed' : 'upstream changed';

  const packDir = join(context.loaded.packsDir, id);

  if (context.options.check === true) {
    const review = await reviewGuidesForRefreshCheck(packDir, report);
    return {
      id,
      status: 'would-build',
      reason,
      warnings: [],
      refresh: report,
      ...(review === undefined ? {} : { guideReview: review }),
    };
  }

  const warnings = await buildPack(context, resolved, existing, acquisitions, workRoot);
  const review = await reviewGuidesAfterBuild(packDir);
  return {
    id,
    status: 'built',
    reason,
    warnings,
    refresh: report,
    ...(review === undefined ? {} : { guideReview: review }),
  };
}

async function syncOnePack(
  context: SyncContext,
  id: string,
  resolveDependencyVersion: DependencyVersionResolver
): Promise<PackSyncResult> {
  const resolved = await resolvePackRecipe(context.loaded.config, id, {
    resolveDependencyVersion,
  });
  assertBuildable(resolved.recipe);
  const existing = await inspectExistingPack(context.loaded.packsDir, id);
  const workRoot = await mkdtemp(join(tmpdir(), 'llm-docs-'));

  try {
    if (context.options.refresh === true) {
      return await refreshOnePack(context, resolved, existing, workRoot);
    }

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
    const review = await reviewGuidesAfterBuild(join(context.loaded.packsDir, id));
    return {
      id,
      status: 'built',
      reason,
      warnings,
      ...(review === undefined ? {} : { guideReview: review }),
    };
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
 * Sync `ids` (default: every configured pack), then update the managed
 * blocks in the agent files from every built pack. Per-pack and per-file
 * failures are reported in the result, not thrown; an invalid config, an
 * unknown id, or a held lock throws.
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
  const resolveDependencyVersion =
    options.resolveDependencyVersion ??
    projectDependencies(loaded.projectRoot, { skipDirectories: [loaded.packsDirRelative] })
      .resolveVersion;
  const run = async (): Promise<SyncReport> => {
    const recoveryWarnings = check ? [] : await recoverStaging(loaded.packsDir);
    const packs: PackSyncResult[] = [];

    for (const id of selected) {
      try {
        packs.push(await syncOnePack(context, id, resolveDependencyVersion));
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

    const agentBlocks = await syncAgentBlocks(loaded, { check });
    const changed =
      packs.some((pack) => pack.status === 'built' || pack.status === 'would-build') ||
      orphans.some((orphan) => orphan.status === 'pruned' || orphan.status === 'would-prune') ||
      agentBlocks.some((block) => block.status !== 'unchanged' && block.status !== 'failed');

    return { check, changed, packs, orphans, agentBlocks };
  };

  if (check) {
    return run();
  }

  await ensurePacksDir(loaded.packsDir);
  return withPacksLock(loaded.packsDir, options.command ?? 'llm-docs sync', run);
}

/**
 * A read-first target checked against the file list a recipe would take. A
 * heading fragment cannot be checked before the pages are built, so a found
 * target with a fragment is only known to name an existing file.
 */
export interface ReadFirstPreview {
  target: string;
  /** Some file the recipe takes lands at the target's path. */
  found: boolean;
  /** Up to five output paths nearest the target's path, when it is not found. */
  nearest: string[];
  /** The heading slug, checked only when the pack is built. */
  fragment: string | null;
}

export interface PackPreview {
  files: { outputPath: string; kind: SelectedFile['kind']; source: string }[];
  readFirst: ReadFirstPreview[];
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
    const outputPaths = selection.files.map((selected) => selected.outputPath);
    return {
      files: selection.files.map((selected) => ({
        outputPath: selected.outputPath,
        kind: selected.kind,
        source: selected.file.sourceLabel,
      })),
      readFirst: (resolved.recipe.readFirst ?? []).map((target) => {
        const { path, fragment } = splitReadFirstTarget(target);
        const found = outputPaths.includes(path);
        return { target, found, nearest: found ? [] : nearest(path, outputPaths), fragment };
      }),
      warnings: [
        ...acquisitions.flatMap((acquisition) => acquisition.warnings),
        ...selection.warnings,
      ],
    };
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}
