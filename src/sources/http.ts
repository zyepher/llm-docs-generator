/**
 * The shared HTTP client (spec 4.1). Every network fetch the engine makes for
 * docs goes through `createHttpClient`, which enforces one policy:
 *
 * - `https:` only; `http:` only to loopback, and private addresses at all,
 *   only when LLM_DOCS_ALLOW_PRIVATE_NETWORK=1.
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
import { isIP } from 'node:net';

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

/**
 * A parameter is a credential when its name, lowercased with separators
 * removed, contains one of these stems (`sig` covers `signature`), starts
 * with a cloud provider's signing prefix, or is exactly `code` (an OAuth
 * authorization code; matching it inside `encode` or `zipcode` would mostly
 * be noise). The match is broad on purpose: a list of names always misses
 * one, and `keyword` or `author` shown as `***` costs nothing.
 */
const CREDENTIAL_STEMS = [
  'token',
  'secret',
  'password',
  'passwd',
  'pwd',
  'key',
  'sig',
  'auth',
  'credential',
  'session',
  'jwt',
];
const CREDENTIAL_PREFIXES = ['xamz', 'xgoog'];

function decodeName(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

function isCredentialName(name: string): boolean {
  const normalized = decodeName(name)
    .toLowerCase()
    .replace(/[\s._-]+/g, '');
  return (
    normalized === 'code' ||
    CREDENTIAL_STEMS.some((stem) => normalized.includes(stem)) ||
    CREDENTIAL_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  );
}

/**
 * `name=value` in a query, a fragment (OAuth implicit flows put tokens
 * there), or a path parameter (`;jsessionid=`), found in the text as
 * written so nothing else in the URL is re-encoded.
 */
const URL_PARAMETER = /([?&#;])([^=&#;?\s]+)=([^&#;?\s]*)/g;

/** Names of the credential-looking parameters a URL carries. */
function credentialParameters(url: URL): string[] {
  return [...`${url.pathname}${url.search}${url.hash}`.matchAll(URL_PARAMETER)]
    .map((match) => match[2] ?? '')
    .filter(isCredentialName);
}

/**
 * A URL safe to print: userinfo replaced by `***`, and the value of every
 * credential-looking parameter in the query, the fragment, or the path
 * replaced by `***`. Text that is not a URL gets the same treatment.
 */
export function redactUrl(value: string | URL): string {
  let text: string;

  try {
    const url = new URL(String(value));
    if (url.username !== '' || url.password !== '') {
      url.username = '***';
      url.password = '';
    }
    text = url.href;
  } catch {
    text = String(value).replace(/\/\/[^/@\s]*@/, '//***@');
  }

  return text.replace(URL_PARAMETER, (match, separator: string, name: string) =>
    isCredentialName(name) ? `${separator}${name}=***` : match
  );
}

// ---------------------------------------------------------------------------
// Address policy
// ---------------------------------------------------------------------------

/**
 * The blocks no docs fetch may reach: `[prefix, source name, description]`.
 *
 * Built from the IANA IPv4 and IPv6 Special-Purpose Address Registries, both
 * last updated 2025-10-09 (https://www.iana.org/assignments/iana-ipv4-special-registry/
 * and .../iana-ipv6-special-registry/): every block whose "Globally Reachable"
 * is False, and every terminated block. A block that is not globally reachable
 * is refused whole even where the registry carves globally reachable anycast
 * services out of it (192.0.0.0/24, 2001::/23): docs never live there. Rows
 * whose name cites an RFC are not in those registries: multicast (in IANA's
 * multicast registries), the deprecated site-local range, and the IPv6 forms
 * that carry an IPv4 address, refused whole, as the tunnels and translators
 * they are (NAT64's well-known prefix is "Globally Reachable" in the registry,
 * but a docs host behind one is an IPv4 host, reached by its IPv4 address).
 */
export const SPECIAL_ADDRESS_BLOCKS: ReadonlyArray<
  readonly [prefix: string, name: string, description: string]
> = [
  ['0.0.0.0/8', '"This network"', 'an unspecified ("this network") address'],
  ['0.0.0.0/32', '"This host on this network"', 'an unspecified ("this network") address'],
  ['10.0.0.0/8', 'Private-Use', 'a private address'],
  ['100.64.0.0/10', 'Shared Address Space', 'a carrier-grade NAT address'],
  ['127.0.0.0/8', 'Loopback', 'a loopback address'],
  ['169.254.0.0/16', 'Link Local', 'a link-local address (cloud metadata lives here)'],
  ['172.16.0.0/12', 'Private-Use', 'a private address'],
  ['192.0.0.0/24', 'IETF Protocol Assignments', 'an IETF protocol assignment address'],
  ['192.0.0.0/29', 'IPv4 Service Continuity Prefix', 'an IETF protocol assignment address'],
  ['192.0.0.8/32', 'IPv4 dummy address', 'an IETF protocol assignment address'],
  ['192.0.0.170/32', 'NAT64/DNS64 Discovery', 'an IETF protocol assignment address'],
  ['192.0.0.171/32', 'NAT64/DNS64 Discovery', 'an IETF protocol assignment address'],
  ['192.0.2.0/24', 'Documentation (TEST-NET-1)', 'a documentation address'],
  ['192.88.99.0/24', 'Deprecated (6to4 Relay Anycast)', 'a 6to4 relay address'],
  ['192.88.99.2/32', '6a44-relay anycast address', 'a 6to4 relay address'],
  ['192.168.0.0/16', 'Private-Use', 'a private address'],
  ['198.18.0.0/15', 'Benchmarking', 'a benchmarking address'],
  ['198.51.100.0/24', 'Documentation (TEST-NET-2)', 'a documentation address'],
  ['203.0.113.0/24', 'Documentation (TEST-NET-3)', 'a documentation address'],
  ['224.0.0.0/4', 'Multicast (RFC 5771)', 'a multicast address'],
  ['240.0.0.0/4', 'Reserved', 'a reserved address'],
  ['255.255.255.255/32', 'Limited Broadcast', 'a broadcast address'],
  ['::/128', 'Unspecified Address', 'an unspecified address'],
  ['::1/128', 'Loopback Address', 'a loopback address'],
  ['::/96', 'IPv4-compatible (RFC 4291, deprecated)', 'an IPv4-compatible address'],
  ['::ffff:0:0:0/96', 'IPv4-translated (RFC 2765)', 'an IPv4-translated address'],
  ['64:ff9b::/96', 'IPv4-IPv6 Translat. (RFC 6052)', 'a NAT64 address'],
  ['64:ff9b:1::/48', 'IPv4-IPv6 Translat.', 'a NAT64 address'],
  ['100::/64', 'Discard-Only Address Block', 'a discard-only address'],
  ['100:0:0:1::/64', 'Dummy IPv6 Prefix', 'a dummy address'],
  ['2001::/23', 'IETF Protocol Assignments', 'an IETF protocol assignment address'],
  ['2001::/32', 'TEREDO (RFC 4380)', 'a Teredo tunnel address'],
  ['2001:2::/48', 'Benchmarking', 'a benchmarking address'],
  ['2001:10::/28', 'Deprecated (previously ORCHID)', 'an ORCHID address'],
  ['2001:db8::/32', 'Documentation', 'a documentation address'],
  ['2002::/16', '6to4 (RFC 3056)', 'a 6to4 tunnel address'],
  ['3fff::/20', 'Documentation', 'a documentation address'],
  ['5f00::/16', 'Segment Routing (SRv6) SIDs', 'a segment routing address'],
  ['fc00::/7', 'Unique-Local', 'a unique-local address'],
  ['fe80::/10', 'Link-Local Unicast', 'a link-local address'],
  ['fec0::/10', 'Site-Local (RFC 3879, deprecated)', 'a site-local address'],
  ['ff00::/8', 'Multicast (RFC 4291)', 'a multicast address'],
];

interface IpAddress {
  family: 4 | 6;
  value: bigint;
}

const IPV4_MASK = 0xffff_ffffn;

function parseIpv4(text: string): bigint {
  return text.split('.').reduce((total, octet) => (total << 8n) | BigInt(octet), 0n);
}

function parseIp(text: string): IpAddress | undefined {
  // A zone (`fe80::1%en0`) names an interface, not part of the address.
  const address = text.replace(/%.*$/, '');
  const version = isIP(address);

  if (version === 4) {
    return { family: 4, value: parseIpv4(address) };
  }
  if (version !== 6) {
    return undefined;
  }

  // A trailing dotted quad (`::ffff:1.2.3.4`) is the last two groups.
  const hex = address.replace(/(\d+\.\d+\.\d+\.\d+)$/, (dotted) => {
    const ipv4 = parseIpv4(dotted);
    return `${(ipv4 >> 16n).toString(16)}:${(ipv4 & 0xffffn).toString(16)}`;
  });
  const [head = '', tail] = hex.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined || tail === '' ? [] : tail.split(':');
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];

  return {
    family: 6,
    value: groups.reduce((total, group) => (total << 16n) | BigInt(`0x${group}`), 0n),
  };
}

function formatIpv4(value: bigint): string {
  return [24n, 16n, 8n, 0n].map((shift) => (value >> shift) & 0xffn).join('.');
}

interface AddressBlock {
  family: 4 | 6;
  /** Bits to the right of the prefix. */
  hostBits: bigint;
  network: bigint;
  reason: string;
}

function parseBlock([prefix, name, description]: readonly [string, string, string]): AddressBlock {
  const [network = '', length = ''] = prefix.split('/');
  const parsed = parseIp(network);
  if (parsed === undefined) {
    throw new Error(`Invalid special-purpose block ${prefix}.`);
  }
  const hostBits = BigInt((parsed.family === 4 ? 32 : 128) - Number(length));
  return {
    family: parsed.family,
    hostBits,
    network: parsed.value >> hostBits,
    reason: `${description} (${prefix}: ${name})`,
  };
}

/** Most specific first, so an address is described by the narrowest block holding it. */
const BLOCKS = SPECIAL_ADDRESS_BLOCKS.map(parseBlock).sort((a, b) =>
  a.hostBits < b.hostBits ? -1 : a.hostBits > b.hostBits ? 1 : 0
);

function inPrefix(value: bigint, network: bigint, hostBits: bigint): boolean {
  return value >> hostBits === network;
}

function blockOf(address: IpAddress): AddressBlock | undefined {
  return BLOCKS.find(
    (block) =>
      block.family === address.family && inPrefix(address.value, block.network, block.hostBits)
  );
}

/** `::ffff:a.b.c.d`: the IPv4 address itself, as the operating system connects to it. */
function ipv4Mapped(address: IpAddress): bigint | undefined {
  return address.family === 6 && inPrefix(address.value, 0xffffn, 32n)
    ? address.value & IPV4_MASK
    : undefined;
}

/**
 * The IPv4 addresses an IPv6 address carries: IPv4-compatible and -translated
 * (RFC 4291, 2765), NAT64 (RFC 6052, the /48 form skipping its reserved
 * octet), 6to4 (RFC 3056), and Teredo's server and inverted client (RFC 4380).
 */
function embeddedIpv4(value: bigint): bigint[] {
  // `::` and `::1` are the unspecified and loopback addresses, not IPv4-compatible ones.
  if ((value > 1n && inPrefix(value, 0n, 32n)) || inPrefix(value, 0xffff_0000n, 32n)) {
    return [value & IPV4_MASK];
  }
  if (inPrefix(value, 0x64_ff9bn << 64n, 32n)) {
    return [value & IPV4_MASK];
  }
  if (inPrefix(value, 0x64_ff9b_0001n, 80n)) {
    return [(((value >> 64n) & 0xffffn) << 16n) | ((value >> 40n) & 0xffffn)];
  }
  if (inPrefix(value, 0x2002n, 112n)) {
    return [(value >> 80n) & IPV4_MASK];
  }
  if (inPrefix(value, 0x2001_0000n, 96n)) {
    return [(value >> 64n) & IPV4_MASK, ~value & IPV4_MASK];
  }
  return [];
}

/**
 * Why an IP address is not a public unicast address, or undefined when it is.
 * An IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) is judged by its IPv4 part;
 * any other IPv6 form carrying an IPv4 address is refused, and names that
 * address when it is itself special.
 */
export function specialAddressReason(address: string): string | undefined {
  const parsed = parseIp(address);

  if (parsed === undefined) {
    return 'not an IP address';
  }

  const mapped = ipv4Mapped(parsed);
  if (mapped !== undefined) {
    return blockOf({ family: 4, value: mapped })?.reason;
  }

  const block = blockOf(parsed);
  if (block === undefined || parsed.family === 4) {
    return block?.reason;
  }

  for (const carried of embeddedIpv4(parsed.value)) {
    const inner = blockOf({ family: 4, value: carried });
    if (inner !== undefined) {
      return `${block.reason} carrying ${formatIpv4(carried)}, ${inner.reason}`;
    }
  }

  return block.reason;
}

function isLoopback(address: string): boolean {
  const parsed = parseIp(address);
  if (parsed === undefined) {
    return false;
  }
  const ipv4 = parsed.family === 4 ? parsed.value : ipv4Mapped(parsed);
  return ipv4 === undefined ? parsed.value === 1n : ipv4 >> 24n === 127n;
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

  if (isIP(host) !== 0) {
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
  /** Cancels the request, its retries, and their backoff (a caller's overall budget). */
  signal?: AbortSignal;
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

  /** The backoff sleep, cut short when the caller's signal aborts. */
  const pause = async (ms: number, signal: AbortSignal | undefined): Promise<void> => {
    if (signal === undefined) {
      await sleep(ms);
      return;
    }
    if (signal.aborted) {
      return;
    }
    let onAbort = (): void => {};
    const aborted = new Promise<void>((resolveAbort) => {
      onAbort = () => resolveAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      await Promise.race([sleep(ms), aborted]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  };

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
    const signal =
      getOptions.signal === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, getOptions.signal]);
    let current = requested;

    try {
      for (let redirects = 0; ; redirects += 1) {
        let result: HopResult;

        try {
          result = await hop(current, getOptions, signal);
        } catch (error) {
          if (error instanceof HttpPolicyError || error instanceof HttpRequestError) {
            throw error;
          }
          if (getOptions.signal?.aborted === true) {
            throw cancelled(current);
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
      // Only the requested URL: a server may legitimately redirect to a presigned one.
      const credentials = credentialParameters(parsed);
      if (credentials.length > 0) {
        throw new HttpPolicyError(
          `Refusing ${redactUrl(parsed)}: it carries a credential (${credentials.join(', ')}). llm-docs records the URLs it fetches in pack manifests and output, so credentials are never allowed in them; remove the parameter from the URL.`
        );
      }
      parsed.hash = '';
      // A function, not a narrowed property read: the signal can abort during any await.
      const isCancelled = (): boolean => getOptions.signal?.aborted === true;

      for (let attemptIndex = 0; ; attemptIndex += 1) {
        if (isCancelled()) {
          throw cancelled(parsed);
        }
        try {
          return await attempt(parsed, getOptions);
        } catch (error) {
          const last = attemptIndex >= retries || isCancelled();

          if (error instanceof RetryableStatus) {
            if (last) {
              return error.response;
            }
            await pause(backoff(attemptIndex, error.retryAfterMs, random), getOptions.signal);
            continue;
          }
          if (!(error instanceof HttpRequestError) || !error.retryable || last) {
            throw error;
          }
          await pause(backoff(attemptIndex, error.retryAfterMs, random), getOptions.signal);
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

function cancelled(url: URL): HttpRequestError {
  return new HttpRequestError(`GET ${redactUrl(url)} was cancelled.`, undefined, false);
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
