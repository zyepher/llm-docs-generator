/**
 * The generated, verified `index.md` of a pack (spec 4.8). Deterministic:
 * everything it says comes from the manifest fields and, for read-first
 * targets with a fragment, the heading text of pages the manifest lists, with
 * upstream text escaped. It never enumerates the agent-owned guides, so a
 * guide change never changes the index, the combined file, or the manifest.
 */

import { compareStringsByCodeUnit } from '../utils/sort.js';
import type { ManifestOutputEntry, PackManifest } from './manifest.js';
import { redactUrl } from '../utils/url-credentials.js';

/** A `recipe.readFirst` target as the build resolved it against the pack's outputs. */
export interface ReadFirstLink {
  /** Pack-relative path of a page or passthrough file. */
  path: string;
  /** The heading slug the target names, or null for the whole file. */
  fragment: string | null;
  /** The page title, or the path for a file without one. */
  title: string;
  /** The text of the heading `fragment` names, or null. */
  heading: string | null;
}

export type IndexPageInput = Pick<
  PackManifest,
  'pack' | 'recipe' | 'origins' | 'acquiredAt' | 'license' | 'sources'
> & {
  /** Page outputs (kind `page`) with their titles and token estimates. */
  pages: readonly Pick<ManifestOutputEntry, 'path' | 'title' | 'tokens'>[];
  /** Passthrough outputs (kind `passthrough`) with their sizes. */
  files: readonly Pick<ManifestOutputEntry, 'path' | 'bytes'>[];
  /** `recipe.readFirst` resolved, in recipe order; empty when the recipe marks none. */
  readFirst: readonly ReadFirstLink[];
};

const TITLE_CAP = 120;
/** Past this many passthrough files, the Files section groups them by top-level directory. */
const UNGROUPED_FILES_MAX = 20;

/** Escape upstream text for one Markdown table cell or list line. */
export function escapeIndexText(value: string): string {
  const cleaned = value
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const capped = cleaned.length > TITLE_CAP ? `${cleaned.slice(0, TITLE_CAP - 3)}...` : cleaned;
  return capped
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/([[\]<>])/g, '\\$1');
}

/** A pack-relative path as a link destination: each segment percent-encoded. */
export function linkPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function githubRepo(repo: string): string | undefined {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(repo);
  return match?.[1];
}

function describeOrigins(input: IndexPageInput): string {
  return input.origins.map((origin, index) => describeOrigin(input, origin, index)).join('; ');
}

function describeOrigin(
  input: IndexPageInput,
  origin: IndexPageInput['origins'][number],
  index: number
): string {
  switch (origin.type) {
    case 'git': {
      const short = origin.commit.slice(0, 12);
      const repo = githubRepo(origin.repo);
      const commit =
        repo === undefined
          ? `commit ${short}`
          : `commit [${short}](https://github.com/${repo}/commit/${origin.commit})`;
      const name =
        repo === undefined ? redactUrl(origin.repo) : `[${repo}](https://github.com/${repo})`;
      return `the git repository ${name} at ${commit} (${origin.refKind} ${escapeIndexText(origin.ref)})`;
    }
    case 'llms-txt':
      return `the index ${redactUrl(origin.url)}`;
    case 'urls': {
      const count = input.sources.filter((entry) => entry.source === index).length;
      return `${count} listed URL${count === 1 ? '' : 's'}`;
    }
    case 'local': {
      const host =
        origin.hostCommit === null
          ? ''
          : ` (host repository commit ${origin.hostCommit.slice(0, 12)}${origin.hostDirty === true ? ', with uncommitted changes' : ''})`;
      return `the project folder \`${origin.path}\`${host}`;
    }
  }
}

function describeLicense(license: IndexPageInput['license']): string {
  if (license.status === 'proprietary') {
    return 'License: proprietary (declared in llm-docs.json); check the terms before redistributing.';
  }

  if (license.declared !== null) {
    return `License: ${escapeIndexText(license.declared)} (declared in llm-docs.json).`;
  }

  if (license.detected !== null) {
    return `License: ${escapeIndexText(license.detected.spdx)} (detected from ${escapeIndexText(license.detected.evidence)}).`;
  }

  return 'License: unknown; check the upstream terms before redistributing these pages.';
}

/** The top-level directory of a path under `pages/` or `files/`, '' for one directly inside. */
function groupOf(path: string): string {
  const inside = path.slice(path.indexOf('/') + 1);
  const slash = inside.indexOf('/');
  return slash === -1 ? '' : inside.slice(0, slash);
}

/** Entries by `groupOf`, groups in code-unit order and each group sorted by path. */
function groupByDirectory<T extends { path: string }>(entries: readonly T[]): [string, T[]][] {
  const groups = new Map<string, T[]>();

  for (const entry of entries) {
    const group = groupOf(entry.path);
    groups.set(group, [...(groups.get(group) ?? []), entry]);
  }

  return [...groups.keys()]
    .sort(compareStringsByCodeUnit)
    .map((group) => [
      group,
      [...(groups.get(group) ?? [])].sort((a, b) => compareStringsByCodeUnit(a.path, b.path)),
    ]);
}

function groupHeading(group: string): string {
  return `### ${group === '' ? 'Top level' : escapeIndexText(group)}`;
}

/** The order pages appear in the index (and the combined file): by top-level group, then path. */
export function compareIndexOrder(a: string, b: string): number {
  return compareStringsByCodeUnit(groupOf(a), groupOf(b)) || compareStringsByCodeUnit(a, b);
}

export function renderIndexPage(input: IndexPageInput): string {
  const { pack } = input;
  const lines: string[] = [
    `# ${escapeIndexText(pack.title)} ${escapeIndexText(pack.version)}`,
    '',
    `Pinned reference docs for ${escapeIndexText(pack.title)} ${escapeIndexText(pack.version)}, acquired on ${input.acquiredAt.slice(0, 10)} from ${describeOrigins(input)}. ${describeLicense(input.license)}`,
    '',
    '## How to read this pack',
    '',
    'Open the page for the API you need and read it before writing code against it. Search `pages/` for exact symbol names. Pages are upstream text at the pinned version. Guides, when this pack has any, are the digests in `guides/` written for this project: they link into the pages and never outrank them.',
  ];

  if (input.readFirst.length > 0) {
    lines.push(
      '',
      '## Read first',
      '',
      `Start with these pages before writing code against ${escapeIndexText(pack.title)} ${escapeIndexText(pack.version)}. They were marked as the ones to read first for this version, usually because they describe what changed.`,
      ''
    );
    for (const entry of input.readFirst) {
      const label =
        entry.heading === null
          ? escapeIndexText(entry.title)
          : `${escapeIndexText(entry.title)}: ${escapeIndexText(entry.heading)}`;
      const target =
        entry.fragment === null
          ? linkPath(entry.path)
          : `${linkPath(entry.path)}#${entry.fragment}`;
      lines.push(`- [${label}](${target})`);
    }
  }

  lines.push('', '## Pages');

  for (const [group, pages] of groupByDirectory(input.pages)) {
    lines.push('', groupHeading(group), '', '| Page | Title | Tokens |', '| --- | --- | --- |');

    for (const page of pages) {
      const label = escapeIndexText(page.path.slice('pages/'.length));
      lines.push(
        `| [${label}](${linkPath(page.path)}) | ${escapeIndexText(page.title ?? '')} | ${page.tokens ?? 0} |`
      );
    }
  }

  if (input.files.length > 0) {
    lines.push(
      '',
      '## Files',
      '',
      'These files are byte-identical copies of the upstream files, kept as they are rather than converted to pages.'
    );
    const fileLine = (file: IndexPageInput['files'][number]): string =>
      `- [${escapeIndexText(file.path.slice('files/'.length))}](${linkPath(file.path)}) (${file.bytes} bytes)`;
    const groups: [string | null, readonly IndexPageInput['files'][number][]][] =
      input.files.length > UNGROUPED_FILES_MAX
        ? groupByDirectory(input.files)
        : [[null, [...input.files].sort((a, b) => compareStringsByCodeUnit(a.path, b.path))]];

    for (const [group, files] of groups) {
      lines.push('', ...(group === null ? [] : [groupHeading(group), '']), ...files.map(fileLine));
    }
  }

  return `${lines.join('\n')}\n`;
}
