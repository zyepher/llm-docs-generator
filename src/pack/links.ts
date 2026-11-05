/**
 * Link rewriting for pack pages (spec 4.5). Every link destination outside
 * code that `findLinkTargets` reports (inline links, images, reference
 * definitions, autolinks, raw HTML `href`/`src`) is resolved in this order:
 *
 * 1. A fragment-only target stays as written.
 * 2. A relative path that names another file of the pack (exactly, or as a
 *    route: `.md`/`.mdx`/`.html` extension or a trailing `/index` dropped)
 *    becomes the relative path from this page to that file's output, with
 *    its fragment.
 * 3. A site-absolute path (`/x/y`), or an absolute URL on `site.baseUrl` (or
 *    on an http-acquired page's own URL), is matched against the pages' site
 *    paths after `site.aliases`; a miss becomes `baseUrl + path`.
 * 4. A relative path that leaves the pack goes upstream: resolved against the
 *    page's URL for http sources, pinned to a blob URL at the recorded commit
 *    for GitHub repositories, or mapped onto `site.baseUrl` for a page that
 *    exists in a local source but was not selected.
 * 5. Anything still unresolved is recorded and turned into plain text,
 *    `[label] (unresolved: target)`, so a pack never holds a dead local link
 *    (verify fails on one).
 *
 * Paths are POSIX throughout, whatever the platform.
 */

import { posix } from 'node:path';

import { compareStringsByCodeUnit } from '../utils/sort.js';
import type { ManifestOrigin } from './manifest.js';
import {
  findLinkTargets,
  type LinkRewriter,
  type LinkRewriteResult,
  type LinkTarget,
  type PackFileRef,
  type PackLinkContext,
} from './markdown.js';

const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const ROUTE_EXTENSION = /\.(?:md|mdx|markdown|html?|rst)$/i;
const GITHUB_BLOB_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([0-9a-f]{40})\/(.+)$/;

/** The route a path names: trailing slashes, a page extension, and a trailing `index` dropped. */
export function routeKey(path: string): string {
  const trimmed = path.replace(/\/+$/, '').replace(ROUTE_EXTENSION, '');
  return trimmed === 'index' ? '' : trimmed.replace(/\/index$/, '');
}

/** True for a path whose last segment is an index page (`index`, `index.md`, ...). */
function isIndexPath(path: string): boolean {
  return /(?:^|\/)index(?:\.[^/]*)?$/i.test(path);
}

/** A site path (`/x/y`) reduced to its route, always with a leading slash. */
function siteRoute(path: string): string {
  return `/${routeKey(path.replace(/^\/+/, ''))}`;
}

function escapesUpward(path: string): boolean {
  return path === '..' || path.startsWith('../');
}

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** A POSIX path as a link destination: each segment percent-encoded, parentheses included. */
export function encodeLinkPath(path: string): string {
  return path
    .split('/')
    .map((segment) =>
      segment === '.' || segment === '..'
        ? segment
        : encodeURIComponent(segment).replace(
            /[()]/g,
            (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
          )
    )
    .join('/');
}

/** The relative link from one pack file to another. */
function relativeOutputLink(fromOutput: string, toOutput: string): string {
  return encodeLinkPath(posix.relative(posix.dirname(fromOutput), toOutput));
}

function parseGithubRemote(repo: string): { owner: string; name: string } | undefined {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(repo);
  return match?.[1] === undefined || match[2] === undefined
    ? undefined
    : { owner: match[1], name: match[2] };
}

function parseUrl(value: string, base?: string): URL | undefined {
  try {
    return new URL(value, base);
  } catch {
    return undefined;
  }
}

type Decision =
  | { kind: 'keep'; external: boolean }
  | { kind: 'replace'; target: string; external: boolean }
  | { kind: 'plain'; reason: string };

/** A path in one address space: `local` (project paths, shared by local sources) or one other source. */
interface Located {
  space: string;
  path: string;
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

function key(space: string, path: string): string {
  return `${space}\u0000${path}`;
}

function pushTo<T>(map: Map<string, T[]>, mapKey: string, value: T): void {
  const list = map.get(mapKey);
  if (list === undefined) {
    map.set(mapKey, [value]);
  } else {
    list.push(value);
  }
}

/**
 * The page a route names when several do (`api.md` and `api/index.md`): the
 * index page for a directory-style target, else the non-index page, then
 * by output path.
 */
function pickRoute(
  candidates: readonly PackFileRef[] | undefined,
  preferIndex: boolean
): PackFileRef | undefined {
  if (candidates === undefined || candidates.length === 0) {
    return undefined;
  }
  return [...candidates].sort((a, b) => {
    const rank = (ref: PackFileRef): number =>
      isIndexPath(ref.sourcePath) === preferIndex ? 0 : 1;
    return rank(a) - rank(b) || compareStringsByCodeUnit(a.outputPath, b.outputPath);
  })[0];
}

/**
 * Normalize an alias map: keys and values are site paths with a leading
 * slash and no trailing slash; the longest matching prefix wins.
 */
function compileAliases(aliases: Readonly<Record<string, string>>): (path: string) => string {
  const normalize = (path: string): string => `/${path.replace(/^\/+|\/+$/g, '')}`;
  const entries = Object.entries(aliases)
    .map(([from, to]) => [normalize(from), normalize(to)] as const)
    .sort(([a], [b]) => b.length - a.length || compareStringsByCodeUnit(a, b));

  return (path) => {
    for (const [from, to] of entries) {
      if (from === '/' || path === from || path.startsWith(`${from}/`)) {
        const rest = from === '/' ? path : path.slice(from.length);
        return `${to}${rest}`.replace(/\/{2,}/g, '/');
      }
    }
    return path;
  };
}

function isHttpOrigin(origin: ManifestOrigin | undefined): boolean {
  return origin?.type === 'urls' || origin?.type === 'llms-txt';
}

/**
 * The rewriter for one pack build (spec 4.5). Pure and synchronous: every
 * decision comes from the context, never from the file system or network.
 */
export function createPackLinkRewriter(context: PackLinkContext): LinkRewriter {
  const { recipe, origins } = context;
  const site = recipe.site;
  const baseUrl = site === null ? undefined : parseUrl(site.baseUrl);
  const basePath = baseUrl === undefined ? '' : baseUrl.pathname.replace(/\/+$/, '');
  const applyAliases = compileAliases(site?.aliases ?? {});

  /** Directory of each local source's files, project-relative ('' for the project root). */
  const localBases = new Map<number, string>();
  for (const ref of [...context.pages, ...context.passthrough]) {
    if (ref.localPath !== undefined && !localBases.has(ref.sourceIndex)) {
      const base = ref.localPath.endsWith(ref.sourcePath)
        ? ref.localPath.slice(0, ref.localPath.length - ref.sourcePath.length)
        : '';
      localBases.set(ref.sourceIndex, base.replace(/\/+$/, ''));
    }
  }

  const localBase = (sourceIndex: number): string => {
    const known = localBases.get(sourceIndex);
    if (known !== undefined) {
      return known;
    }
    const source = recipe.sources[sourceIndex];
    return source?.type === 'local' ? source.path.replace(/^\.$/, '') : '';
  };

  /** Address space and path of an origin-relative file of `sourceIndex`. */
  const locate = (sourceIndex: number, sourcePath: string): Located =>
    origins[sourceIndex]?.type === 'local'
      ? { space: 'local', path: posix.join(localBase(sourceIndex), sourcePath) }
      : { space: `source:${sourceIndex}`, path: sourcePath };

  const located = (ref: PackFileRef): Located =>
    ref.localPath === undefined
      ? locate(ref.sourceIndex, ref.sourcePath)
      : { space: 'local', path: ref.localPath };

  const files = new Map<string, PackFileRef>();
  const routes = new Map<string, PackFileRef[]>();
  const siteFiles = new Map<string, PackFileRef>();
  const sitePages = new Map<string, PackFileRef[]>();
  const urlFiles = new Map<string, PackFileRef>();
  const urlPages = new Map<string, PackFileRef[]>();

  const urlKey = (url: URL, path: string): string => `${url.origin}${path}`;

  for (const ref of context.passthrough) {
    const at = located(ref);
    files.set(key(at.space, at.path), ref);
    siteFiles.set(`/${ref.sourcePath}`, ref);
    const url = ref.url === undefined ? undefined : parseUrl(ref.url);
    if (url !== undefined && isHttpOrigin(origins[ref.sourceIndex])) {
      urlFiles.set(urlKey(url, decodePath(url.pathname)), ref);
    }
  }

  for (const ref of context.pages) {
    const at = located(ref);
    files.set(key(at.space, at.path), ref);
    pushTo(routes, key(at.space, routeKey(at.path)), ref);
    const url = ref.url === undefined ? undefined : parseUrl(ref.url);

    if (url !== undefined && isHttpOrigin(origins[ref.sourceIndex])) {
      const pathname = decodePath(url.pathname);
      pushTo(urlPages, urlKey(url, siteRoute(pathname)), ref);
      pushTo(sitePages, siteRoute(pathname), ref);
    } else {
      pushTo(sitePages, siteRoute(ref.sourcePath), ref);
    }
  }

  const inventory = new Set<string>();
  const inventoryRoutes = new Set<string>();

  for (const [sourceIndex, paths] of (context.inventories ?? []).entries()) {
    for (const path of paths ?? []) {
      const at = locate(sourceIndex, path);
      inventory.add(key(at.space, at.path));
      // Directories count as present too: a link may name a folder of pages.
      for (let dir = posix.dirname(at.path); dir !== '.' && dir !== ''; dir = posix.dirname(dir)) {
        inventory.add(key(at.space, dir));
      }
      if (ROUTE_EXTENSION.test(path)) {
        inventoryRoutes.add(key(at.space, routeKey(at.path)));
      }
    }
  }

  /** A pack file named by a site path (aliases applied), or undefined. */
  const findBySitePath = (sitePath: string, preferIndex: boolean): PackFileRef | undefined => {
    const aliased = applyAliases(sitePath);
    return siteFiles.get(aliased) ?? pickRoute(sitePages.get(siteRoute(aliased)), preferIndex);
  };

  const inPack = (page: PackFileRef, target: PackFileRef, fragment: string): Decision => ({
    kind: 'replace',
    target: `${relativeOutputLink(page.outputPath, target.outputPath)}${fragment}`,
    external: false,
  });

  /**
   * An absolute http(s) URL: in-pack when it names an acquired file, else
   * kept as written (`asWritten`) or written out as the upstream URL.
   */
  const resolveUrl = (
    page: PackFileRef,
    url: URL,
    fragment: string,
    asWritten: boolean
  ): Decision => {
    const pathname = decodePath(url.pathname);
    const preferIndex = pathname.endsWith('/');

    if (
      baseUrl !== undefined &&
      url.origin === baseUrl.origin &&
      (pathname === basePath || pathname.startsWith(`${basePath}/`))
    ) {
      const hit = findBySitePath(pathname.slice(basePath.length) || '/', preferIndex);
      if (hit !== undefined) {
        return inPack(page, hit, fragment);
      }
    }

    const hit =
      urlFiles.get(urlKey(url, pathname)) ??
      pickRoute(urlPages.get(urlKey(url, siteRoute(pathname))), preferIndex);

    if (hit !== undefined) {
      return inPack(page, hit, fragment);
    }

    if (asWritten) {
      return { kind: 'keep', external: true };
    }

    url.hash = '';
    return { kind: 'replace', target: `${url.href}${fragment}`, external: true };
  };

  /** Step 4: the upstream URL of a relative target that is not in the pack. */
  const resolveUpstream = (
    page: PackFileRef,
    target: { decoded: string; joined: string; escapes: boolean; space: string },
    fragment: string
  ): Decision => {
    const origin = origins[page.sourceIndex];

    if (origin?.type === 'git') {
      const blob = page.url === undefined ? null : GITHUB_BLOB_URL.exec(page.url);
      const remote = parseGithubRemote(origin.repo);
      const owner = blob?.[1] ?? remote?.owner;
      const name = blob?.[2] ?? remote?.name;
      const commit = blob?.[3] ?? origin.commit;
      const pagePath = blob?.[4] === undefined ? page.sourcePath : decodePath(blob[4]);

      if (owner === undefined || name === undefined) {
        return { kind: 'plain', reason: 'outside-pack-non-github-remote' };
      }

      const repoPath = posix.normalize(posix.join(posix.dirname(pagePath), target.decoded));
      if (escapesUpward(repoPath) || repoPath === '.') {
        return { kind: 'plain', reason: 'outside-repository' };
      }

      return {
        kind: 'replace',
        target: `https://github.com/${owner}/${name}/blob/${commit}/${encodeLinkPath(repoPath.replace(/\/+$/, ''))}${fragment}`,
        external: true,
      };
    }

    if (target.escapes) {
      return { kind: 'plain', reason: 'outside-source' };
    }

    const base = target.space === 'local' ? localBase(page.sourceIndex) : '';
    const withinSource =
      base === '' ? target.joined : posix.relative(base, target.joined).replace(/^\.$/, '');
    const exists =
      inventory.has(key(target.space, target.joined)) ||
      inventoryRoutes.has(key(target.space, routeKey(target.joined)));

    if (!exists) {
      return {
        kind: 'plain',
        reason: escapesUpward(withinSource) ? 'outside-source' : 'not-found',
      };
    }

    const routeLike = ROUTE_EXTENSION.test(target.joined) || !/\.[^/]*$/.test(target.joined);

    if (baseUrl !== undefined && routeLike && !escapesUpward(withinSource)) {
      const route = routeKey(withinSource);
      return {
        kind: 'replace',
        target: `${baseUrl.href.replace(/\/+$/, '')}/${encodeLinkPath(route)}${fragment}`,
        external: true,
      };
    }

    return { kind: 'plain', reason: 'not-in-pack' };
  };

  const decide = (page: PackFileRef, written: string): Decision => {
    const raw = written.trim();

    if (raw === '' || raw.startsWith('#')) {
      return { kind: 'keep', external: false };
    }

    const hash = raw.indexOf('#');
    const fragment = hash === -1 ? '' : raw.slice(hash);
    const withQuery = hash === -1 ? raw : raw.slice(0, hash);

    if (URL_SCHEME.test(raw) || raw.startsWith('//')) {
      const url = raw.startsWith('//')
        ? parseUrl(`https:${raw}`)
        : /^https?:/i.test(raw)
          ? parseUrl(raw)
          : undefined;
      return url === undefined
        ? { kind: 'keep', external: true }
        : resolveUrl(page, url, fragment, true);
    }

    const pathPart = withQuery.replace(/\?.*$/, '');
    const decoded = decodePath(pathPart);
    const origin = origins[page.sourceIndex];
    const pageUrl = page.url === undefined ? undefined : parseUrl(page.url);

    // Pages fetched over http resolve every non-absolute target in URL space.
    if (isHttpOrigin(origin) && pageUrl !== undefined) {
      const url = parseUrl(withQuery, pageUrl.href);
      return url === undefined
        ? { kind: 'plain', reason: 'malformed' }
        : resolveUrl(page, url, fragment, false);
    }

    const preferIndex = decoded.endsWith('/') || decoded === '' || /(?:^|\/)\.\.?$/.test(decoded);

    if (decoded.startsWith('/')) {
      const hit = findBySitePath(decoded, preferIndex);
      if (hit !== undefined) {
        return inPack(page, hit, fragment);
      }
      if (baseUrl !== undefined) {
        return {
          kind: 'replace',
          target: `${baseUrl.href.replace(/\/+$/, '')}${withQuery}${fragment}`,
          external: true,
        };
      }
      return { kind: 'plain', reason: 'site-absolute-without-base-url' };
    }

    const at = located(page);
    const joined = posix.normalize(posix.join(posix.dirname(at.path), decoded));
    const escapes = escapesUpward(joined);

    if (!escapes) {
      const normalized = joined === '.' ? '' : joined.replace(/\/+$/, '');
      const hit =
        files.get(key(at.space, normalized)) ??
        pickRoute(routes.get(key(at.space, routeKey(normalized))), preferIndex);

      if (hit !== undefined) {
        return inPack(page, hit, fragment);
      }
    }

    return resolveUpstream(
      page,
      {
        decoded,
        joined: joined === '.' ? '' : joined.replace(/\/+$/, ''),
        escapes,
        space: at.space,
      },
      fragment
    );
  };

  // The input names its page by output path; the context knows its URL and project path.
  const byOutput = new Map(context.pages.map((ref) => [ref.outputPath, ref]));

  return (input) => {
    const known = byOutput.get(input.outputPath);
    const page: PackFileRef = {
      sourceIndex: input.sourceIndex,
      sourcePath: input.sourcePath,
      outputPath: input.outputPath,
      url: input.url ?? known?.url,
      localPath: input.localPath ?? known?.localPath,
    };
    const primary = findLinkTargets(input.text, { mdx: input.mdx });
    // verify reads pages with Markdown rules; an MDX page also gets the links
    // only those rules see, so nothing verify checks escapes rewriting.
    const targets = input.mdx ? withMarkdownOnlyTargets(input.text, primary) : primary;
    const result: LinkRewriteResult = {
      text: input.text,
      rewritten: 0,
      external: 0,
      unresolved: [],
      plainTextConversions: 0,
    };
    const edits: Edit[] = [];

    for (const target of targets) {
      const decision = decide(page, target.target);

      switch (decision.kind) {
        case 'keep':
          result.external += decision.external ? 1 : 0;
          break;
        case 'replace':
          result.external += decision.external ? 1 : 0;
          if (decision.target !== target.target) {
            result.rewritten += 1;
            edits.push({ start: target.start, end: target.end, text: decision.target });
          }
          break;
        case 'plain':
          result.plainTextConversions += 1;
          result.unresolved.push({ target: target.target, reason: decision.reason });
          edits.push(...plainTextEdits(input.text, target));
          break;
      }
    }

    result.text = applyEdits(input.text, edits);
    return result;
  };
}

/** Add the targets a Markdown-rules scan finds that the MDX scan did not, when they overlap none. */
function withMarkdownOnlyTargets(text: string, primary: readonly LinkTarget[]): LinkTarget[] {
  const overlaps = (a: LinkTarget, b: LinkTarget): boolean =>
    a.span.start < b.span.end && b.span.start < a.span.end;
  const extra = findLinkTargets(text).filter(
    (candidate) => !primary.some((target) => overlaps(target, candidate))
  );
  return [...primary, ...extra].sort((a, b) => a.start - b.start);
}

/**
 * Edits that turn a link into plain text, `[label] (unresolved: target)`,
 * without touching its label (which may hold other links being rewritten).
 */
function plainTextEdits(text: string, target: LinkTarget): Edit[] {
  const note = `(unresolved: ${target.target.replace(/\s+/g, ' ')})`;

  switch (target.kind) {
    case 'inline':
    case 'image':
      return [
        { start: target.span.start, end: target.label.start, text: '[' },
        { start: target.label.end, end: target.span.end, text: `] ${note}` },
      ];
    case 'reference-definition':
      return [{ start: target.label.end, end: target.span.end, text: `] ${note}` }];
    case 'html-attribute':
      return [
        {
          start: target.label.start,
          end: target.label.end,
          text: `data-unresolved-${text.slice(target.label.start, target.label.end).toLowerCase()}`,
        },
      ];
    case 'autolink':
      return [{ start: target.span.start, end: target.span.end, text: `${target.target} ${note}` }];
  }
}

/** Apply non-overlapping edits. */
function applyEdits(text: string, edits: readonly Edit[]): string {
  let output = '';
  let cursor = 0;

  for (const edit of [...edits].sort((a, b) => a.start - b.start)) {
    output += text.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }

  return output + text.slice(cursor);
}
