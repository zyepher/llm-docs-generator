import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import cutoffTable from '../../data/model-cutoffs.json';
import { ConfigError } from '../config/project.js';
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
  /** Receives each malformed explicit cutoff, which is then skipped instead of thrown. */
  ignoreInvalid?: (problem: string) => void;
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
  best: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
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

/**
 * The variables that switch Claude Code to another provider, in the order it
 * applies them: Bedrock and Foundry win over Claude Platform on AWS, and all
 * three over Google Cloud (Anthropic managed), which wins over Agent Platform
 * (Vertex). Mantle is a Bedrock endpoint whose alias defaults are not
 * published, so its aliases stay unresolved.
 */
const PROVIDER_SWITCHES: ReadonlyArray<readonly [string, ClaudeCodeProvider]> = [
  ['CLAUDE_CODE_USE_BEDROCK', 'bedrock'],
  ['CLAUDE_CODE_USE_MANTLE', 'mantle'],
  ['CLAUDE_CODE_USE_FOUNDRY', 'foundry'],
  ['CLAUDE_CODE_USE_ANTHROPIC_AWS', 'anthropic-aws'],
  ['CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD', 'anthropic-google-cloud'],
  ['CLAUDE_CODE_USE_VERTEX', 'vertex'],
];

function claudeCodeProvider(env: NodeJS.ProcessEnv): ClaudeCodeProvider {
  return PROVIDER_SWITCHES.find(([name]) => isTruthyEnv(env[name]))?.[1] ?? 'anthropic';
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

/**
 * The training data cutoff to compare release dates against. Precedence:
 * `--cutoff`, config `model.cutoff`, LLM_DOCS_MODEL_CUTOFF, then the shipped
 * table for the model id. An unknown model yields undefined; the cutoff is
 * never guessed. A malformed explicit value is a ConfigError, unless
 * `ignoreInvalid` is given: then it is reported there and resolution goes on
 * with the next source (the hook must not lose its whole note to one typo).
 */
export function resolveModelCutoff(input: ResolveModelCutoffInput): ModelCutoff | undefined {
  const env = input.env ?? process.env;
  const fromEnv = env[CUTOFF_ENV];
  const explicit = [
    { value: input.override, origin: '--cutoff', from: '--cutoff', source: 'flag' },
    {
      value: input.configCutoff,
      origin: 'llm-docs.json model.cutoff',
      from: 'llm-docs.json',
      source: 'config',
    },
    {
      value: isNonEmptyString(fromEnv) ? fromEnv : undefined,
      origin: CUTOFF_ENV,
      from: CUTOFF_ENV,
      source: 'env',
    },
  ] as const;

  for (const { value, origin, from, source } of explicit) {
    if (value === undefined) {
      continue;
    }

    const cutoff = value.trim();

    if (CUTOFF_PATTERN.test(cutoff)) {
      return { cutoff, label: `cutoff ${cutoff} (${from})`, source };
    }

    const problem = `${origin} must be a YYYY-MM month (for example 2026-06), got "${value}"`;

    if (input.ignoreInvalid === undefined) {
      throw new ConfigError(`${problem}.`);
    }
    input.ignoreInvalid(problem);
  }

  if (!isNonEmptyString(input.modelId)) {
    return undefined;
  }

  const match = lookupModelCutoff(input.modelId, env);
  return match ? { ...match, source: 'table' } : undefined;
}

/**
 * A model id and where it came from. `payload` (the harness reported it),
 * `flag` (`status --model`), and `env` (ANTHROPIC_MODEL) name the session's
 * model. `settings` is only the default in a Claude Code settings file, which
 * a session started with `--model` overrides without telling the hook.
 */
export type ModelIdentity =
  | { id: string; source: 'payload' | 'flag' | 'env' }
  | { id: string; source: 'settings'; file: string };

export interface ResolveModelIdInput {
  /** The model the hook payload or `--model` names, when there is one. */
  stated?: { id: string; source: 'payload' | 'flag' };
  env: NodeJS.ProcessEnv;
  projectRoot: string;
  homeDir: string;
}

/**
 * The model a Claude Code session most likely runs, for when the hook
 * payload omits it (headless runs) or carries only an alias. Precedence: the
 * stated model, ANTHROPIC_MODEL, then `model` in the first readable settings
 * file among project `.claude/settings.local.json`, project
 * `.claude/settings.json`, and user `~/.claude/settings.json`. Unreadable or
 * invalid files are skipped silently: the hook must never fail on someone
 * else's config.
 */
export function resolveModelIdFromEnvironment(
  input: ResolveModelIdInput
): ModelIdentity | undefined {
  const stated = input.stated?.id.trim();

  if (input.stated !== undefined && isNonEmptyString(stated)) {
    return { id: stated, source: input.stated.source };
  }

  const fromEnv = input.env.ANTHROPIC_MODEL?.trim();

  if (isNonEmptyString(fromEnv)) {
    return { id: fromEnv, source: 'env' };
  }

  const settingsFiles = [
    join(input.projectRoot, '.claude', 'settings.local.json'),
    join(input.projectRoot, '.claude', 'settings.json'),
    join(input.homeDir, '.claude', 'settings.json'),
  ];

  for (const file of settingsFiles) {
    const id = readSettingsModel(file);

    if (id !== undefined) {
      return { id, source: 'settings', file };
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
