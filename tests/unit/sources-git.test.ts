/**
 * Git acquisition (spec 4.1) against local repositories over file://: ref
 * kinds (lightweight and annotated tags, branches, commits), sparse paths,
 * license files outside the taken paths, symlink and submodule handling, and
 * the isolation from user config (a hook it names never runs).
 */

import { execFile } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { PACK_LIMITS, type ResolvedSourceOfType } from '../../src/config/project.js';
import type { AcquireContext } from '../../src/sources/acquire.js';
import { acquireGit, GitError } from '../../src/sources/git.js';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];
let emptyConfig = '';

beforeAll(async () => {
  const dir = await temp('llm-docs-gitcfg-');
  emptyConfig = join(dir, 'gitconfig');
  await writeFile(emptyConfig, '');
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Plain git for building fixtures, isolated from the developer's config. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-c', 'protocol.file.allow=always', ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: emptyConfig,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
  return stdout.trim();
}

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, ...path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

const MIT = await readFile(new URL('../fixtures/licenses/MIT.txt', import.meta.url), 'utf-8');
const CC_BY = await readFile(
  new URL('../fixtures/licenses/CC-BY-4.0.txt', import.meta.url),
  'utf-8'
);

interface Fixture {
  url: string;
  dir: string;
  v1: string;
  v2: string;
}

/** Two commits: v1 (lightweight tag) and v2 (annotated tag, branch main). */
async function makeRepo(): Promise<Fixture> {
  const dir = await temp('llm-docs-repo-');
  await git(dir, 'init', '--quiet', '--initial-branch=main');
  await writeFiles(dir, {
    LICENSE: MIT,
    'README.md': '# Readme\n',
    'docs/index.md': '# Home v1\n',
    'docs/guide/start.md': '# Start\n',
    'docs/LICENSE-docs': CC_BY,
    'src/code.ts': 'export {};\n',
  });
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '--quiet', '-m', 'one');
  await git(dir, 'tag', 'v1');
  const v1 = await git(dir, 'rev-parse', 'HEAD');
  await writeFiles(dir, { 'docs/index.md': '# Home v2\n' });
  await git(dir, 'commit', '--quiet', '-am', 'two');
  await git(dir, 'tag', '-a', 'v2', '-m', 'release two');
  const v2 = await git(dir, 'rev-parse', 'HEAD');
  return { url: pathToFileURL(dir).href, dir, v1, v2 };
}

function gitSource(
  repo: string,
  ref: string,
  overrides: Partial<ResolvedSourceOfType<'git'>> = {}
): ResolvedSourceOfType<'git'> {
  return {
    type: 'git',
    repo,
    ref,
    paths: ['docs'],
    mount: '',
    include: ['**/*.md'],
    exclude: [],
    passthrough: [],
    convert: null,
    transforms: [],
    ...overrides,
  };
}

async function context(): Promise<AcquireContext> {
  const project = await temp('llm-docs-proj-');
  return {
    projectRoot: project,
    packsDir: join(project, 'agent-docs'),
    workDir: await temp('llm-docs-work-'),
    maxFileBytes: PACK_LIMITS.defaultMaxFileBytes,
  };
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false
  );
}

describe('acquireGit', () => {
  it('takes a lightweight tag sparsely, relative to the taken path, with the license outside it', async () => {
    const repo = await makeRepo();
    const ctx = await context();
    const result = await acquireGit(gitSource(repo.url, 'v1'), ctx);

    expect(result.origin).toEqual({
      type: 'git',
      repo: repo.url,
      ref: 'v1',
      commit: repo.v1,
      refKind: 'tag',
    });
    expect(result.files.map((file) => file.path).sort()).toEqual(['guide/start.md', 'index.md']);
    const index = result.files.find((file) => file.path === 'index.md');
    expect(await readFile(index?.absolutePath ?? '', 'utf-8')).toBe('# Home v1\n');
    expect(index?.url).toBeUndefined();
    expect(index?.sourceLabel).toBe(`${repo.url}@${repo.v1}:docs/index.md`);
    // Docs-specific license at the taken path's root outranks the repository's.
    expect(result.license).toEqual({ spdx: 'CC-BY-4.0', evidence: 'docs/LICENSE-docs' });
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('is a file:// repository: a non-portable origin'),
        expect.stringContaining('License files disagree: recorded CC-BY-4.0'),
      ])
    );
    // Sparse: nothing outside the taken paths except license files is checked out.
    const checkout = join(ctx.workDir, 'checkout');
    expect(await exists(join(checkout, 'LICENSE'))).toBe(true);
    expect(await exists(join(checkout, 'src', 'code.ts'))).toBe(false);
    expect(await exists(join(checkout, 'README.md'))).toBe(false);
  });

  it('peels an annotated tag, follows a branch with a floating-pin warning, and takes a commit', async () => {
    const repo = await makeRepo();

    const annotated = await acquireGit(gitSource(repo.url, 'v2'), await context());
    expect(annotated.origin).toMatchObject({ commit: repo.v2, refKind: 'tag' });

    const branch = await acquireGit(gitSource(repo.url, 'main'), await context());
    expect(branch.origin).toMatchObject({ commit: repo.v2, refKind: 'branch' });
    expect(branch.warnings.join('\n')).toContain('is a branch, so the pin floats');

    const commit = await acquireGit(gitSource(repo.url, repo.v1), await context());
    expect(commit.origin).toMatchObject({ commit: repo.v1, refKind: 'commit' });
    const index = commit.files.find((file) => file.path === 'index.md');
    expect(await readFile(index?.absolutePath ?? '', 'utf-8')).toBe('# Home v1\n');
  });

  it('takes the whole repository for "." and several paths from their common root', async () => {
    const repo = await makeRepo();

    const whole = await acquireGit(gitSource(repo.url, 'v1', { paths: ['.'] }), await context());
    expect(whole.files.map((file) => file.path).sort()).toEqual([
      'README.md',
      'docs/guide/start.md',
      'docs/index.md',
    ]);
    expect(whole.license).toEqual({ spdx: 'MIT', evidence: 'LICENSE' });

    const two = await acquireGit(
      gitSource(repo.url, 'v1', { paths: ['docs/guide', 'docs/index.md'] }),
      await context()
    );
    expect(two.files.map((file) => file.path).sort()).toEqual(['guide/start.md', 'index.md']);
  });

  it('rejects an included symlink, ignores others, and never fetches submodules', async () => {
    const repo = await makeRepo();
    const other = await makeRepo();
    await git(repo.dir, 'submodule', 'add', '--quiet', other.url, 'docs/vendor');
    await execFileAsync('ln', ['-s', 'index.md', join(repo.dir, 'docs', 'alias.md')]);
    await execFileAsync('ln', ['-s', 'index.md', join(repo.dir, 'docs', 'alias.txt')]);
    await git(repo.dir, 'add', '-A');
    await git(repo.dir, 'commit', '--quiet', '-m', 'links');
    await git(repo.dir, 'tag', 'v3');

    await expect(acquireGit(gitSource(repo.url, 'v3'), await context())).rejects.toThrow(
      /docs\/alias\.md in .* is a symbolic link/
    );

    const ctx = await context();
    const result = await acquireGit(gitSource(repo.url, 'v3', { exclude: ['alias.md'] }), ctx);
    expect(result.files.map((file) => file.path).sort()).toEqual(['guide/start.md', 'index.md']);
    expect(result.warnings.join('\n')).toContain('Skipped 1 submodule');
    expect(result.warnings.join('\n')).toContain('Ignored 1 symbolic link');
    expect(await exists(join(ctx.workDir, 'checkout', 'docs', 'vendor', 'docs', 'index.md'))).toBe(
      false
    );
  });

  it('never runs a hook that the user config points at', async () => {
    const repo = await makeRepo();
    const marker = join(await temp('llm-docs-marker-'), 'hook-ran');
    const hooks = join(repo.dir, 'hooks');
    await writeFiles(hooks, { 'post-checkout': `#!/bin/sh\ntouch "${marker}"\n` });
    await chmod(join(hooks, 'post-checkout'), 0o755);
    const hostileConfig = join(await temp('llm-docs-hostile-'), 'gitconfig');
    await writeFile(hostileConfig, `[core]\n\thooksPath = ${hooks}\n`);

    // Control: plain git with this config runs the hook.
    const control = await temp('llm-docs-control-');
    await execFileAsync(
      'git',
      ['-c', 'protocol.file.allow=always', 'clone', '--quiet', repo.url, control],
      {
        env: { ...process.env, GIT_CONFIG_GLOBAL: hostileConfig, GIT_CONFIG_NOSYSTEM: '1' },
      }
    );
    expect(await exists(marker)).toBe(true);
    await rm(marker);

    const previous = { global: process.env.GIT_CONFIG_GLOBAL, dir: process.env.GIT_DIR };
    process.env.GIT_CONFIG_GLOBAL = hostileConfig;
    process.env.GIT_DIR = '/nonexistent';
    try {
      const result = await acquireGit(gitSource(repo.url, 'v1'), await context());
      expect(result.files).toHaveLength(2);
    } finally {
      restoreEnv('GIT_CONFIG_GLOBAL', previous.global);
      restoreEnv('GIT_DIR', previous.dir);
    }
    expect(await exists(marker)).toBe(false);
  });

  it('names a missing ref, a missing path, and an unsafe ref as config errors', async () => {
    const repo = await makeRepo();

    await expect(acquireGit(gitSource(repo.url, 'v9'), await context())).rejects.toThrow(
      /git ref "v9" is not a tag or branch of file:\/\/.*, and not a 40-hex commit id/
    );
    await expect(
      acquireGit(gitSource(repo.url, 'v1', { paths: ['manual'] }), await context())
    ).rejects.toThrow(/has no "manual"; fix "paths"/);
    await expect(
      acquireGit(gitSource(repo.url, '--upload-pack=x'), await context())
    ).rejects.toThrow(/is not a valid tag, branch, or 40-hex commit name/);
    await expect(
      acquireGit(gitSource(repo.url, 'v1', { paths: ['../escape'] }), await context())
    ).rejects.toThrow(/must be a relative path inside the repository/);
  });

  it('reports a missing git binary clearly', async () => {
    const repo = await makeRepo();
    const previous = process.env.PATH;
    process.env.PATH = join(await temp('llm-docs-nopath-'), 'bin');
    try {
      const error = await acquireGit(gitSource(repo.url, 'v1'), await context()).catch(
        (caught: unknown) => caught
      );
      expect(error).toBeInstanceOf(GitError);
      expect(String(error)).toContain('git is not installed or not on PATH');
    } finally {
      process.env.PATH = previous;
    }
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
