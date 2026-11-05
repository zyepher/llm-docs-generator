import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';

import packageJson from '../../package.json';
import { errorMessage, isFileNotFoundError, isRecord } from '../utils/guards.js';
import { readJsonFile, writeJsonFileSafely } from '../utils/json.js';
import { compareStringsByCodeUnit } from '../utils/sort.js';
import type { Ecosystem } from './lockfiles.js';

export interface ReleaseQuery {
  ecosystem: Ecosystem;
  name: string;
  version: string;
  /** Required for swiftpm lookups (GitHub repositories only). */
  repositoryUrl?: string;
}

export interface ReleaseInfo {
  /** ISO 8601 publish time, or null when unknown (not found, unsupported, offline, out of budget). */
  publishedAt: string | null;
  /** Where the answer came from: a registry name, or `offline`, `budget`, `error`, `unsupported`. */
  source: string;
  cached: boolean;
}

export interface RegistryEndpoints {
  depsDev: string;
  npmRegistry: string;
  pypi: string;
  cratesIo: string;
  goProxy: string;
  pubDev: string;
  githubApi: string;
}

export interface LookupReleaseDatesOptions {
  /** Cache only: no request is made. */
  offline: boolean;
  /** Wall-time bound for the whole lookup; unfinished queries return null and are not cached. */
  budgetMs?: number;
  cacheDir?: string;
  endpoints?: Partial<RegistryEndpoints>;
  /** Sent as a bearer token to api.github.com only. */
  githubToken?: string;
  now?: () => Date;
}

export interface ReleaseLookupResult {
  /** Keyed by `releaseKey(query)`: `${ecosystem}:${name}@${version}`. */
  releases: Map<string, ReleaseInfo>;
  /** Cache problems and failed lookups, human-readable and sorted. */
  warnings: string[];
}

export const DEFAULT_REGISTRY_ENDPOINTS: Readonly<RegistryEndpoints> = {
  depsDev: 'https://api.deps.dev',
  npmRegistry: 'https://registry.npmjs.org',
  pypi: 'https://pypi.org',
  cratesIo: 'https://crates.io',
  goProxy: 'https://proxy.golang.org',
  pubDev: 'https://pub.dev',
  githubApi: 'https://api.github.com',
};

const CACHE_FILE_NAME = 'release-dates.json';
const CACHE_SCHEMA_VERSION = 1;
const NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5_000;
const CONCURRENCY = 4;
const NPM_PACKUMENT_MAX_BYTES = 25 * 1024 * 1024;
const JSON_RESPONSE_MAX_BYTES = 5 * 1024 * 1024;
const MAX_TAG_DEREFERENCES = 3;
const USER_AGENT = `llm-docs/${packageJson.version} (+https://github.com/Zyepher/llm-docs-generator)`;

export function releaseKey(query: Pick<ReleaseQuery, 'ecosystem' | 'name' | 'version'>): string {
  return `${query.ecosystem}:${query.name}@${query.version}`;
}

/**
 * The per-user cache directory: LLM_DOCS_CACHE_DIR, else
 * `$XDG_CACHE_HOME/llm-docs`, else the platform convention.
 */
export function defaultCacheDir(
  input: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; homeDir?: string } = {}
): string {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const home = input.homeDir ?? homedir();

  if (env.LLM_DOCS_CACHE_DIR) {
    return env.LLM_DOCS_CACHE_DIR;
  }

  if (env.XDG_CACHE_HOME) {
    return (platform === 'win32' ? win32 : posix).join(env.XDG_CACHE_HOME, 'llm-docs');
  }

  if (platform === 'darwin') {
    return posix.join(home, 'Library', 'Caches', 'llm-docs');
  }

  if (platform === 'win32') {
    return win32.join(
      env.LOCALAPPDATA ?? win32.join(home, 'AppData', 'Local'),
      'llm-docs',
      'Cache'
    );
  }

  return posix.join(home, '.cache', 'llm-docs');
}

// ============================================================================
// Cache
// ============================================================================

interface CacheEntry {
  publishedAt: string | null;
  source: string;
  fetchedAt: string;
}

function isCacheEntry(value: unknown): value is CacheEntry {
  return (
    isRecord(value) &&
    (value.publishedAt === null || typeof value.publishedAt === 'string') &&
    typeof value.source === 'string' &&
    typeof value.fetchedAt === 'string'
  );
}

async function readCache(path: string, warnings: string[]): Promise<Map<string, CacheEntry>> {
  let raw: unknown;

  try {
    raw = await readJsonFile(path);
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      warnings.push(
        `Release-date cache ${path} is unreadable and was discarded: ${errorMessage(error)}`
      );
    }

    return new Map();
  }

  if (
    !isRecord(raw) ||
    raw.schemaVersion !== CACHE_SCHEMA_VERSION ||
    !isRecord(raw.entries) ||
    !Object.values(raw.entries).every(isCacheEntry)
  ) {
    warnings.push(`Release-date cache ${path} has an unexpected shape and was discarded.`);
    return new Map();
  }

  return new Map(
    Object.entries(raw.entries).filter((pair): pair is [string, CacheEntry] =>
      isCacheEntry(pair[1])
    )
  );
}

function isFreshCacheEntry(entry: CacheEntry, now: Date): boolean {
  if (entry.publishedAt !== null) {
    return true;
  }

  const fetchedAt = Date.parse(entry.fetchedAt);
  return Number.isFinite(fetchedAt) && now.getTime() - fetchedAt < NEGATIVE_TTL_MS;
}

/**
 * Merge new entries over whatever is on disk now (another process may have
 * written since we read) and replace the file atomically.
 */
async function writeCache(
  cacheDir: string,
  updates: Map<string, CacheEntry>,
  warnings: string[]
): Promise<void> {
  const path = join(cacheDir, CACHE_FILE_NAME);

  try {
    await mkdir(cacheDir, { recursive: true });
    const merged = await readCache(path, []);

    for (const [key, entry] of updates) {
      merged.set(key, entry);
    }

    const entries = Object.fromEntries(
      [...merged.entries()].sort((a, b) => compareStringsByCodeUnit(a[0], b[0]))
    );
    await writeJsonFileSafely(path, { schemaVersion: CACHE_SCHEMA_VERSION, entries });
  } catch (error) {
    warnings.push(`Release-date cache ${path} could not be written: ${errorMessage(error)}`);
  }
}

// ============================================================================
// HTTP
// ============================================================================

class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    url: string
  ) {
    super(`HTTP ${status} from ${url}`);
  }
}

interface RequestContext {
  signal: AbortSignal;
  githubToken: string | undefined;
}

/**
 * GET a JSON document with a per-request timeout, the shared abort signal
 * (budget), a streamed size cap, and the project User-Agent. Returns
 * undefined for 404 and 410 (the version or package does not exist).
 */
async function getJson(url: string, context: RequestContext, maxBytes: number): Promise<unknown> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'user-agent': USER_AGENT,
  };

  if (context.githubToken !== undefined && new URL(url).hostname === 'api.github.com') {
    headers.authorization = `Bearer ${context.githubToken}`;
  }

  const response = await fetch(url, {
    headers,
    signal: AbortSignal.any([context.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
  });

  if (response.status === 404 || response.status === 410) {
    await response.body?.cancel();
    return undefined;
  }

  if (!response.ok) {
    await response.body?.cancel();
    throw new HttpStatusError(response.status, url);
  }

  const declaredLength = Number(response.headers.get('content-length'));

  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new Error(`response from ${url} exceeds ${maxBytes} bytes`);
  }

  const chunks: Uint8Array[] = [];
  let received = 0;

  if (response.body) {
    for await (const chunk of response.body) {
      received += chunk.byteLength;

      if (received > maxBytes) {
        await response.body.cancel().catch(() => undefined);
        throw new Error(`response from ${url} exceeds ${maxBytes} bytes`);
      }

      chunks.push(chunk);
    }
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
}

function toIsoTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** Go module proxy escaping: each uppercase letter becomes `!` plus its lowercase form. */
export function escapeGoModulePath(path: string): string {
  return path.replace(/[A-Z]/g, (letter) => `!${letter.toLowerCase()}`);
}

function trimBase(base: string): string {
  return base.replace(/\/+$/, '');
}

// ============================================================================
// Per-registry lookups
// ============================================================================

/** A lookup returns the publish time for every version it learned about, keyed by version. */
type RegistryAnswer = { source: string; versions: Map<string, string | null> };

async function lookupNpm(
  query: ReleaseQuery,
  endpoints: RegistryEndpoints,
  context: RequestContext
): Promise<RegistryAnswer> {
  const depsDevUrl = `${trimBase(endpoints.depsDev)}/v3/systems/npm/packages/${encodeURIComponent(query.name)}/versions/${encodeURIComponent(query.version)}`;
  let depsDevFailure: unknown;

  try {
    const version = await getJson(depsDevUrl, context, JSON_RESPONSE_MAX_BYTES);
    const publishedAt = isRecord(version) ? toIsoTimestamp(version.publishedAt) : null;

    if (publishedAt !== null) {
      return { source: 'deps.dev', versions: new Map([[query.version, publishedAt]]) };
    }
  } catch (error) {
    if (context.signal.aborted) {
      throw error;
    }

    depsDevFailure = error;
  }

  const packumentUrl = `${trimBase(endpoints.npmRegistry)}/${query.name.replace('/', '%2F')}`;

  try {
    const packument = await getJson(packumentUrl, context, NPM_PACKUMENT_MAX_BYTES);
    const times = isRecord(packument) && isRecord(packument.time) ? packument.time : {};
    return {
      source: 'npm-registry',
      versions: new Map([[query.version, toIsoTimestamp(times[query.version])]]),
    };
  } catch (error) {
    throw depsDevFailure === undefined
      ? error
      : new Error(`${errorMessage(depsDevFailure)}; fallback: ${errorMessage(error)}`);
  }
}

async function lookupPypi(
  query: ReleaseQuery,
  endpoints: RegistryEndpoints,
  context: RequestContext
): Promise<RegistryAnswer> {
  const url = `${trimBase(endpoints.pypi)}/pypi/${encodeURIComponent(query.name)}/${encodeURIComponent(query.version)}/json`;
  const release = await getJson(url, context, JSON_RESPONSE_MAX_BYTES);
  const uploads = (isRecord(release) && Array.isArray(release.urls) ? release.urls : [])
    .map((file) => (isRecord(file) ? toIsoTimestamp(file.upload_time_iso_8601) : null))
    .filter((time): time is string => time !== null)
    .sort(compareStringsByCodeUnit);

  return { source: 'pypi', versions: new Map([[query.version, uploads[0] ?? null]]) };
}

async function lookupCargo(
  query: ReleaseQuery,
  endpoints: RegistryEndpoints,
  context: RequestContext
): Promise<RegistryAnswer> {
  const url = `${trimBase(endpoints.cratesIo)}/api/v1/crates/${encodeURIComponent(query.name)}/${encodeURIComponent(query.version)}`;
  const body = await getJson(url, context, JSON_RESPONSE_MAX_BYTES);
  const version = isRecord(body) && isRecord(body.version) ? body.version : {};
  return {
    source: 'crates.io',
    versions: new Map([[query.version, toIsoTimestamp(version.created_at)]]),
  };
}

async function lookupGo(
  query: ReleaseQuery,
  endpoints: RegistryEndpoints,
  context: RequestContext
): Promise<RegistryAnswer> {
  const url = `${trimBase(endpoints.goProxy)}/${escapeGoModulePath(query.name)}/@v/${escapeGoModulePath(query.version)}.info`;
  const info = await getJson(url, context, JSON_RESPONSE_MAX_BYTES);
  return {
    source: 'proxy.golang.org',
    versions: new Map([[query.version, isRecord(info) ? toIsoTimestamp(info.Time) : null]]),
  };
}

/** pub.dev answers with every version of the package at once; all of them are cached. */
async function lookupPub(
  query: ReleaseQuery,
  endpoints: RegistryEndpoints,
  context: RequestContext
): Promise<RegistryAnswer> {
  const url = `${trimBase(endpoints.pubDev)}/api/packages/${encodeURIComponent(query.name)}`;
  const body = await getJson(url, context, JSON_RESPONSE_MAX_BYTES);
  const versions = new Map<string, string | null>([[query.version, null]]);

  for (const entry of isRecord(body) && Array.isArray(body.versions) ? body.versions : []) {
    if (isRecord(entry) && typeof entry.version === 'string') {
      versions.set(entry.version, toIsoTimestamp(entry.published));
    }
  }

  return { source: 'pub.dev', versions };
}

function githubRepository(
  repositoryUrl: string | undefined
): { owner: string; repo: string } | undefined {
  if (repositoryUrl === undefined) {
    return undefined;
  }

  const match = /^(?:https?:\/\/|git@)github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(
    repositoryUrl.trim()
  );

  return match?.[1] !== undefined && match[2] !== undefined
    ? { owner: match[1], repo: match[2] }
    : undefined;
}

/**
 * SwiftPM versions are git tags. Resolve the tag (as written, then with a `v`
 * prefix), dereference annotated tags to the commit, and use the commit's
 * committer date.
 */
async function lookupSwiftpm(
  query: ReleaseQuery,
  endpoints: RegistryEndpoints,
  context: RequestContext
): Promise<RegistryAnswer> {
  const repository = githubRepository(query.repositoryUrl);

  if (!repository) {
    return { source: 'unsupported', versions: new Map([[query.version, null]]) };
  }

  const base = `${trimBase(endpoints.githubApi)}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
  let target: Record<string, unknown> | undefined;

  for (const tag of [query.version, `v${query.version}`]) {
    const ref = await getJson(
      `${base}/git/ref/tags/${encodeURIComponent(tag)}`,
      context,
      JSON_RESPONSE_MAX_BYTES
    );

    if (isRecord(ref) && isRecord(ref.object)) {
      target = ref.object;
      break;
    }
  }

  for (let depth = 0; target?.type === 'tag' && depth < MAX_TAG_DEREFERENCES; depth++) {
    const tag = await getJson(
      `${base}/git/tags/${String(target.sha)}`,
      context,
      JSON_RESPONSE_MAX_BYTES
    );
    target = isRecord(tag) && isRecord(tag.object) ? tag.object : undefined;
  }

  if (target?.type !== 'commit' || typeof target.sha !== 'string') {
    return { source: 'github', versions: new Map([[query.version, null]]) };
  }

  const commit = await getJson(
    `${base}/git/commits/${target.sha}`,
    context,
    JSON_RESPONSE_MAX_BYTES
  );
  const committer = isRecord(commit) && isRecord(commit.committer) ? commit.committer : {};
  return { source: 'github', versions: new Map([[query.version, toIsoTimestamp(committer.date)]]) };
}

const LOOKUPS: Readonly<
  Record<
    Ecosystem,
    (
      query: ReleaseQuery,
      endpoints: RegistryEndpoints,
      context: RequestContext
    ) => Promise<RegistryAnswer>
  >
> = {
  npm: lookupNpm,
  pypi: lookupPypi,
  cargo: lookupCargo,
  go: lookupGo,
  pub: lookupPub,
  swiftpm: lookupSwiftpm,
};

/** pub.dev returns all versions per request, so its unit of work is the package. */
function workUnitKey(query: ReleaseQuery): string {
  return query.ecosystem === 'pub' ? `pub:${query.name}` : releaseKey(query);
}

// ============================================================================
// Public entry point
// ============================================================================

/**
 * Publish dates for resolved dependency versions, from the cache first and
 * then the registries (unless offline). Requests run 4 at a time with a 5 s
 * timeout each; `budgetMs` bounds the whole call, and anything unfinished
 * comes back as `publishedAt: null` and stays uncached so a later run retries
 * it. A found date is cached forever (a version's publish date never
 * changes); a confirmed absence is cached for 24 hours; transport failures
 * are not cached.
 */
export async function lookupReleaseDates(
  queries: ReleaseQuery[],
  options: LookupReleaseDatesOptions
): Promise<ReleaseLookupResult> {
  const now = options.now ?? (() => new Date());
  const cacheDir = options.cacheDir ?? defaultCacheDir();
  const endpoints: RegistryEndpoints = { ...DEFAULT_REGISTRY_ENDPOINTS, ...options.endpoints };
  const warnings: string[] = [];
  const releases = new Map<string, ReleaseInfo>();
  const cache = await readCache(join(cacheDir, CACHE_FILE_NAME), warnings);
  const pending = new Map<string, ReleaseQuery[]>();

  for (const query of queries) {
    const key = releaseKey(query);

    if (releases.has(key)) {
      continue;
    }

    const cached = cache.get(key);

    if (cached && isFreshCacheEntry(cached, now())) {
      releases.set(key, { publishedAt: cached.publishedAt, source: cached.source, cached: true });
      continue;
    }

    if (options.offline) {
      releases.set(key, { publishedAt: null, source: 'offline', cached: false });
      continue;
    }

    const unit = workUnitKey(query);
    pending.set(unit, [...(pending.get(unit) ?? []), query]);
  }

  if (pending.size === 0) {
    return { releases, warnings: warnings.sort(compareStringsByCodeUnit) };
  }

  const budget = new AbortController();
  const budgetTimer =
    options.budgetMs === undefined ? undefined : setTimeout(() => budget.abort(), options.budgetMs);
  const context: RequestContext = { signal: budget.signal, githubToken: options.githubToken };
  const updates = new Map<string, CacheEntry>();
  const failures: string[] = [];
  const units = [...pending.values()];
  let nextUnit = 0;

  const worker = async (): Promise<void> => {
    while (!budget.signal.aborted) {
      const unit = units[nextUnit++];

      if (!unit) {
        return;
      }

      const [first] = unit;

      if (!first) {
        continue;
      }

      try {
        const answer = await LOOKUPS[first.ecosystem](first, endpoints, context);
        const fetchedAt = now().toISOString();

        for (const query of unit) {
          const publishedAt = answer.versions.get(query.version) ?? null;
          releases.set(releaseKey(query), { publishedAt, source: answer.source, cached: false });
        }

        if (answer.source !== 'unsupported') {
          for (const [version, publishedAt] of answer.versions) {
            updates.set(releaseKey({ ...first, version }), {
              publishedAt,
              source: answer.source,
              fetchedAt,
            });
          }
        }
      } catch (error) {
        if (!budget.signal.aborted) {
          failures.push(`${releaseKey(first)}: ${errorMessage(error)}`);
        }

        for (const query of unit) {
          releases.set(releaseKey(query), {
            publishedAt: null,
            source: budget.signal.aborted ? 'budget' : 'error',
            cached: false,
          });
        }
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, units.length) }, worker));
  } finally {
    if (budgetTimer !== undefined) {
      clearTimeout(budgetTimer);
    }
  }

  for (const query of queries) {
    const key = releaseKey(query);

    if (!releases.has(key)) {
      releases.set(key, { publishedAt: null, source: 'budget', cached: false });
    }
  }

  if (failures.length > 0) {
    warnings.push(
      `${failures.length} release-date lookup${failures.length === 1 ? '' : 's'} failed: ${failures.sort(compareStringsByCodeUnit).join('; ')}`
    );
  }

  if (updates.size > 0) {
    await writeCache(cacheDir, updates, warnings);
  }

  return { releases, warnings: warnings.sort(compareStringsByCodeUnit) };
}
