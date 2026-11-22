import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';

import { createHttpClient, HttpRequestError, type HttpClient } from '../sources/http.js';
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
/** A whole-package document listing every version: the npm packument, a PyPI project, a crate. */
const PACKAGE_DOCUMENT_MAX_BYTES = 25 * 1024 * 1024;
const JSON_RESPONSE_MAX_BYTES = 5 * 1024 * 1024;
const MAX_TAG_DEREFERENCES = 3;

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

interface RequestContext {
  /** The shared client (spec 4.1); it sends GITHUB_TOKEN to api.github.com only. */
  client: HttpClient;
  /** The caller's budget: aborting it cancels requests in flight. */
  signal: AbortSignal;
  timeoutMs: number;
}

/**
 * GET a JSON document through the shared client with the per-request
 * timeout, the budget signal, and a streamed size cap. Returns undefined
 * for 404 and 410 (the version or package does not exist).
 */
async function getJson(url: string, context: RequestContext, maxBytes: number): Promise<unknown> {
  let body: Buffer;

  try {
    const response = await context.client.get(url, {
      maxBytes,
      accept: 'application/json',
      timeoutMs: context.timeoutMs,
      signal: context.signal,
    });
    body = response.body;
  } catch (error) {
    if (error instanceof HttpRequestError && (error.status === 404 || error.status === 410)) {
      return undefined;
    }
    throw error;
  }

  return JSON.parse(body.toString('utf-8'));
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

/** Registry document URLs, shared by the release-date lookups and the package metadata. */
const registryUrls = {
  depsDevVersion: (endpoints: RegistryEndpoints, system: string, name: string, version: string) =>
    `${trimBase(endpoints.depsDev)}/v3/systems/${system}/packages/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`,
  npmPackage: (endpoints: RegistryEndpoints, name: string) =>
    `${trimBase(endpoints.npmRegistry)}/${name.replace('/', '%2F')}`,
  pypiProject: (endpoints: RegistryEndpoints, name: string) =>
    `${trimBase(endpoints.pypi)}/pypi/${encodeURIComponent(name)}`,
  cratesCrate: (endpoints: RegistryEndpoints, name: string) =>
    `${trimBase(endpoints.cratesIo)}/api/v1/crates/${encodeURIComponent(name)}`,
  /** Append `latest` or `v/<escaped version>.info`. */
  goModule: (endpoints: RegistryEndpoints, name: string) =>
    `${trimBase(endpoints.goProxy)}/${escapeGoModulePath(name)}/@`,
  pubPackage: (endpoints: RegistryEndpoints, name: string) =>
    `${trimBase(endpoints.pubDev)}/api/packages/${encodeURIComponent(name)}`,
};

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
  const depsDevUrl = registryUrls.depsDevVersion(endpoints, 'npm', query.name, query.version);
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

  const packumentUrl = registryUrls.npmPackage(endpoints, query.name);

  try {
    const packument = await getJson(packumentUrl, context, PACKAGE_DOCUMENT_MAX_BYTES);
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
  const url = `${registryUrls.pypiProject(endpoints, query.name)}/${encodeURIComponent(query.version)}/json`;
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
  const url = `${registryUrls.cratesCrate(endpoints, query.name)}/${encodeURIComponent(query.version)}`;
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
  const url = `${registryUrls.goModule(endpoints, query.name)}v/${escapeGoModulePath(query.version)}.info`;
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
  const body = await getJson(
    registryUrls.pubPackage(endpoints, query.name),
    context,
    JSON_RESPONSE_MAX_BYTES
  );
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
  const context: RequestContext = {
    client: createHttpClient(),
    signal: budget.signal,
    timeoutMs: REQUEST_TIMEOUT_MS,
  };
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
    await context.client.close();
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

// ============================================================================
// Package metadata (discover --package)
// ============================================================================

/** Ecosystems with a registry; a SwiftPM package is identified by its repository URL. */
export type RegistryEcosystem = Exclude<Ecosystem, 'swiftpm'>;

export interface PackageMetadataQuery {
  ecosystem: RegistryEcosystem;
  name: string;
  /** Undefined asks for the registry's latest version. */
  version: string | undefined;
}

/** A repository URL exactly as the registry states it: untrusted input. */
export interface DeclaredRepository {
  /** The registry field it came from, for example `repository` or `project_urls.Source`. */
  field: string;
  url: string;
  /** The package's directory inside the repository, when the registry states one. */
  directory: string | null;
}

export interface PackageMetadata {
  /** The version the metadata describes: the requested one, else the latest. */
  version: string;
  latestVersion: string | null;
  repository: DeclaredRepository | null;
  homepage: string | null;
  documentationUrl: string | null;
  license: string | null;
  publishedAt: string | null;
}

export type PackageMetadataLookup =
  | { status: 'found'; source: string; metadata: PackageMetadata }
  | { status: 'package-not-found'; source: string }
  | { status: 'version-not-found'; source: string; latestVersion: string | null };

export interface FetchPackageMetadataOptions {
  client: HttpClient;
  endpoints?: Partial<RegistryEndpoints>;
}

/** An interactive one-shot command reads whole-package documents, so it gets a longer timeout. */
const METADATA_REQUEST_TIMEOUT_MS = 30_000;
const FORGE_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org']);

type MetadataAnswer =
  | { status: 'found'; metadata: Omit<PackageMetadata, 'publishedAt'>; warnings: string[] }
  | { status: 'package-not-found' }
  | { status: 'version-not-found'; latestVersion: string | null };

type MetadataFetcher = (
  query: PackageMetadataQuery,
  endpoints: RegistryEndpoints,
  context: RequestContext
) => Promise<MetadataAnswer>;

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function isForgeUrl(value: string): boolean {
  try {
    return FORGE_HOSTS.has(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
}

const NPM_SHORTHAND_HOSTS: Readonly<Record<string, string>> = {
  github: 'github.com',
  gitlab: 'gitlab.com',
  bitbucket: 'bitbucket.org',
};

/** npm's repository shorthand (`github:owner/repo`, `gitlab:...`, bare `owner/repo`) as a URL. */
function expandNpmShorthand(value: string): string {
  const match = /^(?:(github|gitlab|bitbucket):)?([\w.-]+\/[\w.-]+)$/.exec(value);
  const path = match?.[2];

  if (path === undefined) {
    return value;
  }

  return `https://${NPM_SHORTHAND_HOSTS[match?.[1] ?? 'github'] ?? 'github.com'}/${path}`;
}

/** Version manifests (`/<name>/latest`, `/<name>/<version>`), not the multi-megabyte packument. */
const npmMetadata: MetadataFetcher = async (query, endpoints, context) => {
  const base = registryUrls.npmPackage(endpoints, query.name);
  const latest = await getJson(`${base}/latest`, context, JSON_RESPONSE_MAX_BYTES);

  if (!isRecord(latest)) {
    return { status: 'package-not-found' };
  }

  const latestVersion = text(latest.version);
  const manifest =
    query.version === undefined || query.version === latestVersion
      ? latest
      : await getJson(
          `${base}/${encodeURIComponent(query.version)}`,
          context,
          JSON_RESPONSE_MAX_BYTES
        );
  const version = isRecord(manifest) ? text(manifest.version) : null;

  if (!isRecord(manifest) || version === null) {
    return { status: 'version-not-found', latestVersion };
  }

  const declared = manifest.repository;
  const repositoryUrl = isRecord(declared) ? text(declared.url) : text(declared);

  return {
    status: 'found',
    metadata: {
      version,
      latestVersion,
      repository:
        repositoryUrl === null
          ? null
          : {
              field: 'repository',
              url: expandNpmShorthand(repositoryUrl),
              directory: isRecord(declared) ? text(declared.directory) : null,
            },
      homepage: text(manifest.homepage),
      documentationUrl: null,
      license: isRecord(manifest.license) ? text(manifest.license.type) : text(manifest.license),
    },
    warnings: [],
  };
};

/** PyPI writes "UNKNOWN" for unset fields in older metadata. */
function pypiText(value: unknown): string | null {
  const trimmed = text(value);
  return trimmed === 'UNKNOWN' ? null : trimmed;
}

/** A `project_urls` entry by PyPI's label normalization (lowercase, letters and digits only). */
function pypiProjectUrl(
  projectUrls: Record<string, unknown>,
  labels: readonly string[]
): { field: string; url: string } | null {
  for (const [label, value] of Object.entries(projectUrls)) {
    const url = text(value);
    if (url !== null && labels.includes(label.toLowerCase().replace(/[^a-z0-9]/g, ''))) {
      return { field: `project_urls.${label}`, url };
    }
  }

  return null;
}

const PYPI_REPOSITORY_LABELS = [
  'source',
  'sourcecode',
  'repository',
  'code',
  'github',
  'git',
  'sourcerepository',
];

function pypiMetadataFromInfo(
  info: Record<string, unknown>,
  latestVersion: string | null
): Omit<PackageMetadata, 'publishedAt'> | null {
  const version = pypiText(info.version);

  if (version === null) {
    return null;
  }

  const projectUrls = isRecord(info.project_urls) ? info.project_urls : {};
  const homePage = pypiText(info.home_page);
  const repository =
    pypiProjectUrl(projectUrls, PYPI_REPOSITORY_LABELS) ??
    Object.entries(projectUrls)
      .map(([label, value]) => ({ field: `project_urls.${label}`, url: text(value) ?? '' }))
      .find((entry) => isForgeUrl(entry.url)) ??
    (homePage !== null && isForgeUrl(homePage) ? { field: 'home_page', url: homePage } : null);
  const license = pypiText(info.license);
  const classifier = (Array.isArray(info.classifiers) ? info.classifiers : [])
    .filter((entry): entry is string => typeof entry === 'string' && entry.startsWith('License ::'))
    .at(-1);

  return {
    version,
    latestVersion,
    repository: repository === null ? null : { ...repository, directory: null },
    homepage: homePage ?? pypiProjectUrl(projectUrls, ['homepage', 'home'])?.url ?? null,
    documentationUrl:
      pypiText(info.docs_url) ??
      pypiProjectUrl(projectUrls, ['documentation', 'docs'])?.url ??
      null,
    // `license` is sometimes the whole license text; only a one-line name is reported.
    license:
      pypiText(info.license_expression) ??
      (license !== null && !license.includes('\n') && license.length <= 100 ? license : null) ??
      classifier?.split('::').at(-1)?.trim() ??
      null,
  };
}

const pypiMetadata: MetadataFetcher = async (query, endpoints, context) => {
  const base = registryUrls.pypiProject(endpoints, query.name);
  const latestOf = (project: unknown): string | null =>
    isRecord(project) && isRecord(project.info) ? pypiText(project.info.version) : null;

  if (query.version === undefined) {
    const project = await getJson(`${base}/json`, context, PACKAGE_DOCUMENT_MAX_BYTES);
    const metadata =
      isRecord(project) && isRecord(project.info)
        ? pypiMetadataFromInfo(project.info, latestOf(project))
        : null;
    return metadata === null
      ? { status: 'package-not-found' }
      : { status: 'found', metadata, warnings: [] };
  }

  const release = await getJson(
    `${base}/${encodeURIComponent(query.version)}/json`,
    context,
    JSON_RESPONSE_MAX_BYTES
  );

  if (!isRecord(release) || !isRecord(release.info)) {
    const project = await getJson(`${base}/json`, context, PACKAGE_DOCUMENT_MAX_BYTES);
    return project === undefined
      ? { status: 'package-not-found' }
      : { status: 'version-not-found', latestVersion: latestOf(project) };
  }

  // The project document can be large; the latest version is worth a warning, not a failure.
  const warnings: string[] = [];
  let latestVersion: string | null = null;
  try {
    latestVersion = latestOf(await getJson(`${base}/json`, context, PACKAGE_DOCUMENT_MAX_BYTES));
  } catch (error) {
    warnings.push(
      `The latest version of pypi:${query.name} could not be read: ${errorMessage(error)}`
    );
  }

  const metadata = pypiMetadataFromInfo(release.info, latestVersion);
  return metadata === null
    ? { status: 'version-not-found', latestVersion }
    : { status: 'found', metadata, warnings };
};

const cargoMetadata: MetadataFetcher = async (query, endpoints, context) => {
  const base = registryUrls.cratesCrate(endpoints, query.name);
  const body = await getJson(base, context, PACKAGE_DOCUMENT_MAX_BYTES);

  if (!isRecord(body) || !isRecord(body.crate)) {
    return { status: 'package-not-found' };
  }

  const crate = body.crate;
  const latestVersion = text(crate.max_stable_version) ?? text(crate.max_version);
  const target = query.version ?? latestVersion;
  const release =
    target === null
      ? undefined
      : await getJson(`${base}/${encodeURIComponent(target)}`, context, JSON_RESPONSE_MAX_BYTES);
  const version = isRecord(release) && isRecord(release.version) ? release.version : undefined;

  if (target === null || version === undefined) {
    return { status: 'version-not-found', latestVersion };
  }

  const repository = text(crate.repository);
  return {
    status: 'found',
    metadata: {
      version: target,
      latestVersion,
      repository:
        repository === null ? null : { field: 'repository', url: repository, directory: null },
      homepage: text(crate.homepage),
      documentationUrl: text(crate.documentation),
      license: text(version.license),
    },
    warnings: [],
  };
};

/** pub.dev publishes no license field; its score tags (`license:mit`) describe the latest version. */
async function pubLicense(
  query: PackageMetadataQuery,
  endpoints: RegistryEndpoints,
  context: RequestContext
): Promise<string | null> {
  const score = await getJson(
    `${registryUrls.pubPackage(endpoints, query.name)}/score`,
    context,
    JSON_RESPONSE_MAX_BYTES
  );
  const licenses = (isRecord(score) && Array.isArray(score.tags) ? score.tags : [])
    .filter((tag): tag is string => typeof tag === 'string' && tag.startsWith('license:'))
    .map((tag) => tag.slice('license:'.length))
    .filter((license) => license !== 'osi-approved' && license !== 'fsf-libre');

  return licenses.length === 0 ? null : licenses.join(', ');
}

const pubMetadata: MetadataFetcher = async (query, endpoints, context) => {
  const body = await getJson(
    registryUrls.pubPackage(endpoints, query.name),
    context,
    PACKAGE_DOCUMENT_MAX_BYTES
  );

  if (!isRecord(body)) {
    return { status: 'package-not-found' };
  }

  const latestVersion = isRecord(body.latest) ? text(body.latest.version) : null;
  const entry =
    query.version === undefined
      ? body.latest
      : (Array.isArray(body.versions) ? body.versions : []).find(
          (candidate) => isRecord(candidate) && candidate.version === query.version
        );
  const version = isRecord(entry) ? text(entry.version) : null;

  if (!isRecord(entry) || version === null) {
    return { status: 'version-not-found', latestVersion };
  }

  const pubspec = isRecord(entry.pubspec) ? entry.pubspec : {};
  const repository = text(pubspec.repository);
  const homepage = text(pubspec.homepage);
  const warnings: string[] = [];
  let license: string | null = null;

  if (version === latestVersion) {
    try {
      license = await pubLicense(query, endpoints, context);
    } catch (error) {
      warnings.push(`The license of pub:${query.name} could not be read: ${errorMessage(error)}`);
    }
  }

  return {
    status: 'found',
    metadata: {
      version,
      latestVersion,
      repository:
        repository !== null
          ? { field: 'pubspec.repository', url: repository, directory: null }
          : homepage !== null && isForgeUrl(homepage)
            ? { field: 'pubspec.homepage', url: homepage, directory: null }
            : null,
      homepage,
      documentationUrl: text(pubspec.documentation),
      license,
    },
    warnings,
  };
};

/**
 * The module proxy decides existence and the latest version, and its `Origin`
 * names the repository; deps.dev adds the license (the proxy has none).
 */
const goMetadata: MetadataFetcher = async (query, endpoints, context) => {
  const base = registryUrls.goModule(endpoints, query.name);
  const latest = await getJson(`${base}latest`, context, JSON_RESPONSE_MAX_BYTES);

  if (!isRecord(latest)) {
    return { status: 'package-not-found' };
  }

  const latestVersion = text(latest.Version);
  const info =
    query.version === undefined
      ? latest
      : await getJson(
          `${base}v/${escapeGoModulePath(query.version)}.info`,
          context,
          JSON_RESPONSE_MAX_BYTES
        );
  const version = isRecord(info) ? text(info.Version) : null;

  if (!isRecord(info) || version === null) {
    return { status: 'version-not-found', latestVersion };
  }

  const origin = isRecord(info.Origin) && info.Origin.VCS === 'git' ? info.Origin : {};
  const originUrl = text(origin.URL);
  const warnings: string[] = [];
  const links = new Map<string, string>();
  let license: string | null = null;

  try {
    const record = await getJson(
      registryUrls.depsDevVersion(endpoints, 'go', query.name, version),
      context,
      JSON_RESPONSE_MAX_BYTES
    );
    for (const link of isRecord(record) && Array.isArray(record.links) ? record.links : []) {
      const label = isRecord(link) ? text(link.label) : null;
      const url = isRecord(link) ? text(link.url) : null;
      if (label !== null && url !== null && !links.has(label)) {
        links.set(label, url);
      }
    }
    const licenses = (
      isRecord(record) && Array.isArray(record.licenses) ? record.licenses : []
    ).filter((entry): entry is string => typeof entry === 'string');
    license = licenses.length === 0 ? null : licenses.join(', ');
  } catch (error) {
    warnings.push(
      `deps.dev has no license or links for go:${query.name}@${version}: ${errorMessage(error)}`
    );
  }

  const sourceRepo = links.get('SOURCE_REPO') ?? null;
  return {
    status: 'found',
    metadata: {
      version,
      latestVersion,
      repository:
        originUrl !== null
          ? { field: 'Origin.URL', url: originUrl, directory: text(origin.Subdir) }
          : sourceRepo !== null
            ? { field: 'deps.dev SOURCE_REPO', url: sourceRepo, directory: null }
            : null,
      homepage: links.get('HOMEPAGE') ?? null,
      documentationUrl: links.get('DOCUMENTATION') ?? null,
      license,
    },
    warnings,
  };
};

const PACKAGE_METADATA: Readonly<
  Record<RegistryEcosystem, { source: string; fetch: MetadataFetcher }>
> = {
  npm: { source: 'npm-registry', fetch: npmMetadata },
  pypi: { source: 'pypi', fetch: pypiMetadata },
  cargo: { source: 'crates.io', fetch: cargoMetadata },
  go: { source: 'proxy.golang.org', fetch: goMetadata },
  pub: { source: 'pub.dev', fetch: pubMetadata },
};

/**
 * Registry metadata for one package version (or the latest), with its
 * publish date from the same per-registry lookup `lookupReleaseDates` runs
 * (uncached: discover writes nothing). A package or version the registry
 * does not know is a result, not an error; a registry that cannot be reached
 * throws HttpRequestError.
 */
export async function fetchPackageMetadata(
  query: PackageMetadataQuery,
  options: FetchPackageMetadataOptions
): Promise<{ lookup: PackageMetadataLookup; warnings: string[] }> {
  const endpoints: RegistryEndpoints = { ...DEFAULT_REGISTRY_ENDPOINTS, ...options.endpoints };
  const context: RequestContext = {
    client: options.client,
    signal: new AbortController().signal,
    timeoutMs: METADATA_REQUEST_TIMEOUT_MS,
  };
  const registry = PACKAGE_METADATA[query.ecosystem];
  const answer = await registry.fetch(query, endpoints, context);

  if (answer.status !== 'found') {
    return { lookup: { ...answer, source: registry.source }, warnings: [] };
  }

  const release = {
    ecosystem: query.ecosystem,
    name: query.name,
    version: answer.metadata.version,
  };
  const warnings = [...answer.warnings];
  let publishedAt: string | null = null;

  try {
    const dates = await LOOKUPS[query.ecosystem](release, endpoints, context);
    publishedAt = dates.versions.get(release.version) ?? null;
  } catch (error) {
    warnings.push(
      `The publish date of ${releaseKey(release)} could not be read: ${errorMessage(error)}`
    );
  }

  return {
    lookup: {
      status: 'found',
      source: registry.source,
      metadata: { ...answer.metadata, publishedAt },
    },
    warnings,
  };
}
