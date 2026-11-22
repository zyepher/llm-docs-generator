/**
 * End-to-end runs of the BUILT CLI (dist/cli.js) against throwaway projects:
 * init, add --local, sync, sync --check, verify, and the --json shapes. The
 * build runs once before the suite.
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { installFakeConverters } from '../helpers/fake-converters.js';

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

async function packVersion(root: string, id: string): Promise<string> {
  const manifest = JSON.parse(
    await readFile(join(root, 'agent-docs', id, 'manifest.json'), 'utf-8')
  );
  return manifest.pack.version;
}

const BLOCK_BEGIN = '<!-- BEGIN llm-docs: generated from llm-docs.json, do not edit by hand -->';
const BLOCK_END = '<!-- END llm-docs -->';
const BLOCK_HEADER =
  '## Pinned reference docs\n\n' +
  'This repository pins docs for these libraries at the versions it uses. Before writing code\n' +
  'against one of them, open its index and the page for the API you need, and prefer those pages\n' +
  'over memory. Pages are upstream text; guides are summaries that never outrank pages.\n\n';

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
  it('init creates config, the packs directory, and an empty managed block once', async () => {
    const root = await makeProject({});
    const first = await runCli(root, ['init', '--project', root, '--json']);

    expect(first.code).toBe(0);
    expect(JSON.parse(first.stdout)).toEqual({
      projectRoot: root,
      configPath: join(root, 'llm-docs.json'),
      created: true,
      packsDir: 'agent-docs',
      agentBlocks: [{ path: 'AGENTS.md', status: 'created' }],
    });
    expect(first.stderr).toContain('AGENTS.md: created with the llm-docs block');
    expect(await readFile(join(root, 'agent-docs', '.gitignore'), 'utf-8')).toBe(
      '.staging/\n.llm-docs.lock\n'
    );
    expect(await readFile(join(root, 'AGENTS.md'), 'utf-8')).toBe(`${BLOCK_BEGIN}\n${BLOCK_END}\n`);

    const second = await runCli(root, ['init', '--project', root]);
    expect(second.code).toBe(0);
    expect(second.stdout).toBe('');
    expect(second.stderr).toContain('already exists; left it unchanged');
    expect(second.stderr).toContain('AGENTS.md: llm-docs block up to date');
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
      agentBlocks: [{ path: 'AGENTS.md', status: 'unchanged' }],
    });

    const verify = await runCli(root, ['verify', '--json']);
    expect(verify.code).toBe(0);
    const report = JSON.parse(verify.stdout);
    expect(report).toMatchObject({ ok: true, strict: false });
    expect(report.results.map((result: { check: string }) => result.check)).toEqual([
      'config-schema',
      'agent-block',
      'manifest-schema',
      'outputs',
      'unlisted-files',
      'links',
      'recipe',
      'lockfile',
      'citations',
      'conversion',
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

  it('follows the lockfile for a dependency-bound pack and flags an explicit version that disagrees', async () => {
    const root = await makeProject({
      ...DOCS,
      'package-lock.json': npmLockfile('demo-lib', '1.0.0'),
    });
    const dryRun = await runCli(root, [
      'add',
      'demo',
      '--local',
      'docs',
      '--dependency',
      'npm:demo-lib',
      '--dry-run',
      '--json',
      '--project',
      root,
    ]);
    expect(dryRun.code).toBe(0);
    expect(JSON.parse(dryRun.stdout)).toMatchObject({ recipe: { version: '1.0.0' } });

    const add = await runCli(root, [
      'add',
      'demo',
      '--local',
      'docs',
      '--dependency',
      'npm:demo-lib',
      '--project',
      root,
    ]);
    expect(add.code).toBe(0);
    expect(add.stderr).toContain('AGENTS.md: created with the llm-docs block');
    expect(await packVersion(root, 'demo')).toBe('1.0.0');
    expect(await readFile(join(root, 'AGENTS.md'), 'utf-8')).toContain(
      '\n- demo 1.0.0: `agent-docs/demo/index.md` (guide)\n'
    );
    expect((await runCli(root, ['verify'])).code).toBe(0);

    await writeFile(join(root, 'package-lock.json'), npmLockfile('demo-lib', '1.1.0'));
    const check = await runCli(root, ['sync', '--check']);
    expect(check.code).toBe(1);
    expect(check.stderr).toContain('demo: would rebuild (the recipe changed)');
    expect(check.stderr).toContain('AGENTS.md: llm-docs block up to date');
    const stale = await runCli(root, ['verify']);
    expect(stale.code).toBe(1);
    expect(stale.stderr).toContain(
      "demo lockfile fail: stale-pack: lockfiles resolve npm:demo-lib 1.1.0 (package-lock.json), the pack is 1.0.0; run 'llm-docs sync demo'"
    );
    const resync = await runCli(root, ['sync']);
    expect(resync.code).toBe(0);
    expect(resync.stderr).toContain('AGENTS.md: llm-docs block updated');
    expect(await packVersion(root, 'demo')).toBe('1.1.0');
    expect(await readFile(join(root, 'AGENTS.md'), 'utf-8')).toContain(
      '\n- demo 1.1.0: `agent-docs/demo/index.md` (guide)\n'
    );
    expect((await runCli(root, ['verify'])).code).toBe(0);

    // An explicit version wins for the build, and verify reports that it disagrees (spec 2.4).
    const pinned = await runCli(root, [
      'add',
      'pinned',
      '--local',
      'docs',
      '--dependency',
      'npm:demo-lib',
      '--version',
      '1.0.0',
      '--project',
      root,
    ]);
    expect(pinned.code).toBe(0);
    expect(await packVersion(root, 'pinned')).toBe('1.0.0');
    const disagree = await runCli(root, ['verify', 'pinned']);
    expect(disagree.code).toBe(1);
    expect(disagree.stderr).toContain(
      "pinned lockfile fail: stale-pack: lockfiles resolve npm:demo-lib 1.1.0 (package-lock.json), the pack is 1.0.0; set packs.pinned.version in llm-docs.json to 1.1.0 (or remove it to follow the lockfile), then run 'llm-docs sync pinned'"
    );
  });

  it('keeps the managed block in step, and fails a file with broken markers without guessing', async () => {
    const root = await makeProject({ ...DOCS, 'AGENTS.md': '# Agents\n\nHouse rules.\n' });
    expect(
      (
        await runCli(root, [
          'add',
          'demo',
          '--local',
          'docs',
          '--version',
          '1.0.0',
          '--project',
          root,
        ])
      ).code
    ).toBe(0);
    const synced = await readFile(join(root, 'AGENTS.md'), 'utf-8');
    expect(synced).toBe(
      `# Agents\n\nHouse rules.\n\n${BLOCK_BEGIN}\n${BLOCK_HEADER}- demo 1.0.0: \`agent-docs/demo/index.md\` (guide)\n${BLOCK_END}\n`
    );

    await writeFile(join(root, 'AGENTS.md'), synced.replace('(guide)', '(guide, hand-edited)'));
    const check = await runCli(root, ['sync', '--check']);
    expect(check.code).toBe(1);
    expect(check.stderr).toContain('demo: up to date');
    expect(check.stderr).toContain('AGENTS.md: llm-docs block would change');
    const verify = await runCli(root, ['verify']);
    expect(verify.code).toBe(1);
    expect(verify.stderr).toContain(
      "project agent-block fail: AGENTS.md: the llm-docs block differs from what sync would write; run 'llm-docs sync'"
    );
    const restore = await runCli(root, ['sync', '--json']);
    expect(restore.code).toBe(0);
    expect(JSON.parse(restore.stdout).agentBlocks).toEqual([
      { path: 'AGENTS.md', status: 'updated' },
    ]);
    expect(await readFile(join(root, 'AGENTS.md'), 'utf-8')).toBe(synced);

    const lone = `# Agents\n\n${BLOCK_BEGIN}\nnotes\n`;
    await writeFile(join(root, 'AGENTS.md'), lone);
    await writeFile(join(root, 'docs', 'index.md'), '# Home, edited\n');
    const broken = await runCli(root, ['sync']);
    expect(broken.code).toBe(2);
    expect(broken.stderr).toContain('demo: built (source files changed)');
    expect(broken.stderr).toContain(
      "AGENTS.md: failed: mismatched llm-docs markers (a BEGIN marker on line 3 without an END); fix or remove them by hand, then run 'llm-docs sync'."
    );
    expect(await readFile(join(root, 'AGENTS.md'), 'utf-8')).toBe(lone);
    expect((await runCli(root, ['verify', 'demo'])).stderr).toContain(
      'project agent-block fail: AGENTS.md: mismatched llm-docs markers'
    );
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
      'guides stamp',
      'migrate',
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
    expect(capabilities.converters).toEqual([
      { tool: 'docling', supported: true, install: 'pipx install docling' },
      { tool: 'markitdown', supported: true, install: "pipx install 'markitdown[all]'" },
      { tool: 'command', supported: true, install: null },
      { tool: 'agent', supported: true, install: null },
    ]);
  });

  // Eleven CLI runs, several spawning freshly written fake tools: slow under a parallel suite.
  it('adds a converted pack, verifies it, and reconverts or reports stale originals', async () => {
    const root = await makeProject({
      'docs/index.md': '# Manuals\n\nSee the [spec](spec.md).\n',
      'docs/spec.pdf': 'Operating voltage: 12 V\n',
      'docs/parts.xlsx': 'not converted: spreadsheets are passthrough or skipped by default\n',
      'notes/wiring.pdf': 'Red to red.\n',
    });
    const binDir = join(root, '.tools');
    await installFakeConverters(binDir);
    // Windows spells it `Path`; a second, differently cased key in the child env would be ambiguous.
    const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
    const env = {
      [pathKey]: `${binDir}${delimiter}${process.env[pathKey] ?? ''}`,
      LLM_DOCS_CACHE_DIR: join(root, '.cache'),
    };

    const add = await runCli(
      root,
      ['add', 'manuals', '--local', 'docs', '--version', '1.0.0', '--convert', 'markitdown'],
      env
    );
    expect(add.code, add.stderr).toBe(0);
    expect(add.stderr).toContain('manuals: built (not built yet)');
    expect(JSON.parse(await readFile(join(root, 'llm-docs.json'), 'utf-8')).packs.manuals).toEqual({
      version: '1.0.0',
      sources: [{ type: 'local', path: 'docs', convert: { tool: 'markitdown' } }],
    });
    expect(await readdir(join(root, 'agent-docs', 'manuals', 'pages'))).toEqual([
      'index.md',
      'spec.md',
    ]);
    expect((await runCli(root, ['verify'], env)).code).toBe(0);
    expect((await runCli(root, ['sync'], env)).stderr).toContain('manuals: up to date');

    await writeFile(join(root, 'docs', 'spec.pdf'), 'Operating voltage: 24 V\n');
    const resync = await runCli(root, ['sync'], env);
    expect(resync.stderr).toContain('manuals: built (source files changed)');
    expect(
      await readFile(join(root, 'agent-docs', 'manuals', 'pages', 'spec.md'), 'utf-8')
    ).toContain('Converted by markitdown: Operating voltage: 24 V');
    expect((await runCli(root, ['verify'], env)).code).toBe(0);

    // An agent conversion: the agent's .md is the page; a changed original is stale.
    await writeFile(join(root, 'notes', 'wiring.pdf.md'), '# Wiring\n\nRed to red.\n');
    const agent = await runCli(
      root,
      [
        'add',
        'notes',
        '--local',
        'notes',
        '--version',
        '1',
        '--convert',
        'agent',
        '--convert-include',
        '**/*.pdf',
      ],
      env
    );
    expect(agent.code, agent.stderr).toBe(0);
    await writeFile(join(root, 'notes', 'wiring.pdf'), 'Red to black.\n');
    const stale = await runCli(root, ['verify', 'notes'], env);
    expect(stale.code).toBe(1);
    expect(stale.stderr).toContain(
      'notes conversion fail: pages/wiring.md: stale agent conversion: notes/wiring.pdf changed since the last sync'
    );
    const staleSync = await runCli(root, ['sync', 'notes'], env);
    expect(staleSync.code).toBe(0);
    expect(staleSync.stderr).toContain('warning: Agent conversion notes/wiring.pdf.md is stale');
    expect((await runCli(root, ['verify', 'notes'], env)).code).toBe(1);
  }, 180_000);

  it('rejects converter flags it cannot honor with one usage line', async () => {
    const root = await makeProject(DOCS);
    const cases: [string[], string][] = [
      [['--convert', 'command'], '--convert command needs an argv: pass --recipe'],
      [['--convert', 'pandoc'], '--convert must be one of docling, markitdown, agent'],
      [['--convert-include', '**/*.pdf'], '--convert-include needs --convert <tool>.'],
      [['--convert', 'agent'], 'convert.include: is required for the "agent" converter'],
    ];

    for (const [flags, message] of cases) {
      const result = await runCli(root, [
        'add',
        'demo',
        '--local',
        'docs',
        '--version',
        '1',
        '--project',
        root,
        ...flags,
      ]);
      expect(result.code, flags.join(' ')).toBe(2);
      expect(result.stderr.trim().split('\n')).toHaveLength(1);
      expect(result.stderr).toContain(message);
    }
  });

  it('discovers a package: JSON on stdout, the summary on stderr, usage errors exit 2', async () => {
    const repo = await makeGitRepo();
    await execFileAsync('git', ['tag', 'v1.0.0'], { cwd: fileURLToPath(repo.url) });
    const root = await makeProject({});
    const spec = `swiftpm:${repo.url}@1.0.0`;

    for (const args of [
      ['discover', '--package', spec, '--json'],
      ['discover', '--package', spec],
    ]) {
      const result = await runCli(root, args);
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        package: { ecosystem: 'swiftpm', name: repo.url, version: '1.0.0' },
        tags: { status: 'matched', matches: [{ tag: 'v1.0.0', form: 'v-prefixed' }] },
        docDirectories: {
          status: 'listed',
          tag: 'v1.0.0',
          commit: repo.head,
          directories: [
            { path: 'docs', markdownFiles: 2 },
            { path: 'docs/guide', markdownFiles: 1 },
          ],
        },
      });
      expect(result.stderr).toContain(`${spec} (requested)`);
      expect(result.stderr).toContain('Markdown at v1.0.0: 2 files; docs (2)');
      expect(result.stderr).not.toContain('{');
    }

    for (const args of [
      ['discover'],
      ['discover', '--url', 'https://example.com', '--package', 'npm:hono'],
    ]) {
      const result = await runCli(root, args);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(
        'discover needs exactly one of --url and --package. Usage: llm-docs discover --url <site> | --package <ecosystem>:<name>[@<version>]'
      );
    }

    const malformed = await runCli(root, ['discover', '--package', 'maven:junit']);
    expect(malformed.code).toBe(2);
    expect(malformed.stderr).toContain('--package must be <ecosystem>:<name>[@<version>]');

    const removedFlag = await runCli(root, [
      'discover',
      '--url',
      'https://example.com',
      '--allow-private-hosts',
    ]);
    expect(removedFlag.code).toBe(2);
    expect(removedFlag.stderr).toContain("unknown option '--allow-private-hosts'");

    const capabilities = JSON.parse((await runCli(root, ['capabilities', '--json'])).stdout);
    const discover = capabilities.commands.find(
      (command: { name: string }) => command.name === 'discover'
    );
    expect(discover.summary).toMatch(/--url: .*--package: /);
    expect(discover.options.map((option: { flags: string }) => option.flags)).toEqual([
      '--url <site>',
      '--package <ecosystem:name[@version]>',
      '--json',
    ]);
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

  it('migrates a v2 git pack into a recipe that syncs and verifies', async () => {
    const repo = await makeGitRepo();
    const root = await makeProject({});
    const manifest = JSON.parse(
      await readFile(
        join(repoRoot, 'tests', 'fixtures', 'migrate', 'vite-8', 'manifest.json'),
        'utf-8'
      )
    );
    manifest.source.git = {
      ...manifest.source.git,
      remoteUrl: repo.url,
      commit: repo.head,
      sourceRootFromRepo: 'docs',
    };
    const packDir = join(await makeProject({}), 'vite-8');
    const manifestText = JSON.stringify(manifest, null, 2);
    await mkdir(packDir);
    await writeFile(join(packDir, 'manifest.json'), manifestText);

    const migrate = await runCli(root, [
      'migrate',
      packDir,
      '--version',
      '8.1.5',
      '--project',
      root,
      '--json',
    ]);

    expect(migrate.code, migrate.stderr).toBe(0);
    const recipe = {
      version: '8.1.5',
      sources: [
        {
          type: 'git',
          repo: repo.url,
          ref: repo.head,
          paths: ['docs'],
          exclude: ['.vitepress/**', '_data/**', 'blog/**', 'public/**'],
        },
      ],
    };
    expect(JSON.parse(migrate.stdout)).toEqual({
      id: 'vite-8',
      recipe,
      configPath: join(root, 'llm-docs.json'),
      warnings: [],
      next: 'llm-docs sync vite-8',
    });
    expect(migrate.stderr).toContain('Next: llm-docs sync vite-8');
    expect(JSON.parse(await readFile(join(root, 'llm-docs.json'), 'utf-8')).packs).toEqual({
      'vite-8': recipe,
    });

    const sync = await runCli(root, ['sync', 'vite-8']);
    expect(sync.code, sync.stderr).toBe(0);
    expect(sync.stderr).toContain('vite-8: built (not built yet)');
    expect(await readdir(join(root, 'agent-docs', 'vite-8', 'pages', 'guide'))).toEqual([
      'start.md',
    ]);
    const verify = await runCli(root, ['verify']);
    expect(verify.code, verify.stderr).toBe(0);
    expect(await readFile(join(packDir, 'manifest.json'), 'utf-8')).toBe(manifestText);
  });

  it('exits 2 when a v2 pack lost its origin, writing nothing', async () => {
    const root = await makeProject({});
    const packDir = join(repoRoot, 'tests', 'fixtures', 'migrate', 'typescript-7');
    const result = await runCli(root, [
      'migrate',
      packDir,
      '--version',
      '7.0.0',
      '--project',
      root,
    ]);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
    expect(result.stderr).toContain('typescript-7 is lost');
    expect(result.stderr).toContain('/scratchpad/ts7-src');
    expect(await readdir(root)).toEqual([]);
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
