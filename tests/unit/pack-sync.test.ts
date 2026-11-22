import { createHash } from 'node:crypto';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { canCreateSymlinks } from '../helpers/symlinks.js';

import { BLOCK_BEGIN, BLOCK_END } from '../../src/agent/block.js';
import { syncPacks } from '../../src/pack/build.js';
import { readPackManifest } from '../../src/pack/manifest.js';
import { verifyPacks, type VerifyOptions, type VerifyReport } from '../../src/pack/verify.js';
import { ALLOW_TEMP_SOURCES_ENV } from '../../src/sources/acquire.js';

const tempDirs: string[] = [];
let previousAllow: string | undefined;

beforeEach(() => {
  previousAllow = process.env[ALLOW_TEMP_SOURCES_ENV];
  // Test projects live in the OS temp directory, which local sources normally refuse.
  process.env[ALLOW_TEMP_SOURCES_ENV] = '1';
});

afterEach(async () => {
  if (previousAllow === undefined) {
    delete process.env[ALLOW_TEMP_SOURCES_ENV];
  } else {
    process.env[ALLOW_TEMP_SOURCES_ENV] = previousAllow;
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, ...path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

async function makeProject(
  packs: Record<string, unknown>,
  files: Record<string, string>
): Promise<string> {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'llm-docs-sync-'));
  tempDirs.push(root);
  await writeFiles(root, {
    ...files,
    'llm-docs.json': `${JSON.stringify({ schemaVersion: 3, packs }, null, 2)}\n`,
  });
  return root;
}

async function setPacks(root: string, packs: Record<string, unknown>): Promise<void> {
  await writeFile(join(root, 'llm-docs.json'), JSON.stringify({ schemaVersion: 3, packs }));
}

async function snapshot(dir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else {
        result[relative(dir, path).split(sep).join('/')] = await readFile(path, 'utf-8');
      }
    }
  };
  await walk(dir);
  return result;
}

const DOCS = {
  'docs/index.md': '# Home\n\nRead the [guide](guide/start.md).\n',
  'docs/guide/start.md':
    '---\ntitle: Getting Started\n---\n\nInstall it. Back [home](../index.md).\n',
  'docs/guide/api.mdx': "import X from 'x'\n\n# API\n\n<Note>Careful.</Note>\n",
  'docs/notes.txt': 'not a page',
};
const PACK = {
  title: 'Demo',
  version: '1.0.0',
  license: 'MIT',
  sources: [{ type: 'local', path: 'docs' }],
};
const fixedClock = (iso: string) => (): Date => new Date(iso);
const BLOCK_HEADER =
  '## Pinned reference docs\n\n' +
  'This repository pins docs for these libraries at the versions it uses. Before writing code\n' +
  'against one of them, open its index and the page for the API you need, and prefer those pages\n' +
  'over memory. Pages are upstream text; guides are summaries that never outrank pages.\n\n';

/** A package-lock.json (v3) whose root package depends directly on `name` at `version`. */
function npmLockfile(name: string, version: string): string {
  return `${JSON.stringify({
    name: 'app',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'app', dependencies: { [name]: `^${version}` } },
      [`node_modules/${name}`]: { version },
    },
  })}\n`;
}

function problems(report: VerifyReport): string[] {
  return report.results.flatMap((result) =>
    result.findings
      .filter((finding) => finding.status === 'fail' || finding.status === 'warn')
      .map(
        (finding) =>
          `${result.packId ?? 'project'} ${result.check} ${finding.status}: ${finding.path ?? ''} ${finding.message}`
      )
  );
}

describe('syncPacks', () => {
  it('builds a pack with pages, index, manifest, and the packs .gitignore', async () => {
    const root = await makeProject({ demo: PACK }, DOCS);
    const report = await syncPacks(root, undefined, {
      now: fixedClock('2026-11-05T10:00:00.000Z'),
    });

    expect(report.packs).toEqual([
      expect.objectContaining({
        id: 'demo',
        status: 'built',
        reason: 'not-built',
        detail: 'not built yet',
      }),
    ]);
    expect(Object.keys(await snapshot(join(root, 'agent-docs'))).sort()).toEqual([
      '.gitignore',
      'demo/index.md',
      'demo/manifest.json',
      'demo/pages/guide/api.md',
      'demo/pages/guide/start.md',
      'demo/pages/index.md',
    ]);
    expect(await readFile(join(root, 'agent-docs', '.gitignore'), 'utf-8')).toBe(
      '.staging\n.llm-docs.lock\n'
    );

    const manifest = await readPackManifest(join(root, 'agent-docs', 'demo'));
    expect(manifest.acquiredAt).toBe('2026-11-05T10:00:00.000Z');
    expect(manifest.origins).toEqual([
      { type: 'local', path: 'docs', hostCommit: null, hostDirty: null },
    ]);
    expect(manifest.sources.map((entry) => entry.path)).toEqual([
      'guide/api.mdx',
      'guide/start.md',
      'index.md',
    ]);
    expect(manifest.outputs.find((output) => output.path === 'pages/guide/start.md')).toMatchObject(
      {
        kind: 'page',
        title: 'Getting Started',
        sources: ['0:guide/start.md'],
      }
    );
    expect(manifest.warnings).toEqual([]);
    expect(
      await readFile(join(root, 'agent-docs', 'demo', 'pages', 'guide', 'api.md'), 'utf-8')
    ).toBe('<!-- llm-docs: demo@1.0.0 | source: docs/guide/api.mdx -->\n\n# API\n\nCareful.\n');
    expect((await verifyPacks(root, undefined)).ok).toBe(true);
  });

  it('is deterministic: a second sync skips, and a forced rebuild is byte-identical', async () => {
    const root = await makeProject({ demo: PACK }, DOCS);
    await syncPacks(root, undefined, { now: fixedClock('2026-11-05T10:00:00.000Z') });
    const first = await snapshot(join(root, 'agent-docs'));

    const again = await syncPacks(root, undefined, { now: fixedClock('2027-01-01T00:00:00.000Z') });
    expect(again.packs[0]).toMatchObject({ status: 'unchanged' });
    expect(again.changed).toBe(false);
    expect(await snapshot(join(root, 'agent-docs'))).toEqual(first);

    // Tampering forces a rebuild; with the same sources acquiredAt carries over.
    await writeFile(join(root, 'agent-docs', 'demo', 'pages', 'index.md'), 'tampered');
    const rebuilt = await syncPacks(root, undefined, {
      now: fixedClock('2027-01-01T00:00:00.000Z'),
    });
    expect(rebuilt.packs[0]).toMatchObject({
      status: 'built',
      reason: 'files-differ',
    });
    expect(await snapshot(join(root, 'agent-docs'))).toEqual(first);
  });

  it('rebuilds only what a source edit changes and updates acquiredAt', async () => {
    const root = await makeProject({ demo: PACK }, DOCS);
    await syncPacks(root, undefined, { now: fixedClock('2026-11-05T10:00:00.000Z') });
    const before = await snapshot(join(root, 'agent-docs'));

    await writeFile(
      join(root, 'docs', 'guide', 'start.md'),
      '# Getting Started\n\nNew text. [home](../index.md)\n'
    );
    const report = await syncPacks(root, undefined, {
      now: fixedClock('2026-12-01T00:00:00.000Z'),
    });
    const after = await snapshot(join(root, 'agent-docs'));

    expect(report.packs[0]).toMatchObject({ status: 'built', reason: 'sources-changed' });
    const changed = Object.keys(after).filter((path) => after[path] !== before[path]);
    expect(changed.sort()).toEqual([
      'demo/index.md',
      'demo/manifest.json',
      'demo/pages/guide/start.md',
    ]);
    expect((await readPackManifest(join(root, 'agent-docs', 'demo'))).acquiredAt).toBe(
      '2026-12-01T00:00:00.000Z'
    );
  });

  it('never rebuilds for a guide, and keeps guides across a rebuild', async () => {
    const root = await makeProject({ demo: PACK }, DOCS);
    await syncPacks(root, undefined);
    const built = await snapshot(join(root, 'agent-docs', 'demo'));
    await writeFiles(join(root, 'agent-docs', 'demo'), {
      'guides/01-overview.md': '# Overview digest\n\nSee [start](../pages/guide/start.md).\n',
    });

    const report = await syncPacks(root, undefined);
    expect(report.packs[0]).toMatchObject({ status: 'unchanged' });
    const after = await snapshot(join(root, 'agent-docs', 'demo'));
    delete after['guides/01-overview.md'];
    expect(after).toEqual(built);
    expect(built['index.md']).toContain(
      'Guides, when this pack has any, are the digests in `guides/`'
    );

    await setPacks(root, { demo: { ...PACK, title: 'Renamed' } });
    expect((await syncPacks(root, undefined)).packs[0]).toMatchObject({
      status: 'built',
      reason: 'recipe-edited',
      detail: 'packs.demo in llm-docs.json changed',
    });
    expect(await readdir(join(root, 'agent-docs', 'demo', 'guides'))).toEqual(['01-overview.md']);
    expect(await readdir(join(root, 'agent-docs'))).toEqual(['.gitignore', 'demo']);

    const verify = await verifyPacks(root, undefined);
    expect(verify.ok).toBe(true);
    expect(verify.results.find((result) => result.check === 'unlisted-files')?.findings).toEqual([
      {
        status: 'info',
        path: 'guides/',
        message: '1 agent-owned guide file, not covered by outputs',
      },
    ]);
  });

  it('reports what would change under check without writing', async () => {
    const root = await makeProject({ demo: PACK }, DOCS);
    const check = await syncPacks(root, undefined, { check: true });

    expect(check).toMatchObject({
      check: true,
      changed: true,
      packs: [{ id: 'demo', status: 'would-build' }],
    });
    expect(await readdir(root)).not.toContain('agent-docs');

    await syncPacks(root, undefined);
    expect((await syncPacks(root, undefined, { check: true })).changed).toBe(false);
  });

  it('reports orphans and prunes only tool-made packs without guides', async () => {
    const root = await makeProject({ demo: PACK, old: PACK, keep: PACK }, DOCS);
    await syncPacks(root, undefined);
    await writeFiles(join(root, 'agent-docs'), {
      'keep/guides/g.md': '# G\n',
      'notes/readme.md': 'mine',
    });
    await setPacks(root, { demo: PACK });

    expect((await syncPacks(root, undefined)).orphans).toEqual([
      { id: 'keep', status: 'orphan' },
      { id: 'notes', status: 'orphan' },
      { id: 'old', status: 'orphan' },
    ]);
    expect((await syncPacks(root, undefined, { prune: true, check: true })).orphans).toContainEqual(
      {
        id: 'old',
        status: 'would-prune',
      }
    );

    const pruned = await syncPacks(root, undefined, { prune: true });
    expect(pruned.orphans).toEqual([
      {
        id: 'keep',
        status: 'kept',
        reason: 'it holds guides; move its guides/ elsewhere, then run sync --prune again',
      },
      {
        id: 'notes',
        status: 'kept',
        reason:
          'not an llm-docs pack (no manifest.json), so it is never deleted; remove it by hand',
      },
      { id: 'old', status: 'pruned' },
    ]);
    expect((await readdir(join(root, 'agent-docs'))).sort()).toEqual([
      '.gitignore',
      'demo',
      'keep',
      'notes',
    ]);
  });

  it('warns, without recording it, when the title already holds the version', async () => {
    const root = await makeProject(
      {
        twice: { ...PACK, title: 'Demo v1.0.0', version: '1.0.0' },
        word: { ...PACK, title: 'Web3 SDK', version: '3' },
      },
      DOCS
    );
    const report = await syncPacks(root, undefined);
    const twice = report.packs.find((pack) => pack.id === 'twice');

    expect(twice?.warnings).toContain(
      'The title "Demo v1.0.0" already holds the version 1.0.0, and the index and the managed block add the version after the title, so they show it twice; set packs.twice.title to the library\'s name alone, such as "Demo".'
    );
    expect((await readPackManifest(join(root, 'agent-docs', 'twice'))).warnings).toEqual([]);
    expect(report.packs.find((pack) => pack.id === 'word')?.warnings).toEqual([]);
  });

  it('ignores a version inside a longer one and suggests a clean name', async () => {
    const root = await makeProject(
      {
        vue: { ...PACK, title: 'Vue 1.5', version: '1' },
        lib: { ...PACK, title: 'Lib 3.2.1', version: '2.1' },
        paren: { ...PACK, title: 'Vite (v8.2.0)', version: '8.2.0' },
        dash: { ...PACK, title: 'Vite - 8.2.0', version: '8.2.0' },
      },
      DOCS
    );
    const report = await syncPacks(root, undefined);
    const warnings = (id: string): readonly string[] | undefined =>
      report.packs.find((pack) => pack.id === id)?.warnings;

    expect(warnings('vue')).toEqual([]);
    expect(warnings('lib')).toEqual([]);
    expect(warnings('paren')).toEqual([
      'The title "Vite (v8.2.0)" already holds the version 8.2.0, and the index and the managed block add the version after the title, so they show it twice; set packs.paren.title to the library\'s name alone, such as "Vite".',
    ]);
    expect(warnings('dash')).toEqual([
      'The title "Vite - 8.2.0" already holds the version 8.2.0, and the index and the managed block add the version after the title, so they show it twice; set packs.dash.title to the library\'s name alone, such as "Vite".',
    ]);
  });

  it('updates the managed block last, listing only the packs that built', async () => {
    const root = await makeProject(
      { demo: PACK, broken: { ...PACK, sources: [{ type: 'local', path: 'missing' }] } },
      { ...DOCS, 'AGENTS.md': '# Agents\n' }
    );
    const report = await syncPacks(root, undefined);

    expect(report.packs.map((pack) => pack.status)).toEqual(['built', 'failed']);
    expect(report.agentBlocks).toEqual([{ path: 'AGENTS.md', status: 'updated' }]);
    expect(await readFile(join(root, 'AGENTS.md'), 'utf-8')).toBe(
      `# Agents\n\n${BLOCK_BEGIN}\n${BLOCK_HEADER}- Demo 1.0.0: \`agent-docs/demo/index.md\` (guide)\n${BLOCK_END}\n`
    );

    await writeFiles(join(root, 'agent-docs', 'demo'), { 'guides/notes.md': '# Notes\n' });
    const again = await syncPacks(root, ['demo']);
    expect(again.agentBlocks).toEqual([{ path: 'AGENTS.md', status: 'updated' }]);
    expect(await readFile(join(root, 'AGENTS.md'), 'utf-8')).toContain(
      '- Demo 1.0.0: `agent-docs/demo/index.md` (guide, guides)\n'
    );
    expect((await syncPacks(root, ['demo'])).agentBlocks).toEqual([
      { path: 'AGENTS.md', status: 'unchanged' },
    ]);
  });

  it('reports block drift under check without writing, and fixes it on the next sync', async () => {
    const root = await makeProject({ demo: PACK }, DOCS);
    const fresh = await syncPacks(root, undefined, { check: true });
    expect(fresh.agentBlocks).toEqual([{ path: 'AGENTS.md', status: 'would-create' }]);
    expect(await readdir(root)).not.toContain('AGENTS.md');

    await syncPacks(root, undefined);
    const synced = await readFile(join(root, 'AGENTS.md'), 'utf-8');
    await writeFile(join(root, 'AGENTS.md'), synced.replace('Demo 1.0.0', 'Demo 0.9.0'));

    const drift = await syncPacks(root, undefined, { check: true });
    expect(drift).toMatchObject({
      changed: true,
      packs: [{ id: 'demo', status: 'unchanged' }],
      agentBlocks: [{ path: 'AGENTS.md', status: 'would-update' }],
    });
    expect(await readFile(join(root, 'AGENTS.md'), 'utf-8')).toContain('Demo 0.9.0');

    expect((await syncPacks(root, undefined)).agentBlocks).toEqual([
      { path: 'AGENTS.md', status: 'updated' },
    ]);
    expect(await readFile(join(root, 'AGENTS.md'), 'utf-8')).toBe(synced);
  });

  it('fails fast while another sync holds the lock, and replaces a stale lock', async () => {
    const root = await makeProject({ demo: PACK }, DOCS);
    await mkdir(join(root, 'agent-docs'));
    const lock = join(root, 'agent-docs', '.llm-docs.lock');

    await writeFile(
      lock,
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        command: 'llm-docs sync',
      })
    );
    await expect(syncPacks(root, undefined)).rejects.toThrow(
      /Another llm-docs run holds .*pid \d+/
    );

    await writeFile(
      lock,
      JSON.stringify({ pid: process.pid, startedAt: '2020-01-01T00:00:00.000Z', command: 'x' })
    );
    expect((await syncPacks(root, undefined)).packs[0]).toMatchObject({ status: 'built' });
    expect(await readdir(join(root, 'agent-docs'))).not.toContain('.llm-docs.lock');
  });

  it('cleans leftover staging and restores what an interrupted swap left aside', async () => {
    const root = await makeProject({ demo: PACK }, DOCS);
    await syncPacks(root, undefined);
    const packs = join(root, 'agent-docs');
    await writeFiles(join(packs, 'demo'), { 'guides/g.md': '# G\n' });
    await syncPacks(root, undefined);
    const before = await snapshot(join(packs, 'demo'));

    // Simulate a crash after the old pack was renamed aside, with its guides already
    // moved into the staging pack.
    await mkdir(join(packs, '.staging'), { recursive: true });
    await rm(join(packs, 'demo', 'guides'), { recursive: true });
    await writeFiles(join(packs, '.staging', 'demo-0123456789ab'), {
      'manifest.json': await readFile(join(packs, 'demo', 'manifest.json'), 'utf-8'),
      'guides/g.md': '# G\n',
    });
    await import('node:fs/promises').then(({ rename }) =>
      rename(join(packs, 'demo'), join(packs, '.staging', 'demo-old-abcdef012345'))
    );
    await writeFiles(join(packs, '.staging', 'junk'), { 'x.md': 'x' });

    const report = await syncPacks(root, undefined);
    expect(report.packs[0]?.warnings).toEqual(
      expect.arrayContaining([
        'Restored pack "demo" left aside by an interrupted sync.',
        'Restored the guides of pack "demo" from an interrupted sync.',
      ])
    );
    expect(await readdir(packs)).not.toContain('.staging');
    expect(await snapshot(join(packs, 'demo'))).toEqual(before);
  });

  it.skipIf(!canCreateSymlinks)(
    'refuses a .staging that is a symbolic link, and deletes nothing through it',
    async () => {
      const root = await makeProject({ demo: PACK }, DOCS);
      const packs = join(root, 'agent-docs');
      const victim = join(root, 'victim');
      await writeFiles(victim, { 'keep/data.txt': 'precious', 'notes.txt': 'secret' });
      await mkdir(packs, { recursive: true });
      await symlink(victim, join(packs, '.staging'), 'dir');
      const before = await snapshot(victim);

      await expect(syncPacks(root, undefined)).rejects.toThrow(
        /\.staging is a symbolic link\..*Remove .*\.staging and run the command again/s
      );

      expect(await snapshot(victim)).toEqual(before);
      expect(await readdir(packs)).not.toContain('demo');
    }
  );

  it('refuses a .staging that is a file', async () => {
    const root = await makeProject({ demo: PACK }, DOCS);
    await writeFiles(join(root, 'agent-docs'), { '.staging': 'not a directory' });

    await expect(syncPacks(root, undefined)).rejects.toThrow(/\.staging is not a directory\./);
  });

  it.skipIf(!canCreateSymlinks)(
    'removes a symbolic link left inside .staging by name, without entering or restoring it',
    async () => {
      const root = await makeProject({ demo: PACK }, DOCS);
      await syncPacks(root, undefined);
      const packs = join(root, 'agent-docs');
      const victim = join(root, 'victim');
      // A link named like a pack set aside by an interrupted swap, pointing at a directory
      // that even holds a manifest for that pack id.
      await writeFiles(victim, {
        'manifest.json': await readFile(join(packs, 'demo', 'manifest.json'), 'utf-8'),
        'guides/g.md': '# G\n',
        'data.txt': 'precious',
      });
      await rm(join(packs, 'demo'), { recursive: true });
      await mkdir(join(packs, '.staging'));
      await symlink(victim, join(packs, '.staging', 'demo-old-abcdef012345'), 'dir');
      await symlink(victim, join(packs, '.staging', 'demo-0123456789ab'), 'dir');
      const before = await snapshot(victim);

      const report = await syncPacks(root, undefined);

      expect(report.packs[0]).toMatchObject({ id: 'demo', status: 'built' });
      expect(report.packs[0]?.warnings.join(' ')).not.toMatch(/Restored/);
      expect(await snapshot(victim)).toEqual(before);
      expect(await readdir(packs)).not.toContain('.staging');
      expect(await readdir(join(packs, 'demo'))).not.toContain('guides');
    }
  );

  it.skipIf(!canCreateSymlinks)(
    'refuses a pack directory or guides/ that is a symbolic link, and builds nothing through it',
    async () => {
      const root = await makeProject({ demo: PACK }, DOCS);
      await syncPacks(root, undefined);
      const packs = join(root, 'agent-docs');
      const outside = join(root, 'outside');
      await cp(join(packs, 'demo'), outside, { recursive: true });
      await rm(join(packs, 'demo'), { recursive: true });
      await symlink(outside, join(packs, 'demo'), 'dir');
      await writeFiles(root, { 'docs/index.md': '# Home, edited\n' });
      const before = await snapshot(outside);

      const report = await syncPacks(root, undefined);

      expect(report.packs[0]).toMatchObject({ id: 'demo', status: 'failed', exitCode: 2 });
      expect(report.packs[0]?.error).toBe(
        `${join(packs, 'demo')} is a symbolic link. llm-docs only builds packs and keeps guides in real directories, and never writes through a link; replace ${join(packs, 'demo')} with a real directory holding the files it points at, then run the command again.`
      );
      expect(await snapshot(outside)).toEqual(before);

      await rm(join(packs, 'demo'));
      await cp(outside, join(packs, 'demo'), { recursive: true });
      const guides = join(root, 'my-guides');
      await writeFiles(guides, { 'g.md': '# G\n' });
      await symlink(guides, join(packs, 'demo', 'guides'), 'dir');

      const guidesLinked = await syncPacks(root, undefined);
      expect(guidesLinked.packs[0]).toMatchObject({ status: 'failed', exitCode: 2 });
      expect(guidesLinked.packs[0]?.error).toMatch(/demo[\\/]guides is a symbolic link\./);
      expect(await snapshot(guides)).toEqual({ 'g.md': '# G\n' });
      expect(await readdir(packs)).not.toContain('.staging');
    }
  );

  it.skipIf(!canCreateSymlinks)(
    'refuses a packs .gitignore that is a symbolic link, leaving its target alone',
    async () => {
      const root = await makeProject({ demo: PACK }, DOCS);
      await writeFiles(root, { 'outside.txt': 'outside\n' });
      await mkdir(join(root, 'agent-docs'));
      await symlink(join(root, 'outside.txt'), join(root, 'agent-docs', '.gitignore'));

      await expect(syncPacks(root, undefined)).rejects.toThrow(
        /\.gitignore is a symbolic link, not a regular file\. llm-docs adds \.staging and \.llm-docs\.lock to that file/
      );
      expect(await readFile(join(root, 'outside.txt'), 'utf-8')).toBe('outside\n');
    }
  );

  it('rejects output collisions that differ only by case or extension', async () => {
    const root = await makeProject(
      { demo: PACK },
      { 'docs/Guide.md': '# A\n', 'docs/guide.mdx': '# B\n' }
    );
    const report = await syncPacks(root, undefined);

    expect(report.packs[0]).toMatchObject({ status: 'failed', exitCode: 2 });
    expect(report.packs[0]?.error).toMatch(
      /0:Guide\.md and 0:guide\.mdx would both be written to pages\/Guide\.md/
    );
  });

  it('rejects output paths that a case- and normalization-insensitive file system would merge', async () => {
    const pairs = [
      ['ſ.md', 's.mdx'],
      ['Straße.md', 'STRASSE.mdx'],
      ['µ.md', 'μ.mdx'],
      ['ς.md', 'σ.mdx'],
      ['ﬀ.md', 'ff.mdx'],
    ];
    for (const [first = '', second = ''] of pairs) {
      const root = await makeProject(
        { demo: PACK },
        { [`docs/${first}`]: '# A\n', [`docs/${second}`]: '# B\n' }
      );
      const report = await syncPacks(root, undefined);

      expect(report.packs[0], first).toMatchObject({ status: 'failed', exitCode: 2 });
      expect(report.packs[0]?.error).toMatch(/would both be written to pages\/.* and pages\//);
      expect(report.packs[0]?.error).toContain(`0:${first}`);
      expect(report.packs[0]?.error).toContain(`0:${second}`);
    }

    const root = await makeProject(
      {
        demo: {
          ...PACK,
          sources: [
            { type: 'local', path: 'one' },
            { type: 'local', path: 'two' },
          ],
        },
      },
      { 'one/Guide/a.md': '# A\n', 'two/guide/b.md': '# B\n' }
    );
    const report = await syncPacks(root, undefined);
    expect(report.packs[0]).toMatchObject({ status: 'failed', exitCode: 2 });
    expect(report.packs[0]?.error).toMatch(
      /0:Guide\/a\.md and 1:guide\/b\.md would both be written to pages\/Guide and pages\/guide, one path/
    );
  });

  it('rejects Windows-reserved output names', async () => {
    const root = await makeProject({ demo: PACK }, { 'docs/con.md': '# Con\n' });
    expect((await syncPacks(root, undefined)).packs[0]?.error).toMatch(
      /"con\.md" is a reserved name on Windows/
    );
  });

  it('refuses a local source in the OS temp directory unless explicitly allowed', async () => {
    const root = await makeProject({ demo: PACK }, DOCS);
    delete process.env[ALLOW_TEMP_SOURCES_ENV];
    const report = await syncPacks(root, undefined);

    expect(report.packs[0]).toMatchObject({ status: 'failed', exitCode: 2 });
    expect(report.packs[0]?.error).toMatch(
      /is in the OS temp directory .*LLM_DOCS_ALLOW_TEMP_SOURCES=1/
    );
  });

  it.skipIf(!canCreateSymlinks)(
    'rejects a selected symlink and a source that escapes the project',
    async () => {
      const root = await makeProject(
        { demo: PACK },
        { 'docs/a.md': '# A\n', 'outside/b.md': '# B\n' }
      );
      await symlink(join(root, 'outside', 'b.md'), join(root, 'docs', 'b.md'));
      expect((await syncPacks(root, undefined)).packs[0]?.error).toMatch(
        /docs\/b\.md is a symbolic link/
      );

      await setPacks(root, {
        demo: { ...PACK, sources: [{ type: 'local', path: 'docs', exclude: ['b.md'] }] },
      });
      expect((await syncPacks(root, undefined)).packs[0]).toMatchObject({ status: 'built' });

      const outside = await mkdtemp(join(await realpath(tmpdir()), 'llm-docs-outside-'));
      tempDirs.push(outside);
      await symlink(outside, join(root, 'linked'));
      await setPacks(root, { demo: { ...PACK, sources: [{ type: 'local', path: 'linked' }] } });
      expect((await syncPacks(root, undefined)).packs[0]?.error).toMatch(
        /resolves outside the project/
      );
    }
  );

  it('turns a dead relative link into plain text, and links the target once it is carried', async () => {
    const root = await makeProject(
      { demo: PACK },
      { 'docs/a.md': '# A\n\n![diagram](img/d.png) and [code](`x`)\n', 'docs/img/d.png': 'png' }
    );
    const built = await syncPacks(root, undefined);
    const page = join(root, 'agent-docs', 'demo', 'pages', 'a.md');
    let manifest = await readPackManifest(join(root, 'agent-docs', 'demo'));

    expect(built.packs[0]?.status).toBe('built');
    expect(await readFile(page, 'utf-8')).toContain(
      '[diagram] (unresolved: img/d.png) and [code] (unresolved: `x`)'
    );
    expect(manifest.links.unresolved).toEqual([
      { page: 'pages/a.md', target: '`x`', reason: 'not-found' },
      { page: 'pages/a.md', target: 'img/d.png', reason: 'not-in-pack' },
    ]);
    expect(manifest.warnings).toContain(
      '2 unresolvable relative links were converted to plain text.'
    );

    await setPacks(root, {
      demo: { ...PACK, sources: [{ type: 'local', path: 'docs', passthrough: ['img/**'] }] },
    });
    expect((await syncPacks(root, undefined)).packs[0]?.status).toBe('built');
    manifest = await readPackManifest(join(root, 'agent-docs', 'demo'));
    expect(await readFile(page, 'utf-8')).toContain('![diagram](../files/img/d.png)');
    expect(manifest.links.unresolved.map((entry) => entry.target)).toEqual(['`x`']);
    expect((await verifyPacks(root, undefined, { strict: true })).ok).toBe(true);
  });

  it('carries passthrough files byte-identical and warns about unhandled included files', async () => {
    const root = await makeProject(
      {
        demo: {
          ...PACK,
          sources: [
            { type: 'local', path: 'docs', include: ['**/*'], passthrough: ['schema/*.json'] },
          ],
        },
      },
      {
        'docs/a.md': '# A\n',
        'docs/schema/s.json': '{"a":\r\n1}',
        'docs/x.png': 'p',
        'docs/y.png': 'p',
      }
    );
    const report = await syncPacks(root, undefined);
    const manifest = await readPackManifest(join(root, 'agent-docs', 'demo'));

    expect(
      await readFile(join(root, 'agent-docs', 'demo', 'files', 'schema', 's.json'), 'utf-8')
    ).toBe('{"a":\r\n1}');
    expect(manifest.outputs.find((output) => output.kind === 'passthrough')?.path).toBe(
      'files/schema/s.json'
    );
    expect(manifest.warnings).toEqual([
      'Skipped 2 included files with no page handler (.png: 2); list them under "passthrough" to carry them byte-identical.',
    ]);
    expect(report.packs[0]?.warnings).toContain(manifest.warnings[0]);
    expect(await readFile(join(root, 'agent-docs', 'demo', 'index.md'), 'utf-8')).toMatch(
      /\n## Files\n\nThese files are byte-identical copies of the upstream files, kept as they are rather than converted to pages\.\n\n- \[schema\/s\.json\]\(files\/schema\/s\.json\) \(9 bytes\)\n$/
    );
    expect(await readFile(join(root, 'AGENTS.md'), 'utf-8')).toContain(
      '- Demo 1.0.0: `agent-docs/demo/index.md` (files)\n'
    );

    await writeFiles(join(root, 'agent-docs', 'demo'), { 'guides/notes.md': '# Notes\n' });
    await syncPacks(root, ['demo']);
    expect(await readFile(join(root, 'AGENTS.md'), 'utf-8')).toContain(
      '- Demo 1.0.0: `agent-docs/demo/index.md` (files, guides)\n'
    );
  });

  it('applies mount, records transforms, and reports unsupported sources clearly', async () => {
    const root = await makeProject(
      {
        demo: {
          ...PACK,
          sources: [
            {
              type: 'local',
              path: 'docs',
              mount: 'v1',
              transforms: ['strip-html-comments', 'strip-mintlify-banner'],
            },
          ],
        },
      },
      { 'docs/a.md': '# A\n<!-- c -->\n', 'docs/b.md': '# B\n' }
    );
    await syncPacks(root, undefined);
    const manifest = await readPackManifest(join(root, 'agent-docs', 'demo'));

    expect(manifest.outputs.map((output) => output.path)).toEqual([
      'index.md',
      'pages/v1/a.md',
      'pages/v1/b.md',
    ]);
    expect(manifest.transforms).toEqual([
      { name: 'strip-html-comments', pages: 1 },
      { name: 'strip-mintlify-banner', pages: 0 },
    ]);

    await setPacks(root, {
      demo: { ...PACK, sources: [{ type: 'git', repo: 'https://127.0.0.1/a/b', ref: 'v1' }] },
    });
    expect((await syncPacks(root, undefined)).packs[0]).toMatchObject({
      status: 'failed',
      exitCode: 2,
      error: expect.stringMatching(/127\.0\.0\.1 is a loopback address/),
    });
  });

  describe('readFirst', () => {
    const FILES = {
      ...DOCS,
      'docs/guide/migration.md':
        '# Migrating to v1\n\n## Breaking `changes`\n\nRenamed.\n\n## Removed APIs\n\nGone.\n',
      'docs/CHANGES.txt': 'v1: everything\n',
    };
    const READ_FIRST_PACK = {
      ...PACK,
      layout: { combined: true },
      sources: [{ type: 'local', path: 'docs', passthrough: ['CHANGES.txt'] }],
      readFirst: [
        'pages/guide/migration.md',
        'pages/guide/migration.md#breaking-changes',
        'files/CHANGES.txt',
      ],
    };

    it('lists the targets in the index under the reading notes, verifies strictly, and is deterministic', async () => {
      const root = await makeProject({ demo: READ_FIRST_PACK }, FILES);
      const report = await syncPacks(root, undefined, {
        now: fixedClock('2026-11-05T10:00:00.000Z'),
      });
      expect(report.packs[0]).toMatchObject({ status: 'built' });

      const index = await readFile(join(root, 'agent-docs', 'demo', 'index.md'), 'utf-8');
      expect(index).toContain(
        [
          'never outrank them.',
          '',
          '## Read first',
          '',
          'Start with these pages before writing code against Demo 1.0.0. They were marked as the ones to read first for this version, usually because they describe what changed.',
          '',
          '- [Migrating to v1](pages/guide/migration.md)',
          '- [Migrating to v1: Breaking changes](pages/guide/migration.md#breaking-changes)',
          '- [files/CHANGES.txt](files/CHANGES.txt)',
          '',
          '## Pages',
        ].join('\n')
      );
      const combined = await readFile(join(root, 'agent-docs', 'demo', 'demo.full.md'), 'utf-8');
      expect(combined).toContain(
        '- [Migrating to v1: Breaking changes](#guide-migration--breaking-changes)'
      );
      expect(combined).toContain('<a id="guide-migration--breaking-changes"></a>');

      const manifest = await readPackManifest(join(root, 'agent-docs', 'demo'));
      expect(manifest.recipe.readFirst).toEqual(READ_FIRST_PACK.readFirst);
      expect(problems(await verifyPacks(root, undefined, { strict: true }))).toEqual([]);

      const first = await snapshot(join(root, 'agent-docs'));
      expect((await syncPacks(root, undefined)).packs[0]).toMatchObject({ status: 'unchanged' });
      await writeFile(join(root, 'agent-docs', 'demo', 'index.md'), 'tampered');
      expect((await syncPacks(root, undefined)).packs[0]).toMatchObject({ status: 'built' });
      expect(await snapshot(join(root, 'agent-docs'))).toEqual(first);
    });

    it('substitutes placeholders in targets', async () => {
      const root = await makeProject(
        {
          demo: {
            ...PACK,
            version: '2.4.1',
            readFirst: ['pages/v{major}/upgrade.md#to-{major}{minor}'],
          },
        },
        { 'docs/v2/upgrade.md': '# Upgrade\n\n## To 2.4\n\nSteps.\n' }
      );
      await syncPacks(root, undefined);
      expect(await readFile(join(root, 'agent-docs', 'demo', 'index.md'), 'utf-8')).toContain(
        '- [Upgrade: To 2.4](pages/v2/upgrade.md#to-24)'
      );
    });

    it('fails the build on any target that does not resolve, with hints, and keeps the previous pack', async () => {
      const root = await makeProject({ demo: READ_FIRST_PACK }, FILES);
      await syncPacks(root, undefined);
      const before = await snapshot(join(root, 'agent-docs'));
      const cases: [string[], string][] = [
        [
          ['pages/guide/migration.md', 'pages/guide/migrations.md'],
          'packs.demo.readFirst[1] "pages/guide/migrations.md" does not resolve: no page or passthrough file in the built pack has this path (nearest: pages/guide/migration.md, pages/guide/api.md, pages/guide/start.md, pages/index.md, files/CHANGES.txt). Edit packs.demo.readFirst in llm-docs.json.',
        ],
        [
          ['pages/guide/migration.md#breaking'],
          'packs.demo.readFirst[0] "pages/guide/migration.md#breaking" does not resolve: no heading on pages/guide/migration.md has the slug "breaking" (nearest: #breaking-changes, #removed-apis, #migrating-to-v1). Edit packs.demo.readFirst in llm-docs.json.',
        ],
        [
          ['files/CHANGES.txt#v1'],
          'packs.demo.readFirst[0] "files/CHANGES.txt#v1" does not resolve: a fragment only resolves on a Markdown file. Edit packs.demo.readFirst in llm-docs.json.',
        ],
      ];

      for (const [readFirst, error] of cases) {
        await setPacks(root, { demo: { ...READ_FIRST_PACK, readFirst } });
        const report = await syncPacks(root, undefined);
        expect(report.packs[0], readFirst.join(' ')).toMatchObject({
          status: 'failed',
          exitCode: 2,
          error,
        });
        expect(await snapshot(join(root, 'agent-docs'))).toEqual(before);
      }
    });

    it('leaves a pack built without the field up to date and its outputs unchanged', async () => {
      const root = await makeProject({ demo: PACK }, DOCS);
      await syncPacks(root, undefined, { now: fixedClock('2026-11-05T10:00:00.000Z') });
      const manifest = await readPackManifest(join(root, 'agent-docs', 'demo'));

      expect(Object.hasOwn(manifest.recipe, 'readFirst')).toBe(false);
      expect(await readFile(join(root, 'agent-docs', 'demo', 'index.md'), 'utf-8')).not.toContain(
        '## Read first'
      );
      expect((await syncPacks(root, undefined)).packs[0]).toMatchObject({ status: 'unchanged' });
      expect(problems(await verifyPacks(root, undefined))).toEqual([]);
    });
  });

  it('refuses to overwrite a directory that is not a pack, and names unknown ids', async () => {
    const root = await makeProject(
      { demo: PACK },
      { ...DOCS, 'agent-docs/demo/mine.md': 'hand-written' }
    );
    expect((await syncPacks(root, undefined)).packs[0]?.error).toMatch(/is not an llm-docs pack/);
    await expect(syncPacks(root, ['nope'])).rejects.toThrow(/No pack "nope"/);
  });
});

describe('verifyPacks', () => {
  async function builtProject(): Promise<string> {
    const root = await makeProject({ demo: PACK }, DOCS);
    await syncPacks(root, undefined);
    return root;
  }

  it('fails outputs on a tampered or missing file', async () => {
    const root = await builtProject();
    await writeFile(join(root, 'agent-docs', 'demo', 'pages', 'index.md'), 'changed');
    await rm(join(root, 'agent-docs', 'demo', 'pages', 'guide', 'api.md'));

    expect(problems(await verifyPacks(root, undefined))).toEqual([
      "demo outputs fail: pages/guide/api.md listed output is missing; run 'llm-docs sync demo' to rebuild the pack",
      "demo outputs fail: pages/index.md content differs from the manifest (hash mismatch); pack files are tool-written, so run 'llm-docs sync demo' to restore it",
      'demo links fail: index.md link target is not a file in the pack: pages/guide/api.md',
    ]);
  });

  it('fails on an unlisted file and treats OS junk as info', async () => {
    const root = await builtProject();
    await writeFiles(join(root, 'agent-docs', 'demo'), { 'pages/extra.md': 'x', '.DS_Store': 'x' });
    const report = await verifyPacks(root, undefined);

    expect(problems(report)).toEqual([
      "demo unlisted-files fail: pages/extra.md file is not listed in the manifest; move it into guides/ if it is yours, or run 'llm-docs sync demo' to remove it",
    ]);
    expect(
      report.results.find((result) => result.check === 'unlisted-files')?.findings
    ).toContainEqual({
      status: 'info',
      path: '.DS_Store',
      message: 'operating system file, ignored',
    });
  });

  it('fails a broken link (and outputs, since the page changed)', async () => {
    const root = await builtProject();
    const page = join(root, 'agent-docs', 'demo', 'pages', 'index.md');
    await writeFile(
      page,
      `${await readFile(page, 'utf-8')}\n[gone](missing.md) [up](../../x.md) [site](/abs) [web](https://x.dev) [frag](#nope) \`[code](no.md)\`\n`
    );

    expect(
      problems(await verifyPacks(root, ['demo'])).filter((line) => line.includes(' links '))
    ).toEqual([
      'demo links fail: pages/index.md link target is not a file in the pack: missing.md',
      'demo links fail: pages/index.md link points outside the pack: ../../x.md',
      'demo links fail: pages/index.md site-absolute link does not resolve inside the pack: /abs',
    ]);
    expect(
      problems(await verifyPacks(root, ['demo'], { strict: true })).filter((line) =>
        line.includes('fragment')
      )
    ).toEqual([
      'demo links warn: pages/index.md fragment matches no heading on this page; the anchor comes from the upstream text and the link target page exists, so the link still opens that page: #nope',
    ]);
  });

  it('under --strict, matches upstream anchors loosely and only warns for a page fragment that matches nothing', async () => {
    const root = await makeProject(
      {
        demo: {
          ...PACK,
          sources: [{ type: 'local', path: 'docs', passthrough: ['schema.json'] }],
        },
      },
      {
        'docs/index.md': [
          '# Home',
          '',
          '[ref](guide.md#$ref-resolution) [scheme](guide.md#https//) [same](#home)',
          '[logs](guide.md#getting-logs-from-claude-desktop) [mine](#not-here)',
          '[file](schema.json#defs)',
          '',
        ].join('\n'),
        'docs/guide.md': [
          '# Guide',
          '',
          '## `$ref` Resolution',
          '',
          '## https://',
          '',
          '> [accordion] Getting logs from Claude Desktop',
          '',
        ].join('\n'),
        'docs/schema.json': '{}\n',
      }
    );
    expect((await syncPacks(root, undefined)).packs[0]?.status).toBe('built');

    const report = await verifyPacks(root, undefined, { strict: true });
    expect(report.ok).toBe(true);
    expect(problems(report)).toEqual([
      'demo links warn: pages/index.md fragment matches no heading in the target page; the anchor comes from the upstream text and the link target page exists, so the link still opens that page: guide.md#getting-logs-from-claude-desktop',
      'demo links warn: pages/index.md fragment matches no heading on this page; the anchor comes from the upstream text and the link target page exists, so the link still opens that page: #not-here',
    ]);
    expect(problems(await verifyPacks(root, undefined))).toEqual([]);

    // The index is written by the build, so a fragment there that matches nothing fails.
    const index = join(root, 'agent-docs', 'demo', 'index.md');
    await writeFile(index, `${await readFile(index, 'utf-8')}\n[x](pages/guide.md#nope)\n`);
    expect(
      problems(await verifyPacks(root, undefined, { strict: true })).filter((line) =>
        line.includes(' links fail')
      )
    ).toEqual([
      'demo links fail: index.md fragment matches no heading in the target page: pages/guide.md#nope',
    ]);
  });

  it('fails recipe when the config changes and warns for an orphan', async () => {
    const root = await builtProject();
    await setPacks(root, { demo: { ...PACK, version: '2.0.0' } });
    expect(problems(await verifyPacks(root, undefined))).toEqual([
      "demo recipe fail:  packs.demo in llm-docs.json changed since the last sync; run 'llm-docs sync demo'",
    ]);

    await setPacks(root, {});
    const orphan =
      'demo recipe warn:  orphan pack: llm-docs.json has no pack "demo"; delete it with \'llm-docs sync --prune\', or add packs.demo back to llm-docs.json';
    // The block still lists the pack the config dropped until the next sync.
    expect(problems(await verifyPacks(root, undefined))).toEqual([
      "project agent-block fail: AGENTS.md the llm-docs block differs from what sync would write; run 'llm-docs sync'",
      orphan,
    ]);

    await syncPacks(root, undefined);
    const report = await verifyPacks(root, undefined);
    expect(report.ok).toBe(true);
    expect(problems(report)).toEqual([orphan]);
  });

  it('checks each managed block against what sync would write', async () => {
    const root = await builtProject();
    const agentBlock = async () =>
      (await verifyPacks(root, undefined)).results.find((result) => result.check === 'agent-block');
    const synced = await readFile(join(root, 'AGENTS.md'), 'utf-8');

    expect(await agentBlock()).toMatchObject({ packId: null, status: 'pass', findings: [] });

    await writeFile(join(root, 'AGENTS.md'), synced.replace('(guide)', '(guide, extra)'));
    expect(await agentBlock()).toMatchObject({
      status: 'fail',
      findings: [
        {
          status: 'fail',
          path: 'AGENTS.md',
          message: "the llm-docs block differs from what sync would write; run 'llm-docs sync'",
        },
      ],
    });

    await writeFile(join(root, 'AGENTS.md'), '# Agents\n');
    expect((await agentBlock())?.findings).toEqual([
      {
        status: 'fail',
        path: 'AGENTS.md',
        message: "has no llm-docs block; run 'llm-docs sync' to add it",
      },
    ]);

    await rm(join(root, 'AGENTS.md'));
    const missing = await verifyPacks(root, undefined);
    expect(missing.ok).toBe(true);
    expect(problems(missing)).toEqual([
      "project agent-block warn: AGENTS.md does not exist; 'llm-docs sync' creates it with the llm-docs block",
    ]);
  });

  it('verifies configured packs in config order, then orphan packs sorted', async () => {
    const root = await makeProject({ zeta: PACK, mid: PACK, alpha: PACK }, DOCS);
    await syncPacks(root, undefined);
    await setPacks(root, { zeta: PACK, mid: PACK });
    await cp(join(root, 'agent-docs', 'mid'), join(root, 'agent-docs', 'beta'), {
      recursive: true,
    });
    await mkdir(join(root, 'agent-docs', 'not-a-pack'));

    const report = await verifyPacks(root, undefined);
    expect([...new Set(report.results.map((result) => result.packId))]).toEqual([
      null,
      'zeta',
      'mid',
      'alpha',
      'beta',
    ]);
    expect(problems(report)).toContain(
      `beta manifest-schema fail: manifest.json manifest.json belongs to pack "mid", not "beta"; llm-docs.json has no pack "beta", so delete agent-docs/beta/ or add it back to llm-docs.json`
    );
  });

  it("checks the lockfile against the project's own lockfiles", async () => {
    const root = await makeProject(
      { demo: { ...PACK, dependency: { ecosystem: 'npm', name: 'demo' } } },
      { ...DOCS, 'package-lock.json': npmLockfile('demo', '1.0.0') }
    );
    await syncPacks(root, undefined);
    const lockfile = async () =>
      (await verifyPacks(root, undefined)).results.find((result) => result.check === 'lockfile');

    expect(await lockfile()).toMatchObject({ status: 'pass' });

    await writeFile(join(root, 'package-lock.json'), npmLockfile('demo', '1.1.0'));
    expect(await lockfile()).toMatchObject({
      status: 'fail',
      findings: [
        {
          status: 'fail',
          message:
            "stale-pack: lockfiles resolve npm:demo 1.1.0 (package-lock.json), the pack is 1.0.0; set packs.demo.version in llm-docs.json to 1.1.0 (or remove it to follow the lockfile), then run 'llm-docs sync demo'",
        },
      ],
    });

    await rm(join(root, 'package-lock.json'));
    expect((await lockfile())?.findings[0]?.message).toBe(
      'no lockfile resolves npm:demo (searched: none found); install the dependency, or remove packs.demo.dependency from llm-docs.json'
    );
  });

  it("checks a toolchain pack against the project's version files", async () => {
    const root = await makeProject(
      {
        python: {
          ...PACK,
          version: '3.14',
          dependency: { ecosystem: 'toolchain', name: 'python' },
        },
      },
      { ...DOCS, '.python-version': '3.14.2\n' }
    );
    await syncPacks(root, undefined);
    const lockfile = async () =>
      (await verifyPacks(root, undefined)).results.find((result) => result.check === 'lockfile');

    expect(await lockfile()).toMatchObject({ status: 'pass' });

    await writeFile(join(root, '.python-version'), '3.15.0\n');
    expect(await lockfile()).toMatchObject({
      status: 'fail',
      findings: [
        {
          status: 'fail',
          message:
            "stale-pack: the project's files state toolchain:python 3.15 (.python-version), the pack is 3.14; set packs.python.version in llm-docs.json to 3.15 (or remove it to follow the project's files), then run 'llm-docs sync python'",
        },
      ],
    });

    await rm(join(root, '.python-version'));
    expect((await lockfile())?.findings[0]?.message).toBe(
      'no file in the project states a version of toolchain:python (files that can: .python-version, .tool-versions, Pipfile, pyproject.toml); state the version in one of them, or remove packs.python.dependency from llm-docs.json'
    );
  });

  it('takes a dependency-bound version from the lockfile and rebuilds when it moves', async () => {
    const pack = { ...PACK, version: undefined, dependency: { ecosystem: 'npm', name: 'demo' } };
    const root = await makeProject(
      { demo: pack },
      { ...DOCS, 'package-lock.json': npmLockfile('demo', '2.0.0') }
    );

    expect((await syncPacks(root, undefined)).packs[0]).toMatchObject({ status: 'built' });
    expect((await readPackManifest(join(root, 'agent-docs', 'demo'))).pack.version).toBe('2.0.0');
    expect((await verifyPacks(root, undefined)).ok).toBe(true);

    await writeFile(join(root, 'package-lock.json'), npmLockfile('demo', '2.1.0'));
    expect((await syncPacks(root, undefined, { check: true })).packs[0]).toMatchObject({
      status: 'would-build',
      reason: 'lockfile-moved',
      detail: 'the lockfile now resolves npm:demo 2.1.0, the pack is 2.0.0',
    });
    expect((await syncPacks(root, undefined)).packs[0]).toMatchObject({ status: 'built' });
    expect((await readPackManifest(join(root, 'agent-docs', 'demo'))).pack.version).toBe('2.1.0');

    await rm(join(root, 'package-lock.json'));
    expect((await syncPacks(root, undefined)).packs[0]).toMatchObject({
      status: 'failed',
      exitCode: 2,
      error:
        'Pack "demo": no lockfile resolves npm:demo (lockfiles searched: none found); set packs.demo.version in llm-docs.json, or install the dependency so a lockfile records it.',
    });
  });

  it('reports a lockfile that moved once, under lockfile, and an edited recipe under recipe', async () => {
    // The {version} placeholder makes the resolved recipe differ at the new version.
    const pack = {
      ...PACK,
      version: undefined,
      dependency: { ecosystem: 'npm', name: 'demo' },
      sources: [{ type: 'local', path: 'docs', exclude: ['v{version}/**'] }],
    };
    const root = await makeProject(
      { demo: pack },
      { ...DOCS, 'package-lock.json': npmLockfile('demo', '2.0.0') }
    );
    expect((await syncPacks(root, undefined)).packs[0]).toMatchObject({ status: 'built' });

    await writeFile(join(root, 'package-lock.json'), npmLockfile('demo', '2.1.0'));
    const moved = await verifyPacks(root, undefined);
    expect(problems(moved)).toEqual([
      "demo lockfile fail:  stale-pack: lockfiles resolve npm:demo 2.1.0 (package-lock.json), the pack is 2.0.0; run 'llm-docs sync demo'",
    ]);
    expect(moved.results.find((result) => result.check === 'recipe')?.status).toBe('pass');

    await setPacks(root, { demo: { ...pack, title: 'Demo library' } });
    expect(problems(await verifyPacks(root, undefined))).toEqual([
      "demo recipe fail:  packs.demo in llm-docs.json changed since the last sync; run 'llm-docs sync demo'",
      "demo lockfile fail:  stale-pack: lockfiles resolve npm:demo 2.1.0 (package-lock.json), the pack is 2.0.0; run 'llm-docs sync demo'",
    ]);
  });

  it('records covered packages and only warns when one resolves to another major version', async () => {
    const pack = {
      ...PACK,
      version: '2.0.0',
      covers: [
        { ecosystem: 'npm', name: 'demo-client' },
        { ecosystem: 'npm', name: 'demo-absent' },
      ],
    };
    const root = await makeProject({ demo: pack }, DOCS);
    expect((await syncPacks(root, undefined)).packs[0]).toMatchObject({ status: 'built' });
    expect((await readPackManifest(join(root, 'agent-docs', 'demo'))).recipe.covers).toEqual(
      pack.covers
    );

    const lockfile = (client: string): VerifyOptions => ({
      resolveDependencyVersion: (dependency) =>
        dependency.name === 'demo-client'
          ? { kind: 'found', version: client, lockfiles: ['package-lock.json'] }
          : { kind: 'missing', searched: ['package-lock.json'] },
    });

    const sameMajor = await verifyPacks(root, undefined, lockfile('2.7.0'));
    expect(problems(sameMajor)).toEqual([]);

    const otherMajor = await verifyPacks(root, undefined, lockfile('3.1.0'));
    expect(otherMajor.ok).toBe(true);
    expect(problems(otherMajor)).toEqual([
      "demo lockfile warn:  covers npm:demo-client, which the lockfiles resolve to 3.1.0, another major version than the pack's 2.0.0: the pack may not describe that package's version; add a pack for it, or remove it from packs.demo.covers in llm-docs.json",
    ]);
  });

  async function editManifest(
    root: string,
    edit: (manifest: Record<string, unknown> & { pack: { version: string } }) => void
  ): Promise<void> {
    const path = join(root, 'agent-docs', 'demo', 'manifest.json');
    const manifest = JSON.parse(await readFile(path, 'utf-8'));
    edit(manifest);
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  it('fails a manifest edited to disagree with its recipe, and sync rebuilds it', async () => {
    const root = await builtProject();
    await editManifest(root, (manifest) => {
      manifest.pack.version = '9.9.9';
    });

    expect(problems(await verifyPacks(root, undefined))).toContain(
      "demo manifest-schema fail: manifest.json manifest.json does not match the v3 schema at pack.version: differs from recipe.version (the manifest was edited); run 'llm-docs sync demo' to rebuild the pack"
    );
    const synced = await syncPacks(root, undefined);
    expect(synced.packs.map((pack) => [pack.id, pack.status])).toEqual([['demo', 'built']]);
    expect((await readPackManifest(join(root, 'agent-docs', 'demo'))).pack.version).toBe('1.0.0');

    await editManifest(root, (manifest) => {
      const recipe = manifest.recipe as { sources: { path: string }[] };
      recipe.sources[0] = { ...recipe.sources[0], path: 'elsewhere' } as { path: string };
    });
    expect(problems(await verifyPacks(root, undefined))).toContain(
      'demo manifest-schema fail: manifest.json manifest.json does not match the v3 schema at recipeHash: is not the hash of "recipe" (the manifest was edited); run \'llm-docs sync demo\' to rebuild the pack'
    );
  });

  it('never reads a file a manifest path places outside the pack', async () => {
    const root = await builtProject();
    await writeFile(join(root, 'secret.txt'), 'guess-me');
    await editManifest(root, (manifest) => {
      (manifest.outputs as unknown[]).push({
        path: '../../secret.txt',
        kind: 'passthrough',
        sha256: `sha256:${createHash('sha256').update('guess-me').digest('hex')}`,
        bytes: 8,
      });
    });

    const report = await verifyPacks(root, undefined);
    expect(report.ok).toBe(false);
    expect(problems(report).filter((line) => line.startsWith('demo '))[0]).toMatch(
      /^demo manifest-schema fail: manifest\.json .* at outputs\.\d+\.path: must be a relative POSIX path with no "\.\."/
    );
    expect(report.results.find((result) => result.check === 'outputs')?.status).toBe('skipped');
  });

  it('fails unlisted-files for a tree deeper than the walk examines, naming where it stopped', async () => {
    const root = await builtProject();
    const deep = Array.from({ length: 66 }, () => 'd').join('/');
    await writeFiles(join(root, 'agent-docs', 'demo'), { [`pages/${deep}/hidden.md`]: 'x' });

    const report = await verifyPacks(root, undefined);
    expect(report.ok).toBe(false);
    expect(problems(report)).toEqual([
      `demo unlisted-files fail: pages/${Array.from({ length: 64 }, () => 'd').join('/')}/ directory is more than 64 levels deep, so verify could not examine what it holds; remove it, or run 'llm-docs sync demo' to rebuild the pack`,
    ]);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports an unreadable pack file as a finding and still checks every other check and pack',
    async () => {
      const root = await makeProject({ demo: PACK, other: PACK }, DOCS);
      await syncPacks(root, undefined);
      const page = join(root, 'agent-docs', 'demo', 'pages', 'index.md');
      await chmod(page, 0o000);

      try {
        const report = await verifyPacks(root, undefined);
        expect(report.ok).toBe(false);
        expect(problems(report)).toEqual([
          expect.stringMatching(
            /^demo outputs fail: pages\/index\.md listed output is unreadable \(EACCES.*\); run 'llm-docs sync demo' to rebuild the pack$/
          ),
          expect.stringMatching(
            /^demo links fail: pages\/index\.md file is unreadable \(EACCES.*\), so its links were not checked; run 'llm-docs sync demo' to rebuild the pack$/
          ),
        ]);
        expect(
          report.results
            .filter((result) => result.packId === 'other')
            .map((result) => result.status)
        ).not.toContain('skipped');
      } finally {
        await chmod(page, 0o644);
      }
    }
  );

  it.skipIf(!canCreateSymlinks)(
    'fails unlisted-files for a linked pack directory or guides/ and reads nothing through either',
    async () => {
      const root = await builtProject();
      const outside = await mkdtemp(join(await realpath(tmpdir()), 'llm-docs-outside-'));
      tempDirs.push(outside);
      await writeFiles(outside, { 'a.md': '# Outside\n\nSee [missing](pages/nowhere.md).\n' });

      await symlink(outside, join(root, 'agent-docs', 'demo', 'guides'));
      const linkedGuides = await verifyPacks(root, undefined);
      expect(problems(linkedGuides).filter((line) => line.startsWith('demo '))).toEqual([
        "demo unlisted-files fail: guides symbolic link inside the pack; delete it, or run 'llm-docs sync demo' to rebuild the pack",
      ]);
      expect(linkedGuides.results.find((result) => result.check === 'citations')).toMatchObject({
        status: 'skipped',
        reason: 'guides/ is a symbolic link, which verify never follows',
      });
      await rm(join(root, 'agent-docs', 'demo', 'guides'));

      const packDir = join(root, 'agent-docs', 'demo');
      await cp(packDir, join(outside, 'demo'), { recursive: true });
      await rm(packDir, { recursive: true });
      await symlink(join(outside, 'demo'), packDir);
      const linkedPack = await verifyPacks(root, undefined);
      expect(problems(linkedPack).filter((line) => line.startsWith('demo '))).toEqual([
        "demo unlisted-files fail: . the pack directory is a symbolic link, which verify never follows; delete the link, then run 'llm-docs sync demo' to build the pack in place",
      ]);
      expect(linkedPack.ok).toBe(false);
      await expect(readPackManifest(packDir)).rejects.toThrow(
        'the pack directory is a symbolic link, which llm-docs never reads a pack through'
      );
    }
  );

  it('reports a missing manifest and an invalid config', async () => {
    const root = await makeProject({ demo: PACK }, DOCS);
    const report = await verifyPacks(root, undefined);
    expect(problems(report)).toContain(
      "demo manifest-schema fail: manifest.json manifest.json is missing; run 'llm-docs sync demo' to rebuild the pack"
    );
    expect(report.results.filter((result) => result.status === 'skipped')).toHaveLength(8);

    await writeFile(join(root, 'llm-docs.json'), '{"schemaVersion":3,"packs":{},"oops":1}');
    expect(problems(await verifyPacks(root, undefined))).toEqual([
      'project config-schema fail: llm-docs.json llm-docs.json: unknown key "oops"',
    ]);
  });
});
