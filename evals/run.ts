import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { errorMessage, isRecord } from '../src/utils/guards.js';
import { sha256File } from '../src/utils/hash.js';
import { readJsonFile, writeJsonFileSafely } from '../src/utils/json.js';
import {
  ARMS,
  type Arm,
  CACHE_DIR,
  EVALS_DIR,
  type EvalCase,
  isCaseError,
  lintCase,
  listFiles,
  loadCases,
  RESULTS_DIR,
} from './lib/cases.js';
import { installSignalHandlers, isShuttingDown, runProcess } from './lib/proc.js';
import { buildAggregates, isRunRow, renderSummary, type RunRow } from './lib/results.js';
import { summarizeTranscript } from './lib/transcript.js';
import {
  copyTree,
  createWorkspace,
  ensureTemplate,
  gradeWorkspace,
  overlay,
} from './lib/workspace.js';

const USAGE = `Usage: npx tsx evals/run.ts <command> [options]

Commands:
  selftest       [--cases <globs>] [--concurrency N] [--keep]
                 Install each fixture once, then prove the checks discriminate: the fixture alone
                 fails, fixture + solution passes, fixture + naive fails (post-cutoff cases).
  prepare-packs  --llm-docs <cli entry> [--cases <globs>]
                 Build each case's docs pack with the llm-docs CLI into .cache/packs/<id>.
  plan           [--cases] [--arms] [--runs N] [--model M] [--max-budget-usd-per-run X]
                 [--assume-usd-per-run LOW-HIGH]
                 Print the run matrix and an estimated cost range.
  run            [--cases <globs>] [--arms baseline,pack,plugin] [--runs N] [--model M]
                 [--concurrency N] [--max-budget-usd-per-run X] [--max-total-usd Y]
                 [--plugin-dir <path>] [--effort <level>] [--resume <results dir>]
                 [--keep-workspaces]
                 Run claude -p per case, arm, and repeat, grade with the hidden checks, and write
                 evals/results/<timestamp>/results.json and summary.md.
`;

const DEFAULT_MODEL = 'claude-opus-5-5';
const PACK_CACHE_DIR = join(CACHE_DIR, 'packs');
const LLM_DOCS_CACHE_DIR = join(CACHE_DIR, 'llm-docs-cache');
const PREPARED_STAMP = '.prepared.json';

/**
 * Tools every arm may use without a prompt. Web tools are included in every arm on purpose: the
 * realistic alternative to a pinned pack is an agent that browses.
 */
const ALLOWED_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Edit',
  'Write',
  'WebSearch',
  'WebFetch',
  'Bash(npx tsc)',
  'Bash(npx tsc *)',
  'Bash(npx vitest)',
  'Bash(npx vitest *)',
  'Bash(npm test)',
  'Bash(npm test *)',
  'Bash(ls)',
  'Bash(ls *)',
  'Bash(cat *)',
];

function log(line: string): void {
  process.stderr.write(`[evals] ${line}\n`);
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function pool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  const lanes = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    async () => {
      while (next < items.length && !isShuttingDown()) {
        const item = items[next];
        next += 1;
        if (item !== undefined) {
          await worker(item);
        }
      }
    }
  );
  await Promise.all(lanes);
}

function parsePositiveNumber(value: string | undefined, flag: string, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new UsageError(`${flag} must be a positive number`);
  }
  return parsed;
}

function parseArms(value: string | undefined): Arm[] {
  if (value === undefined) {
    return [...ARMS];
  }
  const arms: Arm[] = [];
  for (const raw of value.split(',').map((item) => item.trim())) {
    const arm = ARMS.find((candidate) => candidate === raw);
    if (!arm) {
      throw new UsageError(`unknown arm "${raw}" (expected ${ARMS.join(', ')})`);
    }
    if (!arms.includes(arm)) {
      arms.push(arm);
    }
  }
  return ARMS.filter((arm) => arms.includes(arm));
}

class UsageError extends Error {}

/* ------------------------------------------------------------------------------------------ */
/* selftest                                                                                   */
/* ------------------------------------------------------------------------------------------ */

async function selftest(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      cases: { type: 'string' },
      concurrency: { type: 'string' },
      keep: { type: 'boolean', default: false },
    },
  });
  const cases = await loadCases(values.cases);
  const concurrency = parsePositiveNumber(values.concurrency, '--concurrency', 2);
  const root = join(tmpdir(), 'llm-docs-evals', `selftest-${timestamp()}`);
  const failures: string[] = [];

  // Templates install sequentially so npm never runs twice for the same cache directory.
  const templates = new Map<string, string>();
  for (const evalCase of cases) {
    const problems = await lintCase(evalCase);
    if (problems.length > 0) {
      failures.push(...problems.map((problem) => `${evalCase.id}: ${problem}`));
    }
    templates.set(evalCase.id, await ensureTemplate(evalCase, log));
  }

  const variants = cases.flatMap((evalCase) => {
    const list: Array<{
      evalCase: EvalCase;
      name: string;
      overlayDir: string | null;
      expectPass: boolean;
    }> = [
      { evalCase, name: 'fixture', overlayDir: null, expectPass: false },
      { evalCase, name: 'solution', overlayDir: join(evalCase.dir, 'solution'), expectPass: true },
    ];
    if (evalCase.kind === 'post-cutoff') {
      list.push({
        evalCase,
        name: 'naive',
        overlayDir: join(evalCase.dir, 'naive'),
        expectPass: false,
      });
    }
    return list;
  });

  await pool(variants, concurrency, async ({ evalCase, name, overlayDir, expectPass }) => {
    const label = `${evalCase.id}/${name}`;
    const dir = join(root, `${evalCase.id}-${name}`);
    const template = templates.get(evalCase.id);
    if (template === undefined) {
      return;
    }
    try {
      if (overlayDir !== null && !existsSync(overlayDir)) {
        failures.push(`${label}: ${relative(EVALS_DIR, overlayDir)} is missing`);
        return;
      }
      await createWorkspace(evalCase, template, dir);
      if (overlayDir !== null) {
        await overlay(overlayDir, dir);
      }
      const results = await gradeWorkspace(evalCase, dir);
      const passed = results.every((result) => result.passed);
      const failed = results.filter((result) => !result.passed);
      const ok = passed === expectPass;
      const verdict = passed
        ? 'passes'
        : `fails (${failed.map((result) => result.name).join(', ')})`;
      log(
        `${ok ? 'ok  ' : 'BAD '} ${label} ${verdict}${expectPass ? '' : ', as expected to fail'}`
      );
      if (!ok) {
        const details = failed.map((result) => `  [${result.name}] ${result.detail}`).join('\n');
        failures.push(
          `${label}: expected to ${expectPass ? 'pass' : 'fail'} but ${verdict}\n${details}\n  workspace kept at ${dir}`
        );
      } else if (!values.keep) {
        await rm(dir, { recursive: true, force: true });
      }
    } catch (error) {
      failures.push(`${label}: ${errorMessage(error)} (workspace ${dir})`);
    }
  });

  if (failures.length > 0) {
    log(`selftest FAILED:\n${failures.join('\n')}`);
    return 1;
  }
  log(
    `selftest passed for ${cases.length} case(s): ${cases.map((evalCase) => evalCase.id).join(', ')}`
  );
  if (!values.keep) {
    await rm(root, { recursive: true, force: true });
  }
  return 0;
}

/* ------------------------------------------------------------------------------------------ */
/* prepare-packs                                                                              */
/* ------------------------------------------------------------------------------------------ */

function cliInvocation(cliPath: string): [string, string[]] {
  return /\.(c|m)?js$/.test(cliPath) ? [process.execPath, [cliPath]] : [cliPath, []];
}

async function runCli(cliPath: string, args: string[], cwd: string, timeoutMs: number) {
  const [program, prefix] = cliInvocation(cliPath);
  return runProcess(program, [...prefix, ...args], {
    cwd,
    timeoutMs,
    env: { ...process.env, LLM_DOCS_CACHE_DIR, NO_COLOR: '1' },
  });
}

function packFingerprint(evalCase: EvalCase): string {
  return JSON.stringify({ id: evalCase.pack.id, pack: evalCase.pack.pack });
}

const REQUIRED_CLI_COMMANDS = ['init', 'sync', 'verify', 'status'];

/**
 * The v3 CLI publishes what it implements (spec section 5, `capabilities --json`). Check the
 * commands and every source type the recipes use before spending minutes on git fetches, so an
 * older or partial build fails here with a clear message instead of halfway through a sync.
 */
async function assertCliSupports(cliPath: string, cases: EvalCase[]): Promise<void> {
  const capabilities = await runCli(cliPath, ['capabilities', '--json'], EVALS_DIR, 60_000);
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(capabilities.stdout);
  } catch {
    parsed = null;
  }
  if (capabilities.exitCode !== 0 || !isRecord(parsed)) {
    throw new UsageError(
      `${cliPath} does not answer \`capabilities --json\` (exit ${String(capabilities.exitCode)}). ` +
        `prepare-packs needs the v3 CLI (${REQUIRED_CLI_COMMANDS.join(', ')}, capabilities).`
    );
  }
  const implemented = (Array.isArray(parsed.commands) ? parsed.commands : [])
    .filter(
      (command): command is Record<string, unknown> =>
        isRecord(command) && (command.status === undefined || command.status === 'implemented')
    )
    .map((command) => command.name)
    .filter((name): name is string => typeof name === 'string');
  const missingCommands = REQUIRED_CLI_COMMANDS.filter((name) => !implemented.includes(name));
  if (missingCommands.length > 0) {
    throw new UsageError(
      `${cliPath} does not implement ${missingCommands.join(', ')} (it lists: ${implemented.join(', ') || 'nothing'}). prepare-packs needs the v3 CLI from spec section 5; build it first.`
    );
  }
  const neededTypes = [...new Set(cases.flatMap((evalCase) => evalCase.pack.sourceTypes))].sort();
  const missingTypes = neededTypes.filter((type) => !capabilities.stdout.includes(`"${type}"`));
  if (missingTypes.length > 0) {
    throw new UsageError(
      `${cliPath} does not list source type(s) ${missingTypes.join(', ')} in \`capabilities --json\`; the case recipes need them (spec section 2.3).`
    );
  }
}

async function preparePacks(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { cases: { type: 'string' }, 'llm-docs': { type: 'string' } },
  });
  const cliArg = values['llm-docs'];
  if (cliArg === undefined) {
    throw new UsageError('prepare-packs needs --llm-docs <path to the llm-docs CLI entry>');
  }
  const cliPath = resolve(cliArg);
  if (!existsSync(cliPath)) {
    throw new UsageError(`llm-docs CLI not found at ${cliPath}`);
  }
  const cases = await loadCases(values.cases);

  await assertCliSupports(cliPath, cases);

  const failures: string[] = [];
  for (const evalCase of cases) {
    const dir = join(PACK_CACHE_DIR, evalCase.id);
    log(`preparing pack ${evalCase.pack.id} for ${evalCase.id}`);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    // The fixture's manifest and lockfile let `dependency` bindings resolve the pinned version.
    await cp(join(evalCase.dir, 'fixture', 'package.json'), join(dir, 'package.json'));
    await cp(join(evalCase.dir, 'fixture', 'package-lock.json'), join(dir, 'package-lock.json'));
    await writeJsonFileSafely(join(dir, 'llm-docs.json'), {
      schemaVersion: 3,
      packsDir: 'agent-docs',
      agentFiles: ['AGENTS.md'],
      packs: { [evalCase.pack.id]: evalCase.pack.pack },
    });

    const steps: Array<[string, string[], number]> = [
      ['init', ['init', '--project', dir], 60_000],
      ['sync', ['sync', '--project', dir], 20 * 60_000],
      ['verify', ['verify', '--project', dir], 5 * 60_000],
    ];
    let stepFailed = false;
    for (const [name, args, timeoutMs] of steps) {
      const result = await runCli(cliPath, args, dir, timeoutMs);
      if (result.exitCode !== 0) {
        failures.push(
          `${evalCase.id}: llm-docs ${name} failed (exit ${String(result.exitCode)}${result.timedOut ? ', timed out' : ''})\n${result.stderr.slice(-3000)}`
        );
        stepFailed = true;
        break;
      }
    }
    if (stepFailed) {
      continue;
    }

    const index = join(dir, 'agent-docs', evalCase.pack.id, 'index.md');
    const agentsFile = join(dir, 'AGENTS.md');
    if (!existsSync(index)) {
      failures.push(`${evalCase.id}: sync succeeded but ${relative(dir, index)} is missing`);
      continue;
    }
    if (
      !existsSync(agentsFile) ||
      !(await readFile(agentsFile, 'utf8')).includes('<!-- BEGIN llm-docs')
    ) {
      failures.push(`${evalCase.id}: sync succeeded but AGENTS.md has no managed block`);
      continue;
    }

    // Warm the release-date cache the session-start hook reads, so the plugin arm does not depend
    // on a 1 second network budget during the run. Best effort.
    const status = await runCli(cliPath, ['status', '--project', dir, '--json'], dir, 2 * 60_000);
    if (status.exitCode !== 0) {
      log(`warning: llm-docs status failed for ${evalCase.id}; the hook may lack release dates`);
    }

    await writeJsonFileSafely(join(dir, PREPARED_STAMP), {
      pack: packFingerprint(evalCase),
      cli: cliPath,
      preparedAt: new Date().toISOString(),
    });
  }

  if (failures.length > 0) {
    log(`prepare-packs FAILED:\n${failures.join('\n')}`);
    return 1;
  }
  log(`prepared ${cases.length} pack(s) under ${relative(process.cwd(), PACK_CACHE_DIR)}`);
  return 0;
}

/** Throws unless every case has a pack prepared from its current pack.json. */
async function assertPacksPrepared(cases: EvalCase[]): Promise<void> {
  const problems: string[] = [];
  for (const evalCase of cases) {
    const stampPath = join(PACK_CACHE_DIR, evalCase.id, PREPARED_STAMP);
    if (!existsSync(stampPath)) {
      problems.push(`${evalCase.id}: no prepared pack (run prepare-packs)`);
      continue;
    }
    const stamp = await readJsonFile(stampPath);
    if (!isRecord(stamp) || stamp.pack !== packFingerprint(evalCase)) {
      problems.push(`${evalCase.id}: pack.json changed since prepare-packs; prepare again`);
    }
  }
  if (problems.length > 0) {
    throw new UsageError(problems.join('\n'));
  }
}

/* ------------------------------------------------------------------------------------------ */
/* plan                                                                                       */
/* ------------------------------------------------------------------------------------------ */

interface PlannedRun {
  runId: string;
  evalCase: EvalCase;
  arm: Arm;
  repeat: number;
}

/** Repeat-major order interleaves arms in time, so drift in the model service hits all arms alike. */
function planRuns(cases: EvalCase[], arms: Arm[], runs: number): PlannedRun[] {
  const planned: PlannedRun[] = [];
  for (let repeat = 1; repeat <= runs; repeat += 1) {
    for (const evalCase of cases) {
      for (const arm of arms) {
        planned.push({ runId: `${evalCase.id}.${arm}.${repeat}`, evalCase, arm, repeat });
      }
    }
  }
  return planned;
}

async function loadHistoricalRows(): Promise<RunRow[]> {
  if (!existsSync(RESULTS_DIR)) {
    return [];
  }
  const rows: RunRow[] = [];
  for (const entry of await readdir(RESULTS_DIR, { withFileTypes: true })) {
    const file = join(RESULTS_DIR, entry.name, 'results.json');
    if (!entry.isDirectory() || !existsSync(file)) {
      continue;
    }
    const data = await readJsonFile(file);
    if (isRecord(data) && Array.isArray(data.rows)) {
      for (const row of data.rows) {
        if (isRunRow(row)) {
          rows.push(row);
        }
      }
    }
  }
  return rows;
}

async function plan(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      cases: { type: 'string' },
      arms: { type: 'string' },
      runs: { type: 'string' },
      model: { type: 'string' },
      'max-budget-usd-per-run': { type: 'string' },
      'assume-usd-per-run': { type: 'string' },
    },
  });
  const cases = await loadCases(values.cases);
  const arms = parseArms(values.arms);
  const runs = Math.floor(parsePositiveNumber(values.runs, '--runs', 1));
  const model = values.model ?? DEFAULT_MODEL;
  const cap = parsePositiveNumber(values['max-budget-usd-per-run'], '--max-budget-usd-per-run', 3);
  const assumption = values['assume-usd-per-run'] ?? '0.50-2.50';
  const match = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(assumption);
  if (!match?.[1] || !match[2]) {
    throw new UsageError('--assume-usd-per-run must look like 0.50-2.50');
  }
  const low = Number(match[1]);
  const high = Number(match[2]);
  const planned = planRuns(cases, arms, runs);

  process.stdout.write(`Model ${model}, ${runs} run(s) per cell, arms ${arms.join(', ')}\n\n`);
  process.stdout.write(`${'case'.padEnd(18)} ${'kind'.padEnd(12)} ${'library'.padEnd(40)} runs\n`);
  for (const evalCase of cases) {
    const library = `${evalCase.library.name}@${evalCase.library.version}`;
    process.stdout.write(
      `${evalCase.id.padEnd(18)} ${evalCase.kind.padEnd(12)} ${library.padEnd(40)} ${arms.length * runs}\n`
    );
  }
  process.stdout.write(`\nTotal runs: ${planned.length}\n`);
  process.stdout.write(
    `Assumed cost: $${(planned.length * low).toFixed(2)} to $${(planned.length * high).toFixed(2)} ` +
      `($${low.toFixed(2)} to $${high.toFixed(2)} per run)\n`
  );
  process.stdout.write(
    `Hard ceiling from the per-run cap: $${(planned.length * cap).toFixed(2)}\n`
  );

  const history = (await loadHistoricalRows()).filter(
    (row) => row.model === model && row.infraError === null && typeof row.costUsd === 'number'
  );
  if (history.length > 0) {
    const costOf = (row: RunRow): number => row.costUsd ?? 0;
    const overallMean = history.reduce((sum, row) => sum + costOf(row), 0) / history.length;
    let estimate = 0;
    for (const run of planned) {
      const same = history.filter((row) => row.caseId === run.evalCase.id && row.arm === run.arm);
      estimate +=
        same.length > 0
          ? same.reduce((sum, row) => sum + costOf(row), 0) / same.length
          : overallMean;
    }
    process.stdout.write(
      `From ${history.length} previous ${model} run(s) (mean $${overallMean.toFixed(2)}): about $${estimate.toFixed(2)}\n`
    );
  } else {
    process.stdout.write(`No previous ${model} runs in evals/results to estimate from.\n`);
  }
  return 0;
}

/* ------------------------------------------------------------------------------------------ */
/* run                                                                                        */
/* ------------------------------------------------------------------------------------------ */

/**
 * The parent session's Claude Code variables must not leak into the agent under test (they carry
 * the parent's session id, effort level, and entrypoint).
 */
function agentEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) {
      continue;
    }
    if (
      [
        'CLAUDE_PID',
        'CLAUDE_EFFORT',
        'CLAUDE_PROJECT_DIR',
        'CLAUDE_PLUGIN_ROOT',
        'CLAUDE_ENV_FILE',
      ].includes(key)
    ) {
      continue;
    }
    env[key] = value;
  }
  env.LLM_DOCS_CACHE_DIR = LLM_DOCS_CACHE_DIR;
  return env;
}

interface RunSettings {
  model: string;
  perRunUsd: number;
  pluginDir: string | null;
  effort: string | null;
}

function claudeArgs(evalCase: EvalCase, arm: Arm, settings: RunSettings): string[] {
  const args = [
    '-p',
    evalCase.task,
    '--model',
    settings.model,
    '--setting-sources',
    'project',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--max-turns',
    String(evalCase.maxTurns),
    '--max-budget-usd',
    String(settings.perRunUsd),
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-hook-events',
    '--permission-mode',
    'acceptEdits',
    '--permission-prompts',
    'none',
  ];
  if (settings.effort !== null) {
    args.push('--effort', settings.effort);
  }
  if (arm === 'plugin' && settings.pluginDir !== null) {
    args.push('--plugin-dir', settings.pluginDir);
  }
  // Variadic option last, so it cannot swallow anything that follows.
  args.push('--allowedTools', ...ALLOWED_TOOLS);
  return args;
}

async function copyPackInto(evalCase: EvalCase, dir: string): Promise<void> {
  const prepared = join(PACK_CACHE_DIR, evalCase.id);
  await copyTree(join(prepared, 'agent-docs'), join(dir, 'agent-docs'));
  await rm(join(dir, 'agent-docs', '.staging'), { recursive: true, force: true });
  await rm(join(dir, 'agent-docs', '.llm-docs.lock'), { force: true });
  await cp(join(prepared, 'AGENTS.md'), join(dir, 'AGENTS.md'));
  await cp(join(prepared, 'llm-docs.json'), join(dir, 'llm-docs.json'));
}

const NOT_AGENT_OUTPUT = /^(node_modules|agent-docs)\//;

const MAX_SAVED_FILE_BYTES = 256 * 1024;

/**
 * Saves the files the agent created or changed as one `files.json` (path to content) next to the
 * transcript. A JSON map rather than loose copies, so test files the agent wrote can never be
 * picked up by the repository's own test runner.
 */
async function saveAgentFiles(evalCase: EvalCase, dir: string, outFile: string): Promise<void> {
  const fixtureDir = join(evalCase.dir, 'fixture');
  const fixtureFiles = new Set(await listFiles(fixtureDir));
  const files: Record<string, string> = {};
  for (const rel of await listFiles(dir)) {
    if (NOT_AGENT_OUTPUT.test(rel) || rel === 'AGENTS.md' || rel === 'llm-docs.json') {
      continue;
    }
    if (
      fixtureFiles.has(rel) &&
      (await sha256File(join(fixtureDir, rel))) === (await sha256File(join(dir, rel)))
    ) {
      continue;
    }
    const content = await readFile(join(dir, rel));
    files[rel] =
      content.length > MAX_SAVED_FILE_BYTES
        ? `[${content.length} bytes, not saved]`
        : content.toString('utf8');
  }
  await writeJsonFileSafely(outFile, files);
}

async function claudeVersion(): Promise<string> {
  const result = await runProcess('claude', ['--version'], {
    cwd: EVALS_DIR,
    timeoutMs: 30_000,
    env: agentEnv(),
  });
  if (result.exitCode !== 0) {
    throw new UsageError(`claude --version failed: ${result.spawnError ?? result.stderr}`);
  }
  return result.stdout.trim();
}

async function gitCommit(): Promise<string> {
  const result = await runProcess('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: EVALS_DIR,
    timeoutMs: 30_000,
  });
  return result.exitCode === 0 ? result.stdout.trim() : 'unknown';
}

async function readRows(resultsDir: string): Promise<Map<string, RunRow>> {
  const rows = new Map<string, RunRow>();
  const runsDir = join(resultsDir, 'runs');
  if (!existsSync(runsDir)) {
    return rows;
  }
  for (const entry of await readdir(runsDir, { withFileTypes: true })) {
    const file = join(runsDir, entry.name, 'run.json');
    if (entry.isDirectory() && existsSync(file)) {
      const row = await readJsonFile(file);
      if (isRunRow(row)) {
        rows.set(row.runId, row);
      }
    }
  }
  return rows;
}

async function executeRun(
  run: PlannedRun,
  settings: RunSettings,
  template: string,
  workspaceRoot: string,
  resultsDir: string,
  keepWorkspace: boolean
): Promise<RunRow> {
  const { evalCase, arm, repeat, runId } = run;
  const runDir = join(resultsDir, 'runs', runId);
  await rm(runDir, { recursive: true, force: true });
  await mkdir(runDir, { recursive: true });
  const dir = join(workspaceRoot, `${evalCase.id}-${arm}-${repeat}`);
  const startedAt = new Date().toISOString();
  const base: RunRow = {
    runId,
    caseId: evalCase.id,
    kind: evalCase.kind,
    arm,
    repeat,
    model: settings.model,
    startedAt,
    agentOutcome: 'not-started',
    agentExitCode: null,
    wallMs: 0,
    passed: false,
    checks: [],
    costUsd: null,
    numTurns: null,
    durationMs: null,
    docsConsulted: false,
    docsPaths: [],
    webUsed: false,
    webSearches: 0,
    webFetches: 0,
    webTargets: [],
    toolCalls: {},
    permissionDenials: [],
    sessionStartHookOutput: [],
    session: null,
    infraError: null,
  };

  try {
    await createWorkspace(evalCase, template, dir);
    if (arm !== 'baseline') {
      await copyPackInto(evalCase, dir);
    }
  } catch (error) {
    return { ...base, infraError: `workspace setup failed: ${errorMessage(error)}` };
  }

  const transcriptPath = join(runDir, 'transcript.jsonl');
  const agent = await runProcess('claude', claudeArgs(evalCase, arm, settings), {
    cwd: dir,
    env: agentEnv(),
    timeoutMs: evalCase.timeoutSeconds * 1000,
    stdoutFile: transcriptPath,
  });
  await writeFile(join(runDir, 'stderr.log'), agent.stderr);
  if (agent.spawnError !== null) {
    return {
      ...base,
      wallMs: agent.durationMs,
      infraError: `claude could not start: ${agent.spawnError}`,
    };
  }

  const summary = summarizeTranscript(await readFile(transcriptPath, 'utf8'));
  let agentOutcome = summary.result?.subtype ?? 'no-result';
  if (agent.timedOut) {
    agentOutcome = 'timeout';
  }
  if (isShuttingDown()) {
    return { ...base, wallMs: agent.durationMs, infraError: 'interrupted' };
  }

  await saveAgentFiles(evalCase, dir, join(runDir, 'files.json'));
  const checks = await gradeWorkspace(evalCase, dir);
  if (!keepWorkspace) {
    await rm(dir, { recursive: true, force: true });
  }

  return {
    ...base,
    agentOutcome,
    agentExitCode: agent.exitCode,
    wallMs: agent.durationMs,
    passed: checks.every((check) => check.passed),
    checks,
    costUsd: summary.result?.totalCostUsd ?? null,
    numTurns: summary.result?.numTurns ?? null,
    durationMs: summary.result?.durationMs ?? null,
    docsConsulted: summary.docsConsulted,
    docsPaths: summary.docsPaths,
    webUsed: summary.webSearches + summary.webFetches > 0,
    webSearches: summary.webSearches,
    webFetches: summary.webFetches,
    webTargets: summary.webTargets,
    toolCalls: summary.toolCalls,
    permissionDenials: summary.result?.permissionDenials ?? [],
    sessionStartHookOutput: summary.sessionStartHookOutput,
    session: summary.session,
  };
}

async function runCommandMain(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      cases: { type: 'string' },
      arms: { type: 'string' },
      runs: { type: 'string' },
      model: { type: 'string' },
      concurrency: { type: 'string' },
      'max-budget-usd-per-run': { type: 'string' },
      'max-total-usd': { type: 'string' },
      'plugin-dir': { type: 'string' },
      effort: { type: 'string' },
      resume: { type: 'string' },
      'keep-workspaces': { type: 'boolean', default: false },
    },
  });
  const cases = await loadCases(values.cases);
  const arms = parseArms(values.arms);
  const runs = Math.floor(parsePositiveNumber(values.runs, '--runs', 1));
  const concurrency = Math.floor(parsePositiveNumber(values.concurrency, '--concurrency', 2));
  const perRunUsd = parsePositiveNumber(
    values['max-budget-usd-per-run'],
    '--max-budget-usd-per-run',
    3
  );
  const maxTotalUsd = parsePositiveNumber(
    values['max-total-usd'],
    '--max-total-usd',
    Number.POSITIVE_INFINITY
  );
  const settings: RunSettings = {
    model: values.model ?? DEFAULT_MODEL,
    perRunUsd,
    pluginDir: values['plugin-dir'] === undefined ? null : resolve(values['plugin-dir']),
    effort: values.effort ?? null,
  };

  if (arms.includes('plugin')) {
    if (settings.pluginDir === null) {
      throw new UsageError('the plugin arm needs --plugin-dir <path to the llm-docs plugin>');
    }
    if (!existsSync(join(settings.pluginDir, '.claude-plugin', 'plugin.json'))) {
      throw new UsageError(`${settings.pluginDir} has no .claude-plugin/plugin.json`);
    }
  }
  if (arms.some((arm) => arm !== 'baseline')) {
    await assertPacksPrepared(cases);
  }

  const resultsDir =
    values.resume === undefined ? join(RESULTS_DIR, timestamp()) : resolve(values.resume);
  if (values.resume !== undefined && !existsSync(resultsDir)) {
    throw new UsageError(`--resume directory ${resultsDir} does not exist`);
  }
  await mkdir(join(resultsDir, 'runs'), { recursive: true });
  const existing = await readRows(resultsDir);
  const planned = planRuns(cases, arms, runs);
  const todo = planned.filter((run) => {
    const row = existing.get(run.runId);
    return row === undefined || row.infraError !== null;
  });
  log(`results: ${relative(process.cwd(), resultsDir)}`);
  log(
    `${planned.length} planned run(s), ${planned.length - todo.length} already done, ${todo.length} to run`
  );

  const version = await claudeVersion();
  const commit = await gitCommit();
  const templates = new Map<string, string>();
  for (const evalCase of cases) {
    templates.set(evalCase.id, await ensureTemplate(evalCase, log));
  }

  const workspaceRoot = join(tmpdir(), 'llm-docs-evals', timestamp());
  const rows = new Map(existing);
  let spent = [...existing.values()].reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
  let inFlight = 0;
  let skippedForBudget = 0;

  const writeResults = async (): Promise<void> => {
    const ordered = planned
      .map((run) => rows.get(run.runId))
      .filter((row): row is RunRow => row !== undefined);
    const aggregates = buildAggregates(ordered, arms);
    const meta = {
      timestamp: relative(RESULTS_DIR, resultsDir),
      model: settings.model,
      claudeVersion: version,
      runsPerCell: runs,
      arms,
      gitCommit: commit,
    };
    await writeJsonFileSafely(join(resultsDir, 'results.json'), {
      meta: {
        ...meta,
        cases: cases.map((evalCase) => ({
          id: evalCase.id,
          kind: evalCase.kind,
          library: evalCase.library,
        })),
        maxBudgetUsdPerRun: perRunUsd,
        maxTotalUsd: Number.isFinite(maxTotalUsd) ? maxTotalUsd : null,
        allowedTools: ALLOWED_TOOLS,
        pluginDir: settings.pluginDir,
        effort: settings.effort,
      },
      rows: ordered,
      aggregates,
    });
    await writeFile(join(resultsDir, 'summary.md'), renderSummary(meta, ordered, aggregates));
  };

  await pool(todo, concurrency, async (run) => {
    if (spent + (inFlight + 1) * perRunUsd > maxTotalUsd) {
      skippedForBudget += 1;
      return;
    }
    const template = templates.get(run.evalCase.id);
    if (template === undefined) {
      return;
    }
    inFlight += 1;
    log(`start ${run.runId}`);
    let row: RunRow;
    try {
      row = await executeRun(
        run,
        settings,
        template,
        workspaceRoot,
        resultsDir,
        values['keep-workspaces']
      );
    } finally {
      inFlight -= 1;
    }
    spent += row.costUsd ?? 0;
    rows.set(run.runId, row);
    await writeJsonFileSafely(join(resultsDir, 'runs', run.runId, 'run.json'), row);
    await writeResults();
    const failed = row.checks.filter((check) => !check.passed).map((check) => check.name);
    log(
      `done  ${run.runId}: ${row.infraError ?? row.agentOutcome}, ${row.passed ? 'PASS' : `FAIL (${failed.join(', ') || 'no checks'})`}, ` +
        `$${(row.costUsd ?? 0).toFixed(2)}, docs ${row.docsConsulted ? 'yes' : 'no'}, web ${row.webUsed ? 'yes' : 'no'} ` +
        `(spent $${spent.toFixed(2)})`
    );
  });

  await writeResults();
  if (!values['keep-workspaces']) {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
  if (skippedForBudget > 0) {
    log(
      `${skippedForBudget} run(s) not started because of --max-total-usd; rerun with --resume to continue`
    );
  }
  log(`wrote ${relative(process.cwd(), join(resultsDir, 'summary.md'))}`);
  return isShuttingDown() ? 130 : 0;
}

/* ------------------------------------------------------------------------------------------ */

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  installSignalHandlers();
  switch (command) {
    case 'selftest':
      return selftest(rest);
    case 'prepare-packs':
      return preparePacks(rest);
    case 'plan':
      return plan(rest);
    case 'run':
      return runCommandMain(rest);
    default:
      process.stderr.write(USAGE);
      return command === undefined || command === '--help' ? 0 : 2;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof UsageError || isCaseError(error)) {
      log(error.message);
      process.exitCode = 2;
    } else {
      log(error instanceof Error && error.stack !== undefined ? error.stack : errorMessage(error));
      process.exitCode = 3;
    }
  }
);
