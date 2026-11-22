import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadProjectConfig } from '../../src/config/project.js';
import { syncPacks } from '../../src/pack/build.js';
import { stampGuides } from '../../src/pack/guides.js';
import { verifyPacks } from '../../src/pack/verify.js';
import { ALLOW_TEMP_SOURCES_ENV } from '../../src/sources/acquire.js';

// A real file system refuses a rename only under conditions a test cannot set up portably
// (an ACL, a busy file on Windows), so the refusal is injected at the fs boundary; every
// assertion reads the real files back.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const { rename: realRename } =
  await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const tempDirs: string[] = [];
let previousAllow: string | undefined;

beforeEach(() => {
  previousAllow = process.env[ALLOW_TEMP_SOURCES_ENV];
  process.env[ALLOW_TEMP_SOURCES_ENV] = '1';
});

afterEach(async () => {
  vi.mocked(rename).mockReset();
  vi.mocked(rename).mockImplementation(realRename);
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

/** A built pack `demo` with one stamped guide, and a source edit that makes the next sync rebuild it. */
async function projectWithStampedGuides(): Promise<{
  root: string;
  packDir: string;
  guides: Record<string, string>;
}> {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'llm-docs-swap-'));
  tempDirs.push(root);
  await writeFiles(root, {
    'docs/index.md': '# Home\n\nRead the [start](start.md).\n',
    'docs/start.md': '# Start\n\nInstall it.\n',
    'llm-docs.json': JSON.stringify({
      schemaVersion: 3,
      agentFiles: [],
      packs: {
        demo: { version: '1.0.0', license: 'MIT', sources: [{ type: 'local', path: 'docs' }] },
      },
    }),
  });
  await syncPacks(root, undefined);
  const packDir = join(root, 'agent-docs', 'demo');
  await writeFiles(packDir, { 'guides/g.md': '# G\n\nSee [start](../pages/start.md).\n' });
  await stampGuides(await loadProjectConfig(root), 'demo', [], root);
  await writeFiles(root, { 'docs/index.md': '# Home, edited\n' });
  return { root, packDir, guides: await snapshot(join(packDir, 'guides')) };
}

/** Fail the renames `matches` picks with EIO (not retried), `times` times. */
function failRenames(matches: (from: string, to: string) => boolean, times: number): void {
  let left = times;
  vi.mocked(rename).mockImplementation(async (from, to) => {
    if (left > 0 && matches(String(from), String(to))) {
      left -= 1;
      throw Object.assign(new Error(`EIO: injected rename failure, ${from} -> ${to}`), {
        code: 'EIO',
      });
    }
    return realRename(from, to);
  });
}

const staging = `${sep}.staging${sep}`;
const SWAP_STEPS: {
  step: string;
  matches: (packDir: string, from: string, to: string) => boolean;
}[] = [
  {
    step: 'setting the old pack aside',
    matches: (packDir, from, to) => from === packDir && to.includes(`${staging}demo-old-`),
  },
  {
    step: 'renaming the new pack into place',
    matches: (packDir, from, to) =>
      from.includes(`${staging}demo-`) && !from.includes('-old-') && to === packDir,
  },
  {
    step: 'moving guides/ into the new pack',
    matches: (packDir, from, to) =>
      from.includes(`${staging}demo-old-`) && to === join(packDir, 'guides'),
  },
];

describe('the staging swap', () => {
  for (const { step, matches } of SWAP_STEPS) {
    it(`keeps guides/ and the citations lock when ${step} fails`, async () => {
      const { root, packDir, guides } = await projectWithStampedGuides();
      failRenames((from, to) => matches(packDir, from, to), 1);

      const failed = await syncPacks(root, undefined);

      expect(failed.packs[0]).toMatchObject({ id: 'demo', status: 'failed', exitCode: 3 });
      expect(failed.packs[0]?.error).toContain('EIO: injected rename failure');
      expect(await snapshot(join(packDir, 'guides'))).toEqual(guides);
      expect(await readdir(join(root, 'agent-docs'))).toEqual(['.gitignore', 'demo']);

      const next = await syncPacks(root, undefined);
      expect(next.packs[0]?.status).not.toBe('failed');
      expect(await snapshot(join(packDir, 'guides'))).toEqual(guides);
      expect(await readFile(join(packDir, 'pages', 'index.md'), 'utf-8')).toContain(
        '# Home, edited'
      );
      expect((await verifyPacks(root, undefined)).results).not.toContainEqual(
        expect.objectContaining({ check: 'citations', status: 'fail' })
      );
    });
  }

  it('keeps guides it cannot move back in .staging, fails the pack, and restores them later', async () => {
    const { root, packDir, guides } = await projectWithStampedGuides();
    failRenames((from, to) => SWAP_STEPS[2]?.matches(packDir, from, to) === true, 100);

    const failed = await syncPacks(root, undefined);

    expect(failed.packs[0]).toMatchObject({ id: 'demo', status: 'failed', exitCode: 3 });
    expect(failed.packs[0]?.error).toMatch(
      /\.staging[\\/]demo-old-[0-9a-f]{12}, left by a failed or interrupted sync, could not be put back .*it is kept/
    );
    const [kept] = await readdir(join(root, 'agent-docs', '.staging'));
    expect(await snapshot(join(root, 'agent-docs', '.staging', kept ?? '', 'guides'))).toEqual(
      guides
    );

    vi.mocked(rename).mockImplementation(realRename);
    const next = await syncPacks(root, undefined);
    expect(next.packs[0]?.warnings).toContain(
      'Restored the guides of pack "demo" from an interrupted sync.'
    );
    expect(await snapshot(join(packDir, 'guides'))).toEqual(guides);
    expect(await readdir(join(root, 'agent-docs'))).toEqual(['.gitignore', 'demo']);
  });
});

describe('recovery after a sync died mid-swap', () => {
  async function oldPackAside(root: string, packDir: string): Promise<string> {
    const oldDir = join(root, 'agent-docs', '.staging', 'demo-old-0123456789ab');
    await mkdir(dirname(oldDir), { recursive: true });
    await realRename(packDir, oldDir);
    return oldDir;
  }

  it('puts the old pack back when the process died after setting it aside', async () => {
    const { root, packDir, guides } = await projectWithStampedGuides();
    await oldPackAside(root, packDir);
    await writeFiles(join(root, 'agent-docs', '.staging', 'demo-abcdef012345'), {
      'pages/index.md': 'half-built',
    });

    const report = await syncPacks(root, undefined);

    expect(report.packs[0]).toMatchObject({ status: 'built', reason: 'sources-changed' });
    expect(report.packs[0]?.warnings).toContain(
      'Restored pack "demo" left aside by an interrupted sync.'
    );
    expect(await snapshot(join(packDir, 'guides'))).toEqual(guides);
    expect(await readdir(join(root, 'agent-docs'))).toEqual(['.gitignore', 'demo']);
  });

  it('moves the guides into the new pack when the process died after renaming it into place', async () => {
    const { root, packDir, guides } = await projectWithStampedGuides();
    await syncPacks(root, undefined);
    const oldDir = await oldPackAside(root, packDir);
    await cp(oldDir, packDir, { recursive: true });
    await rm(join(packDir, 'guides'), { recursive: true });

    const report = await syncPacks(root, undefined);

    expect(report.packs[0]?.status).toBe('unchanged');
    expect(report.packs[0]?.warnings).toEqual([
      'Restored the guides of pack "demo" from an interrupted sync.',
    ]);
    expect(await snapshot(join(packDir, 'guides'))).toEqual(guides);
    expect(await readdir(join(root, 'agent-docs'))).toEqual(['.gitignore', 'demo']);
  });

  it('removes the old pack when the process died after the guides moved', async () => {
    const { root, packDir, guides } = await projectWithStampedGuides();
    await syncPacks(root, undefined);
    const oldDir = await oldPackAside(root, packDir);
    await cp(oldDir, packDir, { recursive: true });
    await rm(join(oldDir, 'guides'), { recursive: true });

    const report = await syncPacks(root, undefined);

    expect(report.packs[0]).toMatchObject({ status: 'unchanged', warnings: [] });
    expect(await snapshot(join(packDir, 'guides'))).toEqual(guides);
    expect(await readdir(join(root, 'agent-docs'))).toEqual(['.gitignore', 'demo']);
  });

  it('never deletes a leftover holding guides when the pack already has its own', async () => {
    const { root, packDir, guides } = await projectWithStampedGuides();
    await syncPacks(root, undefined);
    const leftover = join(root, 'agent-docs', '.staging', 'demo-old-0123456789ab');
    await cp(packDir, leftover, { recursive: true });
    await writeFiles(join(leftover, 'guides'), { 'other.md': '# Other\n' });

    const report = await syncPacks(root, undefined);

    expect(report.packs[0]).toMatchObject({ status: 'failed', exitCode: 2 });
    expect(report.packs[0]?.error).toContain('merge the two by hand');
    expect(await snapshot(join(leftover, 'guides'))).toEqual({
      ...guides,
      'other.md': '# Other\n',
    });
    expect(await snapshot(join(packDir, 'guides'))).toEqual(guides);
  });
});
