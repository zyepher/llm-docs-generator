/**
 * The combined single-file layout (spec 4.9): `<id>.full.md` holds the index
 * and every page in index order, each page preceded by
 * `<!-- page: pages/... -->` and an anchor. Links between pages become
 * in-file anchors; links to files outside the combined text (passthrough
 * files, guides) become pack-root-relative paths, since the file sits at the
 * pack root.
 *
 * Anchors are unique across the file: each page gets a stable prefix derived
 * from its path (`pages/api/client.md` is `api-client`, with `-2`, `-3` for
 * paths that slug alike), and each of its headings gets
 * `<prefix>--<GitHub slug>` as an explicit HTML anchor.
 */

import { posix } from 'node:path';

import { compareIndexOrder } from './index-page.js';
import { encodeLinkPath } from './links.js';
import { findLinkTargets, headingAnchors, headingSlugs, scanMarkdownRegions } from './markdown.js';

const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

export interface CombinedInput {
  indexText: string;
  /** Every page output with its written text. */
  pages: readonly { path: string; text: string }[];
}

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function pagePrefix(path: string): string {
  const slug = path
    .replace(/^pages\//, '')
    .replace(/\.md$/i, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'page' : slug;
}

/**
 * Close a fence a page leaves open at its end, so it cannot swallow the pages
 * after it: probe with a trailing line and add closing fences until the probe
 * is outside code.
 */
function closeOpenFence(text: string): string {
  let closed = text;

  for (const fence of ['`'.repeat(32), '~'.repeat(32)]) {
    const probe = `${closed}\n\nprobe`;
    const last = scanMarkdownRegions(probe).at(-1);
    if (last?.kind !== 'fenced-code') {
      break;
    }
    closed = `${closed}\n${fence}`;
  }

  return closed;
}

/** Render the combined file. Deterministic for the same index and pages. */
export function renderCombinedPack(input: CombinedInput): string {
  const pages = [...input.pages].sort((a, b) => compareIndexOrder(a.path, b.path));
  const prefixes = new Map<string, string>();
  const taken = new Set<string>();

  for (const page of pages) {
    const base = pagePrefix(page.path);
    let prefix = base;
    for (let suffix = 2; taken.has(prefix); suffix += 1) {
      prefix = `${base}-${suffix}`;
    }
    taken.add(prefix);
    prefixes.set(page.path, prefix);
  }

  const slugs = new Map(
    pages.map((page) => [page.path, new Set(headingSlugs(page.text).map((h) => h.slug))])
  );
  const anchors = new Map(pages.map((page) => [page.path, headingAnchors(page.text)]));

  /** The in-file anchor for `fragment` (without `#`) of a page. */
  const anchorFor = (path: string, fragment: string): string | undefined => {
    const prefix = prefixes.get(path);
    if (prefix === undefined) {
      return undefined;
    }
    if (fragment === '') {
      return prefix;
    }
    if (slugs.get(path)?.has(fragment) === true) {
      return `${prefix}--${fragment}`;
    }
    // An HTML id the page defines itself is still in the file as written.
    return anchors.get(path)?.has(fragment) === true ? fragment : prefix;
  };

  const rewrite = (path: string, text: string): string => {
    let output = '';
    let cursor = 0;

    for (const link of findLinkTargets(text)) {
      const raw = link.target.trim();
      if (raw === '' || URL_SCHEME.test(raw) || raw.startsWith('//')) {
        continue;
      }

      const hash = raw.indexOf('#');
      const pathPart = (hash === -1 ? raw : raw.slice(0, hash)).replace(/\?.*$/, '');
      const fragment = hash === -1 ? '' : decodePath(raw.slice(hash + 1));
      let replacement: string | undefined;

      if (pathPart === '') {
        const anchor = prefixes.has(path) ? anchorFor(path, fragment) : undefined;
        replacement = anchor === undefined ? undefined : `#${anchor}`;
      } else {
        const resolved = posix.normalize(posix.join(posix.dirname(path), decodePath(pathPart)));
        const anchor = anchorFor(resolved, fragment);
        replacement =
          anchor !== undefined
            ? `#${anchor}`
            : resolved === '..' || resolved.startsWith('../')
              ? undefined
              : `${encodeLinkPath(resolved)}${hash === -1 ? '' : raw.slice(hash)}`;
      }

      if (replacement !== undefined && replacement !== link.target) {
        output += text.slice(cursor, link.start) + replacement;
        cursor = link.end;
      }
    }

    return output + text.slice(cursor);
  };

  /** Insert an explicit anchor line before every heading of a page. */
  const anchorHeadings = (path: string, text: string): string => {
    const prefix = prefixes.get(path) ?? '';
    let output = '';
    let cursor = 0;

    for (const heading of headingSlugs(text)) {
      output += `${text.slice(cursor, heading.offset)}<a id="${prefix}--${heading.slug}"></a>\n\n`;
      cursor = heading.offset;
    }

    return output + text.slice(cursor);
  };

  const parts = [rewrite('index.md', input.indexText).replace(/\n+$/, '')];

  for (const page of pages) {
    const body = anchorHeadings(page.path, rewrite(page.path, page.text)).replace(/\n+$/, '');
    parts.push(
      `<!-- page: ${page.path.replace(/-->/g, '--&gt;')} -->\n<a id="${prefixes.get(page.path) ?? ''}"></a>\n\n${closeOpenFence(body)}`
    );
  }

  return `${parts.join('\n\n')}\n`;
}
