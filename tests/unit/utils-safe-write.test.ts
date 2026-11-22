import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { canCreateSymlinks } from '../helpers/symlinks.js';

import { writeTextFileSafely } from '../../src/utils/safe-write.js';

// The only way to make a real filesystem refuse the final rename on demand is to inject the
// refusal at the fs boundary; every assertion still reads the real files back.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'llm-docs-safe-write-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.mocked(rename).mockReset();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('writeTextFileSafely', () => {
  it('creates a file with exactly the given UTF-8 text and leaves no temp file', async () => {
    const dir = await makeTempDir();
    const path = join(dir, 'out.md');

    await writeTextFileSafely(path, '# Café 快速\n');

    expect(await readFile(path)).toEqual(Buffer.from('# Café 快速\n', 'utf-8'));
    expect(await readdir(dir)).toEqual(['out.md']);
  });

  it('replaces a longer existing file completely, with no stale tail', async () => {
    const dir = await makeTempDir();
    const path = join(dir, 'out.txt');
    await writeFile(path, 'a much longer previous body\n');

    await writeTextFileSafely(path, 'short\n');

    expect(await readFile(path, 'utf-8')).toBe('short\n');
    expect(await readdir(dir)).toEqual(['out.txt']);
  });

  it('does not create missing parent directories', async () => {
    const dir = await makeTempDir();

    await expect(writeTextFileSafely(join(dir, 'missing', 'out.txt'), 'x')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readdir(dir)).toEqual([]);
  });

  it('refuses to replace a directory', async () => {
    const dir = await makeTempDir();
    const path = join(dir, 'out');
    await mkdir(path);
    await writeFile(join(path, 'keep.txt'), 'kept');

    await expect(writeTextFileSafely(path, 'x')).rejects.toThrow(/not a regular file/);
    expect(await readFile(join(path, 'keep.txt'), 'utf-8')).toBe('kept');
    expect(await readdir(dir)).toEqual(['out']);
  });

  it.skipIf(!canCreateSymlinks)(
    'refuses to write through a symlink, leaving the link and its target untouched',
    async () => {
      const dir = await makeTempDir();
      const outside = join(dir, 'outside.txt');
      const link = join(dir, 'out.txt');
      await writeFile(outside, 'outside');
      await symlink(outside, link);

      await expect(writeTextFileSafely(link, 'x')).rejects.toThrow(/not a regular file/);
      expect(await readFile(outside, 'utf-8')).toBe('outside');
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
      expect((await readdir(dir)).sort()).toEqual(['out.txt', 'outside.txt']);
    }
  );

  it('keeps the previous content and removes its temp file when the final rename fails', async () => {
    const dir = await makeTempDir();
    const path = join(dir, 'manifest.json');
    await writeFile(path, '{"previous":true}\n');
    vi.mocked(rename).mockRejectedValueOnce(
      Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' })
    );

    await expect(writeTextFileSafely(path, '{"next":true}\n')).rejects.toMatchObject({
      code: 'EXDEV',
    });
    expect(await readFile(path, 'utf-8')).toBe('{"previous":true}\n');
    expect(await readdir(dir)).toEqual(['manifest.json']);
  });

  it('never exposes a partially written file to a concurrent reader', async () => {
    const dir = await makeTempDir();
    const path = join(dir, 'big.txt');
    const previous = 'a'.repeat(8 * 1024 * 1024);
    const next = 'b'.repeat(8 * 1024 * 1024);
    await writeFile(path, previous);

    let done = false;
    const write = writeTextFileSafely(path, next).finally(() => {
      done = true;
    });
    const observed = new Set<string>();
    let reads = 0;
    while (!done) {
      const text = await readFile(path, 'utf-8');
      reads++;
      observed.add(text === previous ? 'previous' : text === next ? 'next' : 'partial');
    }
    await write;

    expect(reads).toBeGreaterThan(0);
    expect(observed.has('partial')).toBe(false);
    expect(await readFile(path, 'utf-8')).toBe(next);
    expect(await readdir(dir)).toEqual(['big.txt']);
  });
});
