import { execFileSync } from 'node:child_process';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { canCreateSymlinks } from '../helpers/symlinks.js';

import {
  readRegularFile,
  RefusedFileError,
  writeTextFileSafely,
} from '../../src/utils/safe-write.js';

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

  it.skipIf(process.platform === 'win32')(
    'keeps the permission bits of the file it replaces, and creates new files with the default',
    async () => {
      // Windows has no POSIX permission bits: Node maps only the read-only attribute.
      const dir = await makeTempDir();
      const kept = join(dir, 'AGENTS.md');
      await writeFile(kept, 'old\n');
      await chmod(kept, 0o600);
      const fresh = join(dir, 'new.md');

      await writeTextFileSafely(kept, 'new\n');
      await writeTextFileSafely(fresh, 'new\n');

      expect((await stat(kept)).mode & 0o777).toBe(0o600);
      expect(await readFile(kept, 'utf-8')).toBe('new\n');
      expect((await stat(fresh)).mode & 0o777).toBe(0o666 & ~process.umask());
    }
  );

  it('refuses to replace a read-only file, leaving it as it was', async () => {
    const dir = await makeTempDir();
    const path = join(dir, 'AGENTS.md');
    await writeFile(path, 'protected\n');
    await chmod(path, 0o444);

    await expect(writeTextFileSafely(path, 'x')).rejects.toMatchObject({
      refusal: { kind: 'read-only' },
      message: `${path} is read-only`,
    });
    expect(await readFile(path, 'utf-8')).toBe('protected\n');
    expect(await readdir(dir)).toEqual(['AGENTS.md']);
    await chmod(path, 0o644);
  });

  it('refuses to replace a file with other hard links, so no link is left behind', async () => {
    const dir = await makeTempDir();
    const path = join(dir, 'AGENTS.md');
    const other = join(dir, 'shared.md');
    await writeFile(other, 'shared\n');
    await link(other, path);

    await expect(writeTextFileSafely(path, 'x')).rejects.toMatchObject({
      refusal: { kind: 'hard-linked', links: 2 },
    });
    expect(await readFile(path, 'utf-8')).toBe('shared\n');
    expect((await stat(path)).nlink).toBe(2);
  });

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

describe('readRegularFile', () => {
  it('reads a regular file and rejects a missing one with ENOENT', async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, 'a.md'), 'text');

    expect((await readRegularFile(join(dir, 'a.md'), { followLinks: false })).toString()).toBe(
      'text'
    );
    await expect(
      readRegularFile(join(dir, 'missing.md'), { followLinks: true })
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a directory', async () => {
    const dir = await makeTempDir();
    await mkdir(join(dir, 'AGENTS.md'));

    await expect(
      readRegularFile(join(dir, 'AGENTS.md'), { followLinks: true })
    ).rejects.toMatchObject({ refusal: { kind: 'not-regular', found: 'a directory' } });
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a named pipe without blocking on it',
    async () => {
      // Windows has no named pipes in the file system namespace.
      const dir = await makeTempDir();
      const fifo = join(dir, 'AGENTS.md');
      execFileSync('mkfifo', [fifo]);

      for (const followLinks of [true, false]) {
        await expect(readRegularFile(fifo, { followLinks })).rejects.toThrow(
          new RefusedFileError(fifo, { kind: 'not-regular', found: 'a named pipe' })
        );
      }
    },
    5_000
  );

  it.skipIf(!canCreateSymlinks)('follows a symbolic link only when asked to', async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, 'target.md'), 'target');
    await symlink(join(dir, 'target.md'), join(dir, 'link.md'));

    expect((await readRegularFile(join(dir, 'link.md'), { followLinks: true })).toString()).toBe(
      'target'
    );
    await expect(
      readRegularFile(join(dir, 'link.md'), { followLinks: false })
    ).rejects.toMatchObject({ refusal: { kind: 'not-regular', found: 'a symbolic link' } });
  });
});
