/**
 * End-to-end runs of the BUILT CLI (dist/cli.js) against throwaway projects:
 * init, add --local, sync, sync --check, verify, and the --json shapes. The
 * build runs once before the suite.
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cliPath = join(repoRoot, 'dist', 'cli.js');
const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(cwd: string, args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolveResult) => {
    execFile(
      process.execPath,
      [cliPath, ...args],
      {
        cwd,
        env: { ...process.env, NO_COLOR: '1', LLM_DOCS_ALLOW_TEMP_SOURCES: '1', ...env },
      },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
        resolveResult({ code, stdout, stderr });
      }
    );
  });
}

async function makeProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'llm-docs-cli-'));
  tempDirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, ...path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return root;
}

const DOCS = {
  'docs/index.md': '# Home\n\nSee [start](guide/start.md).\n',
  'docs/guide/start.mdx': "import X from 'x'\n\n# Start\n\n<Tip>Use it.</Tip>\n",
};

beforeAll(async () => {
  await execFileAsync('npm', ['run', 'build'], {
    cwd: repoRoot,
    shell: process.platform === 'win32',
  });
}, 120_000);

afterAll(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('llm-docs v3 CLI', () => {
  it('init creates config and the packs directory once', async () => {
    const root = await makeProject({});
    const first = await runCli(root, ['init', '--project', root, '--json']);

    expect(first.code).toBe(0);
    expect(JSON.parse(first.stdout)).toEqual({
      projectRoot: root,
      configPath: join(root, 'llm-docs.json'),
      created: true,
      packsDir: 'agent-docs',
    });
    expect(await readFile(join(root, 'agent-docs', '.gitignore'), 'utf-8')).toBe(
      '.staging/\n.llm-docs.lock\n'
    );

    const second = await runCli(root, ['init', '--project', root]);
    expect(second.code).toBe(0);
    expect(second.stdout).toBe('');
    expect(second.stderr).toContain('already exists; left it unchanged');
  });

  it('adds a local pack, syncs it, checks it, verifies it, and catches tampering', async () => {
    const root = await makeProject(DOCS);
    const add = await runCli(root, [
      'add',
      'demo',
      '--local',
      'docs',
      '--version',
      '1.0.0',
      '--title',
      'Demo',
      '--project',
      root,
    ]);

    expect(add.code).toBe(0);
    expect(add.stdout).toBe('');
    expect(add.stderr).toContain('demo: built (not built yet)');
    expect(JSON.parse(await readFile(join(root, 'llm-docs.json'), 'utf-8')).packs).toEqual({
      demo: { title: 'Demo', version: '1.0.0', sources: [{ type: 'local', path: 'docs' }] },
    });
    expect(await readdir(join(root, 'agent-docs', 'demo', 'pages', 'guide'))).toEqual(['start.md']);

    const check = await runCli(root, ['sync', '--check', '--json']);
    expect(check.code).toBe(0);
    expect(JSON.parse(check.stdout)).toMatchObject({
      check: true,
      changed: false,
      packs: [{ id: 'demo', status: 'unchanged' }],
      orphans: [],
      afterSync: null,
    });

    const verify = await runCli(root, ['verify', '--json']);
    expect(verify.code).toBe(0);
    const report = JSON.parse(verify.stdout);
    expect(report).toMatchObject({ ok: true, strict: false });
    expect(report.results.map((result: { check: string }) => result.check)).toEqual([
      'config-schema',
      'manifest-schema',
      'outputs',
      'unlisted-files',
      'links',
      'recipe',
      'lockfile',
      'license',
    ]);
    // A local pack with no declared license warns, and fails only under --strict.
    expect(verify.stderr).toContain('demo license warn: license unknown');
    expect((await runCli(root, ['verify', '--strict'])).code).toBe(1);

    await writeFile(join(root, 'agent-docs', 'demo', 'pages', 'index.md'), 'tampered\n');
    const failed = await runCli(root, ['verify', 'demo']);
    expect(failed.code).toBe(1);
    expect(failed.stdout).toBe('');
    expect(failed.stderr).toContain(
      'demo outputs fail: pages/index.md: content differs from the manifest (hash mismatch)'
    );

    const stale = await runCli(root, ['sync', '--check']);
    expect(stale.code).toBe(1);
    expect(stale.stderr).toContain('demo: would rebuild (the pack files differ from the manifest)');

    expect((await runCli(root, ['sync'])).code).toBe(0);
    expect((await runCli(root, ['verify'])).code).toBe(0);
  });

  it('dry-runs an add without writing anything', async () => {
    const root = await makeProject(DOCS);
    const result = await runCli(root, [
      'add',
      'demo',
      '--local',
      'docs',
      '--version',
      '2.0.0',
      '--recipe',
      '{"exclude":["guide/**"]}',
      '--dry-run',
      '--json',
      '--project',
      root,
    ]);

    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({ id: 'demo', dryRun: true, recipe: { version: '2.0.0' } });
    expect(output.files).toEqual([
      { outputPath: 'pages/index.md', kind: 'page', source: 'docs/index.md' },
    ]);
    expect(await readdir(root)).toEqual(['docs']);
  });

  it('exits 2 with one clear line for usage and config errors', async () => {
    const root = await makeProject(DOCS);
    const cases: string[][] = [
      ['sync'],
      ['add', 'Bad_Id', '--local', 'docs', '--version', '1', '--project', root],
      ['add', 'demo', '--local', 'docs', '--project', root],
      ['add', 'demo', '--local', '/etc', '--version', '1', '--project', root],
      [
        'add',
        'demo',
        '--recipe',
        '{"type":"local","path":"docs","bogus":1}',
        '--version',
        '1',
        '--project',
        root,
      ],
      [
        'add',
        'demo',
        '--local',
        'docs',
        '--version',
        '1',
        '--dependency',
        'maven:x',
        '--project',
        root,
      ],
    ];
    const expected = [
      "run 'llm-docs init' or pass --project <dir>",
      'must match',
      'Pass --version <v> or --dependency <ecosystem>:<name>.',
      'source path: must be project-relative, not absolute',
      'source: unknown key "bogus"',
      '--dependency must be <ecosystem>:<name>',
    ];

    for (const [index, args] of cases.entries()) {
      const result = await runCli(root, args);
      expect(result.code, args.join(' ')).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr.trim().split('\n')).toHaveLength(1);
      expect(result.stderr).toContain(expected[index]);
    }
  });

  it('lists the v3 commands, sources, and limits in capabilities', async () => {
    const root = await makeProject({});
    const result = await runCli(root, ['capabilities', '--json']);
    const capabilities = JSON.parse(result.stdout);

    expect(capabilities.commands.map((command: { name: string }) => command.name)).toEqual([
      'init',
      'add',
      'sync',
      'refresh',
      'verify',
      'discover',
      'capabilities',
    ]);
    expect(
      capabilities.commands[1].options.map((option: { flags: string }) => option.flags)
    ).toEqual(
      expect.arrayContaining([
        '--local <path>',
        '--git <repo>',
        '--ref <ref>',
        '--path <path>',
        '--url <url>',
        '--urls-file <file>',
        '--llms-txt <url>',
        '--include <glob>',
        '--strip-prefix <prefix>',
        '--site <baseUrl>',
      ])
    );
    expect(capabilities.sourceTypes).toEqual([
      { type: 'git', supported: true },
      { type: 'urls', supported: true },
      { type: 'llms-txt', supported: true },
      { type: 'local', supported: true },
    ]);
    expect(capabilities.limits).toMatchObject({ maxFiles: 5000 });
  });

  it('adds a git pack, syncs and verifies it, and reports upstream changes with refresh', async () => {
    const repo = await makeGitRepo();
    const root = await makeProject({});
    const add = await runCli(root, [
      'add',
      'demo',
      '--git',
      repo.url,
      '--ref',
      'main',
      '--path',
      'docs',
      '--version',
      '1.0.0',
      '--project',
      root,
    ]);

    expect(add.code, add.stderr).toBe(0);
    expect(add.stderr).toContain('demo: built (not built yet)');
    expect(add.stderr).toContain('is a branch, so the pin floats');
    expect(JSON.parse(await readFile(join(root, 'llm-docs.json'), 'utf-8')).packs.demo).toEqual({
      version: '1.0.0',
      sources: [{ type: 'git', repo: repo.url, ref: 'main', paths: ['docs'] }],
    });
    const manifest = JSON.parse(
      await readFile(join(root, 'agent-docs', 'demo', 'manifest.json'), 'utf-8')
    );
    expect(manifest.origins).toEqual([
      { type: 'git', repo: repo.url, ref: 'main', commit: repo.head, refKind: 'branch' },
    ]);
    expect(manifest.license).toEqual({
      declared: null,
      detected: { spdx: 'MIT', evidence: 'LICENSE' },
      status: 'permissive',
    });

    expect((await runCli(root, ['sync'])).stderr).toContain('demo: up to date');
    const verify = await runCli(root, ['verify', '--strict']);
    expect(verify.code, verify.stderr).toBe(0);

    const unchanged = await runCli(root, ['refresh', '--check']);
    expect(unchanged.code, unchanged.stderr).toBe(0);
    expect(unchanged.stderr).toContain(
      'demo: no upstream changes (0 changed, 0 added, 0 removed, 2 unchanged)'
    );

    await repo.commit({ 'docs/index.md': '# Home, revised\n', 'docs/new.md': '# New\n' });
    const changed = await runCli(root, ['refresh', '--check', '--json']);
    expect(changed.code).toBe(1);
    const report = JSON.parse(changed.stdout);
    expect(report.packs[0]).toMatchObject({
      id: 'demo',
      status: 'would-build',
      refresh: {
        changed: true,
        counts: { changed: 1, added: 1, removed: 0, unchanged: 1 },
        refs: [{ ref: 'main', previousCommit: repo.head }],
      },
    });
    expect(changed.stderr).toContain('git ref main of');
    expect(changed.stderr).toContain('changed  pages/index.md');
    expect(changed.stderr).toContain('added    pages/new.md');

    const refreshed = await runCli(root, ['refresh']);
    expect(refreshed.code, refreshed.stderr).toBe(0);
    expect(refreshed.stderr).toContain('demo: upstream changed; rebuilt');
    expect(await readFile(join(root, 'agent-docs', 'demo', 'pages', 'new.md'), 'utf-8')).toContain(
      '# New'
    );
    expect((await runCli(root, ['verify'])).code).toBe(0);
    expect((await runCli(root, ['refresh', '--check'])).code).toBe(0);
  });

  it('builds http sources from the add flags', async () => {
    const root = await makeProject({ 'urls.txt': '# pages\nhttp://127.0.0.1:1/a\n\n' });
    const urlsFile = await runCli(root, [
      'add',
      'demo',
      '--urls-file',
      'urls.txt',
      '--version',
      '1',
      '--dry-run',
      '--json',
      '--project',
      root,
    ]);
    // The dry run acquires, and the policy refuses plain http without the private-network switch.
    expect(urlsFile.code).toBe(2);
    expect(urlsFile.stderr).toContain('plain http is allowed only to loopback');

    const missingInclude = await runCli(root, [
      'add',
      'demo',
      '--llms-txt',
      'https://docs.example.com/llms.txt',
      '--version',
      '1',
      '--project',
      root,
    ]);
    expect(missingInclude.code).toBe(2);
    expect(missingInclude.stderr).toContain('--llms-txt needs at least one --include');

    const misplaced = await runCli(root, [
      'add',
      'demo',
      '--url',
      'https://docs.example.com/a',
      '--ref',
      'v1',
      '--version',
      '1',
      '--project',
      root,
    ]);
    expect(misplaced.code).toBe(2);
    expect(misplaced.stderr).toContain('--ref only applies to --git');
  });
});

async function makeGitRepo(): Promise<{
  url: string;
  head: string;
  commit(files: Record<string, string>): Promise<void>;
}> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'llm-docs-cli-repo-'));
  tempDirs.push(dir);
  const config = join(dir, '..', `${dir.split(/[\\/]/).pop() ?? 'repo'}.gitconfig`);
  await writeFile(config, '');
  tempDirs.push(config);
  const git = async (...args: string[]): Promise<string> =>
    (
      await execFileAsync('git', args, {
        cwd: dir,
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: config,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_AUTHOR_NAME: 'Test',
          GIT_AUTHOR_EMAIL: 'test@example.com',
          GIT_COMMITTER_NAME: 'Test',
          GIT_COMMITTER_EMAIL: 'test@example.com',
        },
      })
    ).stdout.trim();
  const commit = async (files: Record<string, string>): Promise<void> => {
    for (const [path, content] of Object.entries(files)) {
      const target = join(dir, ...path.split('/'));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    await git('add', '-A');
    await git('commit', '--quiet', '-m', 'change');
  };

  await git('init', '--quiet', '--initial-branch=main');
  await commit({
    LICENSE: await readFile(join(repoRoot, 'tests', 'fixtures', 'licenses', 'MIT.txt'), 'utf-8'),
    'docs/index.md': '# Home\n\nSee [start](guide/start.md).\n',
    'docs/guide/start.md': '# Start\n',
    'src/index.ts': 'export {};\n',
  });

  return { url: pathToFileURL(dir).href, head: await git('rev-parse', 'HEAD'), commit };
}
