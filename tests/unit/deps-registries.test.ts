import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  defaultCacheDir,
  escapeGoModulePath,
  lookupReleaseDates,
  releaseKey,
  type RegistryEndpoints,
  type ReleaseQuery,
} from '../../src/deps/registries.js';

type Route = (response: ServerResponse) => void | Promise<void>;

interface TestServer {
  base: string;
  requests: { url: string; headers: IncomingHttpHeaders }[];
  close: () => Promise<void>;
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function sendJson(value: unknown, status = 200): Route {
  return (response) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  };
}

async function startServer(routes: Record<string, Route>): Promise<TestServer> {
  const requests: TestServer['requests'] = [];
  const server: Server = createServer((request, response) => {
    const url = request.url ?? '';
    requests.push({ url, headers: request.headers });
    const route = routes[url];

    if (!route) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"error":"not found"}');
      return;
    }

    void route(response);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  cleanups.push(close);

  return { base: `http://127.0.0.1:${port}`, requests, close };
}

async function makeCacheDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'llm-docs-cache-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function endpointsFor(base: string): RegistryEndpoints {
  return {
    depsDev: `${base}/depsdev`,
    npmRegistry: `${base}/npm`,
    pypi: `${base}/pypi-host`,
    cratesIo: `${base}/crates`,
    goProxy: `${base}/goproxy`,
    pubDev: `${base}/pub`,
    githubApi: `${base}/github`,
  };
}

const FIXED_NOW = new Date('2026-11-05T12:00:00.000Z');

describe('lookupReleaseDates', () => {
  it('queries every registry with its documented shape and caches the answers', async () => {
    const server = await startServer({
      '/depsdev/v3/systems/npm/packages/%40tanstack%2Freact-query/versions/5.40.0': sendJson({
        versionKey: { system: 'NPM', name: '@tanstack/react-query', version: '5.40.0' },
        publishedAt: '2024-05-31T10:00:00Z',
      }),
      '/pypi-host/pypi/django/5.1.2/json': sendJson({
        info: { name: 'Django' },
        urls: [
          { upload_time_iso_8601: '2024-10-08T14:16:40.123456Z' },
          { upload_time_iso_8601: '2024-10-08T14:16:35.000000Z' },
        ],
      }),
      '/crates/api/v1/crates/serde/1.0.214': sendJson({
        version: { num: '1.0.214', created_at: '2024-10-28T22:13:25.157463+00:00' },
      }),
      '/goproxy/github.com/!burnt!sushi/toml/@v/v1.4.0.info': sendJson({
        Version: 'v1.4.0',
        Time: '2024-06-06T21:23:24Z',
      }),
      '/pub/api/packages/http': sendJson({
        name: 'http',
        versions: [
          { version: '1.2.1', published: '2024-03-13T18:00:00.000Z' },
          { version: '1.2.2', published: '2024-07-15T20:00:00.000Z' },
        ],
      }),
    });
    const cacheDir = await makeCacheDir();
    const queries: ReleaseQuery[] = [
      { ecosystem: 'npm', name: '@tanstack/react-query', version: '5.40.0' },
      { ecosystem: 'pypi', name: 'django', version: '5.1.2' },
      { ecosystem: 'cargo', name: 'serde', version: '1.0.214' },
      { ecosystem: 'go', name: 'github.com/BurntSushi/toml', version: 'v1.4.0' },
      { ecosystem: 'pub', name: 'http', version: '1.2.2' },
    ];

    const first = await lookupReleaseDates(queries, {
      offline: false,
      cacheDir,
      endpoints: endpointsFor(server.base),
      now: () => FIXED_NOW,
    });

    expect(first.warnings).toEqual([]);
    expect(Object.fromEntries(first.releases)).toEqual({
      'npm:@tanstack/react-query@5.40.0': {
        publishedAt: '2024-05-31T10:00:00.000Z',
        source: 'deps.dev',
        cached: false,
      },
      'pypi:django@5.1.2': {
        publishedAt: '2024-10-08T14:16:35.000Z',
        source: 'pypi',
        cached: false,
      },
      'cargo:serde@1.0.214': {
        publishedAt: '2024-10-28T22:13:25.157Z',
        source: 'crates.io',
        cached: false,
      },
      'go:github.com/BurntSushi/toml@v1.4.0': {
        publishedAt: '2024-06-06T21:23:24.000Z',
        source: 'proxy.golang.org',
        cached: false,
      },
      'pub:http@1.2.2': {
        publishedAt: '2024-07-15T20:00:00.000Z',
        source: 'pub.dev',
        cached: false,
      },
    });
    expect(server.requests).toHaveLength(5);
    expect(
      server.requests.every(
        (request) =>
          /^llm-docs\/\S+ \(\+https:\/\/github\.com\/Zyepher\/llm-docs-generator\)$/.test(
            request.headers['user-agent'] ?? ''
          ) && request.headers.authorization === undefined
      )
    ).toBe(true);

    const cache = JSON.parse(await readFile(join(cacheDir, 'release-dates.json'), 'utf-8'));
    expect(cache.schemaVersion).toBe(1);
    // pub.dev returns every version in one document; all of them are kept.
    expect(cache.entries['pub:http@1.2.1']).toEqual({
      publishedAt: '2024-03-13T18:00:00.000Z',
      source: 'pub.dev',
      fetchedAt: FIXED_NOW.toISOString(),
    });

    const second = await lookupReleaseDates(
      [...queries, { ecosystem: 'pub', name: 'http', version: '1.2.1' }],
      { offline: false, cacheDir, endpoints: endpointsFor(server.base), now: () => FIXED_NOW }
    );

    expect(server.requests).toHaveLength(5);
    expect([...second.releases.values()].every((release) => release.cached)).toBe(true);
  });

  it('falls back to the npm packument time map when deps.dev has no date', async () => {
    const server = await startServer({
      '/npm/@acme%2Fwidget': sendJson({
        name: '@acme/widget',
        time: { created: '2020-01-01T00:00:00.000Z', '2.0.0': '2026-09-01T08:30:00.000Z' },
      }),
    });

    const result = await lookupReleaseDates(
      [{ ecosystem: 'npm', name: '@acme/widget', version: '2.0.0' }],
      {
        offline: false,
        cacheDir: await makeCacheDir(),
        endpoints: endpointsFor(server.base),
        now: () => FIXED_NOW,
      }
    );

    expect(result.releases.get('npm:@acme/widget@2.0.0')).toEqual({
      publishedAt: '2026-09-01T08:30:00.000Z',
      source: 'npm-registry',
      cached: false,
    });
    expect(server.requests.map((request) => request.url)).toEqual([
      '/depsdev/v3/systems/npm/packages/%40acme%2Fwidget/versions/2.0.0',
      '/npm/@acme%2Fwidget',
    ]);
  });

  it('aborts an npm packument larger than 25 MB while streaming', async () => {
    const server = await startServer({
      '/npm/huge': (response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        const padding = ' '.repeat(1024 * 1024);

        for (let index = 0; index < 26; index++) {
          response.write(padding);
        }

        response.end('{"time":{}}');
      },
    });

    const result = await lookupReleaseDates(
      [{ ecosystem: 'npm', name: 'huge', version: '1.0.0' }],
      {
        offline: false,
        cacheDir: await makeCacheDir(),
        endpoints: endpointsFor(server.base),
      }
    );

    expect(result.releases.get('npm:huge@1.0.0')).toEqual({
      publishedAt: null,
      source: 'error',
      cached: false,
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('exceeds 26214400 bytes');
  });

  it('dates SwiftPM GitHub tags through annotated tags and never sends the token elsewhere', async () => {
    const repo = '/github/repos/pointfreeco/swift-snapshot-testing';
    const server = await startServer({
      [`${repo}/git/ref/tags/1.17.5`]: sendJson({
        ref: 'refs/tags/1.17.5',
        object: { type: 'tag', sha: 'aaa111' },
      }),
      [`${repo}/git/tags/aaa111`]: sendJson({
        tag: '1.17.5',
        object: { type: 'commit', sha: 'bbb222' },
      }),
      [`${repo}/git/commits/bbb222`]: sendJson({
        sha: 'bbb222',
        committer: { date: '2024-09-19T17:02:11Z' },
      }),
      '/github/repos/apple/swift-nio/git/ref/tags/v2.76.1': sendJson({
        object: { type: 'commit', sha: 'ccc333' },
      }),
      '/github/repos/apple/swift-nio/git/commits/ccc333': sendJson({
        committer: { date: '2024-11-01T09:00:00Z' },
      }),
    });

    const result = await lookupReleaseDates(
      [
        {
          ecosystem: 'swiftpm',
          name: 'swift-snapshot-testing',
          version: '1.17.5',
          repositoryUrl: 'https://github.com/pointfreeco/swift-snapshot-testing',
        },
        {
          ecosystem: 'swiftpm',
          name: 'swift-nio',
          version: '2.76.1',
          repositoryUrl: 'https://github.com/apple/swift-nio.git',
        },
        {
          ecosystem: 'swiftpm',
          name: 'gitlab-thing',
          version: '1.0.0',
          repositoryUrl: 'https://gitlab.com/acme/gitlab-thing.git',
        },
      ],
      {
        offline: false,
        cacheDir: await makeCacheDir(),
        endpoints: endpointsFor(server.base),
        githubToken: 'ghp_secret',
      }
    );

    expect(result.releases.get('swiftpm:swift-snapshot-testing@1.17.5')?.publishedAt).toBe(
      '2024-09-19T17:02:11.000Z'
    );
    expect(result.releases.get('swiftpm:swift-nio@2.76.1')?.publishedAt).toBe(
      '2024-11-01T09:00:00.000Z'
    );
    expect(result.releases.get('swiftpm:gitlab-thing@1.0.0')).toEqual({
      publishedAt: null,
      source: 'unsupported',
      cached: false,
    });
    // The token goes to api.github.com only; a local override endpoint never sees it.
    expect(server.requests.some((request) => request.headers.authorization !== undefined)).toBe(
      false
    );
  });

  it('caches confirmed absences for 24 hours and does not cache transport errors', async () => {
    let failing = true;
    const server = await startServer({
      '/crates/api/v1/crates/flaky/1.0.0': (response) => {
        if (failing) {
          response.writeHead(503);
          response.end();
          return;
        }

        sendJson({ version: { created_at: '2025-01-02T03:04:05Z' } })(response);
      },
    });
    const cacheDir = await makeCacheDir();
    const queries: ReleaseQuery[] = [
      { ecosystem: 'pypi', name: 'does-not-exist', version: '0.0.1' },
      { ecosystem: 'cargo', name: 'flaky', version: '1.0.0' },
    ];
    let now = FIXED_NOW;
    const options = {
      offline: false,
      cacheDir,
      endpoints: endpointsFor(server.base),
      now: () => now,
    };

    const first = await lookupReleaseDates(queries, options);

    expect(first.releases.get('pypi:does-not-exist@0.0.1')).toEqual({
      publishedAt: null,
      source: 'pypi',
      cached: false,
    });
    expect(first.releases.get('cargo:flaky@1.0.0')).toEqual({
      publishedAt: null,
      source: 'error',
      cached: false,
    });
    expect(first.warnings).toEqual([
      `1 release-date lookup failed: cargo:flaky@1.0.0: HTTP 503 from ${server.base}/crates/api/v1/crates/flaky/1.0.0`,
    ]);

    failing = false;
    now = new Date(FIXED_NOW.getTime() + 60 * 60 * 1000);
    const second = await lookupReleaseDates(queries, options);

    expect(second.releases.get('pypi:does-not-exist@0.0.1')?.cached).toBe(true);
    expect(second.releases.get('cargo:flaky@1.0.0')).toEqual({
      publishedAt: '2025-01-02T03:04:05.000Z',
      source: 'crates.io',
      cached: false,
    });

    const requestsBefore = server.requests.length;
    now = new Date(FIXED_NOW.getTime() + 25 * 60 * 60 * 1000);
    const third = await lookupReleaseDates(queries, options);

    expect(third.releases.get('pypi:does-not-exist@0.0.1')?.cached).toBe(false);
    expect(third.releases.get('cargo:flaky@1.0.0')?.cached).toBe(true);
    expect(server.requests.length).toBe(requestsBefore + 1);
  });

  it('answers from the cache only when offline', async () => {
    const cacheDir = await makeCacheDir();
    await writeFile(
      join(cacheDir, 'release-dates.json'),
      JSON.stringify({
        schemaVersion: 1,
        entries: {
          'npm:vite@6.0.1': {
            publishedAt: '2024-11-26T00:00:00.000Z',
            source: 'deps.dev',
            fetchedAt: '2024-12-01T00:00:00.000Z',
          },
        },
      })
    );

    const result = await lookupReleaseDates(
      [
        { ecosystem: 'npm', name: 'vite', version: '6.0.1' },
        { ecosystem: 'npm', name: 'vite', version: '6.0.2' },
      ],
      { offline: true, cacheDir, endpoints: endpointsFor('http://127.0.0.1:9') }
    );

    expect(Object.fromEntries(result.releases)).toEqual({
      'npm:vite@6.0.1': {
        publishedAt: '2024-11-26T00:00:00.000Z',
        source: 'deps.dev',
        cached: true,
      },
      'npm:vite@6.0.2': { publishedAt: null, source: 'offline', cached: false },
    });
  });

  it('discards a corrupt cache with a warning and rewrites it', async () => {
    const server = await startServer({
      '/goproxy/golang.org/x/sync/@v/v0.8.0.info': sendJson({ Time: '2024-07-31T00:00:00Z' }),
    });
    const cacheDir = await makeCacheDir();
    const cachePath = join(cacheDir, 'release-dates.json');
    await writeFile(cachePath, '{"schemaVersion": 1, "entries": ');

    const result = await lookupReleaseDates(
      [{ ecosystem: 'go', name: 'golang.org/x/sync', version: 'v0.8.0' }],
      { offline: false, cacheDir, endpoints: endpointsFor(server.base) }
    );

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/^Release-date cache .* is unreadable and was discarded: /);
    expect(result.releases.get('go:golang.org/x/sync@v0.8.0')?.publishedAt).toBe(
      '2024-07-31T00:00:00.000Z'
    );
    expect(Object.keys(JSON.parse(await readFile(cachePath, 'utf-8')).entries)).toEqual([
      'go:golang.org/x/sync@v0.8.0',
    ]);
  });

  it('returns null without caching when the budget runs out', async () => {
    const server = await startServer({
      '/crates/api/v1/crates/slow/1.0.0': (response) => {
        setTimeout(
          () => sendJson({ version: { created_at: '2025-01-01T00:00:00Z' } })(response),
          2_000
        );
      },
    });
    const cacheDir = await makeCacheDir();
    const started = Date.now();

    const result = await lookupReleaseDates(
      [
        { ecosystem: 'cargo', name: 'slow', version: '1.0.0' },
        { ecosystem: 'cargo', name: 'slow', version: '1.0.0' },
      ],
      { offline: false, cacheDir, budgetMs: 150, endpoints: endpointsFor(server.base) }
    );

    expect(Date.now() - started).toBeLessThan(1_500);
    expect(result.releases.get('cargo:slow@1.0.0')).toEqual({
      publishedAt: null,
      source: 'budget',
      cached: false,
    });
    expect(result.warnings).toEqual([]);
    await expect(readFile(join(cacheDir, 'release-dates.json'), 'utf-8')).rejects.toThrow();
  });
});

describe('registry helpers', () => {
  it('escapes Go module paths for the proxy protocol', () => {
    expect(escapeGoModulePath('github.com/BurntSushi/toml')).toBe('github.com/!burnt!sushi/toml');
    expect(escapeGoModulePath('golang.org/x/net')).toBe('golang.org/x/net');
  });

  it('builds release keys', () => {
    expect(releaseKey({ ecosystem: 'pypi', name: 'django', version: '5.1.2' })).toBe(
      'pypi:django@5.1.2'
    );
  });

  it('picks the cache directory by override, XDG, then platform', () => {
    expect(
      defaultCacheDir({ env: { LLM_DOCS_CACHE_DIR: '/custom' }, platform: 'linux', homeDir: '/h' })
    ).toBe('/custom');
    expect(
      defaultCacheDir({ env: { XDG_CACHE_HOME: '/xdg' }, platform: 'darwin', homeDir: '/h' })
    ).toBe('/xdg/llm-docs');
    expect(defaultCacheDir({ env: {}, platform: 'darwin', homeDir: '/Users/me' })).toBe(
      '/Users/me/Library/Caches/llm-docs'
    );
    expect(defaultCacheDir({ env: {}, platform: 'linux', homeDir: '/home/me' })).toBe(
      '/home/me/.cache/llm-docs'
    );
    expect(
      defaultCacheDir({
        env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
        platform: 'win32',
        homeDir: 'C:\\Users\\me',
      })
    ).toBe('C:\\Users\\me\\AppData\\Local\\llm-docs\\Cache');
    expect(defaultCacheDir({ env: {}, platform: 'win32', homeDir: 'C:\\Users\\me' })).toBe(
      'C:\\Users\\me\\AppData\\Local\\llm-docs\\Cache'
    );
  });
});
