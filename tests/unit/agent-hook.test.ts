import { execFileSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { canCreateSymlinks } from '../helpers/symlinks.js';

import { HOOK_LIMITS, runSessionStartHook, type HookIo } from '../../src/agent/hook.js';
import { syncPacks } from '../../src/pack/build.js';
import { ALLOW_TEMP_SOURCES_ENV } from '../../src/sources/acquire.js';
import { ALLOW_PRIVATE_NETWORK_ENV } from '../../src/sources/http.js';
import { isRecord } from '../../src/utils/guards.js';

const NOW = new Date('2026-11-22T09:00:00.000Z');
const HOUR = 60 * 60 * 1000;

const cleanups: (() => Promise<void>)[] = [];

beforeEach(() => {
  vi.stubEnv(ALLOW_PRIVATE_NETWORK_ENV, '1');
  vi.stubEnv(ALLOW_TEMP_SOURCES_ENV, '1');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'llm-docs-hook-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, ...path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

function npmLock(versions: Record<string, string>): Record<string, string> {
  const dependencies = Object.fromEntries(
    Object.entries(versions).map(([name, version]) => [name, `^${version}`])
  );
  const installed = Object.fromEntries(
    Object.entries(versions).map(([name, version]) => [
      `node_modules/${name}`,
      { version, resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz` },
    ])
  );
  return {
    'package.json': JSON.stringify({ name: 'app', version: '1.0.0', dependencies }),
    'package-lock.json': JSON.stringify({
      name: 'app',
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: { '': { name: 'app', version: '1.0.0', dependencies }, ...installed },
    }),
  };
}

const LOCK = npmLock({ hono: '4.13.16', 'date-fns': '2.30.0', zod: '4.1.0', next: '16.1.0' });
const RELEASES: Record<string, string> = {
  'npm:hono@4.13.16': '2026-09-02T10:00:00.000Z',
  'npm:date-fns@2.30.0': '2023-04-28T00:00:00.000Z',
  'npm:zod@4.1.0': '2026-06-25T00:00:00.000Z',
  'npm:zod@4.0.0': '2026-05-01T00:00:00.000Z',
  'npm:next@16.1.0': '2026-10-21T18:00:00.000Z',
};
const LOCAL_DOCS = [{ type: 'local', path: 'docs' }];

/** A cache directory whose release-dates.json already knows `entries`. */
async function seededCache(entries: Record<string, string> = RELEASES): Promise<string> {
  const cache = await tempDir();
  await writeFiles(cache, {
    'release-dates.json': JSON.stringify({
      schemaVersion: 1,
      entries: Object.fromEntries(
        Object.entries(entries).map(([key, publishedAt]) => [
          key,
          { publishedAt, source: 'deps.dev', fetchedAt: '2026-11-01T00:00:00.000Z' },
        ])
      ),
    }),
  });
  return cache;
}

/** Registry stand-in: every request fails with a 500, so nothing ever leaves the machine. */
async function failingRegistry(): Promise<{ base: string; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? '');
    response.writeHead(500);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  );
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, requests };
}

async function* chunks(...values: (string | Uint8Array)[]): AsyncGenerator<string | Uint8Array> {
  yield* values;
}

const neverEnding: AsyncIterable<string> = {
  [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }),
};

interface HookRun {
  out: string[];
  spawned: string[];
  cache: string;
}

interface RunOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  payload?: Record<string, unknown> | string;
  stdin?: AsyncIterable<string | Uint8Array>;
  cache?: string;
  homeDir?: string;
  now?: Date;
  elapsedMs?: () => number;
  harness?: 'claude-code' | 'cursor' | 'unknown';
  onSpawn?: () => void;
}

async function runHook(options: RunOptions = {}): Promise<HookRun> {
  const out: string[] = [];
  const spawned: string[] = [];
  const cache = options.cache ?? (await seededCache());
  const { base } = await failingRegistry();
  const harnessEnv =
    options.harness === 'cursor'
      ? { CURSOR_VERSION: '2.1.0' }
      : options.harness === 'unknown'
        ? {}
        : { CLAUDECODE: '1' };
  const payload =
    typeof options.payload === 'string' ? options.payload : JSON.stringify(options.payload ?? {});
  const io: HookIo = {
    env: { ...harnessEnv, LLM_DOCS_CACHE_DIR: cache, ...options.env },
    cwd: options.cwd ?? (await tempDir()),
    homeDir: options.homeDir ?? (await tempDir()),
    platform: process.platform,
    stdin: options.stdin ?? chunks(payload),
    registryEndpoints: { depsDev: base, npmRegistry: base },
    elapsedMs: options.elapsedMs ?? (() => 0),
    now: () => options.now ?? NOW,
    writeStdout: (text) => out.push(text),
    spawnWarmStatus: (root) => {
      spawned.push(root);
      options.onSpawn?.();
    },
  };

  await runSessionStartHook(io);
  return { out, spawned, cache };
}

/** The injected text, after checking the run printed exactly one Claude Code envelope. */
function injected(run: HookRun): string {
  expect(run.out).toHaveLength(1);
  const [line = ''] = run.out;
  const parsed: unknown = JSON.parse(line);
  expect(line.endsWith('\n')).toBe(true);
  expect(parsed).toEqual({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: expect.any(String) },
  });
  const output = isRecord(parsed) ? parsed.hookSpecificOutput : undefined;
  const text = isRecord(output) ? output.additionalContext : undefined;
  return typeof text === 'string' ? text : '';
}

async function hookLog(cache: string): Promise<string> {
  return readFile(join(cache, 'hook.log'), 'utf-8').catch(() => '');
}

/** A project with the standard lockfile, plus config and built packs when given. */
async function project(
  options: {
    packs?: Record<string, Record<string, unknown>>;
    build?: string[];
    files?: Record<string, string>;
    config?: Record<string, unknown>;
    lock?: Record<string, string>;
    root?: string;
  } = {}
): Promise<string> {
  const root = options.root ?? (await tempDir());
  await writeFiles(root, {
    ...(options.lock ?? LOCK),
    'docs/index.md': '# Docs\n',
    ...options.files,
  });
  if (options.packs !== undefined || options.config !== undefined) {
    await writeFiles(root, {
      'llm-docs.json': JSON.stringify({
        schemaVersion: 3,
        agentFiles: [],
        ...options.config,
        packs: options.packs ?? {},
      }),
    });
  }
  if (options.build !== undefined) {
    const report = await syncPacks(root, options.build);
    expect(report.packs.every((pack) => pack.status === 'built')).toBe(true);
  }
  return root;
}

const OPUS = { model: 'claude-opus-5-5' };
const HONO = {
  title: 'Hono',
  dependency: { ecosystem: 'npm', name: 'hono' },
  sources: LOCAL_DOCS,
};
const ZOD_PINNED = {
  title: 'Zod',
  version: '4.0.0',
  dependency: { ecosystem: 'npm', name: 'zod' },
  sources: LOCAL_DOCS,
};

const REBUILD_ZOD = [
  'Pinned docs packs to fix:',
  "- zod: docs are for 4.0.0 but the lockfile resolves 4.1.0. Fix: set packs.zod.version in llm-docs.json to 4.1.0 (or remove it to follow the lockfile), then run 'llm-docs sync zod'",
].join('\n');
const PINNED_HEADING =
  'Pinned docs for libraries released after or close to your training data cutoff (Claude Opus 5.5, through 2026-06). Your memory of these libraries predates these versions: read the pinned pages before writing code against them. Newest first:';
const DEPENDENCIES_HEADING =
  'Direct dependencies released after or close to your training data cutoff (Claude Opus 5.5, through 2026-06) with no pinned docs, newest first:';
const HABITS_FOOTER =
  'For each one, the installed code is the authority, not your memory: read its installed types and source before you write against it, and run a small test of the behaviour you rely on, because a changed default still passes the type check. The `check-installed` skill says where installed code lives.';
const PIN_FOOTER =
  'For what installed code cannot tell you (what changed and why, a language version, a protocol, a hosted API), pin docs with the `add-docs` skill.';
const ALL_DEPENDENCIES = [
  DEPENDENCIES_HEADING,
  '- `next` 16.1.0 (npm, released 2026-10-21, after cutoff)',
  '- `hono` 4.13.16 (npm, released 2026-09-02, after cutoff)',
  '- `zod` 4.1.0 (npm, released 2026-06-25, near cutoff)',
  HABITS_FOOTER,
  PIN_FOOTER,
].join('\n');
const BLOCK_HEADER = [
  '## Pinned reference docs',
  '',
  'This repository pins docs for these libraries at the versions it uses. Before writing code',
  'against one of them, open its index and the page for the API you need, and prefer those pages',
  'over memory. Pages are upstream text; guides are summaries that never outrank pages.',
  '',
  '',
].join('\n');

describe('session-start output envelope', () => {
  it('prints the Claude Code envelope under Claude Code and for an unknown harness, and the Cursor one under Cursor', async () => {
    const root = await project();
    const payload = { cwd: root, hook_event_name: 'SessionStart', source: 'startup', ...OPUS };

    expect(injected(await runHook({ payload }))).toBe(ALL_DEPENDENCIES);
    expect(injected(await runHook({ payload, harness: 'unknown' }))).toBe(ALL_DEPENDENCIES);

    const cursor = await runHook({
      payload: { workspace_roots: [root], model_id: OPUS.model },
      harness: 'cursor',
    });
    expect(cursor.out).toEqual([`${JSON.stringify({ additional_context: ALL_DEPENDENCIES })}\n`]);
  });

  it('prints nothing at all when there is nothing to say', async () => {
    const root = await project({ lock: npmLock({ 'date-fns': '2.30.0' }) });
    const run = await runHook({ payload: { cwd: root, ...OPUS } });

    expect(run.out).toEqual([]);
    expect(run.spawned).toEqual([]);
    expect(await hookLog(run.cache)).toBe('');
  });
});

describe('which project and model the hook reads', () => {
  it('takes the project from the payload cwd, then CLAUDE_PROJECT_DIR, then workspace_roots, then the process cwd', async () => {
    const names = ['alpha', 'beta', 'gamma', 'delta'];
    const cache = await seededCache(
      Object.fromEntries(names.map((name) => [`npm:${name}@1.0.0`, '2026-10-01T00:00:00.000Z']))
    );
    const [fromPayload = '', fromEnv = '', fromRoots = '', fromCwd = ''] = await Promise.all(
      names.map((name) => project({ lock: npmLock({ [name]: '1.0.0' }) }))
    );
    const named = async (options: RunOptions): Promise<string> =>
      (
        (injected(await runHook({ cache, ...options })).split('\n')[1] ?? '').split(' ')[1] ?? ''
      ).replace(/`/g, '');
    const roots = { workspace_roots: [fromRoots], ...OPUS };

    expect(
      await named({
        payload: { cwd: fromPayload, ...roots },
        env: { CLAUDE_PROJECT_DIR: fromEnv },
        cwd: fromCwd,
      })
    ).toBe('alpha');
    expect(
      await named({ payload: roots, env: { CLAUDE_PROJECT_DIR: fromEnv }, cwd: fromCwd })
    ).toBe('beta');
    expect(await named({ payload: roots, cwd: fromCwd })).toBe('gamma');
    expect(await named({ payload: OPUS, cwd: fromCwd })).toBe('delta');
  });

  it('walks up from a subdirectory to the nearest llm-docs.json', async () => {
    const root = await project({ packs: {} });
    const deep = join(root, 'src', 'deep');
    await mkdir(deep, { recursive: true });

    expect(injected(await runHook({ payload: { cwd: deep, ...OPUS } }))).toBe(ALL_DEPENDENCIES);
  });

  it('takes the model from the payload, then ANTHROPIC_MODEL, then the project and user settings files', async () => {
    const root = await project();
    const home = await tempDir();
    const heading = async (options: RunOptions): Promise<string> =>
      injected(await runHook({ homeDir: home, ...options })).split('\n')[0] ?? '';
    const cutoffOf = (label: string, month: string): string =>
      `Direct dependencies released after or close to your training data cutoff (${label}, through ${month}) with no pinned docs, newest first:`;
    const env = { ANTHROPIC_MODEL: 'claude-opus-5' };

    expect(await heading({ payload: { cwd: root, model: 'claude-fable-5-1' }, env })).toBe(
      cutoffOf('Claude Fable 5.1', '2026-06')
    );
    expect(await heading({ payload: { cwd: root, model_id: 'claude-fable-5-1' }, env })).toBe(
      cutoffOf('Claude Fable 5.1', '2026-06')
    );
    expect(await heading({ payload: { cwd: root }, env })).toBe(
      cutoffOf('Claude Opus 5', '2026-05')
    );

    // A settings file names only the default model, which the session may have overridden,
    // so the cutoff it leads to is stated as an assumption.
    const assumedOf = (label: string, month: string): string =>
      `Assuming your model is the configured default (${label}, cutoff ${month}): direct dependencies released after or close to that cutoff with no pinned docs. If you are a different model, judge by the release dates shown. Newest first:`;
    await writeFiles(home, {
      '.claude/settings.json': JSON.stringify({ model: 'claude-sonnet-5' }),
    });
    expect(await heading({ payload: { cwd: root } })).toBe(assumedOf('Claude Sonnet 5', '2026-01'));

    await writeFiles(root, { '.claude/settings.json': JSON.stringify({ model: 'opus' }) });
    expect(await heading({ payload: { cwd: root } })).toBe(
      assumedOf('Claude Opus 5.5 (alias opus)', '2026-06')
    );
    expect(await heading({ payload: { cwd: root }, env })).toBe(
      cutoffOf('Claude Opus 5', '2026-05')
    );
  });

  it('states the cutoff as an assumption in each heading that names it when only a settings default names the model', async () => {
    const root = await project({
      lock: npmLock({ hono: '4.13.16', next: '16.1.0' }),
      packs: { hono: HONO },
      config: { agentFiles: 'auto' },
      build: ['hono'],
      files: { '.claude/settings.local.json': JSON.stringify({ model: 'claude-opus-5-5' }) },
    });

    expect(injected(await runHook({ payload: { cwd: root } }))).toBe(
      [
        'Assuming your model is the configured default (Claude Opus 5.5, cutoff 2026-06): pinned docs for libraries released after or close to that cutoff. If you are a different model, judge by the release dates shown. Your memory of these libraries predates these versions: read the pinned pages before writing code against them. Newest first:',
        '- Hono 4.13.16 (released 2026-09-02, after cutoff): `agent-docs/hono/index.md`',
        HABITS_FOOTER,
        '',
        'Assuming your model is the configured default (Claude Opus 5.5, cutoff 2026-06): direct dependencies released after or close to that cutoff with no pinned docs, newest first:',
        '- `next` 16.1.0 (npm, released 2026-10-21, after cutoff)',
        PIN_FOOTER,
      ].join('\n')
    );
  });

  it('uses the neutral heading and the 180-day window when no cutoff resolves', async () => {
    const root = await project();

    expect(injected(await runHook({ payload: { cwd: root, model: 'some-unknown-model' } }))).toBe(
      [
        'Recently released dependencies (your training data may predate them), released in the last 180 days with no pinned docs, newest first:',
        '- `next` 16.1.0 (npm, released 2026-10-21)',
        '- `hono` 4.13.16 (npm, released 2026-09-02)',
        '- `zod` 4.1.0 (npm, released 2026-06-25)',
        HABITS_FOOTER,
        PIN_FOOTER,
      ].join('\n')
    );
  });
});

describe('what the hook says', () => {
  it('names a pack that needs a rebuild, alone', async () => {
    const root = await project({
      lock: npmLock({ 'date-fns': '2.30.0' }),
      packs: { later: { version: '1.0.0', sources: LOCAL_DOCS } },
    });

    expect(injected(await runHook({ payload: { cwd: root, ...OPUS } }))).toBe(
      [
        'Pinned docs packs to fix:',
        '- later: not built or invalid. Fix: `llm-docs sync later`',
      ].join('\n')
    );
  });

  it('names a language version newer than the cutoff, read from the project version file', async () => {
    const root = await project({ lock: {}, files: { '.swift-version': '6.4.1\n' } });
    const cache = await seededCache({ 'toolchain:swift@6.4': '2026-09-14T00:00:00.000Z' });

    expect(injected(await runHook({ cache, payload: { cwd: root, ...OPUS } }))).toBe(
      [
        DEPENDENCIES_HEADING,
        '- `swift` 6.4 (toolchain, released 2026-09-14, after cutoff)',
        HABITS_FOOTER,
        PIN_FOOTER,
      ].join('\n')
    );
  });

  it('names a pinned pack newer than the cutoff and where its pages are, alone', async () => {
    const root = await project({
      lock: npmLock({ hono: '4.13.16' }),
      packs: { hono: HONO },
      config: { agentFiles: 'auto' },
      build: ['hono'],
    });

    expect(injected(await runHook({ payload: { cwd: root, ...OPUS } }))).toBe(
      [
        PINNED_HEADING,
        '- Hono 4.13.16 (released 2026-09-02, after cutoff): `agent-docs/hono/index.md`',
        HABITS_FOOTER,
      ].join('\n')
    );
  });

  it('counts a package the pack covers as pinned, naming the pack once with the newest date', async () => {
    const covering = { ...HONO, covers: [{ ecosystem: 'npm', name: 'next' }] };
    const root = await project({
      lock: npmLock({ hono: '4.13.16', next: '16.1.0' }),
      packs: { hono: covering },
      config: { agentFiles: 'auto' },
      build: ['hono'],
    });

    expect(injected(await runHook({ payload: { cwd: root, ...OPUS } }))).toBe(
      [
        PINNED_HEADING,
        '- Hono 4.13.16 (released 2026-10-21, after cutoff): `agent-docs/hono/index.md`',
        HABITS_FOOTER,
      ].join('\n')
    );
  });

  it('names the read-first pages of pinned packs, at most two each, before the index', async () => {
    const root = await project({
      lock: npmLock({ hono: '4.13.16', next: '16.1.0', zod: '4.1.0' }),
      files: {
        'docs/upgrade.md': '# Upgrade\n\n## Breaking\n\nRenamed.\n',
        'docs/changes.md': '# Changes\n',
      },
      packs: {
        hono: { ...HONO, readFirst: ['pages/upgrade.md'] },
        zod: {
          title: 'Zod',
          dependency: { ecosystem: 'npm', name: 'zod' },
          sources: LOCAL_DOCS,
          readFirst: ['pages/changes.md', 'pages/upgrade.md#breaking'],
        },
        next: {
          title: 'Next.js',
          dependency: { ecosystem: 'npm', name: 'next' },
          sources: LOCAL_DOCS,
          readFirst: ['pages/upgrade.md#breaking', 'pages/upgrade.md', 'pages/index.md'],
        },
      },
      config: { agentFiles: 'auto' },
      build: ['hono', 'zod', 'next'],
    });

    expect(injected(await runHook({ payload: { cwd: root, ...OPUS } }))).toBe(
      [
        PINNED_HEADING,
        '- Next.js 16.1.0 (released 2026-10-21, after cutoff): read `agent-docs/next/pages/upgrade.md` and `agent-docs/next/pages/index.md` first, then `agent-docs/next/index.md`',
        '- Hono 4.13.16 (released 2026-09-02, after cutoff): read `agent-docs/hono/pages/upgrade.md` first, then `agent-docs/hono/index.md`',
        '- Zod 4.1.0 (released 2026-06-25, near cutoff): read `agent-docs/zod/pages/changes.md` and `agent-docs/zod/pages/upgrade.md` first, then `agent-docs/zod/index.md`',
        HABITS_FOOTER,
      ].join('\n')
    );
  });

  it('lists the packs when the harness does not see the managed block, alone', async () => {
    const root = await project({
      lock: npmLock({ 'date-fns': '2.30.0' }),
      packs: { notes: { title: 'Notes', version: '1.0.0', sources: LOCAL_DOCS } },
      build: ['notes'],
    });

    expect(injected(await runHook({ payload: { cwd: root, ...OPUS } }))).toBe(
      `${BLOCK_HEADER}- Notes 1.0.0: \`agent-docs/notes/index.md\``
    );
  });

  it('says all four things in order', async () => {
    const root = await project({ packs: { hono: HONO, zod: ZOD_PINNED }, build: ['hono', 'zod'] });

    expect(injected(await runHook({ payload: { cwd: root, ...OPUS } }))).toBe(
      [
        REBUILD_ZOD,
        '',
        PINNED_HEADING,
        '- Hono 4.13.16 (released 2026-09-02, after cutoff): `agent-docs/hono/index.md`',
        '- Zod 4.0.0 (released 2026-05-01, near cutoff): `agent-docs/zod/index.md`',
        HABITS_FOOTER,
        '',
        DEPENDENCIES_HEADING,
        '- `next` 16.1.0 (npm, released 2026-10-21, after cutoff)',
        PIN_FOOTER,
        '',
        `${BLOCK_HEADER}- Hono 4.13.16: \`agent-docs/hono/index.md\``,
        '- Zod 4.0.0: `agent-docs/zod/index.md`',
      ].join('\n')
    );
  });

  it(`stays within ${HOOK_LIMITS.maxChars} characters, dropping the pack list first, then rows from the bottom`, async () => {
    const missing = (count: number) =>
      Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `p${String(index).padStart(2, '0')}`,
          { version: '1.0.0', sources: LOCAL_DOCS },
        ])
      );

    const crowded = await project({ packs: { hono: HONO, ...missing(18) }, build: ['hono'] });
    const fits = injected(await runHook({ payload: { cwd: crowded, ...OPUS } }));
    expect(fits.length).toBeLessThanOrEqual(HOOK_LIMITS.maxChars);
    expect(fits).toContain(PINNED_HEADING);
    expect(fits.endsWith(PIN_FOOTER)).toBe(true);
    expect(fits).not.toContain('## Pinned reference docs');

    const overflowing = await project({ packs: { hono: HONO, ...missing(40) }, build: ['hono'] });
    const cut = injected(await runHook({ payload: { cwd: overflowing, ...OPUS } }));
    const lines = cut.split('\n');
    expect(cut.length).toBeLessThanOrEqual(HOOK_LIMITS.maxChars);
    expect(lines[0]).toBe('Pinned docs packs to fix:');
    expect(lines.at(-1)).toMatch(/^- and \d+ more \(run `llm-docs status`\)$/);
    expect(cut).not.toContain(PINNED_HEADING);
    expect(cut).not.toContain(DEPENDENCIES_HEADING);
  });

  it('drops the items below before read-first paths, and read-first paths before rows', async () => {
    const pinnedRow = async (rebuilds: number): Promise<string[]> => {
      const root = await project({
        files: { 'docs/upgrade.md': '# Upgrade\n' },
        packs: {
          hono: { ...HONO, readFirst: ['pages/upgrade.md'] },
          ...Object.fromEntries(
            Array.from({ length: rebuilds }, (_, index) => [
              `p${String(index).padStart(4, '0')}`,
              { version: '1.0.0', sources: LOCAL_DOCS },
            ])
          ),
        },
        build: ['hono'],
      });
      const text = injected(await runHook({ payload: { cwd: root, ...OPUS } }));
      expect(text.length).toBeLessThanOrEqual(HOOK_LIMITS.maxChars);
      expect(text).not.toContain(DEPENDENCIES_HEADING);
      return text.split('\n').slice(rebuilds + 2);
    };

    expect(await pinnedRow(22)).toEqual([
      PINNED_HEADING,
      '- Hono 4.13.16 (released 2026-09-02, after cutoff): read `agent-docs/hono/pages/upgrade.md` first, then `agent-docs/hono/index.md`',
      HABITS_FOOTER,
    ]);
    expect(await pinnedRow(23)).toEqual([
      PINNED_HEADING,
      '- Hono 4.13.16 (released 2026-09-02, after cutoff): `agent-docs/hono/index.md`',
      HABITS_FOOTER,
    ]);
    expect(await pinnedRow(24)).toEqual([
      PINNED_HEADING,
      '- and 1 more (run `llm-docs status`)',
      HABITS_FOOTER,
    ]);
  });
});

describe('when the hook stays silent', () => {
  it('prints nothing with LLM_DOCS_HOOK=off or hook.enabled false', async () => {
    const root = await project();
    const off = await runHook({ payload: { cwd: root, ...OPUS }, env: { LLM_DOCS_HOOK: 'off' } });
    expect(off.out).toEqual([]);

    const disabled = await project({ config: { hook: { enabled: false } } });
    const quiet = await runHook({ payload: { cwd: disabled, ...OPUS } });
    expect(quiet.out).toEqual([]);
    expect(quiet.spawned).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'ignores a config another user owns, logging whose it is, and keeps the dependency analysis',
    async () => {
      const root = await project({ packs: { later: { version: '1.0.0', sources: LOCAL_DOCS } } });
      const you = process.getuid?.() ?? 0;
      const someoneElse = you === 0 ? 501 : 0;
      const spy = vi.spyOn(process, 'getuid').mockReturnValue(someoneElse);
      let run: HookRun;
      try {
        run = await runHook({ payload: { cwd: root, ...OPUS } });
      } finally {
        spy.mockRestore();
      }
      const user = (uid: number) => `user id ${uid}${uid === 0 ? ' (root)' : ''}`;

      expect(injected(run)).toBe(ALL_DEPENDENCIES);
      const log = await hookLog(run.cache);
      expect(log.slice(log.indexOf(' ') + 1)).toBe(
        `${join(root, 'llm-docs.json')} is owned by ${user(you)}, not by you (${user(someoneElse)}), so the session note ignores llm-docs.json (continuing with the dependency analysis only)\n`
      );
    }
  );

  it('falls back to the environment for a malformed, empty, or oversized payload, logging what was wrong', async () => {
    const root = await project();
    const env = { CLAUDE_PROJECT_DIR: root, ANTHROPIC_MODEL: OPUS.model };

    const garbage = await runHook({ payload: 'not json {', env });
    expect(injected(garbage)).toBe(ALL_DEPENDENCIES);
    expect(await hookLog(garbage.cache)).toMatch(
      /^\S+ the payload on stdin is not JSON; ignored it\n$/
    );

    const empty = await runHook({ stdin: chunks(), env });
    expect(injected(empty)).toBe(ALL_DEPENDENCIES);
    expect(await hookLog(empty.cache)).toBe('');

    const huge = new Uint8Array(HOOK_LIMITS.stdinMaxBytes + 1).fill(0x20);
    const oversized = await runHook({ stdin: chunks(huge), env });
    expect(injected(oversized)).toBe(ALL_DEPENDENCIES);
    expect(await hookLog(oversized.cache)).toContain(
      `the payload on stdin is over ${HOOK_LIMITS.stdinMaxBytes} bytes; ignored it`
    );
  });

  it('stops waiting for stdin that never ends', async () => {
    const root = await project();
    const run = await runHook({
      stdin: neverEnding,
      env: { CLAUDE_PROJECT_DIR: root, ANTHROPIC_MODEL: OPUS.model },
    });

    expect(injected(run)).toBe(ALL_DEPENDENCIES);
    expect(await hookLog(run.cache)).toContain(
      `stdin did not end within ${HOOK_LIMITS.stdinMs} ms; ignored it`
    );
  });

  it('prints nothing and logs when it misses the deadline', async () => {
    const root = await project();
    let calls = 0;
    const run = await runHook({
      payload: { cwd: root, ...OPUS },
      elapsedMs: () => (calls++ < 2 ? 0 : HOOK_LIMITS.deadlineMs + 100),
    });

    expect(run.out).toEqual([]);
    expect(await hookLog(run.cache)).toContain(
      `session-start missed its ${HOOK_LIMITS.deadlineMs} ms deadline; printed nothing`
    );
  });

  it('logs that it printed its note when the deadline passes during the warm-up', async () => {
    const root = await project();
    const { 'npm:date-fns@2.30.0': _missing, ...known } = RELEASES;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const run = await runHook({
        cache: await seededCache(known),
        payload: { cwd: root, ...OPUS },
        onSpawn: () => vi.advanceTimersByTime(HOOK_LIMITS.deadlineMs),
      });

      expect(injected(run)).toContain(DEPENDENCIES_HEADING);
      expect(run.spawned).toEqual([root]);
      expect(await hookLog(run.cache)).toMatch(
        new RegExp(
          `^\\S+ session-start missed its ${HOOK_LIMITS.deadlineMs} ms deadline while starting the background warm-up, after it printed its note\\n$`
        )
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it.skipIf(!canCreateSymlinks)(
    'never writes hook.log through a symbolic link, and never rotates one into place',
    async () => {
      const cache = await seededCache();
      const outside = join(await tempDir(), 'outside.txt');
      await writeFile(outside, 'not the hook log\n');
      await symlink(outside, join(cache, 'hook.log'));
      const root = await project();

      await runHook({ cache, payload: 'not json', env: { CLAUDE_PROJECT_DIR: root } });

      expect(await readFile(outside, 'utf-8')).toBe('not the hook log\n');
      expect((await readdir(cache)).sort()).toEqual(['hook.log', 'release-dates.json']);
    }
  );

  it.skipIf(process.platform === 'win32')(
    'treats a named pipe as an agent file as absent, logs it, and keeps its deadline',
    async () => {
      // Windows has no named pipes in the file system namespace.
      const root = await project({ packs: { zod: ZOD_PINNED }, build: ['zod'] });
      execFileSync('mkfifo', [join(root, 'AGENTS.md')]);
      const started = Date.now();

      const run = await runHook({ payload: { cwd: root, ...OPUS } });

      expect(Date.now() - started).toBeLessThan(HOOK_LIMITS.deadlineMs);
      expect(injected(run)).toContain('- Zod 4.0.0: `agent-docs/zod/index.md`');
      expect(await hookLog(run.cache)).toContain(
        'AGENTS.md is a named pipe, not a regular file; replace it with a regular file, or set "agentFiles" in llm-docs.json to the files the llm-docs block goes into. (treated as absent)'
      );
    },
    10_000
  );

  it('prints nothing, logs, and resolves when the run throws', async () => {
    const root = await project();
    const broken: AsyncIterable<string> = {
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('EIO: read failed')) }),
    };
    const run = await runHook({ stdin: broken, env: { CLAUDE_PROJECT_DIR: root } });

    expect(run.out).toEqual([]);
    expect(await hookLog(run.cache)).toMatch(/^\S+ session-start failed: EIO: read failed\n$/);
  });

  it('ignores a malformed cutoff override, logging it, and keeps the rest of the note', async () => {
    const root = await project();
    const env = { LLM_DOCS_MODEL_CUTOFF: 'June' };
    const ignored =
      /^\S+ LLM_DOCS_MODEL_CUTOFF must be a YYYY-MM month \(for example 2026-06\), got "June"; ignored it\n$/;

    const fromModel = await runHook({ payload: { cwd: root, ...OPUS }, env });
    expect(injected(fromModel)).toBe(ALL_DEPENDENCIES);
    expect(await hookLog(fromModel.cache)).toMatch(ignored);

    const none = await runHook({ payload: { cwd: root, model: 'some-unknown-model' }, env });
    expect(injected(none).split('\n')[0]).toBe(
      'Recently released dependencies (your training data may predate them), released in the last 180 days with no pinned docs, newest first:'
    );
    expect(await hookLog(none.cache)).toMatch(ignored);
  });

  it(`rotates hook.log past ${HOOK_LIMITS.logMaxBytes} bytes, keeping one previous file`, async () => {
    const cache = await seededCache();
    const old = `${'x'.repeat(HOOK_LIMITS.logMaxBytes - 10)}\n`;
    await writeFile(join(cache, 'hook.log'), old);
    const root = await project();

    await runHook({ cache, payload: 'not json', env: { CLAUDE_PROJECT_DIR: root } });

    expect(await readFile(join(cache, 'hook.log.1'), 'utf-8')).toBe(old);
    expect(await hookLog(cache)).toMatch(/^\S+ the payload on stdin is not JSON; ignored it\n$/);
    expect((await readdir(cache)).sort()).toEqual(['hook.log', 'hook.log.1', 'release-dates.json']);
  });
});

describe('background warm-up', () => {
  it('starts one status run per project per six hours when release dates are missing', async () => {
    const root = await project();
    const cache = await seededCache({
      'npm:date-fns@2.30.0': RELEASES['npm:date-fns@2.30.0'] ?? '',
    });
    const at = (hours: number): RunOptions => ({
      cache,
      payload: { cwd: root, ...OPUS },
      now: new Date(NOW.getTime() + hours * HOUR),
    });

    const first = await runHook(at(0));
    expect(first.out).toEqual([]);
    expect(first.spawned).toEqual([root]);
    expect((await runHook(at(5))).spawned).toEqual([]);
    expect((await runHook(at(7))).spawned).toEqual([root]);
    expect((await readdir(join(cache, 'hook-warm'))).length).toBe(1);
  });

  it('leaves a lockfile over its size cap to the warm-up and says nothing false about packs bound through it', async () => {
    const root = await project({ packs: { hono: HONO, zod: ZOD_PINNED }, build: ['hono', 'zod'] });
    const lock = await readFile(join(root, 'package-lock.json'), 'utf-8');
    await writeFile(
      join(root, 'package-lock.json'),
      `${lock}${' '.repeat(HOOK_LIMITS.maxLockfileBytes)}`
    );

    const run = await runHook({ payload: { cwd: root, ...OPUS } });
    const text = injected(run);
    // zod's stale version lives in the unread lockfile: no row claims anything about it.
    expect(text).not.toContain('Pinned docs packs to fix:');
    expect(text).not.toContain('zod: ');
    expect(text.split('\n').slice(0, 2)).toEqual([
      PINNED_HEADING,
      '- Hono 4.13.16 (released 2026-09-02, after cutoff): `agent-docs/hono/index.md`',
    ]);
    expect(run.spawned).toEqual([root]);
  });
});

describe('background warm-up through links', () => {
  it.skipIf(!canCreateSymlinks)(
    'never writes the warm-up marker through a hook-warm/ that is a symbolic link',
    async () => {
      const root = await project();
      const cache = await seededCache({
        'npm:date-fns@2.30.0': RELEASES['npm:date-fns@2.30.0'] ?? '',
      });
      const outside = await tempDir();
      await symlink(outside, join(cache, 'hook-warm'), 'dir');

      const run = await runHook({ cache, payload: { cwd: root, ...OPUS } });

      expect(run.spawned).toEqual([]);
      expect(await readdir(outside)).toEqual([]);
      expect(await hookLog(cache)).toContain(
        `${join(cache, 'hook-warm')} is not a directory; skipped the background warm-up`
      );
    }
  );
});

describe('managed block visibility', () => {
  it('injects the pack list only for a harness that does not read a file holding the block', async () => {
    const parent = await tempDir();
    const root = await project({
      root: join(parent, 'project'),
      lock: npmLock({ 'date-fns': '2.30.0' }),
      packs: { notes: { title: 'Notes', version: '1.0.0', sources: LOCAL_DOCS } },
      config: { agentFiles: 'auto' },
      build: ['notes'],
    });
    const payload = { cwd: root, ...OPUS };
    const list = `${BLOCK_HEADER}- Notes 1.0.0: \`agent-docs/notes/index.md\``;

    expect((await runHook({ payload })).out).toEqual([]);
    expect((await runHook({ payload, harness: 'cursor' })).out).toEqual([]);
    expect(injected(await runHook({ payload, harness: 'unknown' }))).toBe(list);

    await writeFile(join(parent, 'CLAUDE.md'), '# Workspace notes\n');
    expect(injected(await runHook({ payload }))).toBe(list);
    expect((await runHook({ payload, harness: 'cursor' })).out).toEqual([]);
  });
});
