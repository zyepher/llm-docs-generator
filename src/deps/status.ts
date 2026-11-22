/**
 * `llm-docs status` (spec 6.4) and the facts the session-start hook injects
 * (spec 7.2). `gatherProjectStatus` is the one I/O entry point; it feeds the
 * pure `computeStatus`, and the formatters render its report for a person
 * (`formatStatusHuman`) or an agent (`formatStatusBrief`).
 */

import {
  CONFIG_FILE_NAME,
  ConfigError,
  resolvePackRecipe,
  type DependencyVersionResolver,
  type LoadedProjectConfig,
} from '../config/project.js';
import { readProjectPacks, type ProjectPack } from '../pack/manifest.js';
import { compareStringsByCodeUnit } from '../utils/sort.js';
import {
  resolveModelCutoff,
  resolveModelIdFromEnvironment,
  type ModelCutoff,
  type ModelIdentity,
} from './cutoffs.js';
import {
  dependencyKey,
  findDependencyVersion,
  majorVersionsDiffer,
  normalizeDependencyName,
  projectDependencies,
  type DependencyRef,
  type DependencyScan,
  type DependencyVersionLookup,
  type Ecosystem,
  type ResolvedDependency,
  type UnreadLockfile,
} from './lockfiles.js';
import {
  lookupReleaseDates,
  releaseKey,
  type RegistryEndpoints,
  type ReleaseInfo,
  type ReleaseQuery,
} from './registries.js';

export type PackState =
  | 'ok'
  | 'stale-pack'
  | 'lockfile-conflict'
  | 'not-in-lockfile'
  | 'lockfile-unread'
  | 'recipe-changed'
  | 'missing'
  | 'orphan';

/**
 * Where a release date falls for the model in use: after its cutoff month,
 * within `nearCutoffDays` before the end of it, or, when no cutoff is known,
 * within `recentDays` of now.
 */
export type ReleaseWindow = 'after-cutoff' | 'near-cutoff' | 'recent';

export interface PackStatusInput {
  id: string;
  title: string;
  /** The pack's version (manifest, else config); null when neither knows it yet. */
  version: string | null;
  dependency: DependencyRef | null;
  /** llm-docs.json sets `version` explicitly, so a lockfile bump alone does not move the pack. */
  versionPinned: boolean;
  /** The config recipe resolves to a different recipeHash than the manifest records. */
  recipeChanged: boolean;
  /** Project-relative POSIX path of the built pack's index.md; null when it was never built. */
  indexPath: string | null;
  /**
   * The built pack's `recipe.readFirst` as project-relative targets (a
   * `#fragment` kept), in recipe order; empty when it marks none.
   */
  readFirst: string[];
  /** Other packages the docs also describe (`covers`), which bind no version. */
  covers: DependencyRef[];
  /** llm-docs.json lists the pack. */
  inConfig: boolean;
}

/** A package a pack covers, at a version the lockfiles resolve for it. */
export interface CoveredDependency {
  ecosystem: Ecosystem;
  name: string;
  version: string;
  lockfiles: string[];
  publishedAt: string | null;
  releaseWindow: ReleaseWindow | null;
  /** Its major version differs from the pack's, so the pack may describe another release line. */
  majorDiffers: boolean;
}

export interface PackStatus {
  id: string;
  title: string;
  version: string | null;
  dependency: DependencyRef | null;
  state: PackState;
  /** What the lockfiles resolve for the bound dependency (packs with a dependency only). */
  lockfile?: DependencyVersionLookup;
  indexPath: string | null;
  /** Project-relative read-first targets of the built pack, in recipe order (spec 4.8). */
  readFirst: string[];
  /** Each covered package at each version the lockfiles resolve; one absent from them is left out. */
  covered: CoveredDependency[];
  /** When the pack's version of its bound dependency was released, when known. */
  publishedAt: string | null;
  /** Set when that release is newer than the model's training data, or close to it. */
  releaseWindow: ReleaseWindow | null;
  /** What brings the pack back to `ok`; null when it is `ok`. */
  nextStep: string | null;
}

export interface DependencyRelease {
  ecosystem: Ecosystem;
  name: string;
  version: string;
  publishedAt: string;
  dev: boolean;
  lockfiles: string[];
  /** The read-only evidence command for pinning its docs (the engine never picks a source). */
  nextStep: string;
}

/** The cutoff release dates are compared against, and how sure status is of it. */
export interface StatusCutoff {
  cutoff: string;
  label: string;
  source: ModelCutoff['source'];
  /**
   * The cutoff is the table's for a model read from a settings-file default,
   * which a session can override unseen: the note states it as an assumption.
   */
  assumed: boolean;
}

export interface StatusReport {
  /** Sorted by id. */
  packs: PackStatus[];
  /** The model compared against and where its id came from, or null when none is known. */
  model: ModelIdentity | null;
  cutoff: StatusCutoff | null;
  /** Direct dependencies without a pack, released after the cutoff month, newest first. */
  afterCutoff: DependencyRelease[];
  /** Released within `nearCutoffDays` before the end of the cutoff month, newest first. */
  nearCutoff: DependencyRelease[];
  /**
   * Only when no cutoff resolved: direct dependencies without a pack released
   * within `recentDays` of `now`, newest first. A statement about release
   * dates, not a guess about the model.
   */
  recent: DependencyRelease[];
  recentDays: number;
  /** Distinct direct (ecosystem, name, version) entries considered. */
  directDependencies: number;
  /** Of those, how many have no known release date; never counted as after-cutoff. */
  unknownReleaseDates: number;
}

export interface ComputeStatusInput {
  dependencies: ResolvedDependency[];
  releases: Map<string, ReleaseInfo>;
  model?: ModelIdentity;
  cutoff?: StatusCutoff;
  nearCutoffDays: number;
  packs: PackStatusInput[];
  now: Date;
  /** Window for the no-cutoff `recent` list; default 180 days. */
  recentDays?: number;
  /** Lockfiles the scan found but did not read; a pack bound through one is `lockfile-unread`. */
  unread?: UnreadLockfile[];
}

const DEFAULT_RECENT_DAYS = 180;
const DEFAULT_NEAR_CUTOFF_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const BRIEF_MAX_DEPENDENCIES = 8;
/** Read-first paths a brief row names; the index links the rest. */
const BRIEF_MAX_READ_FIRST = 2;

/** First instant after the cutoff month (`YYYY-MM` means through the end of that month). */
function cutoffEnd(cutoff: string): number {
  const [year, month] = cutoff.split('-').map(Number);

  if (
    year === undefined ||
    month === undefined ||
    !Number.isInteger(year) ||
    !Number.isInteger(month)
  ) {
    throw new Error(`Invalid cutoff "${cutoff}": expected YYYY-MM.`);
  }

  return Date.UTC(year, month, 1);
}

function packState(pack: PackStatusInput, lookup: DependencyVersionLookup | undefined): PackState {
  if (!pack.inConfig) {
    return 'orphan';
  }

  if (pack.indexPath === null) {
    return 'missing';
  }

  switch (lookup?.kind) {
    case 'found':
      if (lookup.version !== pack.version) {
        return 'stale-pack';
      }
      break;
    case 'conflict':
      return lookup.versions.some((entry) => entry.version === pack.version)
        ? 'lockfile-conflict'
        : 'stale-pack';
    case 'missing':
      return 'not-in-lockfile';
    case 'unread':
      return 'lockfile-unread';
    case undefined:
      break;
  }

  return pack.recipeChanged ? 'recipe-changed' : 'ok';
}

const MESSAGE_TEXT_CAP = 200;

/**
 * The one escape for text a lockfile, a manifest, a registry response, or
 * config supplies, applied where it is placed into the session note or the
 * status report: one line, no backtick (a code span around it stays closed),
 * no raw angle bracket (no HTML comment or block marker), capped. `@` stays:
 * neither the note nor the report is an agent file that imports `@path`.
 */
function messageText(value: string): string {
  const escaped = value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/`/g, '')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\s+/g, ' ')
    .trim();
  const characters = Array.from(escaped);
  return characters.length <= MESSAGE_TEXT_CAP
    ? escaped
    : `${characters
        .slice(0, MESSAGE_TEXT_CAP - 3)
        .join('')
        .replace(/&(?:lt?|gt?)?$/, '')}...`;
}

/** A name or path shown exactly, as a code span, once messageText made it safe to. */
function codeSpan(value: string): string {
  return `\`${messageText(value)}\``;
}

function dependencyLabel(dependency: DependencyRef): string {
  return `${dependency.ecosystem}:${messageText(dependency.name)}`;
}

/**
 * The step that brings a pack back to `ok`: a command when one command does
 * it, otherwise an instruction. An explicit `version` wins over the lockfile
 * at sync (spec 2.4), so a pinned stale pack needs its config edited first.
 */
function packNextStep(
  pack: PackStatusInput,
  state: PackState,
  lookup: DependencyVersionLookup | undefined
): string | null {
  const id = messageText(pack.id);
  const sync = `llm-docs sync ${id}`;
  const dependency = pack.dependency === null ? 'the dependency' : dependencyLabel(pack.dependency);

  switch (state) {
    case 'ok':
      return null;
    case 'orphan':
      return `run 'llm-docs sync --prune' to delete it, or add packs.${id} back to ${CONFIG_FILE_NAME}`;
    case 'stale-pack':
      if (pack.versionPinned) {
        const to = lookup?.kind === 'found' ? ` to ${messageText(lookup.version)}` : '';
        return `set packs.${id}.version in ${CONFIG_FILE_NAME}${to} (or remove it to follow the lockfile), then run '${sync}'`;
      }
      return sync;
    case 'lockfile-conflict':
      return pack.versionPinned
        ? `make the lockfiles agree on one version of ${dependency}, or add a pack for each version they resolve`
        : `set packs.${id}.version in ${CONFIG_FILE_NAME} to the version these docs describe, then run '${sync}'`;
    case 'not-in-lockfile':
      return `install ${dependency} so a lockfile resolves it, or remove packs.${id}.dependency from ${CONFIG_FILE_NAME}`;
    case 'lockfile-unread': {
      const unread =
        lookup?.kind === 'unread'
          ? lookup.lockfiles.map((entry) => `${messageText(entry.lockfile)} ${entry.reason}`)
          : [];
      return `check by hand that the lockfiles resolve ${dependency} to ${messageText(pack.version ?? 'the pack version')}: ${unread.join('; ')}`;
    }
    case 'recipe-changed':
    case 'missing':
      return sync;
  }
}

/** The `discover --package` spec; a SwiftPM package is named by its repository URL. */
function discoverCommand(dependency: ResolvedDependency): string {
  const repository = dependency.repositoryUrl;
  const name =
    dependency.ecosystem === 'swiftpm' &&
    repository !== undefined &&
    URL.canParse(repository) &&
    new URL(repository).username === ''
      ? repository
      : dependency.name;
  return `llm-docs discover --package ${dependency.ecosystem}:${messageText(name)}@${messageText(dependency.version)}`;
}

function releaseQuery(dependency: DependencyRef, version: string): ReleaseQuery {
  return {
    ecosystem: dependency.ecosystem,
    name: normalizeDependencyName(dependency.ecosystem, dependency.name),
    version,
  };
}

/** The release a pack's docs describe: its version of its bound dependency. */
function packReleaseQuery(pack: PackStatusInput): ReleaseQuery | undefined {
  return pack.dependency === null || pack.version === null
    ? undefined
    : releaseQuery(pack.dependency, pack.version);
}

/** The versions the lockfiles resolve for a dependency, each with the lockfiles that say so. */
function resolvedVersions(
  scan: Pick<DependencyScan, 'dependencies' | 'lockfiles' | 'unread'>,
  dependency: DependencyRef
): { version: string; lockfiles: string[] }[] {
  const lookup = findDependencyVersion(scan, dependency);

  switch (lookup.kind) {
    case 'found':
      return [{ version: lookup.version, lockfiles: lookup.lockfiles }];
    case 'missing':
    case 'unread':
      return [];
    case 'conflict': {
      const byVersion = new Map<string, string[]>();
      for (const entry of lookup.versions) {
        byVersion.set(entry.version, [...(byVersion.get(entry.version) ?? []), entry.lockfile]);
      }
      return [...byVersion].map(([version, lockfiles]) => ({
        version,
        lockfiles: lockfiles.sort(compareStringsByCodeUnit),
      }));
    }
  }
}

/**
 * Join the dependency scan, the packs, release dates, and the cutoff. Pure:
 * every input (including the clock) is a parameter.
 */
export function computeStatus(input: ComputeStatusInput): StatusReport {
  const lockfiles = [...new Set(input.dependencies.map((dependency) => dependency.lockfile))];
  const scan = { dependencies: input.dependencies, lockfiles, unread: input.unread ?? [] };
  const recentDays = input.recentDays ?? DEFAULT_RECENT_DAYS;
  const end = input.cutoff === undefined ? undefined : cutoffEnd(input.cutoff.cutoff);

  const windowOf = (publishedAt: string): ReleaseWindow | null => {
    const time = Date.parse(publishedAt);

    if (end === undefined) {
      return time >= input.now.getTime() - recentDays * DAY_MS ? 'recent' : null;
    }
    if (time >= end) {
      return 'after-cutoff';
    }
    return time >= end - input.nearCutoffDays * DAY_MS ? 'near-cutoff' : null;
  };
  const datedRelease = (query: ReleaseQuery | undefined): string | null => {
    const publishedAt =
      query === undefined ? null : (input.releases.get(releaseKey(query))?.publishedAt ?? null);
    return publishedAt !== null && Number.isFinite(Date.parse(publishedAt)) ? publishedAt : null;
  };

  const packs = input.packs
    .map((pack): PackStatus => {
      const lookup = pack.dependency ? findDependencyVersion(scan, pack.dependency) : undefined;
      const state = packState(pack, lookup);
      const publishedAt = datedRelease(packReleaseQuery(pack));
      const covered = pack.covers.flatMap((dependency) =>
        resolvedVersions(scan, dependency).map(({ version, lockfiles }): CoveredDependency => {
          const released = datedRelease(releaseQuery(dependency, version));
          return {
            ecosystem: dependency.ecosystem,
            name: dependency.name,
            version,
            lockfiles,
            publishedAt: released,
            releaseWindow: released === null ? null : windowOf(released),
            majorDiffers: pack.version !== null && majorVersionsDiffer(version, pack.version),
          };
        })
      );

      return {
        id: pack.id,
        title: pack.title,
        version: pack.version,
        dependency: pack.dependency,
        state,
        ...(lookup === undefined ? {} : { lockfile: lookup }),
        indexPath: pack.indexPath,
        readFirst: pack.readFirst,
        covered,
        publishedAt,
        releaseWindow: publishedAt === null ? null : windowOf(publishedAt),
        nextStep: packNextStep(pack, state, lookup),
      };
    })
    .sort((a, b) => compareStringsByCodeUnit(a.id, b.id));

  // A covered package has a pack too: its docs are pinned, just not at a version of their own.
  const boundDependencies = new Set(
    input.packs.flatMap((pack) =>
      [...(pack.dependency ? [pack.dependency] : []), ...pack.covers].map(dependencyKey)
    )
  );

  const direct = new Map<
    string,
    { dependency: ResolvedDependency; dev: boolean; lockfiles: Set<string> }
  >();

  for (const dependency of input.dependencies) {
    if (!dependency.direct) {
      continue;
    }

    const key = releaseKey(dependency);
    const existing = direct.get(key);

    if (existing) {
      existing.dev = existing.dev && dependency.dev;
      existing.lockfiles.add(dependency.lockfile);
    } else {
      direct.set(key, {
        dependency,
        dev: dependency.dev,
        lockfiles: new Set([dependency.lockfile]),
      });
    }
  }

  const dated: { release: DependencyRelease; window: ReleaseWindow | null }[] = [];
  let unknownReleaseDates = 0;

  for (const entry of direct.values()) {
    const publishedAt = datedRelease(entry.dependency);

    if (publishedAt === null) {
      unknownReleaseDates++;
      continue;
    }

    if (boundDependencies.has(dependencyKey(entry.dependency))) {
      continue;
    }

    dated.push({
      release: {
        ecosystem: entry.dependency.ecosystem,
        name: entry.dependency.name,
        version: entry.dependency.version,
        publishedAt,
        dev: entry.dev,
        lockfiles: [...entry.lockfiles].sort(compareStringsByCodeUnit),
        nextStep: discoverCommand(entry.dependency),
      },
      window: windowOf(publishedAt),
    });
  }

  dated.sort(
    ({ release: a }, { release: b }) =>
      compareStringsByCodeUnit(b.publishedAt, a.publishedAt) ||
      compareStringsByCodeUnit(a.ecosystem, b.ecosystem) ||
      compareStringsByCodeUnit(a.name, b.name) ||
      compareStringsByCodeUnit(a.version, b.version)
  );

  const inWindow = (window: ReleaseWindow): DependencyRelease[] =>
    dated.filter((entry) => entry.window === window).map((entry) => entry.release);

  return {
    packs,
    model: input.model ?? null,
    cutoff: input.cutoff ?? null,
    afterCutoff: inWindow('after-cutoff'),
    nearCutoff: inWindow('near-cutoff'),
    recent: inWindow('recent'),
    recentDays,
    directDependencies: direct.size,
    unknownReleaseDates,
  };
}

// ============================================================================
// Rendering
// ============================================================================

export interface FormatStatusBriefOptions {
  maxChars: number;
}

const WINDOW_TAG: Readonly<Record<ReleaseWindow, string | undefined>> = {
  'after-cutoff': 'after cutoff',
  'near-cutoff': 'near cutoff',
  recent: undefined,
};

function releaseDay(publishedAt: string): string {
  return messageText(publishedAt.slice(0, 10));
}

function packStateReason(pack: PackStatus): string | undefined {
  const version = messageText(pack.version ?? 'an unknown version');
  const name = pack.dependency === null ? 'its dependency' : codeSpan(pack.dependency.name);

  switch (pack.state) {
    case 'stale-pack': {
      const lockfileVersion =
        pack.lockfile?.kind === 'found'
          ? pack.lockfile.version
          : pack.lockfile?.kind === 'conflict'
            ? pack.lockfile.versions.map((entry) => entry.version).join(' / ')
            : 'unknown';
      return `docs are for ${version} but the lockfile resolves ${messageText(lockfileVersion)}`;
    }
    case 'lockfile-conflict': {
      const versions =
        pack.lockfile?.kind === 'conflict'
          ? pack.lockfile.versions
              .map((entry) => `${messageText(entry.version)} in ${codeSpan(entry.lockfile)}`)
              .join(', ')
          : 'unknown';
      return `the lockfiles resolve ${name} to different versions (${versions}); docs are for ${version}`;
    }
    case 'not-in-lockfile':
      return `no lockfile resolves ${name}, so nothing checks that docs for ${version} match what the project uses`;
    case 'missing':
      return 'not built or invalid';
    case 'recipe-changed':
      return 'its recipe in llm-docs.json changed since the last build';
    default:
      return undefined;
  }
}

/** A brief row, and the shorter form it takes before any row is dropped for the budget. */
interface BriefRow {
  full: string;
  short: string;
}

/** One item of the brief; rows past `maxRows`, or past the character budget, become a count. */
interface BriefSection {
  heading: string;
  rows: BriefRow[];
  maxRows: number;
  footer: string[];
}

/** The section with its first `shown` rows, the last `shortened` of those in their short form. */
function renderSection(section: BriefSection, shown: number, shortened: number): string[] {
  const hidden = section.rows.length - shown;
  return [
    section.heading,
    ...section.rows
      .slice(0, shown)
      .map((row, index) => (index >= shown - shortened ? row.short : row.full)),
    ...(hidden > 0 ? [`- and ${hidden} more (run \`llm-docs status\`)`] : []),
    ...section.footer,
  ];
}

/**
 * The shapes a section takes as the budget tightens, widest first: every row
 * whole, then rows shortened from the last one up, then rows dropped from the
 * last one up (all of them short by then).
 */
function sectionCandidates(section: BriefSection): string[][] {
  const wanted = Math.min(section.rows.length, section.maxRows);
  const candidates: string[][] = [];

  for (let shortened = 0; shortened <= wanted; shortened += 1) {
    candidates.push(renderSection(section, wanted, shortened));
  }
  for (let shown = wanted - 1; shown >= 0; shown -= 1) {
    candidates.push(renderSection(section, shown, shown));
  }

  return candidates;
}

function sameRow(text: string): BriefRow {
  return { full: text, short: text };
}

/**
 * The read-first paths a brief row names: fragments dropped (the agent opens
 * files), repeats merged, the first two in recipe order. A path that block
 * escaping would alter is left out rather than shown altered, since an altered
 * path leads nowhere; the index still links it.
 */
function briefReadFirst(targets: readonly string[]): string[] {
  const paths = targets
    .map((target) => target.replace(/#.*$/, ''))
    .filter((path) => messageText(path) === path);
  return [...new Set(paths)].slice(0, BRIEF_MAX_READ_FIRST);
}

/**
 * The first three items of the session-start text (spec 7.2): packs to fix,
 * each with its fix; built packs whose library version is newer than the
 * model's training data (or close to it), with where their pages are (their
 * read-first pages, then the index); and direct dependencies in that window
 * without a pack, at most 8. Newest first. Empty when there is nothing to
 * say. Over `maxChars`, text goes from the bottom up: the last item's rows
 * first (read-first paths before whole rows), a cut list ending with how many
 * more there are, and an item that cannot keep even its heading is dropped
 * with everything below it. The hook appends the pack list after this.
 */
export function formatStatusBrief(report: StatusReport, options: FormatStatusBriefOptions): string {
  const sections: BriefSection[] = [];
  const rebuild = report.packs.flatMap((pack) => {
    const reason = packStateReason(pack);
    const fix = pack.nextStep?.startsWith('llm-docs ') ? `\`${pack.nextStep}\`` : pack.nextStep;
    return reason === undefined ? [] : [`- ${messageText(pack.id)}: ${reason}. Fix: ${fix}`];
  });

  if (rebuild.length > 0) {
    sections.push({
      heading: 'Pinned docs packs to fix:',
      rows: rebuild.map(sameRow),
      maxRows: rebuild.length,
      footer: [],
    });
  }

  // One row per pack, dated by the newest release among its own version and the covered
  // packages the lockfiles resolve, so a pack covering a newer package is listed once.
  const pinned = report.packs
    .flatMap((pack) => {
      const newest = [
        { publishedAt: pack.publishedAt, window: pack.releaseWindow },
        ...pack.covered.map((entry) => ({
          publishedAt: entry.publishedAt,
          window: entry.releaseWindow,
        })),
      ]
        .flatMap(({ publishedAt, window }) =>
          publishedAt === null || window === null ? [] : [{ publishedAt, window }]
        )
        .sort((a, b) => compareStringsByCodeUnit(b.publishedAt, a.publishedAt))[0];
      return pack.state !== 'orphan' &&
        newest !== undefined &&
        pack.indexPath !== null &&
        pack.version !== null
        ? [{ pack, version: pack.version, ...newest }]
        : [];
    })
    .sort((a, b) => compareStringsByCodeUnit(b.publishedAt, a.publishedAt));

  const cutoff = report.cutoff;
  // A cutoff reached through a settings-file default is an assumption: each heading that
  // names it says so, and the first one says what to do when the assumption is wrong.
  const assumption =
    cutoff?.assumed === true
      ? `Assuming your model is the configured default (${messageText(cutoff.label)}, cutoff ${messageText(cutoff.cutoff)})`
      : undefined;
  const judge = 'If you are a different model, judge by the release dates shown.';

  if (pinned.length > 0) {
    const lead =
      cutoff === null
        ? `Pinned docs for libraries released in the last ${report.recentDays} days. Your training data may predate these versions:`
        : assumption === undefined
          ? `Pinned docs for libraries released after or close to your training data cutoff (${messageText(cutoff.label)}, through ${messageText(cutoff.cutoff)}). Your memory of these libraries predates these versions:`
          : `${assumption}: pinned docs for libraries released after or close to that cutoff. ${judge} Your memory of these libraries predates these versions:`;
    sections.push({
      heading: `${lead} read the pinned pages before writing code against them. Newest first:`,
      rows: pinned.map(({ pack, version, publishedAt, window }) => {
        const tag = WINDOW_TAG[window];
        const lead = `- ${messageText(pack.title)} ${messageText(version)} (released ${releaseDay(publishedAt)}${tag ? `, ${tag}` : ''}): `;
        const index = codeSpan(pack.indexPath ?? '');
        const short = `${lead}${index}`;
        const readFirst = briefReadFirst(pack.readFirst);
        return readFirst.length === 0
          ? sameRow(short)
          : {
              full: `${lead}read ${readFirst.map(codeSpan).join(' and ')} first, then ${index}`,
              short,
            };
      }),
      maxRows: pinned.length,
      footer: [],
    });
  }

  const flagged = cutoff
    ? [
        ...report.afterCutoff.map((release) => ({ release, tag: 'after cutoff' })),
        ...report.nearCutoff.map((release) => ({ release, tag: 'near cutoff' })),
      ].sort((a, b) => compareStringsByCodeUnit(b.release.publishedAt, a.release.publishedAt))
    : report.recent.map((release) => ({ release, tag: undefined }));

  if (flagged.length > 0) {
    sections.push({
      heading:
        cutoff === null
          ? `Recently released dependencies (your training data may predate them), released in the last ${report.recentDays} days with no pinned docs, newest first:`
          : assumption === undefined
            ? `Direct dependencies released after or close to your training data cutoff (${messageText(cutoff.label)}, through ${messageText(cutoff.cutoff)}) with no pinned docs, newest first:`
            : `${assumption}: direct dependencies released after or close to that cutoff with no pinned docs${pinned.length === 0 ? `. ${judge} Newest first:` : ', newest first:'}`,
      rows: flagged.map(({ release, tag }) => {
        const suffix = tag ? `, ${tag}` : '';
        return sameRow(
          `- ${codeSpan(release.name)} ${messageText(release.version)} (${release.ecosystem}, released ${releaseDay(release.publishedAt)}${suffix})`
        );
      }),
      maxRows: BRIEF_MAX_DEPENDENCIES,
      footer: [
        'Before using their APIs, read their current docs rather than relying on memory, or create a pinned docs pack with the `add-docs` skill.',
      ],
    });
  }

  let lines: string[] = [];

  for (const section of sections) {
    const prefix = lines.length === 0 ? [] : [...lines, ''];
    const candidates = sectionCandidates(section).map((rendered) => [...prefix, ...rendered]);
    const fit = candidates.findIndex(
      (candidate) => candidate.join('\n').length <= options.maxChars
    );
    const chosen = candidates[fit];

    if (chosen === undefined) {
      break;
    }
    lines = chosen;
    // A section that had to shrink leaves no room for the items below it.
    if (fit > 0) {
      break;
    }
  }

  return lines.join('\n');
}

function table(rows: string[][]): string[] {
  const widths: number[] = [];

  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  }

  return rows.map((row) =>
    row
      .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)))
      .join('  ')
      .trimEnd()
  );
}

function lockfileSummary(pack: PackStatus): string {
  switch (pack.lockfile?.kind) {
    case 'found':
      return messageText(pack.lockfile.version);
    case 'conflict':
      return pack.lockfile.versions
        .map((entry) => `${messageText(entry.version)} (${messageText(entry.lockfile)})`)
        .join(', ');
    case 'missing':
      return 'not in any lockfile';
    case 'unread':
      return 'lockfile not read';
    default:
      return '-';
  }
}

function released(release: {
  publishedAt: string | null;
  releaseWindow: ReleaseWindow | null;
}): string {
  if (release.publishedAt === null) {
    return '-';
  }
  const tag = release.releaseWindow === null ? undefined : WINDOW_TAG[release.releaseWindow];
  return `${releaseDay(release.publishedAt)}${tag ? ` (${tag})` : ''}`;
}

/** The line under a pack row for a package it covers, with a note when the major differs. */
function coveredLine(pack: PackStatus, entry: CoveredDependency): string {
  const note = entry.majorDiffers
    ? `; note: its major version differs from the pack's ${messageText(pack.version ?? '')}, so the pack may not describe this version`
    : '';
  const when = entry.publishedAt === null ? 'release date unknown' : `released ${released(entry)}`;
  return `    covers ${dependencyLabel(entry)} ${messageText(entry.version)}, ${when}${note}`;
}

function releaseRows(releases: DependencyRelease[]): string[] {
  return table([
    ['NAME', 'VERSION', 'ECOSYSTEM', 'RELEASED', 'NEXT'],
    ...releases.map((release) => [
      messageText(release.name),
      messageText(release.version),
      release.ecosystem,
      releaseDay(release.publishedAt),
      release.nextStep,
    ]),
  ]).map((line) => `  ${line}`);
}

const MODEL_SOURCE_TEXT: Readonly<Record<ModelIdentity['source'], string>> = {
  payload: 'reported by the session',
  flag: '--model',
  env: 'ANTHROPIC_MODEL',
  settings: 'assumed from a settings file',
};

/** The human `llm-docs status` report. */
export function formatStatusHuman(report: StatusReport): string {
  const lines: string[] = [];

  if (report.packs.length === 0) {
    lines.push('Packs: none configured.');
  } else {
    const [header = '', ...rows] = table([
      ['ID', 'VERSION', 'DEPENDENCY', 'LOCKFILE', 'STATE', 'RELEASED', 'READ FIRST', 'NEXT'],
      ...report.packs.map((pack) => [
        messageText(pack.id),
        messageText(pack.version ?? '-'),
        pack.dependency ? dependencyLabel(pack.dependency) : '-',
        lockfileSummary(pack),
        pack.state,
        released(pack),
        pack.readFirst.length === 0 ? '-' : String(pack.readFirst.length),
        pack.nextStep ?? '-',
      ]),
    ]);
    lines.push('Packs:', `  ${header}`);
    report.packs.forEach((pack, index) => {
      lines.push(
        `  ${rows[index] ?? ''}`,
        ...pack.covered.map((entry) => coveredLine(pack, entry))
      );
    });
  }

  lines.push('');

  if (report.model !== null) {
    lines.push(
      `Model: ${messageText(report.model.id)} (${MODEL_SOURCE_TEXT[report.model.source]}).`
    );
    if (report.model.source === 'settings') {
      lines.push(
        `  This is the default in ${messageText(report.model.file)}; a session started with another model differs. Pass --model to name it.`
      );
    }
  }

  if (report.cutoff) {
    lines.push(
      `Model training data cutoff: ${messageText(report.cutoff.cutoff)} (${messageText(report.cutoff.label)})${report.cutoff.assumed ? ', assuming that default' : ''}.`
    );
    lines.push('');
    lines.push(
      report.afterCutoff.length === 0
        ? 'Direct dependencies released after the cutoff without a pack: none.'
        : 'Direct dependencies released after the cutoff without a pack:'
    );

    if (report.afterCutoff.length > 0) {
      lines.push(...releaseRows(report.afterCutoff));
    }

    if (report.nearCutoff.length > 0) {
      lines.push('');
      lines.push('Released shortly before the cutoff (coverage may be thin), without a pack:');
      lines.push(...releaseRows(report.nearCutoff));
    }
  } else {
    lines.push(
      'Model training data cutoff: unknown (pass --model or --cutoff, or set model.cutoff in llm-docs.json).'
    );
    lines.push('');
    lines.push(
      report.recent.length === 0
        ? `Direct dependencies released in the last ${report.recentDays} days without a pack: none.`
        : `Direct dependencies released in the last ${report.recentDays} days without a pack:`
    );

    if (report.recent.length > 0) {
      lines.push(...releaseRows(report.recent));
    }
  }

  lines.push('');
  lines.push(
    `${report.directDependencies} direct dependencies checked; ${report.unknownReleaseDates} with an unknown release date.`
  );

  return `${lines.join('\n')}\n`;
}

// ============================================================================
// Gathering
// ============================================================================

/**
 * A project as status sees it: a root, and its config when there is one.
 * Status and the hook both work before a project adopts packs.
 */
export interface ProjectContext {
  projectRoot: string;
  loaded: LoadedProjectConfig | null;
}

export interface GatherStatusOptions {
  /** Cache only, no request. */
  offline: boolean;
  /** Network budget for missing release dates; unbounded when absent (the `status` command). */
  budgetMs?: number;
  /** `--model`, or the hook payload's model. Falls back to resolveModelIdFromEnvironment. */
  model?: { id: string; source: 'payload' | 'flag' };
  /** `--cutoff YYYY-MM`. A malformed value is a ConfigError (exit 2). */
  cutoff?: string;
  /**
   * The hook's policy for a malformed `--cutoff`, `model.cutoff`, or
   * LLM_DOCS_MODEL_CUTOFF: report it here and go on with the next source.
   * Without it, a malformed value is a ConfigError, for a person to fix.
   */
  ignoreInvalidCutoff?: (problem: string) => void;
  env: NodeJS.ProcessEnv;
  homeDir: string;
  cacheDir: string;
  now: Date;
  /** Stops the dependency scan and the release-date lookup (the hook's deadline). */
  signal?: AbortSignal;
  /** Tests point the registries at a local server. */
  endpoints?: Partial<RegistryEndpoints>;
  /** Largest lockfile the scan reads (the hook's is small enough for its deadline). */
  maxLockfileBytes?: number;
}

export interface ProjectStatus {
  projectRoot: string;
  loaded: LoadedProjectConfig | null;
  /** The packs read for this report, so the hook renders its pack list without reading them again. */
  packs: readonly ProjectPack[];
  report: StatusReport;
  /** The model status compared against, after every fallback, and where its id came from. */
  model: ModelIdentity | null;
  cutoff: ModelCutoff | null;
  /**
   * Release dates this run could not get only because it ran out of time or
   * hit a transport error (not because the registry has none), plus one per
   * lockfile it left unread (over its size cap, or past the deadline), whose
   * dependencies' dates it never asked for. Above zero, a background
   * warm-up, a `status` run without the hook's limits, helps the next session.
   */
  pendingReleaseDates: number;
  /** Scan, cache, and lookup warnings, sorted. */
  warnings: string[];
}

async function packStatusInput(
  loaded: LoadedProjectConfig,
  pack: ProjectPack,
  resolveDependencyVersion: DependencyVersionResolver
): Promise<PackStatusInput> {
  const config = pack.inConfig ? loaded.config.packs[pack.id] : undefined;
  const manifest = pack.manifest.kind === 'ok' ? pack.manifest.manifest : undefined;
  let recipeChanged = false;

  if (config !== undefined && manifest !== undefined) {
    try {
      const resolved = await resolvePackRecipe(loaded.config, pack.id, {
        resolveDependencyVersion,
      });
      recipeChanged = resolved.recipeHash !== manifest.recipeHash;
    } catch (error) {
      // A lockfile that no longer resolves the dependency shows in the LOCKFILE column instead.
      if (!(error instanceof ConfigError)) {
        throw error;
      }
    }
  }

  return {
    id: pack.id,
    title: manifest?.pack.title ?? config?.title ?? pack.id,
    version: manifest?.pack.version ?? config?.version ?? null,
    dependency: manifest?.dependency ?? config?.dependency ?? null,
    versionPinned: config?.version !== undefined,
    recipeChanged,
    indexPath: manifest === undefined ? null : `${loaded.packsDirRelative}/${pack.id}/index.md`,
    readFirst: (manifest?.recipe.readFirst ?? []).map(
      (target) => `${loaded.packsDirRelative}/${pack.id}/${target}`
    ),
    covers: manifest?.recipe.covers ?? config?.covers ?? [],
    inConfig: pack.inConfig,
  };
}

/**
 * Everything computeStatus needs, from one lazy dependency scan: the packs
 * and whether their recipes moved, the cutoff (`--cutoff`, config
 * `model.cutoff`, LLM_DOCS_MODEL_CUTOFF, then the table match for the model
 * id from `--model`, the payload, or the environment), and the release dates
 * of direct dependencies and of each bound pack's version. Throws only for
 * an unreadable project (I/O) or, without `ignoreInvalidCutoff`, a malformed
 * cutoff (ConfigError).
 */
export async function gatherProjectStatus(
  project: ProjectContext,
  options: GatherStatusOptions
): Promise<ProjectStatus> {
  const { projectRoot, loaded } = project;
  const dependencies = projectDependencies(projectRoot, {
    ...(loaded === null ? {} : { skipDirectories: [loaded.packsDirRelative] }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.maxLockfileBytes === undefined
      ? {}
      : { maxLockfileBytes: options.maxLockfileBytes }),
  });
  const model =
    resolveModelIdFromEnvironment({
      ...(options.model === undefined ? {} : { stated: options.model }),
      env: options.env,
      projectRoot,
      homeDir: options.homeDir,
    }) ?? null;
  const configCutoff = loaded?.config.model?.cutoff;
  const cutoff =
    resolveModelCutoff({
      ...(model === null ? {} : { modelId: model.id }),
      ...(options.cutoff === undefined ? {} : { override: options.cutoff }),
      ...(configCutoff === undefined ? {} : { configCutoff }),
      ...(options.ignoreInvalidCutoff === undefined
        ? {}
        : { ignoreInvalid: options.ignoreInvalidCutoff }),
      env: options.env,
    }) ?? null;

  const [scan, packs] = await Promise.all([
    dependencies.scan(),
    loaded === null ? [] : readProjectPacks(loaded),
  ]);
  const packInputs =
    loaded === null
      ? []
      : await Promise.all(
          packs.map((pack) => packStatusInput(loaded, pack, dependencies.resolveVersion))
        );

  const queries = new Map<string, ReleaseQuery>();
  for (const dependency of scan.dependencies) {
    if (dependency.direct) {
      queries.set(releaseKey(dependency), dependency);
    }
  }
  for (const input of packInputs) {
    if (input.indexPath === null) {
      continue;
    }
    const own = packReleaseQuery(input);
    const covered = input.covers.flatMap((dependency) =>
      resolvedVersions(scan, dependency).map(({ version }) => releaseQuery(dependency, version))
    );
    for (const query of [...(own === undefined ? [] : [own]), ...covered]) {
      if (!queries.has(releaseKey(query))) {
        queries.set(releaseKey(query), query);
      }
    }
  }

  const lookup = await lookupReleaseDates([...queries.values()], {
    offline: options.offline,
    cacheDir: options.cacheDir,
    now: () => options.now,
    ...(options.budgetMs === undefined ? {} : { budgetMs: options.budgetMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.endpoints === undefined ? {} : { endpoints: options.endpoints }),
  });
  const pendingReleaseDates =
    [...queries.keys()].filter((key) => {
      const source = lookup.releases.get(key)?.source;
      return source === 'budget' || source === 'error';
    }).length + scan.unread.length;

  const report = computeStatus({
    dependencies: scan.dependencies,
    releases: lookup.releases,
    ...(model === null ? {} : { model }),
    ...(cutoff === null
      ? {}
      : {
          cutoff: {
            cutoff: cutoff.cutoff,
            label: cutoff.label,
            source: cutoff.source,
            assumed: cutoff.source === 'table' && model?.source === 'settings',
          },
        }),
    nearCutoffDays: loaded?.config.hook?.nearCutoffDays ?? DEFAULT_NEAR_CUTOFF_DAYS,
    packs: packInputs,
    now: options.now,
    unread: scan.unread,
  });

  return {
    projectRoot,
    loaded,
    packs,
    report,
    model,
    cutoff,
    pendingReleaseDates,
    warnings: [...new Set([...scan.warnings, ...lookup.warnings])].sort(compareStringsByCodeUnit),
  };
}
