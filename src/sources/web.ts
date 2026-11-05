/**
 * HTTP sources (spec 2.3): `urls` fetches exactly the listed URLs; `llms-txt`
 * fetches an `llms.txt` index, keeps the same-origin https Markdown link
 * targets that pass the planner's include/exclude filter, and fetches each.
 * Both go through the shared client (src/sources/http.ts) and never follow
 * links inside fetched pages.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  ConfigError,
  PACK_LIMITS,
  storedPathForPathname,
  type ResolvedSourceOfType,
} from '../config/project.js';
import { extractMarkdownLinkUrls } from '../core/website-discovery.js';
import type { ManifestFetch } from '../pack/manifest.js';
import { sha256Prefixed } from '../utils/hash.js';
import { compileGlobs, type AcquireContext, type AcquiredFile } from './acquire.js';
import type { SourceAcquisition } from './acquire.js';
import { createHttpClient, redactUrl, type HttpClient, type HttpResponse } from './http.js';

/** Requests in flight per source; the client also caps each host at 4. */
const FETCH_CONCURRENCY = 8;

interface PlannedFetch {
  url: string;
  /** Stored, origin-relative POSIX path. */
  path: string;
}

function fetchMetadata(response: HttpResponse): ManifestFetch {
  return {
    finalUrl: response.finalUrl,
    status: response.status,
    ...(response.etag === undefined ? {} : { etag: response.etag }),
    ...(response.lastModified === undefined ? {} : { lastModified: response.lastModified }),
  };
}

function assertStoredPath(path: string, url: string): void {
  const segments = path.split('/');
  if (
    path === '' ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new ConfigError(
      `${redactUrl(url)} maps to the unsafe stored path "${path}"; give it an explicit "path".`
    );
  }
}

/** Fetch every planned URL into `workDir`, at most FETCH_CONCURRENCY at a time, in plan order. */
async function fetchAll(
  client: HttpClient,
  planned: readonly PlannedFetch[],
  context: AcquireContext
): Promise<AcquiredFile[]> {
  const directory = join(context.workDir, 'fetched');
  await mkdir(directory, { recursive: true });
  const files: AcquiredFile[] = new Array(planned.length);
  let next = 0;
  let failed = false;

  const worker = async (): Promise<void> => {
    while (next < planned.length && !failed) {
      const index = next;
      next += 1;
      const entry = planned[index];
      if (entry === undefined) {
        continue;
      }
      assertStoredPath(entry.path, entry.url);
      const response = await client
        .get(entry.url, { maxBytes: context.maxFileBytes })
        .catch((error: unknown) => {
          // Stop the other workers; the caller removes the work directory.
          failed = true;
          throw error;
        });
      // Bodies are stored under a counter, not the URL path, so no URL can shape a file name.
      const absolutePath = join(directory, `${index}`);
      await writeFile(absolutePath, response.body);
      files[index] = {
        path: entry.path,
        absolutePath,
        sha256: sha256Prefixed(response.body),
        bytes: response.body.byteLength,
        url: entry.url,
        sourceLabel: entry.url,
        fetch: fetchMetadata(response),
      };
    }
  };

  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, planned.length) }, worker));
  return files;
}

export async function acquireUrls(
  source: ResolvedSourceOfType<'urls'>,
  context: AcquireContext
): Promise<SourceAcquisition> {
  const client = createHttpClient();

  try {
    const files = await fetchAll(client, source.urls, context);
    return { origin: { type: 'urls' }, files, warnings: [] };
  } finally {
    await client.close();
  }
}

function decodedPathname(url: URL): string {
  try {
    return decodeURIComponent(url.pathname);
  } catch {
    return url.pathname;
  }
}

/** `/a/b/` and `a/b` both mean the pathname prefix `/a/b`. */
function normalizePrefix(prefix: string): string {
  const trimmed = prefix.replace(/^\/+|\/+$/g, '');
  return trimmed === '' ? '' : `/${trimmed}`;
}

/**
 * The page URLs an llms.txt index lists for this source: Markdown link
 * targets resolved against the index URL, same-origin https only, fragments
 * dropped, duplicates removed, filtered by include/exclude over the decoded
 * pathname (matched with and without its leading slash), in listing order.
 */
export function selectIndexedUrls(
  indexText: string,
  indexUrls: readonly string[],
  source: Pick<ResolvedSourceOfType<'llms-txt'>, 'include' | 'exclude' | 'stripPrefix' | 'url'>
): PlannedFetch[] {
  const base = indexUrls[0] ?? source.url;
  const origins = new Set(indexUrls.map((url) => new URL(url).origin));
  const included = compileGlobs(source.include);
  const excluded = compileGlobs(source.exclude);
  const matches = (test: (path: string) => boolean, pathname: string): boolean =>
    test(pathname) || test(pathname.replace(/^\/+/, ''));
  const prefix = normalizePrefix(source.stripPrefix);
  const seenUrls = new Set<string>();
  const byPath = new Map<string, string>();
  const planned: PlannedFetch[] = [];

  for (const raw of extractMarkdownLinkUrls(indexText)) {
    let url: URL;
    try {
      url = new URL(raw.replace(/^<|>$/g, ''), base);
    } catch {
      continue;
    }
    url.hash = '';

    if (url.protocol !== new URL(base).protocol || !origins.has(url.origin)) {
      continue;
    }
    if (url.username !== '' || url.password !== '' || seenUrls.has(url.href)) {
      continue;
    }

    const pathname = decodedPathname(url);
    if (!matches(included, pathname) || matches(excluded, pathname)) {
      continue;
    }
    seenUrls.add(url.href);

    const stripped =
      prefix !== '' && (pathname === prefix || pathname.startsWith(`${prefix}/`))
        ? pathname.slice(prefix.length) || '/'
        : pathname;
    const path = storedPathForPathname(stripped);
    const previous = byPath.get(path);

    if (previous !== undefined) {
      throw new ConfigError(
        `${redactUrl(previous)} and ${redactUrl(url.href)} in ${redactUrl(source.url)} would both be stored at "${path}"; narrow "include" or "exclude".`
      );
    }

    byPath.set(path, url.href);
    planned.push({ url: url.href, path });
  }

  return planned;
}

export async function acquireLlmsTxt(
  source: ResolvedSourceOfType<'llms-txt'>,
  context: AcquireContext
): Promise<SourceAcquisition> {
  const client = createHttpClient();

  try {
    const index = await client.get(source.url, {
      maxBytes: context.maxFileBytes,
      accept: 'text/markdown, text/plain;q=0.9, */*;q=0.1',
    });
    const planned = selectIndexedUrls(
      index.body.toString('utf-8'),
      [index.finalUrl, source.url],
      source
    );

    if (planned.length === 0) {
      throw new ConfigError(
        `${redactUrl(source.url)} lists no same-origin https links that pass "include" (${source.include.join(', ')}); check the filter against the index.`
      );
    }
    if (planned.length > PACK_LIMITS.maxFiles) {
      throw new ConfigError(
        `${redactUrl(source.url)} lists ${planned.length} pages that pass the filter, more than the ${PACK_LIMITS.maxFiles} file cap; narrow "include".`
      );
    }

    const files = await fetchAll(client, planned, context);
    return {
      origin: {
        type: 'llms-txt',
        url: source.url,
        sha256: sha256Prefixed(index.body),
        ...(index.finalUrl === new URL(source.url).href ? {} : { finalUrl: index.finalUrl }),
      },
      files,
      warnings: [],
    };
  } finally {
    await client.close();
  }
}
