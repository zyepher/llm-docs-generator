/**
 * The `urls` and `llms-txt` acquirers (spec 2.3) against a loopback server
 * with LLM_DOCS_ALLOW_PRIVATE_NETWORK=1: stored paths, fetch metadata, the
 * llms.txt filter and stripPrefix, the index hash, and that links inside
 * fetched pages are never followed.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PACK_LIMITS, type ResolvedSourceOfType } from '../../src/config/project.js';
import type { AcquireContext } from '../../src/sources/acquire.js';
import { ALLOW_PRIVATE_NETWORK_ENV } from '../../src/sources/http.js';
import { acquireLlmsTxt, acquireUrls, selectIndexedUrls } from '../../src/sources/web.js';
import { sha256Prefixed } from '../../src/utils/hash.js';

const servers: Server[] = [];
const tempDirs: string[] = [];
let previousAllow: string | undefined;

beforeEach(() => {
  previousAllow = process.env[ALLOW_PRIVATE_NETWORK_ENV];
  process.env[ALLOW_PRIVATE_NETWORK_ENV] = '1';
});

afterEach(async () => {
  if (previousAllow === undefined) {
    delete process.env[ALLOW_PRIVATE_NETWORK_ENV];
  } else {
    process.env[ALLOW_PRIVATE_NETWORK_ENV] = previousAllow;
  }
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolveClose) => {
          server.closeAllConnections();
          server.close(() => resolveClose());
        })
    )
  );
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function serveSite(
  routes: Record<string, string | ((request: IncomingMessage, response: ServerResponse) => void)>
): Promise<{ origin: string; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? '');
    const route = routes[request.url ?? ''];
    if (typeof route === 'function') {
      route(request, response);
    } else if (route === undefined) {
      response.writeHead(404);
      response.end();
    } else {
      response.writeHead(200, {
        'content-type': 'text/markdown',
        etag: `"${sha256Prefixed(route).slice(7, 15)}"`,
      });
      response.end(route);
    }
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('no port');
  }
  return { origin: `http://127.0.0.1:${address.port}`, requests };
}

async function context(): Promise<AcquireContext> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'llm-docs-web-'));
  tempDirs.push(dir);
  return {
    projectRoot: dir,
    packsDir: join(dir, 'agent-docs'),
    workDir: dir,
    maxFileBytes: PACK_LIMITS.defaultMaxFileBytes,
  };
}

const common = {
  mount: '',
  exclude: [],
  passthrough: [],
  convert: null,
  transforms: [],
} as const;

describe('acquireUrls', () => {
  it('fetches exactly the listed URLs with fetch metadata and redirects recorded', async () => {
    const { origin, requests } = await serveSite({
      '/guide/start': '# Start\n\nSee [other](/guide/other).\n',
      '/old': (_request, response) => {
        response.writeHead(301, { location: '/guide/api.md' });
        response.end();
      },
      '/guide/api.md': '# API\n',
    });
    const source: ResolvedSourceOfType<'urls'> = {
      type: 'urls',
      urls: [
        { url: `${origin}/guide/start`, path: 'guide/start.md' },
        { url: `${origin}/old`, path: 'api.md' },
      ],
      include: ['**'],
      ...common,
    };
    const result = await acquireUrls(source, await context());

    expect(result.origin).toEqual({ type: 'urls' });
    expect(result.files.map(({ absolutePath: _, ...file }) => file)).toEqual([
      {
        path: 'guide/start.md',
        url: `${origin}/guide/start`,
        sourceLabel: `${origin}/guide/start`,
        sha256: sha256Prefixed('# Start\n\nSee [other](/guide/other).\n'),
        bytes: 36,
        fetch: { finalUrl: `${origin}/guide/start`, status: 200, etag: expect.any(String) },
      },
      {
        path: 'api.md',
        url: `${origin}/old`,
        sourceLabel: `${origin}/old`,
        sha256: sha256Prefixed('# API\n'),
        bytes: 6,
        fetch: { finalUrl: `${origin}/guide/api.md`, status: 200, etag: expect.any(String) },
      },
    ]);
    expect(await readFile(result.files[1]?.absolutePath ?? '', 'utf-8')).toBe('# API\n');
    // The link inside the fetched page was never followed.
    expect(requests.sort()).toEqual(['/guide/api.md', '/guide/start', '/old']);
  });

  it('fails on an error status and refuses private networks without the switch', async () => {
    const { origin } = await serveSite({});
    const source: ResolvedSourceOfType<'urls'> = {
      type: 'urls',
      urls: [{ url: `${origin}/missing`, path: 'missing.md' }],
      include: ['**'],
      ...common,
    };
    await expect(acquireUrls(source, await context())).rejects.toThrow(/answered HTTP 404/);

    delete process.env[ALLOW_PRIVATE_NETWORK_ENV];
    await expect(acquireUrls(source, await context())).rejects.toThrow(
      /plain http is allowed only to loopback with LLM_DOCS_ALLOW_PRIVATE_NETWORK=1/
    );
  });
});

const INDEX = [
  '# MCP',
  '',
  '## Specification',
  '- [Overview](/specification/2026-07-28/index.md): the spec',
  '- [Transports](/specification/2026-07-28/basic/transports.md "Transports")',
  '- [Transports again](/specification/2026-07-28/basic/transports.md#session)',
  '- [Lifecycle](specification/2026-07-28/basic/lifecycle.md)',
  '- [Old revision](/specification/2025-06-18/index.md)',
  '- [Schema](/specification/2026-07-28/schema)',
  '- [Elsewhere](https://example.com/specification/2026-07-28/x.md)',
  '- ![diagram](/specification/2026-07-28/diagram.png)',
  '',
].join('\n');

describe('selectIndexedUrls', () => {
  it('keeps same-origin links that pass the filter, strips the prefix, and drops duplicates', () => {
    const base = 'https://docs.example.com/llms.txt';
    const planned = selectIndexedUrls(INDEX, [base], {
      url: base,
      include: ['/specification/2026-07-28/**'],
      exclude: ['**/*.png'],
      stripPrefix: '/specification/2026-07-28/',
    });

    expect(planned).toEqual([
      { url: 'https://docs.example.com/specification/2026-07-28/index.md', path: 'index.md' },
      {
        url: 'https://docs.example.com/specification/2026-07-28/basic/transports.md',
        path: 'basic/transports.md',
      },
      {
        url: 'https://docs.example.com/specification/2026-07-28/basic/lifecycle.md',
        path: 'basic/lifecycle.md',
      },
      { url: 'https://docs.example.com/specification/2026-07-28/schema', path: 'schema.md' },
    ]);
    // Globs without a leading slash match too.
    expect(
      selectIndexedUrls(INDEX, [base], {
        url: base,
        include: ['specification/2025-06-18/**'],
        exclude: [],
        stripPrefix: '',
      })
    ).toEqual([
      {
        url: 'https://docs.example.com/specification/2025-06-18/index.md',
        path: 'specification/2025-06-18/index.md',
      },
    ]);
  });

  it('names both URLs when two links map to one stored path', () => {
    const base = 'https://docs.example.com/llms.txt';
    expect(() =>
      selectIndexedUrls('[a](/a)\n[b](/a.md)\n', [base], {
        url: base,
        include: ['**'],
        exclude: [],
        stripPrefix: '',
      })
    ).toThrow(/\/a and https:\/\/docs\.example\.com\/a\.md .* would both be stored at "a\.md"/);
  });
});

describe('acquireLlmsTxt', () => {
  it('fetches the index and the filtered pages, recording the index hash', async () => {
    const pages: Record<string, string> = {
      '/specification/2026-07-28/index.md': '# Overview\n\nRead [lifecycle](basic/lifecycle.md).\n',
      '/specification/2026-07-28/basic/transports.md': '# Transports\n',
      '/specification/2026-07-28/basic/lifecycle.md': '# Lifecycle\n',
      '/specification/2026-07-28/schema': '# Schema\n',
    };
    const { origin, requests } = await serveSite({ '/llms.txt': INDEX, ...pages });
    const source: ResolvedSourceOfType<'llms-txt'> = {
      type: 'llms-txt',
      url: `${origin}/llms.txt`,
      include: ['/specification/2026-07-28/**'],
      stripPrefix: '/specification/2026-07-28',
      ...common,
      exclude: ['**/*.png'],
    };
    const result = await acquireLlmsTxt(source, await context());

    expect(result.origin).toEqual({
      type: 'llms-txt',
      url: `${origin}/llms.txt`,
      sha256: sha256Prefixed(INDEX),
    });
    expect(result.files.map((file) => [file.path, file.url])).toEqual([
      ['index.md', `${origin}/specification/2026-07-28/index.md`],
      ['basic/transports.md', `${origin}/specification/2026-07-28/basic/transports.md`],
      ['basic/lifecycle.md', `${origin}/specification/2026-07-28/basic/lifecycle.md`],
      ['schema.md', `${origin}/specification/2026-07-28/schema`],
    ]);
    expect(requests.sort()).toEqual(['/llms.txt', ...Object.keys(pages)].sort());
  });

  it('refuses a filter that matches nothing', async () => {
    const { origin } = await serveSite({ '/llms.txt': INDEX });
    const source: ResolvedSourceOfType<'llms-txt'> = {
      type: 'llms-txt',
      url: `${origin}/llms.txt`,
      include: ['/nothing/**'],
      stripPrefix: '',
      ...common,
    };
    await expect(acquireLlmsTxt(source, await context())).rejects.toThrow(
      /lists no same-origin https links that pass "include" \(\/nothing\/\*\*\)/
    );
  });
});
