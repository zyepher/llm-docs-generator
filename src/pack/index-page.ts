/**
 * The generated, verified `index.md` of a pack (spec 4.8). Deterministic:
 * everything it says comes from the manifest fields and the guide list, in
 * sorted order, with upstream text escaped.
 */

import { compareStringsByCodeUnit } from '../utils/sort.js';
import type { ManifestOutputEntry, PackManifest } from './manifest.js';

export interface IndexGuide {
  /** Pack-relative POSIX path (`guides/...`). */
  path: string;
  title: string;
}

export type IndexPageInput = Pick<
  PackManifest,
  'pack' | 'recipe' | 'origins' | 'acquiredAt' | 'license' | 'sources'
> & {
  /** Page outputs (kind `page`) with their titles and token estimates. */
  pages: readonly Pick<ManifestOutputEntry, 'path' | 'title' | 'tokens'>[];
  guides: readonly IndexGuide[];
};

const TITLE_CAP = 120;

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
  const parts = input.origins.map((origin, index) => {
    switch (origin.type) {
      case 'git': {
        const short = origin.commit.slice(0, 12);
        const repo = githubRepo(origin.repo);
        const commit =
          repo === undefined
            ? `commit ${short}`
            : `commit [${short}](https://github.com/${repo}/commit/${origin.commit})`;
        const name = repo === undefined ? origin.repo : `[${repo}](https://github.com/${repo})`;
        return `the git repository ${name} at ${commit} (${origin.refKind} ${escapeIndexText(origin.ref)})`;
      }
      case 'llms-txt':
        return `the index ${origin.url}`;
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
  });

  return parts.join('; ');
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

function groupOf(path: string): string {
  const inside = path.slice('pages/'.length);
  const slash = inside.indexOf('/');
  return slash === -1 ? '' : inside.slice(0, slash);
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
    'Open the page for the API you need and read it before writing code against it. Search `pages/` for exact symbol names. Pages are upstream text at the pinned version; guides are digests written for this project and never outrank pages.',
  ];

  if (input.guides.length > 0) {
    lines.push('', '## Guides', '');
    for (const guide of [...input.guides].sort((a, b) =>
      compareStringsByCodeUnit(a.path, b.path)
    )) {
      lines.push(`- [${escapeIndexText(guide.title)}](${linkPath(guide.path)})`);
    }
  }

  lines.push('', '## Pages');

  const groups = new Map<string, IndexPageInput['pages'][number][]>();

  for (const page of input.pages) {
    const group = groupOf(page.path);
    groups.set(group, [...(groups.get(group) ?? []), page]);
  }

  for (const group of [...groups.keys()].sort(compareStringsByCodeUnit)) {
    const pages = [...(groups.get(group) ?? [])].sort((a, b) =>
      compareStringsByCodeUnit(a.path, b.path)
    );
    lines.push(
      '',
      `### ${group === '' ? 'Top level' : escapeIndexText(group)}`,
      '',
      '| Page | Title | Tokens |',
      '| --- | --- | --- |'
    );

    for (const page of pages) {
      const label = escapeIndexText(page.path.slice('pages/'.length));
      lines.push(
        `| [${label}](${linkPath(page.path)}) | ${escapeIndexText(page.title ?? '')} | ${page.tokens ?? 0} |`
      );
    }
  }

  return `${lines.join('\n')}\n`;
}
