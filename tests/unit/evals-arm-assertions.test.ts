import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { ARMS, type Arm, type EvalCase, isPluginArm } from '../../evals/lib/cases.js';
import {
  checkHookNote,
  expectedNoteProblems,
  type NoteExpectation,
  settleHookNote,
} from '../../evals/lib/hook-note.js';
import { summarizeTranscript } from '../../evals/lib/transcript.js';
import {
  type ArmAssertion,
  type ArmExpectation,
  assertArm,
  inspectWorkspace,
  type WorkspaceFacts,
} from '../../evals/lib/workspace.js';
import { agentInvocation, type RunSettings } from '../../evals/run.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'evals');
const EXPECTED: ArmExpectation = {
  model: 'claude-opus-5-5',
  packId: 'zod',
  pluginName: null,
  hookNote: null,
  hasReadFirst: true,
};
/** The `probe` hook's note in WITH_PLUGIN, as prepare-packs would have stored it. */
const PLUGIN_EXPECTED: ArmExpectation = {
  ...EXPECTED,
  pluginName: 'probe',
  hookNote: 'probe context line',
};

/** Observed: claude-opus-5-5, built-in plugins only, no MCP servers, no hooks. */
const CLEAN = readFileSync(join(FIXTURES, 'observed-auth-invalid-key.jsonl'), 'utf8');
/** Observed: the same plus the `probe` plugin and its two SessionStart hooks (one silent). */
const WITH_PLUGIN = readFileSync(join(FIXTURES, 'observed-completed-plugin.jsonl'), 'utf8');

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function workspace(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'llm-docs-arm-'));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), content);
  }
  return dir;
}

const BLOCK =
  '<!-- BEGIN llm-docs: generated from llm-docs.json, do not edit by hand -->\n## Pinned reference docs\n<!-- END llm-docs -->\n';
const PACK_FILES = {
  'src/iban.ts': 'export {};\n',
  'agent-docs/zod/index.md': '# zod\n',
  'agent-docs/zod/manifest.json': '{}\n',
  'AGENTS.md': BLOCK,
  'llm-docs.json': '{}\n',
};

function without(jsonl: string, predicate: (line: string) => boolean): string {
  return jsonl
    .split('\n')
    .filter((line) => !predicate(line))
    .join('\n');
}

function failures(assertions: ArmAssertion[]): string[] {
  return assertions.filter((assertion) => !assertion.passed).map((assertion) => assertion.detail);
}

function check(
  arm: Arm,
  facts: WorkspaceFacts,
  jsonl: string,
  expected: ArmExpectation = isPluginArm(arm) ? PLUGIN_EXPECTED : EXPECTED
): ArmAssertion[] {
  return assertArm(arm, facts, summarizeTranscript(jsonl), expected);
}

describe('inspectWorkspace', () => {
  it('reports a baseline workspace as holding no treatment', async () => {
    const facts = await inspectWorkspace(await workspace({ 'src/iban.ts': 'export {};\n' }), 'zod');
    expect(facts).toEqual({
      agentDocsDir: false,
      llmDocsJson: false,
      agentsMd: false,
      packDir: false,
      packIndex: false,
      packManifest: false,
      managedBlock: false,
    });
  });

  it('reports a pack workspace and requires both managed block markers', async () => {
    expect(await inspectWorkspace(await workspace(PACK_FILES), 'zod')).toEqual({
      agentDocsDir: true,
      llmDocsJson: true,
      agentsMd: true,
      packDir: true,
      packIndex: true,
      packManifest: true,
      managedBlock: true,
    });
    const halfBlock = await workspace({ ...PACK_FILES, 'AGENTS.md': '<!-- BEGIN llm-docs -->\n' });
    expect((await inspectWorkspace(halfBlock, 'zod')).managedBlock).toBe(false);
  });
});

describe('assertArm', () => {
  it('passes a clean baseline session in a bare workspace', async () => {
    const facts = await inspectWorkspace(await workspace({ 'src/iban.ts': '' }), 'zod');
    const assertions = check('baseline', facts, CLEAN);
    expect(failures(assertions)).toEqual([]);
    expect(assertions.map((assertion) => assertion.name)).toEqual([
      'no agent-docs/',
      'no llm-docs.json',
      'no AGENTS.md',
      'model',
      'no MCP servers',
      'no plugins',
      'no SessionStart hook',
    ]);
  });

  it('fails a baseline that was handed any part of the treatment', async () => {
    const facts = await inspectWorkspace(await workspace(PACK_FILES), 'zod');
    expect(failures(check('baseline', facts, CLEAN))).toEqual([
      'agent-docs/ is present in a baseline workspace',
      'llm-docs.json is present in a baseline workspace',
      'AGENTS.md is present in a baseline workspace',
    ]);
  });

  it('passes a pack session and fails one whose pack or block is missing', async () => {
    const full = await inspectWorkspace(await workspace(PACK_FILES), 'zod');
    expect(failures(check('pack', full, CLEAN))).toEqual([]);
    const broken = await inspectWorkspace(
      await workspace({ 'agent-docs/zod/index.md': '# zod\n', 'AGENTS.md': '# notes\n' }),
      'zod'
    );
    expect(failures(check('pack', broken, CLEAN))).toEqual([
      'agent-docs/zod/manifest.json is missing',
      'AGENTS.md has no llm-docs managed block markers',
    ]);
  });

  it('fails a baseline or pack session that loaded a plugin or ran a SessionStart hook', async () => {
    const full = await inspectWorkspace(await workspace(PACK_FILES), 'zod');
    expect(failures(check('pack', full, WITH_PLUGIN))).toEqual([
      'plugins loaded: probe',
      '2 SessionStart hook(s) ran',
    ]);
  });

  it('passes a plugin session whose hook gave exactly the note prepare-packs stored', async () => {
    const full = await inspectWorkspace(await workspace(PACK_FILES), 'zod');
    const assertions = check('plugin', full, WITH_PLUGIN);
    expect(failures(assertions)).toEqual([]);
    expect(assertions.map((assertion) => assertion.detail).slice(-2)).toEqual([
      '2 SessionStart hook(s) ran',
      'plugin hook gave the expected 18-character note',
    ]);
    expect(
      summarizeTranscript(WITH_PLUGIN)
        .sessionStartHooks.map((hook) => hook.output)
        .sort()
    ).toEqual(['', 'probe context line']);
  });

  it('fails a plugin session whose hook ran but gave nothing, or another note', async () => {
    const full = await inspectWorkspace(await workspace(PACK_FILES), 'zod');
    const silent = WITH_PLUGIN.replaceAll(
      '{\\"hookSpecificOutput\\":{\\"hookEventName\\":\\"SessionStart\\",\\"additionalContext\\":\\"probe context line\\"}}',
      ''
    );
    expect(failures(check('plugin', full, silent))).toEqual([
      'plugin hook gave the agent nothing, not the expected 18-character note',
    ]);
    const otherCutoff = WITH_PLUGIN.replaceAll(
      'probe context line',
      'probe context, cutoff 2025-01'
    );
    expect(failures(check('plugin', full, otherCutoff))).toEqual([
      'plugin hook gave a 29-character note that differs from the expected 18-character one',
    ]);
  });

  it('tells "never ran" and "started but never finished" apart from "ran with no output"', async () => {
    const full = await inspectWorkspace(await workspace(PACK_FILES), 'zod');
    const silence = 'plugin hook gave the agent nothing, not the expected 18-character note';
    const neverRan = without(WITH_PLUGIN, (line) => line.includes('"hook_'));
    expect(failures(check('plugin', full, neverRan))).toEqual(['plugin hook did not run', silence]);
    const neverFinished = without(WITH_PLUGIN, (line) => line.includes('"hook_response"'));
    expect(failures(check('plugin', full, neverFinished))).toEqual([
      'plugin hook did not finish: no response, no response',
      silence,
    ]);
  });

  it('fails a plugin session where the plugin did not load', async () => {
    const full = await inspectWorkspace(await workspace(PACK_FILES), 'zod');
    expect(failures(check('plugin', full, CLEAN))).toEqual([
      'plugin probe did not load',
      'plugin hook did not run',
      'plugin hook gave the agent nothing, not the expected 18-character note',
    ]);
  });

  it('fails every arm on a different model, an MCP server, or a missing init event', async () => {
    const facts = await inspectWorkspace(await workspace({ 'src/iban.ts': '' }), 'zod');
    const otherModel = CLEAN.replace('"model":"claude-opus-5-5"', '"model":"claude-sonnet-5"');
    expect(failures(check('baseline', facts, otherModel))).toEqual([
      'session model is claude-sonnet-5, not claude-opus-5-5',
    ]);
    const withMcp = CLEAN.replace(
      '"mcp_servers":[]',
      '"mcp_servers":[{"name":"github","status":"connected"}]'
    );
    expect(failures(check('baseline', facts, withMcp))).toEqual(['MCP servers: github']);
    const noInit = without(CLEAN, (line) => line.includes('"subtype":"init"'));
    expect(failures(check('baseline', facts, noInit))).toEqual([
      'session reported no system/init event',
      'MCP servers: unknown (no init event)',
      'plugins loaded: unknown (no init event)',
    ]);
  });
});

describe('assertArm for the note and changes arms', () => {
  /** An initialized project with no packs, as prepare-packs builds it for the note arm. */
  const NOTE_FILES = {
    'src/iban.ts': 'export {};\n',
    'agent-docs/.gitignore': '.staging/\n',
    'AGENTS.md': BLOCK,
    'llm-docs.json': '{}\n',
  };
  const ENVELOPE =
    '{\\"hookSpecificOutput\\":{\\"hookEventName\\":\\"SessionStart\\",\\"additionalContext\\":\\"probe context line\\"}}';
  /** The probe plugin's session, with its hook giving the agent nothing. */
  const SILENT = WITH_PLUGIN.replaceAll(ENVELOPE, '');
  const NO_NOTE: ArmExpectation = { ...PLUGIN_EXPECTED, hookNote: '' };
  const NO_READ_FIRST: ArmExpectation = { ...PLUGIN_EXPECTED, hasReadFirst: false };
  const PLUGIN_NAMES = [
    'model',
    'no MCP servers',
    'plugin loaded',
    'plugin hook ran',
    'plugin hook note',
  ];

  it('passes a note session with llm-docs.json, no pack, the plugin, and the expected note', async () => {
    const facts = await inspectWorkspace(await workspace(NOTE_FILES), 'zod');
    const assertions = check('note', facts, WITH_PLUGIN);
    expect(failures(assertions)).toEqual([]);
    expect(assertions.map((assertion) => assertion.name)).toEqual([
      'llm-docs.json',
      'no pack',
      ...PLUGIN_NAMES,
    ]);
  });

  it('fails a note session without llm-docs.json, with the pack, or without the plugin', async () => {
    const { 'llm-docs.json': _config, ...withoutConfig } = NOTE_FILES;
    const bare = await inspectWorkspace(await workspace(withoutConfig), 'zod');
    expect(failures(check('note', bare, WITH_PLUGIN))).toEqual([
      'llm-docs.json is missing from a note workspace',
    ]);
    const packed = await inspectWorkspace(await workspace(PACK_FILES), 'zod');
    expect(failures(check('note', packed, WITH_PLUGIN))).toEqual([
      'agent-docs/zod/ is present in a note workspace',
    ]);
    const facts = await inspectWorkspace(await workspace(NOTE_FILES), 'zod');
    expect(failures(check('note', facts, CLEAN))).toEqual([
      'plugin probe did not load',
      'plugin hook did not run',
      'plugin hook gave the agent nothing, not the expected 18-character note',
    ]);
    expect(
      failures(check('note', facts, WITH_PLUGIN.replaceAll('probe context line', 'other')))
    ).toEqual([
      'plugin hook gave a 5-character note that differs from the expected 18-character one',
    ]);
  });

  it('passes a session whose hook gave nothing when the expected note is empty, as a match', async () => {
    const facts = await inspectWorkspace(await workspace(NOTE_FILES), 'zod');
    for (const arm of ['note', 'changes'] as const) {
      const assertions = check(arm, facts, SILENT, { ...NO_NOTE, hasReadFirst: false });
      expect(failures(assertions)).toEqual([]);
      expect(assertions.at(-1)?.detail).toBe('plugin hook gave no note, as expected');
    }
    // A match, not the silence of a missed deadline, so the run is neither an infra error nor retried.
    expect(checkHookNote('', summarizeTranscript(SILENT).sessionStartHooks).verdict).toBe('match');
  });

  it('fails a session whose hook gave a note when none was expected', async () => {
    const facts = await inspectWorkspace(await workspace(NOTE_FILES), 'zod');
    expect(failures(check('note', facts, WITH_PLUGIN, NO_NOTE))).toEqual([
      'plugin hook gave a 18-character note where none was expected',
    ]);
  });

  it('passes a changes session holding the pack of read-first pages, and fails one without it', async () => {
    const packed = await inspectWorkspace(await workspace(PACK_FILES), 'zod');
    const assertions = check('changes', packed, WITH_PLUGIN);
    expect(failures(assertions)).toEqual([]);
    expect(assertions.map((assertion) => assertion.name)).toEqual([
      'llm-docs.json',
      'pack index',
      ...PLUGIN_NAMES,
    ]);
    const unpacked = await inspectWorkspace(await workspace(NOTE_FILES), 'zod');
    expect(failures(check('changes', unpacked, WITH_PLUGIN))).toEqual([
      'agent-docs/zod/index.md is missing',
    ]);
    const { 'llm-docs.json': _config, ...withoutConfig } = PACK_FILES;
    const bare = await inspectWorkspace(await workspace(withoutConfig), 'zod');
    expect(failures(check('changes', bare, WITH_PLUGIN))).toEqual([
      'llm-docs.json is missing from a changes workspace',
    ]);
    expect(failures(check('changes', packed, CLEAN))).toEqual([
      'plugin probe did not load',
      'plugin hook did not run',
      'plugin hook gave the agent nothing, not the expected 18-character note',
    ]);
  });

  it('passes a changes session with no pack when the case marks no read-first pages, and fails one with a pack', async () => {
    const unpacked = await inspectWorkspace(await workspace(NOTE_FILES), 'zod');
    const assertions = check('changes', unpacked, WITH_PLUGIN, NO_READ_FIRST);
    expect(failures(assertions)).toEqual([]);
    expect(assertions.map((assertion) => assertion.name)).toEqual([
      'llm-docs.json',
      'no pack',
      ...PLUGIN_NAMES,
    ]);
    const packed = await inspectWorkspace(await workspace(PACK_FILES), 'zod');
    expect(failures(check('changes', packed, WITH_PLUGIN, NO_READ_FIRST))).toEqual([
      'agent-docs/zod/ is present in a changes workspace, but the case marks no read-first pages',
    ]);
  });
});

describe('the session environment', () => {
  const settings: RunSettings = {
    model: 'claude-opus-5-5',
    perRunUsd: 3,
    pluginDir: '/plugins/llm-docs',
    pluginName: 'llm-docs',
    hookNotes: { note: new Map(), changes: new Map(), plugin: new Map() },
    effort: null,
  };
  const evalCase: EvalCase = {
    id: 'zod-4-6',
    title: 'zod',
    kind: 'post-cutoff',
    stratum: 'type-visible',
    packageDocumentsAnswer: 'types',
    library: { name: 'zod', version: '4.6.7', released: '2026-10-12' },
    notes: '',
    maxTurns: 30,
    timeoutSeconds: 900,
    dir: '/nonexistent',
    task: 'task',
    checks: [],
    pack: { id: 'zod', pack: {}, sourceTypes: [] },
  };

  it('names the evaluated model in ANTHROPIC_MODEL in every arm, over the operator value', () => {
    const previous = process.env.ANTHROPIC_MODEL;
    process.env.ANTHROPIC_MODEL = 'opus';
    try {
      const invocations = ARMS.map((arm) => agentInvocation(evalCase, arm, settings));
      for (const { args, env } of invocations) {
        expect(env.ANTHROPIC_MODEL).toBe('claude-opus-5-5');
        expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-5-5');
        expect(env).toEqual(invocations[0]?.env);
      }
    } finally {
      if (previous === undefined) {
        delete process.env.ANTHROPIC_MODEL;
      } else {
        process.env.ANTHROPIC_MODEL = previous;
      }
    }
  });

  it('loads the plugin with --plugin-dir in the note, changes, and plugin arms only', () => {
    const pluginDirOf = (arm: Arm): string | null => {
      const { args } = agentInvocation(evalCase, arm, settings);
      const at = args.indexOf('--plugin-dir');
      return at === -1 ? null : (args[at + 1] ?? null);
    };
    expect(ARMS.map((arm) => [arm, pluginDirOf(arm)])).toEqual([
      ['baseline', null],
      ['note', '/plugins/llm-docs'],
      ['changes', '/plugins/llm-docs'],
      ['pack', null],
      ['plugin', '/plugins/llm-docs'],
    ]);
  });
});

describe('the expected hook note', () => {
  const HEAD =
    'Pinned docs for libraries released after or close to your training data cutoff (Claude Opus 5.5, through 2026-06). Your memory of these libraries predates these versions: read the pinned pages before writing code against them. Newest first:';
  const UNPINNED =
    'Direct dependencies released after or close to your training data cutoff (Claude Opus 5.5, through 2026-06) with no pinned docs, newest first:';
  const HABITS =
    'For each one, the installed code is the authority, not your memory: read its installed types and source before you write against it, and run a small test of the behaviour you rely on, because a changed default still passes the type check. The `check-installed` skill says where installed code lives.';
  const PIN =
    'For what installed code cannot tell you (what changed and why, a language version, a protocol, a hosted API), pin docs with the `add-docs` skill.';
  const SDK_ROW =
    '- MCP TypeScript SDK 2.4.0 (released 2026-10-23, after cutoff): read `agent-docs/mcp-typescript-sdk/pages/docs/migration/upgrade-to-v2.md` first, then `agent-docs/mcp-typescript-sdk/index.md`';
  const TS_ROW = '- typescript 6.0.3 (npm, released 2026-09-01, after cutoff)';
  const note = (pinned: string[], unpinned: string[]): string =>
    [
      ...(pinned.length > 0 ? [HEAD, ...pinned, HABITS] : []),
      ...(pinned.length > 0 && unpinned.length > 0 ? [''] : []),
      ...(unpinned.length > 0
        ? [UNPINNED, ...unpinned, ...(pinned.length > 0 ? [] : [HABITS]), PIN]
        : []),
    ].join('\n');
  const sdk: NoteExpectation = {
    kind: 'post-cutoff',
    packId: 'mcp-typescript-sdk',
    library: '@modelcontextprotocol/server',
    boundDependency: '@modelcontextprotocol/server',
    dependencies: [
      { name: '@modelcontextprotocol/client', sharesPackRepository: true },
      { name: '@modelcontextprotocol/server', sharesPackRepository: true },
      { name: 'typescript', sharesPackRepository: false },
    ],
    pinned: true,
  };

  it('accepts a post-cutoff note that lists the pack as pinned docs after the cutoff', () => {
    expect(expectedNoteProblems(note([SDK_ROW], [TS_ROW]), sdk)).toEqual({
      failures: [],
      warnings: [],
    });
  });

  it('fails a post-cutoff note that does not list the pack after the cutoff, quoting the line', () => {
    const near = SDK_ROW.replace('after cutoff', 'near cutoff');
    expect(expectedNoteProblems(note([near], []), sdk).failures).toEqual([
      `the note does not list \`agent-docs/mcp-typescript-sdk/index.md\` as pinned docs for a library released after the cutoff: "${near}"`,
    ]);
    expect(expectedNoteProblems(note([], [TS_ROW]), sdk).failures).toEqual([
      'the note does not list `agent-docs/mcp-typescript-sdk/index.md` as pinned docs for a library released after the cutoff: no line names it',
    ]);
  });

  it('fails a note that lists the case library or the bound dependency with no pinned docs', () => {
    const row = '- zod 4.6.7 (npm, released 2026-10-12, after cutoff)';
    const zod: NoteExpectation = {
      kind: 'control',
      packId: 'zod',
      library: 'zod',
      boundDependency: 'zod',
      dependencies: [{ name: 'zod', sharesPackRepository: true }],
      pinned: true,
    };
    expect(expectedNoteProblems(note([], [row]), zod)).toEqual({
      failures: [`the note says the case's own library has no pinned docs: "${row}"`],
      warnings: [],
    });
    const server = '- modelcontextprotocol/server 2.4.0 (npm, released 2026-10-23, after cutoff)';
    expect(expectedNoteProblems(note([SDK_ROW], [server]), sdk).failures).toEqual([
      `the note says the case's own library has no pinned docs: "${server}"`,
    ]);
  });

  it('only warns about a library from the pack repository that the pack does not bind', () => {
    const client = '- modelcontextprotocol/client 2.4.0 (npm, released 2026-10-23, after cutoff)';
    const tools = { ...sdk, library: '@modelcontextprotocol/client' };
    for (const expectation of [sdk, tools]) {
      expect(expectedNoteProblems(note([SDK_ROW], [client, TS_ROW]), expectation)).toEqual({
        failures: [],
        warnings: [
          `@modelcontextprotocol/client comes from the pack's repository but the pack binds @modelcontextprotocol/server, so the note lists it with no pinned docs: "${client}"`,
        ],
      });
    }
  });

  it('does not look for a pinned row in a control note', () => {
    const control: NoteExpectation = { ...sdk, kind: 'control' };
    expect(expectedNoteProblems(note([], [TS_ROW]), control).failures).toEqual([]);
  });

  it('settles on two consecutive equal non-empty hook runs, within five runs', async () => {
    const scripted = (outputs: string[]) => async (): Promise<string> => outputs.shift() ?? '';
    expect(await settleHookNote(scripted(['', 'a', 'a']))).toEqual({ note: 'a' });
    expect(await settleHookNote(scripted(['a', '', 'a', 'a']))).toEqual({ note: 'a' });
    expect(await settleHookNote(scripted(['', '', 'a', 'b', 'a', 'a']))).toEqual({
      outputs: ['', '', 'a', 'b', 'a'],
    });
    // The note and changes arms accept an empty note, also settled by two equal runs.
    expect(await settleHookNote(scripted(['', '', 'a']), true)).toEqual({ note: '' });
    expect(await settleHookNote(scripted(['', 'a', 'a']), true)).toEqual({ note: 'a' });
  });

  describe('in a workspace that holds no pack (the note arm, and changes without read-first pages)', () => {
    const LIBRARY_ROW =
      '- `@modelcontextprotocol/server` 2.4.0 (npm, released 2026-10-23, after cutoff)';
    const bare: NoteExpectation = { ...sdk, pinned: false };

    it('accepts a post-cutoff note that lists the case library with no pinned docs', () => {
      expect(expectedNoteProblems(note([], [LIBRARY_ROW, TS_ROW]), bare)).toEqual({
        failures: [],
        warnings: [],
      });
    });

    it('fails a post-cutoff note that does not list the case library, or has a pinned section', () => {
      expect(expectedNoteProblems(note([], [TS_ROW]), bare).failures).toEqual([
        "the note does not list the case's library `@modelcontextprotocol/server` among the dependencies with no pinned docs",
      ]);
      expect(expectedNoteProblems('', bare).failures).toEqual([
        "the note does not list the case's library `@modelcontextprotocol/server` among the dependencies with no pinned docs",
      ]);
      expect(expectedNoteProblems(note([SDK_ROW], [LIBRARY_ROW]), bare).failures).toEqual([
        'the note has a pinned docs section, but the workspace holds no pack',
      ]);
    });

    it('requires nothing of a control note, an empty one included', () => {
      const control: NoteExpectation = { ...bare, kind: 'control' };
      for (const text of ['', note([], [TS_ROW]), note([SDK_ROW], [])]) {
        expect(expectedNoteProblems(text, control)).toEqual({ failures: [], warnings: [] });
      }
    });
  });
});
