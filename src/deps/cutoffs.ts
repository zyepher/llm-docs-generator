import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import cutoffTable from '../../data/model-cutoffs.json';
import { isNonEmptyString, isRecord } from '../utils/guards.js';

export interface ModelCutoff {
  /** `YYYY-MM`: the model's training data runs through the end of this month. */
  cutoff: string;
  label: string;
  source: 'flag' | 'config' | 'env' | 'table';
  /** For table matches, the vendor page the cutoff was read from. */
  reference?: string;
}

export interface ResolveModelCutoffInput {
  modelId?: string;
  /** `--cutoff` */
  override?: string;
  /** `model.cutoff` from llm-docs.json */
  configCutoff?: string;
  env?: NodeJS.ProcessEnv;
}

const CUTOFF_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const CUTOFF_ENV = 'LLM_DOCS_MODEL_CUTOFF';

type ClaudeCodeProvider = keyof typeof cutoffTable.claudeCodeAliases.providers;

const MODEL_ENTRIES = cutoffTable.models.map((entry) => ({
  ...entry,
  regExp: new RegExp(entry.pattern),
}));

/**
 * Environment variables that pin a Claude Code alias to a specific model
 * (documented on the Claude Code model configuration page).
 */
const ALIAS_PIN_ENV: Readonly<Record<string, string>> = {
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  fable: 'ANTHROPIC_DEFAULT_FABLE_MODEL',
  opusplan: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
};

/**
 * Canonical form of a model id for table matching: lowercase; bracketed and
 * parenthesized suffixes (`[1m]`, `(fast mode)`) removed; provider prefixes
 * (`us.anthropic.`, `anthropic/`, `models/`, ...) removed; Bedrock version
 * suffixes (`-v1:0`) and snapshot dates (`-20250929`, `@20250929`,
 * `-2025-04-14`) removed.
 */
export function normalizeModelId(modelId: string): string {
  let id = modelId.trim().toLowerCase();
  let previous: string;

  do {
    previous = id;
    id = id
      .replace(/\s*\[[^\]]*\]$/, '')
      .replace(/\s*\([^)]*\)$/, '')
      .trim();
  } while (id !== previous);

  id = id
    .replace(/^(?:(?:us|eu|apac|global|jp|au|ca)\.)?anthropic\./, '')
    .replace(/^(?:anthropic|openai|google|models|vertex_ai|bedrock)\//, '')
    .replace(/^models\//, '')
    .replace(/-v\d+(?::\d+)?$/, '')
    .replace(/[-@]\d{8}$/, '')
    .replace(/-\d{4}-\d{2}-\d{2}$/, '');

  return id;
}

function claudeCodeProvider(env: NodeJS.ProcessEnv): ClaudeCodeProvider {
  if (isTruthyEnv(env.CLAUDE_CODE_USE_BEDROCK)) {
    return 'bedrock';
  }

  if (isTruthyEnv(env.CLAUDE_CODE_USE_VERTEX)) {
    return 'vertex';
  }

  if (isTruthyEnv(env.CLAUDE_CODE_USE_FOUNDRY)) {
    return 'foundry';
  }

  return 'anthropic';
}

function isTruthyEnv(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false';
}

/**
 * Resolve a Claude Code alias (`opus`, `sonnet[1m]`, `fable`, ...) to the
 * model id it currently selects for the active provider. A pin variable such
 * as ANTHROPIC_DEFAULT_OPUS_MODEL wins. `default` is account-dependent and
 * deliberately unresolved.
 */
function resolveClaudeCodeAlias(
  normalizedId: string,
  env: NodeJS.ProcessEnv
): { modelId: string; alias: string } | undefined {
  const pinVariable = ALIAS_PIN_ENV[normalizedId];
  const pinned = pinVariable === undefined ? undefined : env[pinVariable];

  if (isNonEmptyString(pinned)) {
    return { modelId: normalizeModelId(pinned), alias: normalizedId };
  }

  const aliases: Record<string, string> =
    cutoffTable.claudeCodeAliases.providers[claudeCodeProvider(env)];
  const modelId = Object.hasOwn(aliases, normalizedId) ? aliases[normalizedId] : undefined;

  return modelId === undefined ? undefined : { modelId, alias: normalizedId };
}

function lookupModelCutoff(
  modelId: string,
  env: NodeJS.ProcessEnv
): Omit<ModelCutoff, 'source'> | undefined {
  const normalized = normalizeModelId(modelId);
  const alias = resolveClaudeCodeAlias(normalized, env);
  const candidate = alias?.modelId ?? normalized;
  const entry = MODEL_ENTRIES.find((model) => model.regExp.test(candidate));

  if (!entry) {
    return undefined;
  }

  return {
    cutoff: entry.cutoff,
    label: alias ? `${entry.label} (alias ${alias.alias})` : entry.label,
    reference: entry.source,
  };
}

function validatedCutoff(value: string, origin: string): string {
  const trimmed = value.trim();

  if (!CUTOFF_PATTERN.test(trimmed)) {
    throw new Error(`${origin} must be a YYYY-MM month, got "${value}".`);
  }

  return trimmed;
}

/**
 * The training data cutoff to compare release dates against. Precedence:
 * `--cutoff`, config `model.cutoff`, LLM_DOCS_MODEL_CUTOFF, then the shipped
 * table for the model id. An unknown model yields undefined; the cutoff is
 * never guessed. A malformed explicit value is an error, not a fallthrough.
 */
export function resolveModelCutoff(input: ResolveModelCutoffInput): ModelCutoff | undefined {
  const env = input.env ?? process.env;

  if (input.override !== undefined) {
    const cutoff = validatedCutoff(input.override, '--cutoff');
    return { cutoff, label: `cutoff ${cutoff} (--cutoff)`, source: 'flag' };
  }

  if (input.configCutoff !== undefined) {
    const cutoff = validatedCutoff(input.configCutoff, 'llm-docs.json model.cutoff');
    return { cutoff, label: `cutoff ${cutoff} (llm-docs.json)`, source: 'config' };
  }

  const fromEnv = env[CUTOFF_ENV];

  if (isNonEmptyString(fromEnv)) {
    const cutoff = validatedCutoff(fromEnv, CUTOFF_ENV);
    return { cutoff, label: `cutoff ${cutoff} (${CUTOFF_ENV})`, source: 'env' };
  }

  if (!isNonEmptyString(input.modelId)) {
    return undefined;
  }

  const match = lookupModelCutoff(input.modelId, env);
  return match ? { ...match, source: 'table' } : undefined;
}

export interface ResolveModelIdInput {
  /** `model` from the hook payload, when the harness sent one. */
  payloadModel?: string;
  env: NodeJS.ProcessEnv;
  projectRoot: string;
  homeDir: string;
}

/**
 * The model a Claude Code session most likely runs, for when the hook
 * payload omits it (headless runs) or carries only an alias. Precedence:
 * payload, ANTHROPIC_MODEL, then `model` in the first readable settings file
 * among project `.claude/settings.local.json`, project `.claude/settings.json`,
 * and user `~/.claude/settings.json`. Unreadable or invalid files are skipped
 * silently: the hook must never fail on someone else's config.
 */
export function resolveModelIdFromEnvironment(input: ResolveModelIdInput): string | undefined {
  if (isNonEmptyString(input.payloadModel?.trim())) {
    return input.payloadModel?.trim();
  }

  const fromEnv = input.env.ANTHROPIC_MODEL?.trim();

  if (isNonEmptyString(fromEnv)) {
    return fromEnv;
  }

  const settingsFiles = [
    join(input.projectRoot, '.claude', 'settings.local.json'),
    join(input.projectRoot, '.claude', 'settings.json'),
    join(input.homeDir, '.claude', 'settings.json'),
  ];

  for (const path of settingsFiles) {
    const model = readSettingsModel(path);

    if (model !== undefined) {
      return model;
    }
  }

  return undefined;
}

function readSettingsModel(path: string): string | undefined {
  try {
    const settings: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    const model = isRecord(settings) ? settings.model : undefined;
    return typeof model === 'string' && model.trim() !== '' ? model.trim() : undefined;
  } catch {
    return undefined;
  }
}
