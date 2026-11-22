import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import type { Arm } from '../../evals/lib/cases.js';
import { summarizeTranscript } from '../../evals/lib/transcript.js';
import {
  type ArmAssertion,
  assertArm,
  inspectWorkspace,
  type WorkspaceFacts,
} from '../../evals/lib/workspace.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'evals');
const EXPECTED = { model: 'claude-opus-5-5', packId: 'zod', pluginName: null };
const PLUGIN_EXPECTED = { ...EXPECTED, pluginName: 'probe' };

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
  expected: typeof EXPECTED | typeof PLUGIN_EXPECTED = arm === 'plugin' ? PLUGIN_EXPECTED : EXPECTED
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

  it('passes a plugin session whose hook ran, including a hook that had nothing to say', async () => {
    const full = await inspectWorkspace(await workspace(PACK_FILES), 'zod');
    const assertions = check('plugin', full, WITH_PLUGIN);
    expect(failures(assertions)).toEqual([]);
    expect(assertions.find((assertion) => assertion.name === 'plugin hook ran')?.detail).toBe(
      '2 SessionStart hook(s) ran, 1 with output'
    );
    expect(
      summarizeTranscript(WITH_PLUGIN)
        .sessionStartHooks.map((hook) => hook.output)
        .sort()
    ).toEqual(['', 'probe context line']);
  });

  it('tells "never ran" and "started but never finished" apart from "ran with no output"', async () => {
    const full = await inspectWorkspace(await workspace(PACK_FILES), 'zod');
    const neverRan = without(WITH_PLUGIN, (line) => line.includes('"hook_'));
    expect(failures(check('plugin', full, neverRan))).toEqual(['plugin hook did not run']);
    const neverFinished = without(WITH_PLUGIN, (line) => line.includes('"hook_response"'));
    expect(failures(check('plugin', full, neverFinished))).toEqual([
      'plugin hook did not finish: no response, no response',
    ]);
  });

  it('fails a plugin session where the plugin did not load', async () => {
    const full = await inspectWorkspace(await workspace(PACK_FILES), 'zod');
    expect(failures(check('plugin', full, CLEAN))).toEqual([
      'plugin probe did not load',
      'plugin hook did not run',
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
