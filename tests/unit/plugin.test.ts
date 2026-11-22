import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import packageJson from '../../package.json';
import {
  findRegistryInstructions,
  lintPlugin,
  parseCapabilities,
  staleCutoffTableWarning,
  type Capabilities,
} from '../../scripts/check-plugin.js';
import { runSessionStartHook } from '../../src/agent/hook.js';
import { isRecord } from '../../src/utils/guards.js';

const run = promisify(execFile);
const repoRoot = join(import.meta.dirname, '..', '..');
const pluginDir = join(repoRoot, 'plugin');
const bundle = join(pluginDir, 'bin', 'llm-docs.mjs');
const tempDirs: string[] = [];

async function tempDir(files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'llm-docs-plugin-'));
  tempDirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, ...path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return root;
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(join(repoRoot, path), 'utf-8'));
  if (!isRecord(value)) {
    throw new Error(`${path} is not a JSON object`);
  }
  return value;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

let capabilities: Capabilities;

beforeAll(async () => {
  const { stdout } = await run(process.execPath, [bundle, 'capabilities', '--json']);
  capabilities = parseCapabilities(JSON.parse(stdout));
});

afterAll(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('plugin manifests and hooks', () => {
  it('name the plugin llm-docs at the package version in both plugin manifests', async () => {
    for (const path of ['plugin/.claude-plugin/plugin.json', 'plugin/.cursor-plugin/plugin.json']) {
      expect(await readJson(path)).toMatchObject({
        name: 'llm-docs',
        version: packageJson.version,
      });
    }
    expect(await readJson('plugin/.cursor-plugin/plugin.json')).toMatchObject({
      skills: './skills/',
      agents: './agents/',
      hooks: './hooks/cursor-hooks.json',
    });
  });

  it('list the plugin in both marketplaces at the package version, pointing at plugin/', async () => {
    const marketplaces = {
      '.claude-plugin/marketplace.json': { source: './plugin', manifest: '.claude-plugin' },
      '.cursor-plugin/marketplace.json': { source: 'plugin', manifest: '.cursor-plugin' },
    };

    for (const [path, expected] of Object.entries(marketplaces)) {
      const marketplace = await readJson(path);
      expect(marketplace).toMatchObject({ name: 'llm-docs', owner: { name: 'Zyepher' } });
      const entry = records(marketplace.plugins).find((plugin) => plugin.name === 'llm-docs');
      expect(entry).toMatchObject({ source: expected.source, version: packageJson.version });
      await expect(
        readFile(join(repoRoot, expected.source, expected.manifest, 'plugin.json'), 'utf-8')
      ).resolves.toContain('"name": "llm-docs"');
    }
  });

  it('run the bundled hook at every Claude Code session source with a 5 second timeout', async () => {
    const hooks = await readJson('plugin/hooks/hooks.json');
    const sessionStart = isRecord(hooks.hooks) ? records(hooks.hooks.SessionStart) : [];

    expect(sessionStart).toHaveLength(1);
    expect(String(sessionStart[0]?.matcher).split('|').sort()).toEqual(
      ['clear', 'compact', 'fork', 'resume', 'startup'].sort()
    );
    expect(sessionStart[0]?.hooks).toEqual([
      {
        type: 'command',
        command: expect.stringMatching(
          /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/llm-docs\.mjs" hook session-start$/
        ),
        timeout: 5,
      },
    ]);
  });

  it('run the bundled hook at Cursor session start, from the plugin directory', async () => {
    expect(await readJson('plugin/hooks/cursor-hooks.json')).toEqual({
      version: 1,
      hooks: {
        sessionStart: [{ command: 'node ./bin/llm-docs.mjs hook session-start', timeout: 5 }],
      },
    });
  });
});

describe('plugin skills and agent', () => {
  it('name each skill after its folder and mention only commands, flags, and checks the CLI has', async () => {
    expect((await readdir(join(pluginDir, 'skills'))).sort()).toEqual([
      'add-docs',
      'llm-docs',
      'write-docs-guide',
    ]);
    expect(await lintPlugin(pluginDir, capabilities)).toEqual([]);
  });

  it('reports a renamed skill, an unknown command and flag, and a check the table misses', async () => {
    const copy = await tempDir();
    for (const part of ['skills', 'agents', 'README.md']) {
      await cp(join(pluginDir, part), join(copy, part), { recursive: true });
    }
    const reference = join(copy, 'skills', 'llm-docs', 'SKILL.md');
    const text = await readFile(reference, 'utf-8');
    await writeFile(
      reference,
      text
        .replace('name: llm-docs', 'name: llm-docs-reference')
        .replace(/^\| `license` \|.*\n/m, '')
        .concat('\nRun `llm-docs sync --force` or `llm-docs publish`.\n')
    );

    expect(await lintPlugin(copy, capabilities)).toEqual([
      'skills/llm-docs/SKILL.md: frontmatter name "llm-docs-reference" must equal "llm-docs".',
      expect.stringMatching(
        /^skills\/llm-docs\/SKILL\.md:\d+: `--force` is not an option of `llm-docs sync`\.$/
      ),
      expect.stringMatching(
        /^skills\/llm-docs\/SKILL\.md:\d+: `llm-docs publish` is not an llm-docs command\.$/
      ),
      'skills/llm-docs/SKILL.md: the Check table does not list `license`.',
    ]);
  });
});

describe('the package registry rule', () => {
  it('passes the committed plugin and docs', async () => {
    expect(await findRegistryInstructions(repoRoot, ['plugin', 'docs'])).toEqual([]);
  });

  it('names each line that tells the reader to get the CLI from a registry', async () => {
    const root = await tempDir({
      'plugin/skills/x/SKILL.md': [
        'Run it as `npx llm-docs` if that command is not found.',
        'Or `npx --yes llm-docs@3 verify`, `pnpm dlx llm-docs sync`, `bunx llm-docs`.',
        'Never `npx tsx scripts/build.ts` or `npm install llm-docs-generator`.',
      ].join('\n'),
      'docs/install.md': [
        '# Install',
        'npm install --save-dev llm-docs',
        'yarn global add llm-docs',
        '"$schema": "./node_modules/llm-docs/schema/llm-docs.schema.json"',
        'curl -fsSLO https://github.com/o/r/releases/download/v3.0.0/llm-docs.mjs',
      ].join('\n'),
    });

    const problems = await findRegistryInstructions(root, ['plugin', 'docs']);
    expect(problems.map((problem) => problem.split(': ')[0])).toEqual([
      'plugin/skills/x/SKILL.md:1',
      'plugin/skills/x/SKILL.md:2',
      'docs/install.md:2',
      'docs/install.md:3',
      'docs/install.md:4',
    ]);
    expect(problems[0]).toMatch(/GitHub Release asset llm-docs\.mjs instead\.$/);
  });
});

describe('the bundled CLI', () => {
  it('prints the package version', async () => {
    const { stdout } = await run(process.execPath, [bundle, '--version']);
    expect(stdout).toBe(`${packageJson.version}\n`);
  });

  it('prints the same session-start envelope as the unbundled hook, from a temp directory', async () => {
    const root = await tempDir({
      'package.json': JSON.stringify({ name: 'app', dependencies: { hono: '^4.13.16' } }),
      'package-lock.json': JSON.stringify({
        name: 'app',
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': { name: 'app', dependencies: { hono: '^4.13.16' } },
          'node_modules/hono': { version: '4.13.16' },
        },
      }),
    });
    const cache = await tempDir({
      'release-dates.json': JSON.stringify({
        schemaVersion: 1,
        entries: {
          'npm:hono@4.13.16': {
            publishedAt: '2026-09-02T10:00:00.000Z',
            source: 'deps.dev',
            fetchedAt: '2026-11-01T00:00:00.000Z',
          },
        },
      }),
    });
    const home = await tempDir();
    // Isolated from the session running the suite: no inherited harness, model, or settings.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      LLM_DOCS_CACHE_DIR: cache,
      HOME: home,
      USERPROFILE: home,
      CLAUDECODE: '1',
      CLAUDE_PROJECT_DIR: '',
      CURSOR_VERSION: '',
      CURSOR_PLUGIN_ROOT: '',
      ANTHROPIC_MODEL: '',
      LLM_DOCS_MODEL_CUTOFF: '',
      LLM_DOCS_HOOK: '',
    };
    const payload = JSON.stringify({
      session_id: 'test',
      cwd: root,
      hook_event_name: 'SessionStart',
      source: 'startup',
      model: 'claude-opus-5-5',
    });

    const bundled = await new Promise<string>((resolveOutput, reject) => {
      const child = execFile(
        process.execPath,
        [bundle, 'hook', 'session-start'],
        { cwd: root, env },
        (error, stdout, stderr) => {
          if (error !== null || stderr !== '') {
            reject(error ?? new Error(stderr));
            return;
          }
          resolveOutput(stdout);
        }
      );
      child.stdin?.end(payload);
    });

    let unbundled = '';
    await runSessionStartHook({
      env,
      cwd: root,
      homeDir: home,
      platform: process.platform,
      stdin: (async function* () {
        yield payload;
      })(),
      elapsedMs: () => 0,
      now: () => new Date(),
      writeStdout: (text) => {
        unbundled += text;
      },
      spawnWarmStatus: () => undefined,
    });

    expect(unbundled).toContain('"hookEventName":"SessionStart"');
    expect(unbundled).toContain('hono 4.13.16 (npm, released 2026-09-02, after cutoff)');
    expect(bundled).toBe(unbundled);
  });
});

describe('the bin wrappers', () => {
  it.skipIf(process.platform === 'win32')('run the bundle through the POSIX wrapper', async () => {
    const { stdout } = await run(join(pluginDir, 'bin', 'llm-docs'), ['--version']);
    expect(stdout).toBe(`${packageJson.version}\n`);
  });

  it.skipIf(process.platform !== 'win32')(
    'run the bundle through the Windows wrapper',
    async () => {
      const { stdout } = await run(`"${join(pluginDir, 'bin', 'llm-docs.cmd')}"`, ['--version'], {
        shell: true,
      });
      expect(stdout.trim()).toBe(packageJson.version);
    }
  );
});

describe('the model cutoff table review reminder', () => {
  it('stays quiet for 90 days after the review and then names the date and the refresh steps', () => {
    expect(staleCutoffTableWarning('2026-11-22', new Date('2027-02-20T12:00:00Z'))).toBeNull();
    expect(staleCutoffTableWarning('2026-11-22', new Date('2027-02-21T12:00:00Z'))).toBe(
      'data/model-cutoffs.json was last reviewed on 2026-11-22, 91 days ago; refresh it from the vendor pages listed in docs/design/v3-spec.md section 6.3 and set "reviewed" to the day you checked.'
    );
    expect(staleCutoffTableWarning('soon', new Date('2026-11-22T00:00:00Z'))).toMatch(
      /last reviewed on soon; refresh it/
    );
  });
});
