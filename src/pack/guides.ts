/**
 * Agent-owned guides under `<pack>/guides/` and their citations (spec 8).
 *
 * The tool never writes or deletes a guide. It lists them, extracts their
 * citations (links into `pages/` or `files/`), and owns
 * `guides/citations.lock.json`: `stampGuides` is its only writer and
 * `assessCitations` its only reader, so the `citations` verify check and the
 * re-review list after a rebuild are projections of one recomputation.
 *
 * The lock is not a manifest output. It travels with `guides/` across the
 * staging swap, and sync never reads or writes it, so the manifest stays a
 * function of the recipe and the upstream bytes (spec 2.5).
 */

import { lstat, readFile } from 'node:fs/promises';
import { join, posix, relative, resolve, sep } from 'node:path';

import { z } from 'zod';

import { ConfigError, formatSchemaIssues, type LoadedProjectConfig } from '../config/project.js';
import { isSameOrDescendant, realpathIfExists } from '../utils/fs-path.js';
import { errorMessage, isFileNotFoundError } from '../utils/guards.js';
import { sha256Prefixed } from '../utils/hash.js';
import { canonicalJsonStringify, readJsonFile } from '../utils/json.js';
import { writeTextFileSafely } from '../utils/safe-write.js';
import { compareStringsByCodeUnit } from '../utils/sort.js';
import { walkBoundedDirectoryTree } from '../utils/traversal.js';
import { withPacksLock } from './lock.js';
import { ManifestError, readPackManifest, type PackManifest } from './manifest.js';
import { findLinkTargets, headingSlugs } from './markdown.js';
import type { RefreshReport } from './refresh.js';
import type { CheckFinding } from './verify.js';

/** Pack-relative path of the lock. Not a `.md` file, so it is never listed as a guide. */
export const CITATIONS_LOCK_PATH = 'guides/citations.lock.json';

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/** Pack-relative paths of the Markdown guides under `<packDir>/guides`, sorted. */
export async function listGuides(packDir: string): Promise<string[]> {
  const root = join(packDir, 'guides');

  try {
    await lstat(root);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return [];
    }
    throw error;
  }

  const guides: string[] = [];

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

    guides.push(`guides/${event.relativePath.split(sep).join('/')}`);
  }

  return guides.sort(compareStringsByCodeUnit);
}

// ---------------------------------------------------------------------------
// Citations (pure)
// ---------------------------------------------------------------------------

/**
 * A link in a guide that resolves into the pack's `pages/` or `files/`.
 * `target` is the form recorded in the lock: the pack-relative, decoded path
 * (with `%` and `#` escaped, so a `C#` page stays one path), then `#` and the
 * decoded fragment when there is one.
 */
export interface Citation {
  target: string;
  /** Pack-relative POSIX path, percent-decoded. */
  path: string;
  /** Decoded fragment, or null for a whole-file citation. */
  fragment: string | null;
}

export interface GuideLinks {
  /** Deduplicated by target, in target order. */
  citations: Citation[];
  /**
   * Relative links that leave the pack but name `pages/` or `files/` once
   * their leading `../` segments are dropped (`../../pages/x.md` from
   * `guides/a.md`): meant as citations, written one level too high.
   */
  outsidePack: string[];
}

const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const CITABLE_ROOT = /^(?:pages|files)\//;

function decodePart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** A normalized pack-relative path under `pages/` or `files/`, never climbing out. */
function isCitablePath(path: string): boolean {
  return (
    CITABLE_ROOT.test(path) && posix.normalize(path) === path && !path.split('/').includes('..')
  );
}

function formatTarget(path: string, fragment: string | null): string {
  const escaped = path.replace(/[%#]/g, (char) => (char === '%' ? '%25' : '%23'));
  return fragment === null ? escaped : `${escaped}#${fragment}`;
}

/** The citation a lock target names, or undefined when it does not name one inside the pack. */
function parseTarget(target: string): Citation | undefined {
  const hash = target.indexOf('#');
  const path = (hash === -1 ? target : target.slice(0, hash)).replace(/%2[35]/g, (code) =>
    code === '%23' ? '#' : '%'
  );
  const fragment = hash === -1 ? null : target.slice(hash + 1);

  return isCitablePath(path) && formatTarget(path, fragment) === target
    ? { target, path, fragment }
    : undefined;
}

/**
 * The citations in one guide. A link is a citation when it is relative (no
 * scheme, not `//` or `/`), and its path, resolved against the guide's
 * directory, lies under `pages/` or `files/`. Links to other guides, to
 * index.md, to the web, and fragment-only links are not citations; links in
 * code are not links at all (`findLinkTargets`, the definition verify's
 * `links` check uses). An empty fragment is a whole-file citation.
 */
export function extractCitations(guidePath: string, text: string): GuideLinks {
  const citations = new Map<string, Citation>();
  const outsidePack = new Set<string>();

  for (const link of findLinkTargets(text)) {
    const raw = link.target.trim();

    if (raw === '' || URL_SCHEME.test(raw) || raw.startsWith('/') || raw.startsWith('#')) {
      continue;
    }

    const hash = raw.indexOf('#');
    const pathPart = (hash === -1 ? raw : raw.slice(0, hash)).replace(/\?.*$/, '');
    const fragmentPart = hash === -1 ? '' : decodePart(raw.slice(hash + 1));
    const resolved = posix.normalize(
      posix.join(posix.dirname(guidePath), decodePart(pathPart).split(sep).join('/'))
    );

    if (resolved === '..' || resolved.startsWith('../')) {
      if (CITABLE_ROOT.test(resolved.replace(/^(?:\.\.\/)+/, ''))) {
        outsidePack.add(raw);
      }
      continue;
    }

    if (isCitablePath(resolved)) {
      const fragment = fragmentPart === '' ? null : fragmentPart;
      const target = formatTarget(resolved, fragment);
      citations.set(target, { target, path: resolved, fragment });
    }
  }

  return {
    citations: [...citations.values()].sort((a, b) => compareStringsByCodeUnit(a.target, b.target)),
    outsidePack: [...outsidePack].sort(compareStringsByCodeUnit),
  };
}

/**
 * The text of the section a fragment names: from the heading whose GitHub
 * slug (`headingSlugs`, `-1`/`-2` suffixes for duplicates) equals `fragment`
 * to the next heading of the same or a higher level, else the end of the
 * page. Undefined when no heading has that slug (an HTML `id` is not a
 * section).
 */
export function citedSection(pageText: string, fragment: string): string | undefined {
  const headings = headingSlugs(pageText);
  const index = headings.findIndex((heading) => heading.slug === fragment);
  const start = headings[index];

  if (start === undefined) {
    return undefined;
  }

  const end = headings.slice(index + 1).find((heading) => heading.level <= start.level);
  return pageText.slice(start.offset, end?.offset ?? pageText.length);
}

/**
 * The page text a whole-page citation covers: the page without the
 * provenance comment line (and the blank line after it) that the build puts
 * on every page. That line names the pack version and the pinned origin URL,
 * so it changes with every version bump even when the upstream text does not.
 * Frontmatter is already gone from pages (its title and description became
 * upstream-derived body text), so nothing else is generated.
 */
export function citedPageText(pageText: string): string {
  return pageText.replace(/^<!-- llm-docs: [^\n]* -->\n\n?/, '');
}

export type UnresolvedReason =
  'no-such-file' | 'no-such-heading' | 'fragment-on-non-markdown' | 'outside-pack';

const UNRESOLVED_TEXT: Readonly<Record<UnresolvedReason, string>> = {
  'no-such-file': 'no such file in the pack',
  'no-such-heading': 'no heading on the page has this slug',
  'fragment-on-non-markdown': 'a fragment only resolves on a Markdown page',
  'outside-pack': 'the link leaves the pack; write it relative to the guide',
};

type CitationResolution =
  | { kind: 'resolved'; sectionSha256: string; bytesSha256: string }
  | { kind: 'unresolved'; reason: UnresolvedReason };

/** Reads pack files once per stamp or assessment; undefined for anything but a regular file. */
function packFileReader(packDir: string): (path: string) => Promise<Buffer | undefined> {
  const cache = new Map<string, Promise<Buffer | undefined>>();

  const load = async (path: string): Promise<Buffer | undefined> => {
    const absolute = join(packDir, ...path.split('/'));
    if (!isSameOrDescendant(packDir, absolute)) {
      return undefined;
    }
    try {
      return (await lstat(absolute)).isFile() ? await readFile(absolute) : undefined;
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return undefined;
      }
      throw error;
    }
  };

  return (path) => {
    let read = cache.get(path);
    if (read === undefined) {
      read = load(path);
      cache.set(path, read);
    }
    return read;
  };
}

/**
 * Hash what a citation points at, as the pack holds it now: a `pages/` page
 * without its provenance line (`citedPageText`), a `files/` file byte for
 * byte, or the section a fragment names. `bytesSha256` is the whole file, as
 * the manifest records it.
 */
async function resolveCitation(
  citation: Citation,
  read: (path: string) => Promise<Buffer | undefined>
): Promise<CitationResolution> {
  const bytes = await read(citation.path);

  if (bytes === undefined) {
    return { kind: 'unresolved', reason: 'no-such-file' };
  }

  const bytesSha256 = sha256Prefixed(bytes);
  const markdown = /\.md$/i.test(citation.path);

  if (citation.fragment === null) {
    const isPage = citation.path.startsWith('pages/') && markdown;
    return {
      kind: 'resolved',
      sectionSha256: isPage ? sha256Prefixed(citedPageText(bytes.toString('utf-8'))) : bytesSha256,
      bytesSha256,
    };
  }

  if (!markdown) {
    return { kind: 'unresolved', reason: 'fragment-on-non-markdown' };
  }

  const section = citedSection(bytes.toString('utf-8'), citation.fragment);
  return section === undefined
    ? { kind: 'unresolved', reason: 'no-such-heading' }
    : { kind: 'resolved', sectionSha256: sha256Prefixed(section), bytesSha256 };
}

// ---------------------------------------------------------------------------
// The lock
// ---------------------------------------------------------------------------

const hashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/, {
  error: 'must be a sha256:<64 hex> hash',
});

const citationsLockSchema = z.strictObject({
  schemaVersion: z.literal(1),
  guides: z.record(
    z
      .string()
      .regex(/^guides\/.+\.md$/i, { error: 'must be a guides/**.md path' })
      .refine((path) => posix.normalize(path) === path && !path.split('/').includes('..'), {
        error: 'must be a normalized path inside guides/',
      }),
    z.strictObject({
      sha256: hashSchema,
      citations: z.array(
        z.strictObject({
          target: z.string().refine((target) => parseTarget(target) !== undefined, {
            error: 'must be a path under pages/ or files/, optionally with #fragment',
          }),
          sectionSha256: hashSchema,
        })
      ),
    })
  ),
});

type CitationsLock = z.infer<typeof citationsLockSchema>;
type LockEntry = CitationsLock['guides'][string];

type LockRead =
  { kind: 'absent' } | { kind: 'invalid'; message: string } | { kind: 'ok'; lock: CitationsLock };

/** Parse the lock at the boundary; a broken lock is a value, never a throw. */
async function readCitationsLock(packDir: string): Promise<LockRead> {
  let raw: unknown;

  try {
    raw = await readJsonFile(join(packDir, ...CITATIONS_LOCK_PATH.split('/')));
  } catch (error) {
    return isFileNotFoundError(error)
      ? { kind: 'absent' }
      : { kind: 'invalid', message: `not readable JSON (${errorMessage(error)})` };
  }

  const parsed = citationsLockSchema.safeParse(raw);
  return parsed.success
    ? { kind: 'ok', lock: parsed.data }
    : {
        kind: 'invalid',
        message: formatSchemaIssues(CITATIONS_LOCK_PATH, parsed.error).replace(/\n/g, '; '),
      };
}

/**
 * The exact bytes of a lock: sorted keys at every depth, each guide's
 * citations in target order, two-space indent, one trailing newline. The same
 * guides over the same pages give the same bytes.
 */
function serializeCitationsLock(lock: CitationsLock): string {
  const guides = Object.fromEntries(
    Object.entries(lock.guides).map(([path, entry]) => [
      path,
      {
        ...entry,
        citations: [...entry.citations].sort((a, b) =>
          compareStringsByCodeUnit(a.target, b.target)
        ),
      },
    ])
  );
  return `${canonicalJsonStringify({ schemaVersion: 1, guides }, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Stamp (the only writer of the lock)
// ---------------------------------------------------------------------------

export interface StampResult {
  packId: string;
  /** Project-relative POSIX path of the lock. */
  lockPath: string;
  /** False when the lock already held exactly these bytes. */
  changed: boolean;
  guides: { path: string; sha256: string; citations: number }[];
  /** Lock entries dropped because their guide no longer exists. */
  removed: string[];
  warnings: string[];
}

/**
 * A stamp argument as typed: `x.md` and `guides/x.md` are pack-relative;
 * anything else is a path from `cwd` that must land on a guide of this pack,
 * so a tab-completed `agent-docs/vite/guides/x.md` works.
 */
async function guidePathFromArg(
  packDir: string,
  cwd: string,
  arg: string,
  guides: ReadonlySet<string>
): Promise<string | undefined> {
  const posixArg = arg.split(sep).join('/');
  const packRelative = posix.normalize(
    posixArg.startsWith('guides/') ? posixArg : `guides/${posixArg}`
  );

  if (guides.has(packRelative)) {
    return packRelative;
  }

  const guidesRoot = await realpathIfExists(join(packDir, 'guides'));
  const absolute = await realpathIfExists(resolve(cwd, arg));

  if (guidesRoot === undefined || absolute === undefined) {
    return undefined;
  }

  const path = `guides/${relative(guidesRoot, absolute).split(sep).join('/')}`;
  return isSameOrDescendant(guidesRoot, absolute) && guides.has(path) ? path : undefined;
}

async function readStampedManifest(packDir: string, packId: string): Promise<PackManifest> {
  try {
    const manifest = await readPackManifest(packDir);
    if (manifest.pack.id !== packId) {
      throw new ConfigError(
        `${packDir} holds pack "${manifest.pack.id}", not "${packId}"; stamp the guides of "${manifest.pack.id}" instead.`
      );
    }
    return manifest;
  } catch (error) {
    if (error instanceof ManifestError) {
      throw new ConfigError(
        `Pack "${packId}" cannot be stamped: ${error.message}; run 'llm-docs sync ${packId}' first.`
      );
    }
    throw error;
  }
}

/**
 * `llm-docs guides stamp <id> [guide...]`: record, for each named guide (every
 * guide when none is named), its hash and the hash of every section it cites.
 *
 * Holds the packs lock, so a concurrent sync cannot move `guides/` mid-write.
 * Refuses with a ConfigError, writing nothing, when a named guide does not
 * exist, when any citation does not resolve (every one listed), or when a
 * cited file's bytes differ from its manifest output, so a lock only ever
 * attests to verified pages. Entries of guides not named are kept; entries
 * whose guide is gone are dropped and reported. Writing the same bytes again
 * is skipped.
 */
export async function stampGuides(
  loaded: LoadedProjectConfig,
  packId: string,
  guideArgs: readonly string[],
  cwd: string
): Promise<StampResult> {
  const packDir = join(loaded.packsDir, packId);
  const packLabel = `${loaded.packsDirRelative}/${packId}`;
  const lockPath = `${packLabel}/${CITATIONS_LOCK_PATH}`;

  return withPacksLock(loaded.packsDir, `llm-docs guides stamp ${packId}`, async () => {
    if ((await realpathIfExists(packDir)) === undefined) {
      throw new ConfigError(
        `No pack directory ${packLabel}/; build the pack with 'llm-docs sync ${packId}' first.`
      );
    }

    const manifest = await readStampedManifest(packDir, packId);
    const onDisk = await listGuides(packDir);
    const present = new Set(onDisk);
    const previous = await readCitationsLock(packDir);

    if (onDisk.length === 0 && previous.kind === 'absent') {
      throw new ConfigError(
        `Pack "${packId}" has no guides to stamp; write Markdown guides under ${packLabel}/guides/ first.`
      );
    }

    const wanted: string[] = [];
    const unknown: string[] = [];

    for (const arg of guideArgs) {
      const path = await guidePathFromArg(packDir, cwd, arg, present);
      if (path === undefined) {
        unknown.push(arg);
      } else if (!wanted.includes(path)) {
        wanted.push(path);
      }
    }

    if (unknown.length > 0) {
      throw new ConfigError(
        `Not a guide of pack "${packId}": ${unknown.join(', ')}. Name a .md file under ${packLabel}/guides/ as guides/x.md, x.md, or its path.`
      );
    }

    const read = packFileReader(packDir);
    const outputHashes = new Map(manifest.outputs.map((output) => [output.path, output.sha256]));
    const entries = new Map<string, LockEntry>();
    const unresolved: string[] = [];
    const unverified = new Set<string>();

    for (const path of guideArgs.length === 0 ? [...present] : wanted) {
      const bytes = await read(path);
      if (bytes === undefined) {
        throw new Error(`Guide ${path} disappeared while stamping.`);
      }

      const links = extractCitations(path, bytes.toString('utf-8'));
      const citations: LockEntry['citations'] = [];

      for (const target of links.outsidePack) {
        unresolved.push(`${path}: ${target} (${UNRESOLVED_TEXT['outside-pack']})`);
      }

      for (const citation of links.citations) {
        const resolution = await resolveCitation(citation, read);

        if (resolution.kind === 'unresolved') {
          unresolved.push(`${path}: ${citation.target} (${UNRESOLVED_TEXT[resolution.reason]})`);
          continue;
        }
        if (outputHashes.get(citation.path) !== resolution.bytesSha256) {
          unverified.add(citation.path);
          continue;
        }
        citations.push({ target: citation.target, sectionSha256: resolution.sectionSha256 });
      }

      entries.set(path, { sha256: sha256Prefixed(bytes), citations });
    }

    if (unresolved.length > 0 || unverified.size > 0) {
      const problems = [
        ...(unverified.size === 0
          ? []
          : [
              `cited files differ from the manifest (${[...unverified].sort(compareStringsByCodeUnit).join(', ')}); run 'llm-docs sync ${packId}' first`,
            ]),
        ...(unresolved.length === 0
          ? []
          : [
              `${unresolved.length} citation${unresolved.length === 1 ? ' does' : 's do'} not resolve: ${unresolved.join('; ')}`,
            ]),
      ];
      throw new ConfigError(
        `Nothing stamped for pack "${packId}": ${problems.join('. ')}. Fix the links, then run 'llm-docs guides stamp ${packId}' again.`
      );
    }

    const warnings =
      previous.kind === 'invalid'
        ? [`The previous ${lockPath} was invalid (${previous.message}); it was replaced.`]
        : [];
    const kept = previous.kind === 'ok' ? Object.entries(previous.lock.guides) : [];
    const removed = kept.map(([path]) => path).filter((path) => !present.has(path));
    const guides: CitationsLock['guides'] = Object.fromEntries([
      ...kept.filter(([path]) => present.has(path)),
      ...entries,
    ]);
    const text = serializeCitationsLock({ schemaVersion: 1, guides });
    const target = join(packDir, ...CITATIONS_LOCK_PATH.split('/'));
    let current: string | undefined;

    try {
      current = await readFile(target, 'utf-8');
    } catch (error) {
      if (!isFileNotFoundError(error)) {
        throw error;
      }
    }

    if (current !== text) {
      await writeTextFileSafely(target, text);
    }

    return {
      packId,
      lockPath,
      changed: current !== text,
      guides: [...entries].map(([path, entry]) => ({
        path,
        sha256: entry.sha256,
        citations: entry.citations.length,
      })),
      removed,
      warnings,
    };
  });
}

// ---------------------------------------------------------------------------
// Assessment (the only reader): verify and the re-review list derive from it
// ---------------------------------------------------------------------------

export type CitationAssessment =
  | { target: string; state: 'ok' | 'section-changed' }
  | { target: string; state: 'unresolved'; reason: UnresolvedReason };

export type GuideAssessment =
  /** The lock records a guide that no longer exists. */
  | { path: string; missing: true }
  | {
      path: string;
      missing: false;
      /** The guide's bytes differ from the stamped hash. */
      edited: boolean;
      /** The recorded citations, resolved against the pack as it is now. */
      citations: CitationAssessment[];
    };

export type CitationsAssessment =
  | { kind: 'no-guides' }
  | { kind: 'invalid-lock'; message: string }
  | {
      kind: 'assessed';
      /** Guides with no lock entry (every guide when there is no lock). */
      unstamped: string[];
      guides: GuideAssessment[];
    };

/**
 * Recompute everything the lock claims (spec 8: "verify recomputes
 * everything") against the guides and pages as they are on disk now.
 * Read-only and offline.
 */
export async function assessCitations(packDir: string): Promise<CitationsAssessment> {
  const onDisk = await listGuides(packDir);
  const lock = await readCitationsLock(packDir);

  if (lock.kind === 'absent' && onDisk.length === 0) {
    return { kind: 'no-guides' };
  }
  if (lock.kind === 'invalid') {
    return { kind: 'invalid-lock', message: lock.message };
  }

  const recorded = lock.kind === 'ok' ? lock.lock.guides : {};
  const read = packFileReader(packDir);
  const guides: GuideAssessment[] = [];

  for (const path of Object.keys(recorded).sort(compareStringsByCodeUnit)) {
    const entry = recorded[path];
    const bytes = await read(path);

    if (entry === undefined || bytes === undefined) {
      guides.push({ path, missing: true });
      continue;
    }

    const citations: CitationAssessment[] = [];

    for (const { target, sectionSha256 } of entry.citations) {
      const citation = parseTarget(target);
      const resolution =
        citation === undefined
          ? ({ kind: 'unresolved', reason: 'outside-pack' } as const)
          : await resolveCitation(citation, read);

      citations.push(
        resolution.kind === 'unresolved'
          ? { target, state: 'unresolved', reason: resolution.reason }
          : { target, state: resolution.sectionSha256 === sectionSha256 ? 'ok' : 'section-changed' }
      );
    }

    guides.push({
      path,
      missing: false,
      edited: sha256Prefixed(bytes) !== entry.sha256,
      citations,
    });
  }

  return {
    kind: 'assessed',
    unstamped: onDisk.filter((path) => !Object.hasOwn(recorded, path)),
    guides,
  };
}

/**
 * The per-pack `citations` verify check (spec 5.1), a projection of
 * `assessCitations`. Fails: an invalid lock, a citation that no longer
 * resolves, a cited section whose hash changed. Warns: an unstamped guide, a
 * guide edited after stamping, a lock entry whose guide is gone. Each
 * finding names the guide and the command to run after re-review.
 */
export async function checkCitations(packId: string, packDir: string): Promise<CheckFinding[]> {
  const assessment = await assessCitations(packDir);
  const stampCommand = (guide?: string): string =>
    `'llm-docs guides stamp ${packId}${guide === undefined ? '' : ` ${guide}`}'`;

  if (assessment.kind === 'no-guides') {
    return [];
  }
  if (assessment.kind === 'invalid-lock') {
    return [
      {
        status: 'fail',
        path: CITATIONS_LOCK_PATH,
        message: `invalid citations lock (${assessment.message}); ${stampCommand()} rewrites it`,
      },
    ];
  }

  const findings: CheckFinding[] = [];

  for (const guide of assessment.guides) {
    if (guide.missing) {
      findings.push({
        status: 'warn',
        path: guide.path,
        message: `the guide no longer exists but the lock still records it; ${stampCommand()} drops the entry`,
      });
      continue;
    }

    const restamp = `re-review the guide, then ${stampCommand(guide.path)}`;

    if (guide.edited) {
      findings.push({
        status: 'warn',
        path: guide.path,
        message: `edited after stamping; ${restamp}`,
      });
    }

    for (const citation of guide.citations) {
      if (citation.state === 'section-changed') {
        const cited = citation.target.includes('#')
          ? 'section'
          : citation.target.startsWith('pages/')
            ? 'page'
            : 'file';
        findings.push({
          status: 'fail',
          path: guide.path,
          message: `${citation.target}: cited ${cited} changed since stamping; ${restamp}`,
        });
      } else if (citation.state === 'unresolved') {
        findings.push({
          status: 'fail',
          path: guide.path,
          message: `${citation.target}: citation no longer resolves (${UNRESOLVED_TEXT[citation.reason]}); fix the link and ${restamp}`,
        });
      }
    }
  }

  for (const path of assessment.unstamped) {
    findings.push({
      status: 'warn',
      path,
      message: `not stamped; after reviewing its citations, run ${stampCommand(path)}`,
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// The re-review list (refresh and sync)
// ---------------------------------------------------------------------------

/** Known after a rebuild: the cited section itself was recomputed. */
export type SectionChange = 'section-changed' | 'unresolved';
/** Known without building (`refresh --check`): only that the cited page's source moved. */
export type PageChange = 'page-changed' | 'page-removed';

export interface GuideReview<Change extends SectionChange | PageChange> {
  guide: string;
  citations: { target: string; change: Change }[];
}

/**
 * What the planner should re-review. The basis is in the type, so a printer
 * cannot present a page-level guess as a section-level fact.
 */
export type GuideReviewReport =
  | { basis: 'sections'; guides: GuideReview<SectionChange>[] }
  | { basis: 'pages'; guides: GuideReview<PageChange>[] };

/**
 * After a rebuild swapped in (the lock moved with `guides/`): the stamped
 * citations that no longer match, from the same recomputation `verify`
 * runs. Undefined when there is nothing to re-review.
 */
export async function reviewGuidesAfterBuild(
  packDir: string
): Promise<GuideReviewReport | undefined> {
  const assessment = await assessCitations(packDir);

  if (assessment.kind !== 'assessed') {
    return undefined;
  }

  const guides = assessment.guides.flatMap((guide): GuideReview<SectionChange>[] => {
    const citations = guide.missing
      ? []
      : guide.citations.flatMap((citation) =>
          citation.state === 'ok' ? [] : [{ target: citation.target, change: citation.state }]
        );
    return citations.length === 0 ? [] : [{ guide: guide.path, citations }];
  });

  return guides.length === 0 ? undefined : { basis: 'sections', guides };
}

/**
 * Under `refresh --check`, where nothing is built: the stamped citations of
 * guides still on disk whose cited file the refresh reports changed or
 * removed upstream, or reconverted by a new converter version (page level;
 * whether the cited section changed is known only after the rebuild).
 * Undefined when there is nothing to re-review.
 */
export async function reviewGuidesForRefreshCheck(
  packDir: string,
  refresh: RefreshReport
): Promise<GuideReviewReport | undefined> {
  const lock = await readCitationsLock(packDir);

  if (lock.kind !== 'ok') {
    return undefined;
  }

  const changed = new Map<string, PageChange>();
  for (const file of refresh.files) {
    if (file.status === 'changed' || file.status === 'removed') {
      changed.set(file.output, file.status === 'changed' ? 'page-changed' : 'page-removed');
    }
  }
  for (const conversion of refresh.converters) {
    if (!changed.has(conversion.output)) {
      changed.set(conversion.output, 'page-changed');
    }
  }

  const present = new Set(await listGuides(packDir));
  const guides = Object.keys(lock.lock.guides)
    .filter((path) => present.has(path))
    .sort(compareStringsByCodeUnit)
    .flatMap((path): GuideReview<PageChange>[] => {
      const citations = (lock.lock.guides[path]?.citations ?? []).flatMap(({ target }) => {
        const citation = parseTarget(target);
        const change = citation === undefined ? undefined : changed.get(citation.path);
        return change === undefined ? [] : [{ target, change }];
      });
      return citations.length === 0 ? [] : [{ guide: path, citations }];
    });

  return guides.length === 0 ? undefined : { basis: 'pages', guides };
}
