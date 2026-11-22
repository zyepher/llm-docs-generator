/**
 * The shared HTTP client (spec 4.1) against loopback servers: the address
 * policy (literals and DNS answers through an injected resolver), per-hop
 * redirect re-validation, size caps, timeouts, retries with Retry-After,
 * per-host concurrency, the User-Agent, and redaction.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createHttpClient,
  HttpPolicyError,
  redactUrl,
  SPECIAL_ADDRESS_BLOCKS,
  specialAddressReason,
  USER_AGENT,
  type HttpClient,
} from '../../src/sources/http.js';

const servers: Server[] = [];
const clients: HttpClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolveClose) => {
          server.closeAllConnections();
          server.close(() => resolveClose());
        })
    )
  );
});

async function serve(
  handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<{ origin: string; port: number; requests: IncomingMessage[] }> {
  const requests: IncomingMessage[] = [];
  const server = createServer((request, response) => {
    requests.push(request);
    handler(request, response);
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('no port');
  }
  return { origin: `http://127.0.0.1:${address.port}`, port: address.port, requests };
}

function client(options: Parameters<typeof createHttpClient>[0] = {}): HttpClient {
  const created = createHttpClient({ allowPrivateNetwork: false, ...options });
  clients.push(created);
  return created;
}

const LIMIT = { maxBytes: 1024 * 1024 };

/** A CIDR block as numbers, computed here independently of the code under test. */
function cidr(prefix: string): { family: 4 | 6; first: bigint; last: bigint; length: number } {
  const [network = '', length = ''] = prefix.split('/');
  const family = network.includes(':') ? 6 : 4;
  const bits = family === 4 ? 32 : 128;
  const value =
    family === 4
      ? network.split('.').reduce((total, octet) => (total << 8n) | BigInt(octet), 0n)
      : expandIpv6(network);
  const hostBits = BigInt(bits - Number(length));
  const first = (value >> hostBits) << hostBits;
  return { family, first, last: first + (1n << hostBits) - 1n, length: Number(length) };
}

function expandIpv6(address: string): bigint {
  const [head = '', tail] = address.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined || tail === '' ? [] : tail.split(':');
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  return groups.reduce((total, group) => (total << 16n) | BigInt(`0x${group}`), 0n);
}

function formatAddress(family: 4 | 6, value: bigint): string {
  if (family === 4) {
    return [24n, 16n, 8n, 0n].map((shift) => (value >> shift) & 0xffn).join('.');
  }
  return [112n, 96n, 80n, 64n, 48n, 32n, 16n, 0n]
    .map((shift) => ((value >> shift) & 0xffffn).toString(16))
    .join(':');
}

describe('specialAddressReason', () => {
  const blocks = SPECIAL_ADDRESS_BLOCKS.map(([prefix]) => ({ prefix, ...cidr(prefix) }));
  const moreSpecificHolds = (block: (typeof blocks)[number], value: bigint): boolean =>
    blocks.some(
      (other) =>
        other.family === block.family &&
        other.length > block.length &&
        value >= other.first &&
        value <= other.last
    );

  it.each(blocks)('refuses an address inside $prefix and names the block', (block) => {
    const inside = moreSpecificHolds(block, block.last) ? block.first : block.last;
    expect(specialAddressReason(formatAddress(block.family, inside))).toContain(
      `(${block.prefix}:`
    );
  });

  it.each(blocks)('does not apply $prefix just outside it', (block) => {
    const max = block.family === 4 ? (1n << 32n) - 1n : (1n << 128n) - 1n;
    for (const outside of [block.first - 1n, block.last + 1n]) {
      if (outside >= 0n && outside <= max) {
        expect(specialAddressReason(formatAddress(block.family, outside)) ?? '').not.toContain(
          `(${block.prefix}:`
        );
      }
    }
  });

  it.each([
    // Ranges an earlier hand-written list treated as public.
    ['2001:2::1', /benchmarking/],
    ['3fff::1', /documentation/],
    ['2001:10::1', /ORCHID/],
    ['2001:20::1', /IETF protocol assignment/],
    ['5f00::1', /segment routing/],
    ['100:0:0:1::1', /dummy/],
    ['192.88.99.1', /6to4 relay/],
    // IPv4 carried inside IPv6: the IPv4 part is named.
    ['::ffff:0:7f00:1', /IPv4-translated.*127\.0\.0\.1, a loopback address/],
    ['::ffff:0:a9fe:a9fe', /169\.254\.169\.254, a link-local address/],
    ['::7f00:1', /IPv4-compatible.*127\.0\.0\.1, a loopback address/],
    ['64:ff9b::a00:1', /NAT64.*10\.0\.0\.1, a private address/],
    ['64:ff9b:1:7f00:0:100::', /NAT64.*127\.0\.0\.1, a loopback address/],
    ['2002:7f00:1::', /6to4.*127\.0\.0\.1, a loopback address/],
    ['2001:0:7f00:1::', /Teredo.*127\.0\.0\.1, a loopback address/],
    ['2001:0:808:808::80ff:fffe', /Teredo.*127\.0\.0\.1, a loopback address/],
    // IPv4-mapped addresses are judged by their IPv4 part alone.
    ['::ffff:127.0.0.1', /^a loopback address/],
    ['::ffff:a9fe:a9fe', /^a link-local address \(cloud metadata lives here\)/],
    ['::ffff:10.0.0.1', /^a private address/],
  ])('refuses %s', (address, reason) => {
    expect(specialAddressReason(address)).toMatch(reason);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '100.128.0.1',
    '172.32.0.1',
    '192.0.1.255',
    '2606:4700::1111',
    '2a00:1450:4001::200e',
    '::ffff:8.8.8.8',
    '2606:4700::1%en0',
  ])('accepts the public address %s', (address) => {
    expect(specialAddressReason(address)).toBeUndefined();
  });
});

describe('redactUrl', () => {
  it('hides userinfo and credential-looking query values', () => {
    expect(redactUrl('https://user:pass@example.com/a?token=abc&page=2&X-Amz-Signature=s')).toBe(
      'https://***@example.com/a?token=***&page=2&X-Amz-Signature=***'
    );
    expect(redactUrl('not a url https://u:p@host/x')).toBe('not a url https://***@host/x');
  });
});

describe('createHttpClient policy', () => {
  it.each([
    ['https://127.0.0.1/', /127\.0\.0\.1 is a loopback address/],
    ['https://[::1]/', /::1 is a loopback address/],
    ['https://[::ffff:169.254.169.254]/', /link-local/],
    ['https://[fd00::1]/', /unique-local/],
    ['https://100.64.1.1/', /carrier-grade NAT/],
    ['https://0.0.0.0/', /unspecified/],
    ['https://0x7f.0.0.1/', /loopback/],
    ['http://example.com/', /only https:\/\/ URLs are fetched/],
    ['ftp://example.com/x', /only https:\/\/ URLs are fetched/],
    ['file:///etc/passwd', /only https:\/\/ URLs are fetched/],
    ['https://user:secret@example.com/', /credentials in URLs are not allowed/],
  ])('refuses %s before connecting', async (url, message) => {
    const resolver = async () => {
      throw new Error('the resolver must not run');
    };
    const error = await client({ resolver })
      .get(url, LIMIT)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpPolicyError);
    expect(String(error)).toMatch(message);
    expect(String(error)).not.toContain('secret');
  });

  it('refuses a hostname that resolves to loopback, and allows it only with the switch', async () => {
    const { port, requests } = await serve((_request, response) => response.end('ok'));
    const resolver = async () => [{ address: '127.0.0.1', family: 4 as const }];
    const url = `https://docs.example.test:${port}/page`;

    await expect(client({ resolver }).get(url, LIMIT)).rejects.toThrow(
      /docs\.example\.test resolves to 127\.0\.0\.1/
    );
    // Plain http to the same hostname is pinned to the vetted loopback address.
    const allowed = await client({ resolver, allowPrivateNetwork: true }).get(
      `http://docs.example.test:${port}/page`,
      LIMIT
    );
    expect(allowed.body.toString()).toBe('ok');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.host).toBe(`docs.example.test:${port}`);
  });

  it('refuses a DNS answer that mixes public and private addresses', async () => {
    const resolver = async () => [
      { address: '93.184.215.14', family: 4 as const },
      { address: '10.0.0.7', family: 4 as const },
    ];
    await expect(client({ resolver }).get('https://mixed.example.test/', LIMIT)).rejects.toThrow(
      /10\.0\.0\.7 is a private address/
    );
  });

  it('refuses plain http to a non-loopback address even with the switch', async () => {
    const resolver = async () => [{ address: '10.0.0.5', family: 4 as const }];
    await expect(
      client({ resolver, allowPrivateNetwork: true }).get('http://internal.test/', LIMIT)
    ).rejects.toThrow(/plain http is allowed only to loopback/);
  });
});

describe('createHttpClient requests', () => {
  it('sends the llm-docs User-Agent and reports fetch metadata', async () => {
    const { origin, requests } = await serve((_request, response) => {
      response.writeHead(200, {
        'content-type': 'text/markdown',
        etag: '"v1"',
        'last-modified': 'Wed, 21 Oct 2026 07:28:00 GMT',
      });
      response.end('# Hi\n');
    });
    const response = await client({ allowPrivateNetwork: true }).get(`${origin}/a.md`, LIMIT);

    expect(requests[0]?.headers['user-agent']).toBe(USER_AGENT);
    expect(USER_AGENT).toMatch(
      /^llm-docs\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/Zyepher\/llm-docs-generator\)$/
    );
    expect(response).toMatchObject({
      status: 200,
      finalUrl: `${origin}/a.md`,
      contentType: 'text/markdown',
      etag: '"v1"',
      lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT',
      truncated: false,
    });
  });

  it('follows redirects, records the final URL, and re-applies the policy on every hop', async () => {
    const { origin, port } = await serve((request, response) => {
      const routes: Record<string, string> = {
        '/start': '/middle',
        '/middle': `http://other.example.test:${port}/end`,
        '/to-private': `http://internal.example.test:${port}/secret`,
        '/to-creds': 'https://user:pw@example.com/',
        '/to-file': 'file:///etc/passwd',
        '/loop': '/loop',
      };
      const target = routes[request.url ?? ''];
      if (target !== undefined) {
        response.writeHead(302, { location: target });
        response.end();
        return;
      }
      response.end(`at ${request.headers.host}${request.url}`);
    });
    const resolver = async (hostname: string) =>
      hostname === 'internal.example.test'
        ? [{ address: '10.0.0.9', family: 4 as const }]
        : [{ address: '127.0.0.1', family: 4 as const }];
    const http = client({ resolver, allowPrivateNetwork: true });

    const followed = await http.get(`${origin}/start`, LIMIT);
    expect(followed.finalUrl).toBe(`http://other.example.test:${port}/end`);
    expect(followed.body.toString()).toBe(`at other.example.test:${port}/end`);

    await expect(http.get(`${origin}/to-private`, LIMIT)).rejects.toThrow(
      /plain http is allowed only to loopback, and internal\.example\.test is 10\.0\.0\.9/
    );
    await expect(http.get(`${origin}/to-creds`, LIMIT)).rejects.toThrow(/credentials in URLs/);
    await expect(http.get(`${origin}/to-file`, LIMIT)).rejects.toThrow(/only https:\/\//);
    await expect(http.get(`${origin}/loop`, LIMIT)).rejects.toThrow(/redirected more than 5 times/);
  });

  it('aborts a body over the byte cap, with or without Content-Length, or truncates on request', async () => {
    const big = 'x'.repeat(50_000);
    const { origin } = await serve((request, response) => {
      if (request.url === '/chunked') {
        response.writeHead(200, { 'transfer-encoding': 'chunked' });
        for (let index = 0; index < 50; index += 1) {
          response.write('y'.repeat(1000));
        }
        response.end();
        return;
      }
      response.writeHead(200, { 'content-length': String(big.length) });
      response.end(big);
    });
    const http = client({ allowPrivateNetwork: true });

    await expect(http.get(`${origin}/sized`, { maxBytes: 1000 })).rejects.toThrow(
      /50000 bytes, over the 1000 byte limit/
    );
    await expect(http.get(`${origin}/chunked`, { maxBytes: 1000 })).rejects.toThrow(
      /over the 1000 byte limit; download stopped/
    );
    const truncated = await http.get(`${origin}/sized`, { maxBytes: 1000, truncate: true });
    expect(truncated.body.byteLength).toBe(1000);
    expect(truncated.truncated).toBe(true);
  });

  it('times out a request that never answers', async () => {
    const { origin } = await serve(() => {
      // Never respond.
    });
    const http = client({ allowPrivateNetwork: true, totalTimeoutMs: 200, retries: 0 });
    await expect(http.get(`${origin}/slow?token=hunter2`, LIMIT)).rejects.toThrow(
      /GET http:\/\/127\.0\.0\.1:\d+\/slow\?token=\*\*\* failed: timed out after 200 ms/
    );
  });

  it('retries 5xx, 429, and network errors with backoff honoring Retry-After (capped at 30 s)', async () => {
    let calls = 0;
    const { origin } = await serve((request, response) => {
      calls += 1;
      if (request.url === '/flaky') {
        if (calls === 1) {
          response.writeHead(503, { 'retry-after': '2' });
          response.end();
        } else if (calls === 2) {
          response.writeHead(429, { 'retry-after': '120' });
          response.end();
        } else {
          response.end('finally');
        }
        return;
      }
      if (request.url === '/reset') {
        if (calls === 1) {
          request.socket.destroy();
          return;
        }
        response.end('recovered');
        return;
      }
      response.writeHead(404);
      response.end();
    });
    const delays: number[] = [];
    const sleep = async (ms: number) => {
      delays.push(ms);
    };
    const http = client({ allowPrivateNetwork: true, sleep, random: () => 0.5 });

    expect((await http.get(`${origin}/flaky`, LIMIT)).body.toString()).toBe('finally');
    expect(delays).toEqual([2000, 30_000]);

    calls = 0;
    delays.length = 0;
    expect((await http.get(`${origin}/reset`, LIMIT)).body.toString()).toBe('recovered');
    expect(delays).toEqual([750]);

    calls = 0;
    delays.length = 0;
    await expect(http.get(`${origin}/missing`, LIMIT)).rejects.toThrow(/answered HTTP 404/);
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });

  it('gives up after two retries', async () => {
    let calls = 0;
    const { origin } = await serve((_request, response) => {
      calls += 1;
      response.writeHead(500);
      response.end();
    });
    const http = client({ allowPrivateNetwork: true, sleep: async () => {} });
    await expect(http.get(`${origin}/down`, LIMIT)).rejects.toThrow(/answered HTTP 500/);
    expect(calls).toBe(3);
  });

  it("stops at the caller's signal, in flight or during a retry backoff", async () => {
    const inFlight = new AbortController();
    const backoff = new AbortController();
    let unavailableCalls = 0;
    const { origin } = await serve((request, response) => {
      if (request.url === '/hang') {
        // The request has reached the server and no answer is coming.
        inFlight.abort();
        return;
      }
      unavailableCalls += 1;
      response.writeHead(503, { 'retry-after': '30' });
      response.end();
    });
    const sleeps: number[] = [];
    const http = client({
      allowPrivateNetwork: true,
      // A backoff that never ends on its own, aborted the moment it starts: only
      // the signal can finish the request.
      sleep: (ms) => {
        sleeps.push(ms);
        backoff.abort();
        return new Promise(() => undefined);
      },
    });

    await expect(http.get(`${origin}/hang`, { ...LIMIT, signal: inFlight.signal })).rejects.toThrow(
      /GET http:\/\/127\.0\.0\.1:\d+\/hang was cancelled/
    );
    expect(sleeps).toEqual([]);

    await expect(
      http.get(`${origin}/unavailable`, { ...LIMIT, signal: backoff.signal })
    ).rejects.toThrow(/\/unavailable was cancelled/);
    expect(unavailableCalls).toBe(1);
    expect(sleeps).toEqual([30_000]);
  });

  it('runs at most 4 requests per host at once', async () => {
    let active = 0;
    let peak = 0;
    const { origin } = await serve((_request, response) => {
      active += 1;
      peak = Math.max(peak, active);
      setTimeout(() => {
        active -= 1;
        response.end('ok');
      }, 50);
    });
    const http = client({ allowPrivateNetwork: true });
    await Promise.all(
      Array.from({ length: 10 }, (_, index) => http.get(`${origin}/${index}`, LIMIT))
    );
    expect(peak).toBe(4);
  });
});
