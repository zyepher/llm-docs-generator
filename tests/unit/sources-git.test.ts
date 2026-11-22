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

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { ConfigError, PACK_LIMITS, type ResolvedSourceOfType } from '../../src/config/project.js';
import type { AcquireContext } from '../../src/sources/acquire.js';
import { acquireGit, createGitRunner, GitError } from '../../src/sources/git.js';
import { ALLOW_PRIVATE_NETWORK_ENV } from '../../src/sources/http.js';
import {
  createTestCertificate,
  gitHttpBackend,
  startHttpsServer,
  trustCertificate,
  type TestCertificate,
  type TestHttpsServer,
} from '../helpers/https-git-server.js';

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
    // Symlinks enter the index directly (mode 120000), so the test needs no
    // file-system symlink support (Windows without Developer Mode has none).
    const target = await git(repo.dir, 'hash-object', '-w', 'docs/index.md');
    for (const name of ['docs/alias.md', 'docs/alias.txt']) {
      await git(repo.dir, 'update-index', '--add', '--cacheinfo', `120000,${target},${name}`);
    }
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
    // Git runs hooks with its own sh, which takes forward slashes on Windows too.
    await writeFiles(hooks, {
      'post-checkout': `#!/bin/sh\ntouch "${marker.replace(/\\/g, '/')}"\n`,
    });
    await chmod(join(hooks, 'post-checkout'), 0o755);
    const hostileConfig = join(await temp('llm-docs-hostile-'), 'gitconfig');
    await writeFile(hostileConfig, `[core]\n\thooksPath = ${hooks.replace(/\\/g, '/')}\n`);

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

  it('takes monorepo release tags that contain "@"', async () => {
    const repo = await makeRepo();
    await git(repo.dir, 'tag', 'pkg@1.2.3', repo.v1);
    await git(repo.dir, 'tag', '-a', '@scope/pkg@1.2.3', '-m', 'scoped release', repo.v2);

    const plain = await acquireGit(gitSource(repo.url, 'pkg@1.2.3'), await context());
    const scoped = await acquireGit(gitSource(repo.url, '@scope/pkg@1.2.3'), await context());

    expect(plain.origin).toMatchObject({ commit: repo.v1, refKind: 'tag' });
    expect(scoped.origin).toMatchObject({ commit: repo.v2, refKind: 'tag' });
    for (const ref of ['@', '-x@1', 'a@{1}', 'a..b@1']) {
      await expect(acquireGit(gitSource(repo.url, ref), await context())).rejects.toThrow(
        /is not a valid tag, branch, or 40-hex commit name/
      );
    }
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

describe('git over https', () => {
  let certificate: TestCertificate;
  let certificateDir = '';
  let untrust = (): void => {};
  const servers: TestHttpsServer[] = [];
  const saved = {
    caInfo: process.env.GIT_SSL_CAINFO,
    allowPrivate: process.env[ALLOW_PRIVATE_NETWORK_ENV],
  };

  beforeAll(async () => {
    certificateDir = await mkdtemp(join(await realpath(tmpdir()), 'llm-docs-cert-'));
    certificate = await createTestCertificate(certificateDir);
    untrust = trustCertificate(certificate);
    // The runner keeps GIT_SSL_CAINFO: the TLS trust a corporate network needs.
    process.env.GIT_SSL_CAINFO = certificate.certPath;
    process.env[ALLOW_PRIVATE_NETWORK_ENV] = '1';
  });

  afterAll(async () => {
    untrust();
    restoreEnv('GIT_SSL_CAINFO', saved.caInfo);
    restoreEnv(ALLOW_PRIVATE_NETWORK_ENV, saved.allowPrivate);
    await rm(certificateDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  /**
   * A git host serving `repo` as /new/widget.git, redirecting /old/ to it
   * (a renamed repository), /elsewhere/ to `elsewhere`, and /nonrepo/ to a
   * page that is not a repository.
   */
  async function gitHost(repo: Fixture, elsewhere = ''): Promise<TestHttpsServer> {
    const root = await temp('llm-docs-served-');
    await git(root, 'clone', '--quiet', '--bare', repo.dir, join(root, 'new', 'widget.git'));
    const backend = await gitHttpBackend(root);
    const server = await startHttpsServer(certificate, (request, response) => {
      const path = request.url ?? '/';
      const redirect = path.startsWith('/old/')
        ? path.replace('/old/', '/new/')
        : path.startsWith('/elsewhere/')
          ? elsewhere
          : path.startsWith('/nonrepo/')
            ? '/login'
            : undefined;
      if (redirect === undefined) {
        backend(request, response);
        return;
      }
      response.writeHead(302, { location: redirect });
      response.end();
    });
    servers.push(server);
    return server;
  }

  it('never lets git follow a redirect to a host nobody vetted', async () => {
    const internal = await startHttpsServer(certificate, (_request, response) => {
      response.writeHead(404);
      response.end();
    });
    servers.push(internal);
    const host = await gitHost(
      await makeRepo(),
      `${internal.origin.replace('127.0.0.1', 'localhost')}/internal-admin/x/info/refs?service=git-upload-pack`
    );
    const repo = new URL(`${host.origin}/elsewhere/widget.git`);
    const runner = await createGitRunner(await temp('llm-docs-work-'), repo);

    await expect(runner(['ls-remote', repo.href])).rejects.toBeInstanceOf(GitError);
    expect(host.requests).toEqual(['GET /elsewhere/widget.git/info/refs?service=git-upload-pack']);
    expect(internal.requests).toEqual([]);
  });

  it('follows a renamed repository through the vetted client and records both URLs', async () => {
    const repo = await makeRepo();
    const host = await gitHost(repo);
    const requested = `${host.origin}/old/widget.git`;

    const result = await acquireGit(gitSource(requested, 'v1'), await context());

    expect(result.origin).toEqual({
      type: 'git',
      repo: requested,
      finalRepo: `${host.origin}/new/widget.git`,
      ref: 'v1',
      commit: repo.v1,
      refKind: 'tag',
    });
    expect(result.files.map((file) => file.path).sort()).toEqual(['guide/start.md', 'index.md']);
    expect(result.warnings).toContain(
      `git repo ${requested} redirects to ${host.origin}/new/widget.git, so this build fetched from there; put that URL in "repo" to skip the redirect.`
    );
    // Only the client's discovery request went to the old path; git itself never did.
    expect(host.requests.filter((request) => request.includes('/old/'))).toEqual([
      'GET /old/widget.git/info/refs?service=git-upload-pack',
    ]);
  });

  it('refuses a redirect that does not lead to a repository', async () => {
    const host = await gitHost(await makeRepo());
    const error = await acquireGit(
      gitSource(`${host.origin}/nonrepo/widget.git`, 'v1'),
      await context()
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConfigError);
    expect(String(error)).toContain(
      `redirects to ${host.origin}/login, which is not a git repository URL`
    );
  });

  it('ignores the config of a repository that encloses its work directory', async () => {
    const host = await gitHost(await makeRepo());
    const enclosing = await temp('llm-docs-enclosing-');
    await git(enclosing, 'init', '--quiet');
    await git(
      enclosing,
      'config',
      `url.${host.origin}/new/widget.git.insteadOf`,
      'https://steered.invalid/widget.git'
    );
    const work = join(enclosing, 'work');
    await mkdir(work);
    const runner = await createGitRunner(work, new URL('https://steered.invalid/widget.git'));

    // Control: plain git in that directory follows the enclosing repository's rewrite.
    expect(await git(work, 'ls-remote', 'https://steered.invalid/widget.git')).toContain(
      'refs/tags/v1'
    );
    await expect(runner(['ls-remote', 'https://steered.invalid/widget.git'])).rejects.toThrow(
      /steered\.invalid/
    );
  });
});

describe('fetched object checks', () => {
  it('refuses a repository whose commit is malformed', async () => {
    const repo = await makeRepo();
    const tree = await git(repo.dir, 'rev-parse', 'v1^{tree}');
    const malformed = join(await temp('llm-docs-malformed-'), 'commit');
    await writeFile(
      malformed,
      `tree ${tree}\nauthor Test <test@example.com> 1700000000 +99999\ncommitter Test <test@example.com> 1700000000 +0000\n\nbad timezone\n`
    );
    const commit = await git(
      repo.dir,
      'hash-object',
      '-t',
      'commit',
      '--literally',
      '-w',
      malformed
    );
    await git(repo.dir, 'tag', 'malformed', commit);

    await expect(acquireGit(gitSource(repo.url, 'malformed'), await context())).rejects.toThrow(
      /badTimezone/
    );
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
