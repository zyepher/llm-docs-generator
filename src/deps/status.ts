import { compareStringsByCodeUnit } from '../utils/sort.js';
import {
  findDependencyVersion,
  normalizeDependencyName,
  type DependencyRef,
  type DependencyVersionLookup,
  type Ecosystem,
  type ResolvedDependency,
} from './lockfiles.js';
import { releaseKey, type ReleaseInfo } from './registries.js';

export type PackState = 'ok' | 'stale-pack' | 'recipe-changed' | 'missing' | 'orphan';

export interface PackStatusInput {
  id: string;
  /** The pack's version (manifest, else config); null when neither knows it yet. */
  version: string | null;
  dependency: DependencyRef | null;
  /** The config recipe resolves to a different recipeHash than the manifest records. */
  recipeChanged: boolean;
  /** A manifest exists on disk. */
  synced: boolean;
  /** llm-docs.json lists the pack. */
  inConfig: boolean;
}

export interface PackStatus {
  id: string;
  version: string | null;
  dependency: DependencyRef | null;
  state: PackState;
  /** What the lockfiles resolve for the bound dependency (packs with a dependency only). */
  lockfile?: DependencyVersionLookup;
}

export interface DependencyRelease {
  ecosystem: Ecosystem;
  name: string;
  version: string;
  publishedAt: string;
  dev: boolean;
  lockfiles: string[];
}

export interface StatusReport {
  packs: PackStatus[];
  cutoff: { cutoff: string; label: string } | null;
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
  cutoff?: { cutoff: string; label: string };
  nearCutoffDays: number;
  packs: PackStatusInput[];
  now: Date;
  /** Window for the no-cutoff `recent` list; default 180 days. */
  recentDays?: number;
}

const DEFAULT_RECENT_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;
const BRIEF_MAX_DEPENDENCIES = 8;

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

  if (!pack.synced) {
    return 'missing';
  }

  if (lookup?.kind === 'found' && lookup.version !== pack.version) {
    return 'stale-pack';
  }

  if (
    lookup?.kind === 'conflict' &&
    !lookup.versions.some((entry) => entry.version === pack.version)
  ) {
    return 'stale-pack';
  }

  return pack.recipeChanged ? 'recipe-changed' : 'ok';
}

function dependencyKey(ecosystem: Ecosystem, name: string): string {
  return `${ecosystem}:${normalizeDependencyName(ecosystem, name)}`;
}

/**
 * Join the dependency scan, the packs, release dates, and the cutoff. Pure:
 * every input (including the clock) is a parameter.
 */
export function computeStatus(input: ComputeStatusInput): StatusReport {
  const lockfiles = [...new Set(input.dependencies.map((dependency) => dependency.lockfile))];
  const scan = { dependencies: input.dependencies, lockfiles };
  const recentDays = input.recentDays ?? DEFAULT_RECENT_DAYS;

  const packs = input.packs
    .map((pack): PackStatus => {
      const lookup = pack.dependency ? findDependencyVersion(scan, pack.dependency) : undefined;
      return {
        id: pack.id,
        version: pack.version,
        dependency: pack.dependency,
        state: packState(pack, lookup),
        ...(lookup === undefined ? {} : { lockfile: lookup }),
      };
    })
    .sort((a, b) => compareStringsByCodeUnit(a.id, b.id));

  const boundDependencies = new Set(
    input.packs.flatMap((pack) =>
      pack.dependency ? [dependencyKey(pack.dependency.ecosystem, pack.dependency.name)] : []
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

  const dated: DependencyRelease[] = [];
  let unknownReleaseDates = 0;

  for (const [key, entry] of direct) {
    const publishedAt = input.releases.get(key)?.publishedAt ?? null;

    if (publishedAt === null || !Number.isFinite(Date.parse(publishedAt))) {
      unknownReleaseDates++;
      continue;
    }

    if (boundDependencies.has(dependencyKey(entry.dependency.ecosystem, entry.dependency.name))) {
      continue;
    }

    dated.push({
      ecosystem: entry.dependency.ecosystem,
      name: entry.dependency.name,
      version: entry.dependency.version,
      publishedAt,
      dev: entry.dev,
      lockfiles: [...entry.lockfiles].sort(compareStringsByCodeUnit),
    });
  }

  dated.sort(
    (a, b) =>
      compareStringsByCodeUnit(b.publishedAt, a.publishedAt) ||
      compareStringsByCodeUnit(a.ecosystem, b.ecosystem) ||
      compareStringsByCodeUnit(a.name, b.name) ||
      compareStringsByCodeUnit(a.version, b.version)
  );

  const afterCutoff: DependencyRelease[] = [];
  const nearCutoff: DependencyRelease[] = [];
  const recent: DependencyRelease[] = [];

  if (input.cutoff) {
    const end = cutoffEnd(input.cutoff.cutoff);
    const nearStart = end - input.nearCutoffDays * DAY_MS;

    for (const release of dated) {
      const time = Date.parse(release.publishedAt);

      if (time >= end) {
        afterCutoff.push(release);
      } else if (time >= nearStart) {
        nearCutoff.push(release);
      }
    }
  } else {
    const recentStart = input.now.getTime() - recentDays * DAY_MS;
    recent.push(...dated.filter((release) => Date.parse(release.publishedAt) >= recentStart));
  }

  return {
    packs,
    cutoff: input.cutoff ? { cutoff: input.cutoff.cutoff, label: input.cutoff.label } : null,
    afterCutoff,
    nearCutoff,
    recent,
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
  packsDir: string;
  /** The managed block is present in the agent file the harness reads. */
  blockPresent: boolean;
  /** Pack id -> project-relative path of its index.md, when it differs from `<packsDir>/<id>/index.md`. */
  packIndexPaths: Record<string, string>;
}

function releaseDay(publishedAt: string): string {
  return publishedAt.slice(0, 10);
}

function packStateReason(pack: PackStatus): string | undefined {
  switch (pack.state) {
    case 'stale-pack': {
      const lockfileVersion =
        pack.lockfile?.kind === 'found'
          ? pack.lockfile.version
          : pack.lockfile?.kind === 'conflict'
            ? pack.lockfile.versions.map((entry) => entry.version).join(' / ')
            : 'unknown';
      return `docs are for ${pack.version ?? 'an unknown version'} but the lockfile resolves ${lockfileVersion}`;
    }
    case 'missing':
      return 'configured but never built';
    case 'recipe-changed':
      return 'its recipe in llm-docs.json changed since the last build';
    default:
      return undefined;
  }
}

function dependencyLine(release: DependencyRelease, tag?: string): string {
  const suffix = tag ? `, ${tag}` : '';
  return `- ${release.name} ${release.version} (${release.ecosystem}, released ${releaseDay(release.publishedAt)}${suffix})`;
}

/**
 * The session-start hook text (spec 7.2): packs that need a rebuild with the
 * fix command; then direct dependencies newer than the model's training data
 * (or recently released, when no cutoff is known) that have no pack, newest
 * first, at most 8; then the pack list when the managed block is missing.
 * Empty when there is nothing to say. Capped at `maxChars` by dropping whole
 * lines from the end.
 */
export function formatStatusBrief(report: StatusReport, options: FormatStatusBriefOptions): string {
  const lines: string[] = [];
  const needsSync = report.packs.filter((pack) => packStateReason(pack) !== undefined);

  if (needsSync.length > 0) {
    lines.push('Pinned docs packs that need a rebuild:');

    for (const pack of needsSync) {
      lines.push(`- ${pack.id}: ${packStateReason(pack)}. Fix: \`llm-docs sync ${pack.id}\``);
    }
  }

  const flagged = report.cutoff
    ? [
        ...report.afterCutoff.map((release) => ({ release, tag: 'after cutoff' })),
        ...report.nearCutoff.map((release) => ({ release, tag: 'near cutoff' })),
      ].sort((a, b) => compareStringsByCodeUnit(b.release.publishedAt, a.release.publishedAt))
    : report.recent.map((release) => ({ release, tag: undefined }));

  if (flagged.length > 0) {
    if (lines.length > 0) {
      lines.push('');
    }

    lines.push(
      report.cutoff
        ? `Direct dependencies released after or close to your training data cutoff (${report.cutoff.label}, through ${report.cutoff.cutoff}) with no pinned docs, newest first:`
        : `Recently released dependencies (your training data may predate them), released in the last ${report.recentDays} days with no pinned docs, newest first:`
    );

    for (const { release, tag } of flagged.slice(0, BRIEF_MAX_DEPENDENCIES)) {
      lines.push(dependencyLine(release, tag));
    }

    if (flagged.length > BRIEF_MAX_DEPENDENCIES) {
      lines.push(`- and ${flagged.length - BRIEF_MAX_DEPENDENCIES} more (run \`llm-docs status\`)`);
    }

    lines.push(
      'Before using their APIs, read their current docs rather than relying on memory, or create a pinned docs pack with the `add-docs` skill.'
    );
  }

  const listedPacks = report.packs.filter(
    (pack) => pack.state !== 'missing' && pack.state !== 'orphan'
  );

  if (!options.blockPresent && listedPacks.length > 0) {
    if (lines.length > 0) {
      lines.push('');
    }

    lines.push(
      'Pinned reference docs in this repository (open the index and the page for the API you need before writing code against these libraries):'
    );

    for (const pack of listedPacks) {
      const indexPath =
        options.packIndexPaths[pack.id] ??
        `${options.packsDir.replace(/\/+$/, '')}/${pack.id}/index.md`;
      lines.push(`- ${pack.id}${pack.version ? ` ${pack.version}` : ''}: \`${indexPath}\``);
    }
  }

  return truncateLines(lines, options.maxChars);
}

function truncateLines(lines: string[], maxChars: number): string {
  const kept: string[] = [];
  let length = 0;

  for (const line of lines) {
    const added = (kept.length === 0 ? 0 : 1) + line.length;

    if (length + added > maxChars) {
      break;
    }

    kept.push(line);
    length += added;
  }

  while (kept.at(-1) === '') {
    kept.pop();
  }

  return kept.join('\n');
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
      return pack.lockfile.version;
    case 'conflict':
      return pack.lockfile.versions
        .map((entry) => `${entry.version} (${entry.lockfile})`)
        .join(', ');
    case 'missing':
      return 'not in any lockfile';
    default:
      return '-';
  }
}

function releaseRows(releases: DependencyRelease[]): string[] {
  return table([
    ['NAME', 'VERSION', 'ECOSYSTEM', 'RELEASED'],
    ...releases.map((release) => [
      release.name,
      release.version,
      release.ecosystem,
      releaseDay(release.publishedAt),
    ]),
  ]).map((line) => `  ${line}`);
}

/** The human `llm-docs status` report. */
export function formatStatusHuman(report: StatusReport): string {
  const lines: string[] = [];

  if (report.packs.length === 0) {
    lines.push('Packs: none configured.');
  } else {
    lines.push('Packs:');
    lines.push(
      ...table([
        ['ID', 'VERSION', 'DEPENDENCY', 'LOCKFILE', 'STATE'],
        ...report.packs.map((pack) => [
          pack.id,
          pack.version ?? '-',
          pack.dependency ? `${pack.dependency.ecosystem}:${pack.dependency.name}` : '-',
          lockfileSummary(pack),
          pack.state,
        ]),
      ]).map((line) => `  ${line}`)
    );
  }

  lines.push('');

  if (report.cutoff) {
    lines.push(`Model training data cutoff: ${report.cutoff.cutoff} (${report.cutoff.label}).`);
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

  if (report.afterCutoff.length + report.nearCutoff.length + report.recent.length > 0) {
    lines.push('');
    lines.push(
      'Next step: add a pack with `llm-docs add <id> --dependency <ecosystem>:<name> ...`.'
    );
  }

  lines.push('');
  lines.push(
    `${report.directDependencies} direct dependencies checked; ${report.unknownReleaseDates} with an unknown release date.`
  );

  return `${lines.join('\n')}\n`;
}
