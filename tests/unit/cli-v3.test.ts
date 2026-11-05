/**
 * End-to-end runs of the BUILT CLI (dist/cli.js) against throwaway projects:
 * init, add --local, sync, sync --check, verify, and the --json shapes. The
 * build runs once before the suite.
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
      'conversion',
    ]);

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
      'verify',
      'discover',
      'capabilities',
    ]);
    expect(
      capabilities.commands[1].options.map((option: { flags: string }) => option.flags)
    ).toContain('--local <path>');
    expect(capabilities.sourceTypes).toEqual([
      { type: 'git', supported: false },
      { type: 'urls', supported: false },
      { type: 'llms-txt', supported: false },
      { type: 'local', supported: true },
    ]);
    expect(capabilities.limits).toMatchObject({ maxFiles: 5000 });
  });
});
