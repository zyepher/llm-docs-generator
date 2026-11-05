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

describe('specialAddressReason', () => {
  it.each([
    ['127.0.0.1', 'a loopback address'],
    ['10.1.2.3', 'a private address'],
    ['172.20.0.1', 'a private address'],
    ['192.168.1.1', 'a private address'],
    ['169.254.169.254', 'a link-local address (cloud metadata lives here)'],
    ['100.64.0.1', 'a carrier-grade NAT address'],
    ['100.127.255.254', 'a carrier-grade NAT address'],
    ['0.0.0.0', 'an unspecified ("this network") address'],
    ['224.0.0.1', 'a multicast address'],
    ['255.255.255.255', 'a reserved address'],
    ['192.0.2.10', 'a documentation address'],
    ['::', 'an unspecified address'],
    ['::1', 'a loopback address'],
    ['fe80::1', 'a link-local address'],
    ['fd12:3456::1', 'a unique-local address'],
    ['ff02::1', 'a multicast address'],
    ['2001:db8::1', 'a documentation address'],
    ['::ffff:127.0.0.1', 'a loopback address'],
    ['::ffff:a9fe:a9fe', 'a link-local address (cloud metadata lives here)'],
    ['::ffff:10.0.0.1', 'a private address'],
  ])('refuses %s as %s', (address, reason) => {
    expect(specialAddressReason(address)).toBe(reason);
  });

  it.each(['8.8.8.8', '100.128.0.1', '172.32.0.1', '2606:4700::1111', '::ffff:8.8.8.8'])(
    'accepts the public address %s',
    (address) => {
      expect(specialAddressReason(address)).toBeUndefined();
    }
  );
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
