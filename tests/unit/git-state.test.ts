/**
 * Git provenance capture: the enclosing repository identity for a source path.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { captureGitState } from '../../src/core/git-state.js';

const tempDirs: string[] = [];

// An empty global config isolates the tests from the developer's ~/.gitconfig.
// It must be a real file: Git for Windows cannot open os.devNull (`\\.\nul`)
// as a config file.
const isolatedConfigDir = mkdtempSync(join(tmpdir(), 'llm-docs-git-config-'));
const emptyGlobalConfig = join(isolatedConfigDir, 'gitconfig');
writeFileSync(emptyGlobalConfig, '');

afterAll(() => {
  rmSync(isolatedConfigDir, { recursive: true, force: true });
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), prefix));
  tempDirs.push(dir);

  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: emptyGlobalConfig },
  }).trim();
}

async function initRepo(root: string): Promise<void> {
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['config', 'commit.gpgsign', 'false']);
}

async function writeSourceFile(root: string, relativePath: string, content: string): Promise<void> {
  const fullPath = join(root, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, 'utf-8');
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('captureGitState (git provenance capture)', () => {
  it('records the enclosing repo identity for a directory source', async () => {
    const repo = await makeTempDir('llm-docs-git-capture-');
    await initRepo(repo);
    await writeSourceFile(repo, 'docs/intro.md', '# Intro\n\nHello.\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'init']);
    git(repo, ['remote', 'add', 'origin', 'https://github.com/example/repo.git']);
    git(repo, ['tag', 'v1.0.0']);
    git(repo, ['tag', 'alpha']);
    const commit = git(repo, ['rev-parse', 'HEAD']);

    const state = await captureGitState(join(repo, 'docs'));

    expect(state).toEqual({
      remoteUrl: 'https://github.com/example/repo.git',
      commit,
      // Tags sorted deterministically by code unit.
      tags: ['alpha', 'v1.0.0'],
      dirty: false,
      sourceRootFromRepo: 'docs',
    });
  });

  it('records a null remote and the file name for a file source at repo root', async () => {
    const repo = await makeTempDir('llm-docs-git-file-');
    await initRepo(repo);
    await writeSourceFile(repo, 'guide.md', '# Guide\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'init']);

    const state = await captureGitState(join(repo, 'guide.md'));

    expect(state?.remoteUrl).toBeNull();
    expect(state?.tags).toEqual([]);
    expect(state?.sourceRootFromRepo).toBe('guide.md');
  });

  it('scrubs embedded credentials from the origin remote', async () => {
    const repo = await makeTempDir('llm-docs-git-scrub-');
    await initRepo(repo);
    await writeSourceFile(repo, 'docs/a.md', '# A\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'init']);
    git(repo, ['remote', 'add', 'origin', 'https://user:secret-token@github.com/example/repo.git']);

    const state = await captureGitState(join(repo, 'docs'));

    expect(state?.remoteUrl).toBe('https://github.com/example/repo.git');
    expect(state?.remoteUrl).not.toContain('secret-token');
  });

  it('reports dirty when the working tree has uncommitted changes', async () => {
    const repo = await makeTempDir('llm-docs-git-dirty-');
    await initRepo(repo);
    await writeSourceFile(repo, 'docs/a.md', '# A\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'init']);
    await writeSourceFile(repo, 'docs/a.md', '# A changed\n');

    const state = await captureGitState(join(repo, 'docs'));

    expect(state?.dirty).toBe(true);
  });

  it('returns undefined for a non-git source (never an error)', async () => {
    const plain = await makeTempDir('llm-docs-git-none-');
    await writeSourceFile(plain, 'docs/a.md', '# A\n');

    expect(await captureGitState(join(plain, 'docs'))).toBeUndefined();
  });
});
