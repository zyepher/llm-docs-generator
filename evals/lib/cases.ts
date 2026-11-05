import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isNonEmptyString, isRecord } from '../../src/utils/guards.js';
import { readJsonFile } from '../../src/utils/json.js';

export const EVALS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CASES_DIR = join(EVALS_DIR, 'cases');
export const CACHE_DIR = join(EVALS_DIR, '.cache');
export const RESULTS_DIR = join(EVALS_DIR, 'results');

export type CaseKind = 'post-cutoff' | 'control';
export const ARMS = ['baseline', 'pack', 'plugin'] as const;
export type Arm = (typeof ARMS)[number];

export interface EvalCase {
  id: string;
  title: string;
  kind: CaseKind;
  library: { name: string; version: string; released: string };
  notes: string;
  maxTurns: number;
  timeoutSeconds: number;
  dir: string;
  task: string;
  checks: CheckSpec[];
  pack: PackRecipe;
}

export type BuiltinCheck = 'deps-unchanged' | 'no-type-suppressions';
const BUILTINS: readonly BuiltinCheck[] = ['deps-unchanged', 'no-type-suppressions'];

export type CheckSpec =
  | { name: string; kind: 'builtin'; builtin: BuiltinCheck }
  | { name: string; kind: 'command'; command: [string, ...string[]]; timeoutSeconds: number };

export interface PackRecipe {
  /** Pack id inside llm-docs.json (`packs.<id>`). */
  id: string;
  /** The pack entry exactly as it goes into llm-docs.json. */
  pack: Record<string, unknown>;
  /** Source types the recipe uses, so prepare-packs can check CLI support up front. */
  sourceTypes: string[];
}

/** Sentences every task prompt must contain, so all cases share the same ground rules. */
export const REQUIRED_TASK_LINES = [
  'Do not change package.json or install packages.',
  'Run the type checker when you are done.',
];

/**
 * Words that would leak the treatment into the prompt or the starting project. The fixture must
 * look like an ordinary repository in every arm.
 */
const LEAK_PATTERN = /agent-docs|llm-docs|docs pack|\beval(s|uation)?\b|benchmark|training cutoff/i;

class CaseError extends Error {}

function fail(caseId: string, message: string): never {
  throw new CaseError(`case ${caseId}: ${message}`);
}

function requireString(caseId: string, value: unknown, field: string): string {
  if (!isNonEmptyString(value)) {
    fail(caseId, `${field} must be a non-empty string`);
  }
  return value;
}

function requirePositiveInt(caseId: string, value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    fail(caseId, `${field} must be a positive integer`);
  }
  return value;
}

function parseCheck(caseId: string, raw: unknown, index: number): CheckSpec {
  if (!isRecord(raw)) {
    fail(caseId, `checks[${index}] must be an object`);
  }
  const name = requireString(caseId, raw.name, `checks[${index}].name`);
  if (raw.builtin !== undefined) {
    const builtin = BUILTINS.find((b) => b === raw.builtin);
    if (!builtin) {
      fail(caseId, `checks[${index}].builtin must be one of ${BUILTINS.join(', ')}`);
    }
    return { name, kind: 'builtin', builtin };
  }
  const command = raw.command;
  if (!Array.isArray(command) || command.length === 0 || !command.every(isNonEmptyString)) {
    fail(caseId, `checks[${index}].command must be a non-empty array of strings`);
  }
  const [program, ...args] = command;
  if (program === undefined) {
    fail(caseId, `checks[${index}].command is empty`);
  }
  return {
    name,
    kind: 'command',
    command: [program, ...args],
    timeoutSeconds: requirePositiveInt(
      caseId,
      raw.timeoutSeconds,
      `checks[${index}].timeoutSeconds`
    ),
  };
}

function parsePack(caseId: string, raw: unknown): PackRecipe {
  if (!isRecord(raw)) {
    fail(caseId, 'pack.json must be an object');
  }
  const id = requireString(caseId, raw.id, 'pack.json id');
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) {
    fail(caseId, `pack.json id "${id}" is not a valid pack id`);
  }
  const pack = raw.pack;
  if (!isRecord(pack)) {
    fail(caseId, 'pack.json pack must be an object');
  }
  const sources = pack.sources;
  if (!Array.isArray(sources) || sources.length === 0) {
    fail(caseId, 'pack.json pack.sources must be a non-empty array');
  }
  const sourceTypes = new Set<string>();
  for (const [index, source] of sources.entries()) {
    if (!isRecord(source) || !isNonEmptyString(source.type)) {
      fail(caseId, `pack.json pack.sources[${index}].type must be a non-empty string`);
    }
    sourceTypes.add(source.type);
  }
  return { id, pack, sourceTypes: [...sourceTypes].sort() };
}

async function loadCase(id: string): Promise<EvalCase> {
  const dir = join(CASES_DIR, id);
  const raw = await readJsonFile(join(dir, 'case.json'));
  if (!isRecord(raw)) {
    fail(id, 'case.json must be an object');
  }
  if (raw.id !== id) {
    fail(id, 'case.json id must equal the directory name');
  }
  const kind = raw.kind;
  if (kind !== 'post-cutoff' && kind !== 'control') {
    fail(id, 'kind must be "post-cutoff" or "control"');
  }
  const library = raw.library;
  if (!isRecord(library)) {
    fail(id, 'library must be an object');
  }
  const released = requireString(id, library.released, 'library.released');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(released)) {
    fail(id, 'library.released must be YYYY-MM-DD');
  }

  const task = await readFile(join(dir, 'task.md'), 'utf8');
  for (const line of REQUIRED_TASK_LINES) {
    if (!task.includes(line)) {
      fail(id, `task.md must contain "${line}"`);
    }
  }

  const checksRaw = await readJsonFile(join(dir, 'checks', 'checks.json'));
  if (!isRecord(checksRaw) || !Array.isArray(checksRaw.checks) || checksRaw.checks.length === 0) {
    fail(id, 'checks/checks.json must hold a non-empty "checks" array');
  }
  const checks = checksRaw.checks.map((check, index) => parseCheck(id, check, index));
  const names = new Set(checks.map((check) => check.name));
  if (names.size !== checks.length) {
    fail(id, 'check names must be unique');
  }
  if (!checks.some((check) => check.kind === 'builtin' && check.builtin === 'deps-unchanged')) {
    fail(id, 'checks must include the deps-unchanged builtin');
  }

  return {
    id,
    title: requireString(id, raw.title, 'title'),
    kind,
    library: {
      name: requireString(id, library.name, 'library.name'),
      version: requireString(id, library.version, 'library.version'),
      released,
    },
    notes: requireString(id, raw.notes, 'notes'),
    maxTurns: requirePositiveInt(id, raw.maxTurns, 'maxTurns'),
    timeoutSeconds: requirePositiveInt(id, raw.timeoutSeconds, 'timeoutSeconds'),
    dir,
    task,
    checks,
    pack: parsePack(id, await readJsonFile(join(dir, 'pack.json'))),
  };
}

/** Converts a simple glob (`*`, `?`) into an anchored regular expression. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

/**
 * Loads every case whose id matches one of the comma-separated globs, sorted by id so run order
 * is deterministic.
 */
export async function loadCases(globs = '*'): Promise<EvalCase[]> {
  const patterns = globs
    .split(',')
    .map((glob) => glob.trim())
    .filter((glob) => glob.length > 0)
    .map(globToRegExp);
  const entries = await readdir(CASES_DIR, { withFileTypes: true });
  const ids = entries
    .filter((entry) => entry.isDirectory() && existsSync(join(CASES_DIR, entry.name, 'case.json')))
    .map((entry) => entry.name)
    .filter((id) => patterns.some((pattern) => pattern.test(id)))
    .sort();
  if (ids.length === 0) {
    throw new CaseError(`no case matches "${globs}"`);
  }
  const cases: EvalCase[] = [];
  for (const id of ids) {
    cases.push(await loadCase(id));
  }
  return cases;
}

/**
 * Static lint over what the agent sees: no leak words in the prompt or fixture text files, and
 * exact dependency versions (no ranges) in the fixture package.json.
 */
export async function lintCase(evalCase: EvalCase): Promise<string[]> {
  const problems: string[] = [];
  if (LEAK_PATTERN.test(evalCase.task)) {
    problems.push(`task.md mentions ${String(evalCase.task.match(LEAK_PATTERN)?.[0])}`);
  }
  const fixtureDir = join(evalCase.dir, 'fixture');
  for (const name of await listFiles(fixtureDir)) {
    if (name === 'package-lock.json' || !/\.(md|ts|json|js|mjs|svelte|html)$/.test(name)) {
      continue;
    }
    const text = await readFile(join(fixtureDir, name), 'utf8');
    const leak = text.match(LEAK_PATTERN);
    if (leak) {
      problems.push(`fixture/${name} mentions ${leak[0]}`);
    }
  }
  const pkg = await readJsonFile(join(fixtureDir, 'package.json'));
  if (!isRecord(pkg)) {
    problems.push('fixture/package.json is not an object');
    return problems;
  }
  for (const field of ['dependencies', 'devDependencies']) {
    const deps = pkg[field];
    if (deps === undefined) {
      continue;
    }
    if (!isRecord(deps)) {
      problems.push(`fixture/package.json ${field} is not an object`);
      continue;
    }
    for (const [name, version] of Object.entries(deps)) {
      if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
        problems.push(
          `fixture/package.json ${field}.${name} is not an exact version: ${String(version)}`
        );
      }
    }
  }
  if (!existsSync(join(fixtureDir, 'package-lock.json'))) {
    problems.push('fixture/package-lock.json is missing');
  }
  return problems;
}

/** Relative POSIX paths of every file under `root`, skipping node_modules. Sorted. */
export async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules') {
        continue;
      }
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), rel);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  };
  await walk(root, '');
  return out.sort();
}

export function isCaseError(error: unknown): error is Error {
  return error instanceof CaseError;
}
