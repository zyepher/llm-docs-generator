/**
 * The shared HTTP client (spec 4.1). Every network fetch the engine makes for
 * docs goes through `createHttpClient`, which enforces one policy:
 *
 * - `https:` only; `http:` only to loopback, and private addresses at all,
 *   only when LLM_DOCS_ALLOW_PRIVATE_NETWORK=1 (or the caller's equivalent
 *   switch, such as `discover --allow-private-hosts`).
 * - The hostname is resolved before connecting; private, loopback,
 *   link-local, CGNAT, multicast, unique-local, documentation, and other
 *   special-purpose addresses are refused, and the connection is pinned to
 *   the vetted address so DNS rebinding cannot swap it.
 * - Redirects (at most 5) are followed by hand, re-applying the policy on
 *   every hop; the final URL is reported.
 * - 15 s connect and 60 s total timeouts, a streamed per-response byte cap,
 *   4 concurrent requests per host, and 2 retries with jittered backoff for
 *   network errors, 429, and 5xx (honoring Retry-After up to 30 s).
 * - Credentials in URLs are refused and every URL in an error is redacted.
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupAddress, LookupOptions } from 'node:dns';
import { BlockList, isIP } from 'node:net';

import { Agent, request } from 'undici';

import packageJson from '../../package.json';
import { ConfigError } from '../config/project.js';
import { errorMessage } from '../utils/guards.js';

export const ALLOW_PRIVATE_NETWORK_ENV = 'LLM_DOCS_ALLOW_PRIVATE_NETWORK';
export const USER_AGENT = `llm-docs/${packageJson.version} (+https://github.com/Zyepher/llm-docs-generator)`;

const HTTP_DEFAULTS = {
  connectTimeoutMs: 15_000,
  totalTimeoutMs: 60_000,
  maxRedirects: 5,
  retries: 2,
  perHostConcurrency: 4,
  maxRetryAfterMs: 30_000,
} as const;

/** A URL or address the network policy refuses. Never retried; the user fixes the input. */
export class HttpPolicyError extends ConfigError {
  override name = 'HttpPolicyError';
}

/** A request that failed at runtime (network error, timeout, bad status, size cap). */
export class HttpRequestError extends Error {
  override name = 'HttpRequestError';

  constructor(
    message: string,
    /** The HTTP status when the server answered. */
    readonly status: number | undefined,
    /** Whether another attempt may succeed. */
    readonly retryable: boolean,
    readonly retryAfterMs?: number
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const SENSITIVE_QUERY_KEY =
  /^(?:access[_-]?token|token|auth|authorization|key|api[_-]?key|secret|client[_-]?secret|password|passwd|sig|signature|code|x-amz-[a-z-]+|x-goog-[a-z-]+)$/i;

/**
 * A URL safe to print: userinfo replaced by `***` and the values of
 * credential-looking query parameters replaced by `***`.
 */
export function redactUrl(value: string | URL): string {
  let url: URL;

  try {
    url = new URL(String(value));
  } catch {
    return String(value).replace(/\/\/[^/@\s]*@/, '//***@');
  }

  if (url.username !== '' || url.password !== '') {
    url.username = '***';
    url.password = '';
  }

  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_QUERY_KEY.test(key)) {
      url.searchParams.set(key, '***');
    }
  }

  return url.href;
}

// ---------------------------------------------------------------------------
// Address policy
// ---------------------------------------------------------------------------

type AddressFamily = 'ipv4' | 'ipv6';

/** Special-purpose ranges (IANA registries) that docs never live on. */
const SPECIAL_RANGES: ReadonlyArray<readonly [string, number, AddressFamily, string]> = [
  ['0.0.0.0', 8, 'ipv4', 'an unspecified ("this network") address'],
  ['10.0.0.0', 8, 'ipv4', 'a private address'],
  ['100.64.0.0', 10, 'ipv4', 'a carrier-grade NAT address'],
  ['127.0.0.0', 8, 'ipv4', 'a loopback address'],
  ['169.254.0.0', 16, 'ipv4', 'a link-local address (cloud metadata lives here)'],
  ['172.16.0.0', 12, 'ipv4', 'a private address'],
  ['192.0.0.0', 24, 'ipv4', 'an IETF protocol assignment address'],
  ['192.0.2.0', 24, 'ipv4', 'a documentation address'],
  ['192.168.0.0', 16, 'ipv4', 'a private address'],
  ['198.18.0.0', 15, 'ipv4', 'a benchmarking address'],
  ['198.51.100.0', 24, 'ipv4', 'a documentation address'],
  ['203.0.113.0', 24, 'ipv4', 'a documentation address'],
  ['224.0.0.0', 4, 'ipv4', 'a multicast address'],
  ['240.0.0.0', 4, 'ipv4', 'a reserved address'],
  ['::', 128, 'ipv6', 'an unspecified address'],
  ['::1', 128, 'ipv6', 'a loopback address'],
  // IPv4-compatible (deprecated); IPv4-mapped addresses are judged by their IPv4 part.
  ['::', 96, 'ipv6', 'an IPv4-compatible address'],
  ['64:ff9b::', 96, 'ipv6', 'a NAT64 address'],
  ['64:ff9b:1::', 48, 'ipv6', 'a NAT64 address'],
  ['100::', 64, 'ipv6', 'a discard-only address'],
  ['2001::', 32, 'ipv6', 'a Teredo tunnel address'],
  ['2001:db8::', 32, 'ipv6', 'a documentation address'],
  ['2002::', 16, 'ipv6', 'a 6to4 tunnel address'],
  ['fc00::', 7, 'ipv6', 'a unique-local address'],
  ['fe80::', 10, 'ipv6', 'a link-local address'],
  ['fec0::', 10, 'ipv6', 'a site-local address'],
  ['ff00::', 8, 'ipv6', 'a multicast address'],
];

const RANGE_LISTS = SPECIAL_RANGES.map(([network, prefix, family, label]) => {
  const list = new BlockList();
  list.addSubnet(network, prefix, family);
  return { list, label };
});

const LOOPBACK = new BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');

function familyOf(address: string): AddressFamily | undefined {
  const version = isIP(address);
  return version === 4 ? 'ipv4' : version === 6 ? 'ipv6' : undefined;
}

/**
 * Why an IP address is not a public unicast address, or undefined when it is.
 * IPv4-mapped IPv6 addresses (`::ffff:a.b.c.d`) are judged by the IPv4 part.
 */
export function specialAddressReason(address: string): string | undefined {
  const family = familyOf(address);

  if (family === undefined) {
    return 'not an IP address';
  }

  for (const { list, label } of RANGE_LISTS) {
    if (list.check(address, family)) {
      return label;
    }
  }

  return undefined;
}

function isLoopback(address: string): boolean {
  const family = familyOf(address);
  return family !== undefined && LOOPBACK.check(address, family);
}

function hostOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '');
}

/**
 * The checks that need no DNS: scheme, credentials, and IP-literal hosts.
 * Throws HttpPolicyError naming the redacted URL.
 */
export function assertUrlAllowed(url: URL, allowPrivateNetwork: boolean): void {
  const shown = redactUrl(url);

  if (url.username !== '' || url.password !== '') {
    throw new HttpPolicyError(`Refusing ${shown}: credentials in URLs are not allowed.`);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new HttpPolicyError(`Refusing ${shown}: only https:// URLs are fetched.`);
  }

  if (url.protocol === 'http:' && !allowPrivateNetwork) {
    throw new HttpPolicyError(
      `Refusing ${shown}: only https:// URLs are fetched (plain http is allowed only to loopback with ${ALLOW_PRIVATE_NETWORK_ENV}=1).`
    );
  }

  const host = hostOf(url);

  if (familyOf(host) !== undefined) {
    assertAddressAllowed(url, host, allowPrivateNetwork);
  }
}

function assertAddressAllowed(url: URL, address: string, allowPrivateNetwork: boolean): void {
  if (url.protocol === 'http:' && !isLoopback(address)) {
    throw new HttpPolicyError(
      `Refusing ${redactUrl(url)}: plain http is allowed only to loopback, and ${url.hostname} is ${address}.`
    );
  }

  const reason = specialAddressReason(address);

  if (reason !== undefined && !allowPrivateNetwork) {
    const via = hostOf(url) === address ? '' : ` (${url.hostname} resolves to ${address})`;
    throw new HttpPolicyError(
      `Refusing ${redactUrl(url)}: ${address} is ${reason}${via}; set ${ALLOW_PRIVATE_NETWORK_ENV}=1 to allow private networks.`
    );
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Resolves a hostname to every address it has (injectable for tests). */
export type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>;

async function systemResolver(hostname: string): Promise<ResolvedAddress[]> {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry) => ({ address: entry.address, family: entry.family === 6 ? 6 : 4 }));
}

/**
 * Resolve the URL's host and vet every address it has against the policy;
 * the connection is pinned to the first. Also vets remote repositories
 * before the version-control client (which resolves on its own) connects.
 */
export async function resolveAllowedAddress(
  url: URL,
  allowPrivateNetwork: boolean,
  resolver: HostResolver = systemResolver
): Promise<ResolvedAddress> {
  const host = hostOf(url);
  const literal = isIP(host);

  if (literal !== 0) {
    assertAddressAllowed(url, host, allowPrivateNetwork);
    return { address: host, family: literal === 6 ? 6 : 4 };
  }

  let addresses: ResolvedAddress[];
  try {
    addresses = await resolver(host);
  } catch (error) {
    throw new HttpRequestError(
      `Cannot resolve ${url.hostname} for ${redactUrl(url)}: ${errorMessage(error)}`,
      undefined,
      true
    );
  }

  const first = addresses[0];
  if (first === undefined) {
    throw new HttpRequestError(
      `${url.hostname} has no addresses (${redactUrl(url)}).`,
      undefined,
      true
    );
  }

  // Every address must pass: a mixed answer could otherwise steer a retry to a private one.
  for (const entry of addresses) {
    assertAddressAllowed(url, entry.address, allowPrivateNetwork);
  }

  return first;
}

export interface HttpClientOptions {
  /** Default: LLM_DOCS_ALLOW_PRIVATE_NETWORK=1. */
  allowPrivateNetwork?: boolean;
  resolver?: HostResolver;
  connectTimeoutMs?: number;
  totalTimeoutMs?: number;
  maxRedirects?: number;
  retries?: number;
  perHostConcurrency?: number;
  /** Backoff sleep (tests record it instead of waiting). */
  sleep?: (ms: number) => Promise<void>;
  /** Jitter source in [0, 1). */
  random?: () => number;
}

export interface HttpGetOptions {
  /** Per-response byte cap: the request fails when the body is larger. */
  maxBytes: number;
  /** Keep the first `maxBytes` bytes and report `truncated` instead of failing. */
  truncate?: boolean;
  /** Return 4xx and 5xx responses (after retries) instead of throwing. */
  acceptErrorStatus?: boolean;
  accept?: string;
  /** Overrides the client's total timeout for this request. */
  timeoutMs?: number;
}

export interface HttpResponse {
  /** The URL that was requested. */
  url: string;
  /** The URL that answered, after redirects. */
  finalUrl: string;
  status: number;
  contentType: string | undefined;
  etag: string | undefined;
  lastModified: string | undefined;
  body: Buffer;
  truncated: boolean;
}

export interface HttpClient {
  readonly allowPrivateNetwork: boolean;
  get(url: string, options: HttpGetOptions): Promise<HttpResponse>;
  /** Close pooled connections. */
  close(): Promise<void>;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Stop reading a body; the abort error a destroyed undici body emits is expected. */
function discard(body: NodeJS.ReadableStream & { destroy(): void }): void {
  body.on('error', () => {});
  body.destroy();
}

/** A counting semaphore per host. */
function createHostLimiter(limit: number): (host: string) => Promise<() => void> {
  const active = new Map<string, number>();
  const waiting = new Map<string, (() => void)[]>();

  return async (host) => {
    if ((active.get(host) ?? 0) >= limit) {
      await new Promise<void>((resolveTurn) => {
        const queue = waiting.get(host) ?? [];
        queue.push(resolveTurn);
        waiting.set(host, queue);
      });
    } else {
      active.set(host, (active.get(host) ?? 0) + 1);
    }

    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const next = waiting.get(host)?.shift();
      if (next !== undefined) {
        // The slot passes straight to the next waiter.
        next();
      } else {
        active.set(host, (active.get(host) ?? 1) - 1);
      }
    };
  };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  const single = Array.isArray(value) ? value[0] : value;
  const trimmed = single?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

/** Retry-After as milliseconds (delta-seconds or an HTTP date), or undefined. */
function parseRetryAfter(value: string | undefined, now: number): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (/^\d+$/.test(value)) {
    return Number(value) * 1000;
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function pinnedLookup(address: string, family: 4 | 6) {
  return (
    _hostname: string,
    options: LookupOptions,
    callback: (
      error: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number
    ) => void
  ): void => {
    if (options.all === true) {
      callback(null, [{ address, family }]);
    } else {
      callback(null, address, family);
    }
  };
}

interface HopResult {
  kind: 'response' | 'redirect';
  status: number;
  location?: string;
  contentType?: string | undefined;
  etag?: string | undefined;
  lastModified?: string | undefined;
  retryAfter?: string | undefined;
  body?: Buffer;
  truncated?: boolean;
}

export function createHttpClient(options: HttpClientOptions = {}): HttpClient {
  const allowPrivateNetwork =
    options.allowPrivateNetwork ?? process.env[ALLOW_PRIVATE_NETWORK_ENV] === '1';
  const resolver = options.resolver ?? systemResolver;
  const connectTimeoutMs = options.connectTimeoutMs ?? HTTP_DEFAULTS.connectTimeoutMs;
  const totalTimeoutMs = options.totalTimeoutMs ?? HTTP_DEFAULTS.totalTimeoutMs;
  const maxRedirects = options.maxRedirects ?? HTTP_DEFAULTS.maxRedirects;
  const retries = options.retries ?? HTTP_DEFAULTS.retries;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms)));
  const random = options.random ?? Math.random;
  const limit = createHostLimiter(options.perHostConcurrency ?? HTTP_DEFAULTS.perHostConcurrency);
  const agents = new Map<string, Agent>();

  const agentFor = (hostname: string, pinned: ResolvedAddress): Agent => {
    const key = `${hostname}\u0000${pinned.address}`;
    let agent = agents.get(key);
    if (agent === undefined) {
      agent = new Agent({
        connect: {
          timeout: connectTimeoutMs,
          lookup: pinnedLookup(pinned.address, pinned.family),
        },
        headersTimeout: totalTimeoutMs,
        bodyTimeout: totalTimeoutMs,
      });
      agents.set(key, agent);
    }
    return agent;
  };

  const hop = async (
    url: URL,
    getOptions: HttpGetOptions,
    signal: AbortSignal
  ): Promise<HopResult> => {
    assertUrlAllowed(url, allowPrivateNetwork);
    const pinned = await resolveAllowedAddress(url, allowPrivateNetwork, resolver);
    const release = await limit(url.host);

    try {
      const headers: Record<string, string> = {
        'user-agent': USER_AGENT,
        accept: getOptions.accept ?? '*/*',
      };
      const token = process.env.GITHUB_TOKEN;
      if (url.hostname === 'api.github.com' && token !== undefined && token !== '') {
        headers.authorization = `Bearer ${token}`;
      }

      const response = await request(url, {
        method: 'GET',
        dispatcher: agentFor(url.hostname, pinned),
        headers,
        signal,
      });
      const status = response.statusCode;
      const location = headerValue(response.headers.location);

      if (REDIRECT_STATUSES.has(status) && location !== undefined) {
        await response.body.dump();
        return { kind: 'redirect', status, location };
      }

      const meta = {
        contentType: headerValue(response.headers['content-type']),
        etag: headerValue(response.headers.etag),
        lastModified: headerValue(response.headers['last-modified']),
        retryAfter: headerValue(response.headers['retry-after']),
      };

      if (status >= 400) {
        // Error bodies are not needed; read a little so the connection can be reused.
        await response.body.dump({ limit: 64 * 1024 });
        return { kind: 'response', status, ...meta, body: Buffer.alloc(0), truncated: false };
      }

      const declared = Number(headerValue(response.headers['content-length']) ?? Number.NaN);
      if (
        getOptions.truncate !== true &&
        Number.isFinite(declared) &&
        declared > getOptions.maxBytes
      ) {
        discard(response.body);
        throw new HttpRequestError(
          `${redactUrl(url)} is ${declared} bytes, over the ${getOptions.maxBytes} byte limit.`,
          status,
          false
        );
      }

      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;

      for await (const chunk of response.body) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (size + buffer.byteLength > getOptions.maxBytes) {
          if (getOptions.truncate !== true) {
            discard(response.body);
            throw new HttpRequestError(
              `${redactUrl(url)} is over the ${getOptions.maxBytes} byte limit; download stopped.`,
              status,
              false
            );
          }
          chunks.push(buffer.subarray(0, getOptions.maxBytes - size));
          size = getOptions.maxBytes;
          truncated = true;
          discard(response.body);
          break;
        }
        chunks.push(buffer);
        size += buffer.byteLength;
      }

      return { kind: 'response', status, ...meta, body: Buffer.concat(chunks, size), truncated };
    } finally {
      release();
    }
  };

  /** One attempt: the redirect chain under one total timeout. */
  const attempt = async (requested: URL, getOptions: HttpGetOptions): Promise<HttpResponse> => {
    const timeoutMs = getOptions.timeoutMs ?? totalTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let current = requested;

    try {
      for (let redirects = 0; ; redirects += 1) {
        let result: HopResult;

        try {
          result = await hop(current, getOptions, controller.signal);
        } catch (error) {
          if (error instanceof HttpPolicyError || error instanceof HttpRequestError) {
            throw error;
          }
          const message = controller.signal.aborted
            ? `timed out after ${timeoutMs} ms`
            : errorMessage(error);
          throw new HttpRequestError(
            `GET ${redactUrl(current)} failed: ${message}`,
            undefined,
            true
          );
        }

        if (result.kind === 'redirect') {
          if (redirects >= maxRedirects) {
            throw new HttpRequestError(
              `GET ${redactUrl(requested)} redirected more than ${maxRedirects} times.`,
              result.status,
              false
            );
          }
          let next: URL;
          try {
            next = new URL(result.location ?? '', current);
          } catch {
            throw new HttpRequestError(
              `GET ${redactUrl(current)} redirected to an invalid location.`,
              result.status,
              false
            );
          }
          next.hash = '';
          current = next;
          continue;
        }

        const retryable = result.status === 429 || result.status >= 500;
        if (result.status >= 400 && getOptions.acceptErrorStatus !== true) {
          throw new HttpRequestError(
            `GET ${redactUrl(current)} answered HTTP ${result.status}.`,
            result.status,
            retryable,
            parseRetryAfter(result.retryAfter, Date.now())
          );
        }
        if (retryable && getOptions.acceptErrorStatus === true) {
          // Let the retry loop see it; the last attempt returns it.
          throw new RetryableStatus(
            toResponse(requested, current, result),
            parseRetryAfter(result.retryAfter, Date.now())
          );
        }

        return toResponse(requested, current, result);
      }
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    allowPrivateNetwork,
    async get(url, getOptions) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new HttpPolicyError(`Refusing ${redactUrl(url)}: not a valid URL.`);
      }
      parsed.hash = '';

      for (let attemptIndex = 0; ; attemptIndex += 1) {
        try {
          return await attempt(parsed, getOptions);
        } catch (error) {
          const last = attemptIndex >= retries;

          if (error instanceof RetryableStatus) {
            if (last) {
              return error.response;
            }
            await sleep(backoff(attemptIndex, error.retryAfterMs, random));
            continue;
          }
          if (!(error instanceof HttpRequestError) || !error.retryable || last) {
            throw error;
          }
          await sleep(backoff(attemptIndex, error.retryAfterMs, random));
        }
      }
    },
    async close() {
      const pending = [...agents.values()].map((agent) => agent.close());
      agents.clear();
      await Promise.all(pending);
    },
  };
}

class RetryableStatus extends Error {
  constructor(
    readonly response: HttpResponse,
    readonly retryAfterMs: number | undefined
  ) {
    super(`HTTP ${response.status}`);
  }
}

function toResponse(requested: URL, final: URL, result: HopResult): HttpResponse {
  return {
    url: requested.href,
    finalUrl: final.href,
    status: result.status,
    contentType: result.contentType,
    etag: result.etag,
    lastModified: result.lastModified,
    body: result.body ?? Buffer.alloc(0),
    truncated: result.truncated ?? false,
  };
}

/** Jittered exponential backoff (0.5 s, 1 s, ...), or Retry-After when given, capped at 30 s. */
function backoff(attempt: number, retryAfterMs: number | undefined, random: () => number): number {
  if (retryAfterMs !== undefined) {
    return Math.min(retryAfterMs, HTTP_DEFAULTS.maxRetryAfterMs);
  }
  const base = 500 * 2 ** attempt;
  return Math.min(Math.round(base + base * random()), HTTP_DEFAULTS.maxRetryAfterMs);
}
