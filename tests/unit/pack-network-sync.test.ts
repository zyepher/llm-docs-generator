/**
 * sync and refresh with network sources: an llms-txt pack built end to end
 * from a loopback server, a sync that skips without touching the network
 * once the recipe hash matches and the outputs verify, --offline, and the
 * refresh report for page and index changes.
 */

import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { syncPacks } from '../../src/pack/build.js';
import { readPackManifest } from '../../src/pack/manifest.js';
import { verifyPacks } from '../../src/pack/verify.js';
import { ALLOW_PRIVATE_NETWORK_ENV } from '../../src/sources/http.js';
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

/** A site whose pages can change between requests; every request path is recorded. */
async function serveSite(pages: Record<string, string>): Promise<{
  origin: string;
  requests: string[];
}> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? '');
    const page = pages[request.url ?? ''];
    if (page === undefined) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/markdown' });
    response.end(page);
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('no port');
  }
  return { origin: `http://127.0.0.1:${address.port}`, requests };
}

async function makeProject(packs: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'llm-docs-net-'));
  tempDirs.push(root);
  await writeFile(join(root, 'llm-docs.json'), JSON.stringify({ schemaVersion: 3, packs }));
  return root;
}

const BANNER =
  '> ## Documentation Index\n> Fetch the complete documentation index at: https://example.com/llms.txt\n> Use this file to discover all available pages before exploring further.\n\n';

function site(): Record<string, string> {
  return {
    '/llms.txt': [
      '# Spec',
      '- [Overview](/spec/2026-07-28/index.md)',
      '- [Transports](/spec/2026-07-28/basic/transports.md)',
      '- [Old](/spec/2025-06-18/index.md)',
      '',
    ].join('\n'),
    '/spec/2026-07-28/index.md': `${BANNER}# Overview\n\nRead [transports](basic/transports.md).\n`,
    '/spec/2026-07-28/basic/transports.md': `${BANNER}# Transports\n\nStdio and HTTP.\n`,
    '/spec/2025-06-18/index.md': '# Old\n',
  };
}

function llmsPack(origin: string): Record<string, unknown> {
  return {
    title: 'Spec',
    version: '2026-07-28',
    license: 'CC-BY-4.0',
    sources: [
      {
        type: 'llms-txt',
        url: `${origin}/llms.txt`,
        include: ['/spec/{version}/**'],
        stripPrefix: '/spec/2026-07-28',
        transforms: ['strip-mintlify-banner'],
      },
    ],
  };
}

describe('network sources in sync and refresh', () => {
  it('builds an llms-txt pack, then skips it without any request while it verifies', async () => {
    const pages = site();
    const { origin, requests } = await serveSite(pages);
    const root = await makeProject({ spec: llmsPack(origin) });

    const first = await syncPacks(root, undefined);
    expect(first.packs[0]).toMatchObject({ status: 'built' });
    expect([...requests].sort()).toEqual([
      '/llms.txt',
      '/spec/2026-07-28/basic/transports.md',
      '/spec/2026-07-28/index.md',
    ]);

    const packDir = join(root, 'agent-docs', 'spec');
    const manifest = await readPackManifest(packDir);
    expect(manifest.origins).toEqual([
      {
        type: 'llms-txt',
        url: `${origin}/llms.txt`,
        sha256: sha256Prefixed(pages['/llms.txt'] ?? ''),
      },
    ]);
    expect(manifest.sources.map((entry) => [entry.path, entry.url, entry.fetch])).toEqual([
      [
        'basic/transports.md',
        `${origin}/spec/2026-07-28/basic/transports.md`,
        { finalUrl: `${origin}/spec/2026-07-28/basic/transports.md`, status: 200 },
      ],
      [
        'index.md',
        `${origin}/spec/2026-07-28/index.md`,
        { finalUrl: `${origin}/spec/2026-07-28/index.md`, status: 200 },
      ],
    ]);
    expect(manifest.transforms).toEqual([{ name: 'strip-mintlify-banner', pages: 2 }]);
    expect(manifest.license).toEqual({
      declared: 'CC-BY-4.0',
      detected: null,
      status: 'attribution',
    });
    const page = await readFile(join(packDir, 'pages', 'index.md'), 'utf-8');
    expect(page).toBe(
      `<!-- llm-docs: spec@2026-07-28 | source: ${origin}/spec/2026-07-28/index.md -->\n\n# Overview\n\nRead [transports](basic/transports.md).\n`
    );
    expect((await verifyPacks(root, undefined)).ok).toBe(true);

    // The upstream moves, but sync never re-fetches a network source whose recipe and outputs hold.
    pages['/spec/2026-07-28/index.md'] = '# Overview, revised\n';
    requests.length = 0;
    const second = await syncPacks(root, undefined, { offline: true });
    expect(second.packs[0]).toMatchObject({ status: 'unchanged' });
    expect(requests).toEqual([]);

    // A stale pack under --offline fails instead of acquiring.
    await writeFile(join(packDir, 'pages', 'index.md'), 'tampered\n');
    const offline = await syncPacks(root, undefined, { offline: true });
    expect(offline.packs[0]).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('needs to acquire network sources'),
    });
    expect(requests).toEqual([]);
  });

  it('refresh reports changed, added, and removed pages and rebuilds unless check', async () => {
    const pages = site();
    const { origin } = await serveSite(pages);
    const root = await makeProject({ spec: llmsPack(origin) });
    await syncPacks(root, undefined);

    const quiet = await syncPacks(root, undefined, { refresh: true, check: true });
    expect(quiet.changed).toBe(false);
    expect(quiet.packs[0]?.refresh?.counts).toEqual({
      unchanged: 2,
      changed: 0,
      added: 0,
      removed: 0,
    });

    pages['/llms.txt'] = [
      '- [Overview](/spec/2026-07-28/index.md)',
      '- [Lifecycle](/spec/2026-07-28/basic/lifecycle.md)',
      '',
    ].join('\n');
    pages['/spec/2026-07-28/index.md'] = '# Overview, revised\n';
    pages['/spec/2026-07-28/basic/lifecycle.md'] = '# Lifecycle\n';

    const checked = await syncPacks(root, undefined, { refresh: true, check: true });
    expect(checked.changed).toBe(true);
    expect(checked.packs[0]).toMatchObject({ status: 'would-build', reason: 'upstream changed' });
    expect(checked.packs[0]?.refresh?.files).toEqual([
      { source: '0:basic/lifecycle.md', output: 'pages/basic/lifecycle.md', status: 'added' },
      { source: '0:basic/transports.md', output: 'pages/basic/transports.md', status: 'removed' },
      { source: '0:index.md', output: 'pages/index.md', status: 'changed' },
    ]);
    expect(
      await readFile(join(root, 'agent-docs', 'spec', 'pages', 'index.md'), 'utf-8')
    ).toContain('# Overview\n');

    const written = await syncPacks(root, undefined, { refresh: true });
    expect(written.packs[0]).toMatchObject({ status: 'built' });
    expect(
      await readFile(join(root, 'agent-docs', 'spec', 'pages', 'index.md'), 'utf-8')
    ).toContain('# Overview, revised\n');
    expect((await verifyPacks(root, undefined)).ok).toBe(true);
    expect((await syncPacks(root, undefined, { refresh: true, check: true })).changed).toBe(false);
  });

  it('refuses to refresh a pack that was never built or whose recipe changed', async () => {
    const { origin } = await serveSite(site());
    const root = await makeProject({ spec: llmsPack(origin) });

    expect((await syncPacks(root, undefined, { refresh: true })).packs[0]?.error).toContain(
      "has no readable manifest to refresh; run 'llm-docs sync spec'"
    );

    await syncPacks(root, undefined);
    await writeFile(
      join(root, 'llm-docs.json'),
      JSON.stringify({
        schemaVersion: 3,
        packs: { spec: { ...llmsPack(origin), title: 'Renamed' } },
      })
    );
    expect((await syncPacks(root, undefined, { refresh: true })).packs[0]?.error).toContain(
      'changed since its last sync'
    );
  });
});
