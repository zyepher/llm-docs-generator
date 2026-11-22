import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { canCreateSymlinks } from '../helpers/symlinks.js';

import { isSameOrDescendant, resolveEffectiveOutputPath } from '../../src/utils/fs-path.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'llm-docs-fs-path-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const root = resolve('/project/docs');

describe('isSameOrDescendant', () => {
  it('accepts the same path, with or without a trailing separator', () => {
    expect(isSameOrDescendant(root, root)).toBe(true);
    expect(isSameOrDescendant(`${root}${sep}`, root)).toBe(true);
    expect(isSameOrDescendant(root, `${root}${sep}`)).toBe(true);
  });

  it('accepts descendants at any depth', () => {
    expect(isSameOrDescendant(root, join(root, 'a.md'))).toBe(true);
    expect(isSameOrDescendant(root, join(root, 'guide', 'deep', 'b.md'))).toBe(true);
    expect(isSameOrDescendant(root, `${join(root, 'guide')}${sep}`)).toBe(true);
  });

  it('rejects a sibling that only shares a string prefix', () => {
    expect(isSameOrDescendant(root, `${root}2`)).toBe(false);
    expect(isSameOrDescendant(root, `${root}-old${sep}a.md`)).toBe(false);
  });

  it('rejects ancestors and paths that escape through ..', () => {
    expect(isSameOrDescendant(root, resolve('/project'))).toBe(false);
    expect(isSameOrDescendant(root, `${root}${sep}..${sep}secrets`)).toBe(false);
    expect(isSameOrDescendant(root, `${root}${sep}a${sep}..${sep}..${sep}docs-x`)).toBe(false);
    expect(isSameOrDescendant(root, resolve('/elsewhere'))).toBe(false);
  });

  it('accepts a path that leaves and re-enters the root, and a child whose name starts with ..', () => {
    expect(isSameOrDescendant(root, `${root}${sep}a${sep}..${sep}b.md`)).toBe(true);
    expect(isSameOrDescendant(root, join(root, '..hidden'))).toBe(true);
  });

  it.skipIf(!canCreateSymlinks)(
    'compares paths lexically, so a symlink escape is caught only after canonicalizing',
    async () => {
      const dir = await makeTempDir();
      const project = join(dir, 'project');
      const outside = join(dir, 'outside');
      await mkdir(project);
      await mkdir(outside);
      await symlink(outside, join(project, 'link'), 'dir');
      const throughLink = join(project, 'link', 'out.md');

      expect(isSameOrDescendant(project, throughLink)).toBe(true);
      expect(isSameOrDescendant(project, await realpath(join(project, 'link')))).toBe(false);
      expect(isSameOrDescendant(project, await resolveEffectiveOutputPath(throughLink))).toBe(
        false
      );
    }
  );
});

describe('resolveEffectiveOutputPath', () => {
  it('returns the realpath of an existing directory', async () => {
    const dir = await makeTempDir();
    await mkdir(join(dir, 'packs'));

    expect(await resolveEffectiveOutputPath(join(dir, 'packs'))).toBe(join(dir, 'packs'));
  });

  it('keeps the missing tail of a path that does not exist yet', async () => {
    const dir = await makeTempDir();

    expect(await resolveEffectiveOutputPath(join(dir, 'a', 'b', 'c'))).toBe(
      join(dir, 'a', 'b', 'c')
    );
  });

  it.skipIf(!canCreateSymlinks)(
    'resolves symlinks in the existing prefix of a path that does not exist yet',
    async () => {
      const dir = await makeTempDir();
      await mkdir(join(dir, 'real'));
      await symlink(join(dir, 'real'), join(dir, 'alias'), 'dir');

      expect(await resolveEffectiveOutputPath(join(dir, 'alias', 'new', 'x'))).toBe(
        join(dir, 'real', 'new', 'x')
      );
    }
  );
});
