import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import cutoffTable from '../../data/model-cutoffs.json';
import {
  normalizeModelId,
  resolveModelCutoff,
  resolveModelIdFromEnvironment,
} from '../../src/deps/cutoffs.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function tableLabel(modelId: string, env: NodeJS.ProcessEnv = {}): string | undefined {
  return resolveModelCutoff({ modelId, env })?.label;
}

describe('model cutoff table', () => {
  it('has a valid month, a compilable pattern, and an https source for every entry', () => {
    expect(cutoffTable.models.length).toBeGreaterThan(20);

    for (const entry of cutoffTable.models) {
      expect(entry.cutoff).toMatch(/^\d{4}-(?:0[1-9]|1[0-2])$/);
      expect(entry.source).toMatch(/^https:\/\//);
      expect(() => new RegExp(entry.pattern)).not.toThrow();
      expect(entry.label.trim()).toBe(entry.label);
    }

    const patterns = cutoffTable.models.map((entry) => entry.pattern);
    expect(new Set(patterns).size).toBe(patterns.length);
  });

  it('maps every Claude Code alias to an id the table knows', () => {
    for (const aliases of Object.values(cutoffTable.claudeCodeAliases.providers)) {
      for (const modelId of Object.values(aliases)) {
        expect(tableLabel(modelId), modelId).toBeDefined();
      }
    }
  });
});

describe('normalizeModelId', () => {
  it.each([
    ['Claude-Opus-4-6[1m]', 'claude-opus-4-6'],
    ['us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'claude-sonnet-4-5'],
    ['global.anthropic.claude-haiku-4-5-20251001-v1:0', 'claude-haiku-4-5'],
    ['anthropic.claude-opus-4-6-v1', 'claude-opus-4-6'],
    ['claude-opus-4-5@20251101', 'claude-opus-4-5'],
    ['anthropic/claude-opus-5-5', 'claude-opus-5-5'],
    ['openai/gpt-4.1-2025-04-14', 'gpt-4.1'],
    ['google/gemini-2.5-pro', 'gemini-2.5-pro'],
    ['models/gemini-2.5-flash', 'gemini-2.5-flash'],
    ['Claude Opus 4.7 (fast mode)', 'claude opus 4.7'],
    ['opus[1m]', 'opus'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeModelId(input)).toBe(expected);
  });
});

describe('resolveModelCutoff from the table', () => {
  it.each([
    ['claude-opus-5-5', 'Claude Opus 5.5', '2026-06'],
    ['claude-opus-5-5-fast', 'Claude Opus 5.5', '2026-06'],
    ['claude-opus-5', 'Claude Opus 5', '2026-05'],
    ['claude-fable-5-1', 'Claude Fable 5.1', '2026-06'],
    ['claude-fable-5', 'Claude Fable 5', '2026-01'],
    ['Claude Fable 5', 'Claude Fable 5', '2026-01'],
    ['claude-sonnet-5', 'Claude Sonnet 5', '2026-01'],
    ['claude-opus-4-8', 'Claude Opus 4.8', '2026-01'],
    ['Claude Opus 4.7 (fast mode)', 'Claude Opus 4.7', '2026-01'],
    ['claude-opus-4-6[1m]', 'Claude Opus 4.6', '2025-05'],
    ['Claude 4.6 Sonnet', 'Claude Sonnet 4.6', '2025-08'],
    ['us.anthropic.claude-opus-4-5-20251101-v1:0', 'Claude Opus 4.5', '2025-05'],
    ['claude-4.5-sonnet', 'Claude Sonnet 4.5', '2025-01'],
    ['claude-4.5-sonnet-thinking', 'Claude Sonnet 4.5', '2025-01'],
    ['anthropic.claude-haiku-4-5', 'Claude Haiku 4.5', '2025-02'],
    ['claude-sonnet-4-20250514', 'Claude Sonnet 4', '2025-01'],
    ['claude-4-sonnet-1m', 'Claude Sonnet 4', '2025-01'],
    ['claude-opus-4-0', 'Claude Opus 4', '2025-01'],
    ['claude-3-7-sonnet-20250219', 'Claude Sonnet 3.7', '2024-10'],
    ['gpt-5.6-sol', 'GPT-5.6 Sol', '2026-02'],
    ['gpt-5.6', 'GPT-5.6 Sol', '2026-02'],
    ['gpt-5.2-high', 'GPT-5.2', '2025-08'],
    ['gpt-5-mini-2025-08-07', 'GPT-5 mini', '2024-05'],
    ['gpt-5-high-fast', 'GPT-5', '2024-09'],
    ['openai/gpt-4.1', 'GPT-4.1', '2024-06'],
    ['gpt-4o-2024-08-06', 'GPT-4o', '2023-10'],
    ['o4-mini', 'o4-mini', '2024-06'],
    ['models/gemini-2.5-pro', 'Gemini 2.5 Pro', '2025-01'],
    ['gemini-2.5-flash-lite', 'Gemini 2.5 Flash-Lite', '2025-01'],
    ['gemini-2.0-flash-001', 'Gemini 2.0 Flash', '2024-08'],
  ])('%s -> %s (%s)', (modelId, label, cutoff) => {
    expect(resolveModelCutoff({ modelId, env: {} })).toEqual({
      cutoff,
      label,
      source: 'table',
      reference: expect.stringMatching(/^https:\/\//),
    });
  });

  it.each([
    'claude-opus-4-1-20250805',
    'claude-3-5-haiku-20241022',
    'claude-mythos-5',
    'gpt-5-nano',
    'gpt-5.5-pro',
    'gemini-3-pro-preview',
    'llama-4-maverick',
    'default',
    '',
  ])('never guesses for %s', (modelId) => {
    expect(resolveModelCutoff({ modelId, env: {} })).toBeUndefined();
  });
});

describe('Claude Code aliases', () => {
  it('resolves aliases to the current models on the Anthropic API', () => {
    expect(tableLabel('opus')).toBe('Claude Opus 5.5 (alias opus)');
    expect(tableLabel('sonnet[1m]')).toBe('Claude Sonnet 5.5 (alias sonnet)');
    expect(tableLabel('haiku')).toBe('Claude Haiku 5.5 (alias haiku)');
    expect(tableLabel('fable')).toBe('Claude Fable 5.1 (alias fable)');
    expect(tableLabel('opusplan')).toBe('Claude Sonnet 5.5 (alias opusplan)');
  });

  it('follows the provider mapping and pin variables', () => {
    expect(tableLabel('sonnet', { CLAUDE_CODE_USE_BEDROCK: '1' })).toBe(
      'Claude Sonnet 4.5 (alias sonnet)'
    );
    expect(tableLabel('haiku', { CLAUDE_CODE_USE_VERTEX: 'true' })).toBe(
      'Claude Haiku 4.5 (alias haiku)'
    );
    expect(tableLabel('opus', { CLAUDE_CODE_USE_FOUNDRY: '1' })).toBe(
      'Claude Opus 4.6 (alias opus)'
    );
    expect(tableLabel('fable', { CLAUDE_CODE_USE_BEDROCK: '1' })).toBeUndefined();
    expect(tableLabel('opus', { CLAUDE_CODE_USE_BEDROCK: '0' })).toBe(
      'Claude Opus 5.5 (alias opus)'
    );
    expect(
      tableLabel('opus', { ANTHROPIC_DEFAULT_OPUS_MODEL: 'us.anthropic.claude-opus-4-8' })
    ).toBe('Claude Opus 4.8 (alias opus)');
  });
});

describe('cutoff precedence', () => {
  const env = { LLM_DOCS_MODEL_CUTOFF: '2025-03' };

  it('prefers the flag, then config, then the environment, then the table', () => {
    expect(
      resolveModelCutoff({
        modelId: 'claude-opus-5-5',
        override: '2024-01',
        configCutoff: '2024-02',
        env,
      })
    ).toEqual({ cutoff: '2024-01', label: 'cutoff 2024-01 (--cutoff)', source: 'flag' });
    expect(
      resolveModelCutoff({ modelId: 'claude-opus-5-5', configCutoff: '2024-02', env })
    ).toEqual({ cutoff: '2024-02', label: 'cutoff 2024-02 (llm-docs.json)', source: 'config' });
    expect(resolveModelCutoff({ modelId: 'claude-opus-5-5', env })).toEqual({
      cutoff: '2025-03',
      label: 'cutoff 2025-03 (LLM_DOCS_MODEL_CUTOFF)',
      source: 'env',
    });
    expect(resolveModelCutoff({ modelId: 'claude-opus-5-5', env: {} })?.source).toBe('table');
    expect(resolveModelCutoff({ env: {} })).toBeUndefined();
  });

  it('rejects malformed explicit cutoffs instead of falling through', () => {
    expect(() => resolveModelCutoff({ override: '2025-13', env: {} })).toThrow(
      '--cutoff must be a YYYY-MM month, got "2025-13".'
    );
    expect(() => resolveModelCutoff({ configCutoff: 'June 2025', env: {} })).toThrow(
      'llm-docs.json model.cutoff must be a YYYY-MM month'
    );
    expect(() => resolveModelCutoff({ env: { LLM_DOCS_MODEL_CUTOFF: '2025-6' } })).toThrow(
      'LLM_DOCS_MODEL_CUTOFF must be a YYYY-MM month'
    );
  });
});

describe('resolveModelIdFromEnvironment', () => {
  async function makeDirs(): Promise<{ projectRoot: string; homeDir: string }> {
    const base = await mkdtemp(join(tmpdir(), 'llm-docs-model-'));
    tempDirs.push(base);
    const projectRoot = join(base, 'project');
    const homeDir = join(base, 'home');
    await mkdir(join(projectRoot, '.claude'), { recursive: true });
    await mkdir(join(homeDir, '.claude'), { recursive: true });
    return { projectRoot, homeDir };
  }

  it('uses the payload model, then ANTHROPIC_MODEL, then settings files in order', async () => {
    const dirs = await makeDirs();
    await writeFile(join(dirs.homeDir, '.claude', 'settings.json'), '{"model": "fable"}');

    expect(resolveModelIdFromEnvironment({ ...dirs, env: {} })).toBe('fable');

    await writeFile(join(dirs.projectRoot, '.claude', 'settings.json'), '{"model": "sonnet"}');
    expect(resolveModelIdFromEnvironment({ ...dirs, env: {} })).toBe('sonnet');

    await writeFile(
      join(dirs.projectRoot, '.claude', 'settings.local.json'),
      '{"model": "opus[1m]"}'
    );
    expect(resolveModelIdFromEnvironment({ ...dirs, env: {} })).toBe('opus[1m]');

    expect(
      resolveModelIdFromEnvironment({ ...dirs, env: { ANTHROPIC_MODEL: 'claude-opus-4-8' } })
    ).toBe('claude-opus-4-8');
    expect(
      resolveModelIdFromEnvironment({
        ...dirs,
        payloadModel: 'claude-fable-5-1',
        env: { ANTHROPIC_MODEL: 'claude-opus-4-8' },
      })
    ).toBe('claude-fable-5-1');
  });

  it('skips unreadable, invalid, and model-less settings silently', async () => {
    const dirs = await makeDirs();
    await writeFile(join(dirs.projectRoot, '.claude', 'settings.local.json'), '{ broken');
    await writeFile(join(dirs.projectRoot, '.claude', 'settings.json'), '{"permissions": {}}');
    await mkdir(join(dirs.homeDir, '.claude', 'settings.json'));

    expect(resolveModelIdFromEnvironment({ ...dirs, payloadModel: '  ', env: {} })).toBeUndefined();

    await rm(join(dirs.homeDir, '.claude', 'settings.json'), { recursive: true });
    await writeFile(join(dirs.homeDir, '.claude', 'settings.json'), '{"model": "haiku"}');
    expect(resolveModelIdFromEnvironment({ ...dirs, env: {} })).toBe('haiku');
  });
});
