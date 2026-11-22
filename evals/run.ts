import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  STRATA,
  STRATUM_CHECKS,
} from './lib/cases.js';
import { installSignalHandlers, isShuttingDown, runProcess } from './lib/proc.js';
import {
  buildAggregates,
  isRunRow,
  isSegment,
  renderSummary,
  type RunRow,
  type Segment,
} from './lib/results.js';
import {
  ACCOUNT_STOP_REASONS,
  type CouldNotRunReason,
  classifyOutcome,
  describeOutcome,
  summarizeTranscript,
  TRANSIENT_REASONS,
} from './lib/transcript.js';
import {
  assertArm,
  type CheckResult,
  copyTree,
  createWorkspace,
  ensureTemplate,
  findTypeSuppressions,
  gradeWorkspace,
  inspectWorkspace,
  overlay,
  type WorkspaceFacts,
} from './lib/workspace.js';

const USAGE = `Usage: npx tsx evals/run.ts <command> [options]

Commands:
  selftest       [--cases <globs>] [--concurrency N] [--keep]
                 Install each fixture once, then prove the checks discriminate: the fixture alone
                 fails, every solution*/ passes, every wrong-*/ fails, and naive/ (post-cutoff
                 cases) fails the way the case's stratum says. Also proves the suppression scan
                 on tests/fixtures/evals/suppressions.
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
                 evals/results/<timestamp>/results.json and summary.md. Stops with exit 4 when
                 the account runs out of quota or loses its login; continue with --resume.
  smoke          [--case <id>] [--arms ...] [--model M] [--plugin-dir <path>]
                 [--max-budget-usd-per-run X] [--effort <level>] [--resume <dir>]
                 One case (default zod-4-6) once per arm with the run invocation. Prints each
                 session's outcome, cost, hook output, and arm assertions; exits non-zero if any
                 session could not run or any assertion failed. Writes evals/results/smoke-<ts>/.
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

/**
 * One workspace the selftest grades: the bare fixture or the fixture with one overlay directory.
 * `solution*` overlays must pass, `wrong-*` overlays (solutions a check once let through, or must
 * keep rejecting) must fail, and `naive` must fail the way the case's stratum says.
 */
interface SelftestVariant {
  evalCase: EvalCase;
  name: string;
  expect: 'pass' | 'fail' | 'naive';
}

async function selftestVariants(evalCase: EvalCase): Promise<SelftestVariant[] | string> {
  const dirs = (await readdir(evalCase.dir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (!dirs.includes('solution')) {
    return 'solution/ is missing';
  }
  const hasNaive = dirs.includes('naive');
  if (evalCase.kind === 'post-cutoff' && !hasNaive) {
    return 'naive/ is missing; a post-cutoff case needs it to prove its stratum';
  }
  if (evalCase.kind === 'control' && hasNaive) {
    return 'naive/ is for post-cutoff cases; a control has no wrong from-memory solution';
  }
  const variants: SelftestVariant[] = [{ evalCase, name: 'fixture', expect: 'fail' }];
  for (const name of dirs) {
    if (/^solution(-[a-z0-9-]+)?$/.test(name)) {
      variants.push({ evalCase, name, expect: 'pass' });
    } else if (/^wrong-[a-z0-9-]+$/.test(name)) {
      variants.push({ evalCase, name, expect: 'fail' });
    } else if (name === 'naive') {
      variants.push({ evalCase, name, expect: 'naive' });
    } else if (!['fixture', 'checks'].includes(name)) {
      return `${name}/ is not a known case directory (fixture, checks, solution*, wrong-*, naive)`;
    }
  }
  return variants;
}

/**
 * What the from-memory solution must do for the case's stratum, or null when it does it. It must
 * fail for the reason the stratum names, never for a trivial one such as a changed lockfile.
 */
function naiveProblem(evalCase: EvalCase, results: CheckResult[]): string | null {
  const passed = (name: string): boolean | undefined =>
    results.find((result) => result.name === name)?.passed;
  const trivial = results.filter(
    (result) => !result.passed && !STRATUM_CHECKS.some((name) => name === result.name)
  );
  if (trivial.length > 0) {
    return `naive must fail only ${STRATUM_CHECKS.join(' or ')}`;
  }
  if (evalCase.stratum === 'type-visible' && passed('typecheck') !== false) {
    return 'type-visible requires naive to fail typecheck';
  }
  if (
    evalCase.stratum === 'type-invisible' &&
    (passed('typecheck') !== true || passed('behaviour') !== false)
  ) {
    return 'type-invisible requires naive to pass typecheck and fail behaviour';
  }
  return null;
}

const SUPPRESSION_FIXTURES = join(EVALS_DIR, '..', 'tests', 'fixtures', 'evals', 'suppressions');

/**
 * The suppression scan must flag exactly the suppressions in code that `expected.json` lists and
 * nothing in comments, strings, templates, regexes, Svelte markup prose, or the agent's own tests.
 */
async function selftestSuppressionScan(templateDir: string): Promise<string[]> {
  const expected = await readJsonFile(join(SUPPRESSION_FIXTURES, 'expected.json'));
  if (!Array.isArray(expected) || !expected.every((hit) => typeof hit === 'string')) {
    return [
      `${relative(process.cwd(), SUPPRESSION_FIXTURES)}/expected.json must be a string array`,
    ];
  }
  const found = await findTypeSuppressions(join(SUPPRESSION_FIXTURES, 'src'), templateDir);
  const missed = expected.filter((hit) => !found.includes(hit));
  const extra = found.filter((hit) => !expected.includes(hit));
  if (missed.length === 0 && extra.length === 0) {
    log(`ok   suppression scan flags exactly the ${expected.length} expected suppressions`);
    return [];
  }
  log('BAD  suppression scan');
  return [`suppression scan: missed [${missed.join('; ')}], flagged wrongly [${extra.join('; ')}]`];
}

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

  const firstTemplate = templates.values().next().value;
  if (firstTemplate !== undefined) {
    failures.push(...(await selftestSuppressionScan(firstTemplate)));
  }

  const variants: SelftestVariant[] = [];
  for (const evalCase of cases) {
    const found = await selftestVariants(evalCase);
    if (typeof found === 'string') {
      failures.push(`${evalCase.id}: ${found}`);
    } else {
      variants.push(...found);
    }
  }

  await pool(variants, concurrency, async ({ evalCase, name, expect }) => {
    const label = `${evalCase.id}/${name}`;
    const dir = join(root, `${evalCase.id}-${name}`);
    const template = templates.get(evalCase.id);
    if (template === undefined) {
      return;
    }
    try {
      await createWorkspace(evalCase, template, dir);
      if (name !== 'fixture') {
        await overlay(join(evalCase.dir, name), dir);
      }
      const results = await gradeWorkspace(evalCase, dir);
      const passed = results.every((result) => result.passed);
      const failed = results.filter((result) => !result.passed);
      const problem =
        expect === 'naive'
          ? naiveProblem(evalCase, results)
          : passed === (expect === 'pass')
            ? null
            : `expected to ${expect}`;
      const verdict = passed
        ? 'passes'
        : `fails (${failed.map((result) => result.name).join(', ')})`;
      const expected =
        expect === 'naive'
          ? `, as ${evalCase.stratum} requires`
          : expect === 'fail'
            ? ', as expected to fail'
            : '';
      log(`${problem === null ? 'ok  ' : 'BAD '} ${label} ${verdict}${expected}`);
      if (problem !== null) {
        const details = failed.map((result) => `  [${result.name}] ${result.detail}`).join('\n');
        failures.push(
          `${label}: ${problem} but ${verdict}\n${details}\n  workspace kept at ${dir}`
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

export interface PlannedRun {
  runId: string;
  evalCase: EvalCase;
  arm: Arm;
  repeat: number;
}

/** Repeat-major order interleaves arms in time, so drift in the model service hits all arms alike. */
export function planRuns(cases: EvalCase[], arms: Arm[], runs: number): PlannedRun[] {
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
  process.stdout.write(
    `${'case'.padEnd(20)} ${'stratum'.padEnd(15)} ${'library'.padEnd(40)} ${'pkg docs'.padEnd(9)} runs\n`
  );
  for (const evalCase of cases) {
    const library = `${evalCase.library.name}@${evalCase.library.version}`;
    process.stdout.write(
      `${evalCase.id.padEnd(20)} ${evalCase.stratum.padEnd(15)} ${library.padEnd(40)} ${evalCase.packageDocumentsAnswer.padEnd(9)} ${arms.length * runs}\n`
    );
  }
  const perStratum = STRATA.map(
    (stratum) => `${cases.filter((evalCase) => evalCase.stratum === stratum).length} ${stratum}`
  );
  process.stdout.write(`\n${cases.length} case(s): ${perStratum.join(', ')}\n`);
  process.stdout.write(`Total runs: ${planned.length}\n`);
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
  process.stdout.write(
    `\nBefore a full run, prove the pipeline with \`npm run eval -- smoke\`: case ${SMOKE_CASE} (or --case <id>) ` +
      `once per arm (${arms.join(', ')}) = ${arms.length} session(s) with the same invocation as run, ` +
      `at most $${(arms.length * cap).toFixed(2)}. It prints every arm assertion and exits non-zero if any fails ` +
      'or any session could not run. Note your usage meter before and after it.\n'
  );
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
  /** `name` from the plugin's manifest, which the plugin arm asserts the session loaded. */
  pluginName: string | null;
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

/** Installed, provided, or generated (SvelteKit writes route types to .svelte-kit/ when Vite starts). */
const NOT_AGENT_OUTPUT = /^(node_modules|agent-docs|\.svelte-kit)\//;

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

async function readSegments(resultsDir: string): Promise<Segment[]> {
  const file = join(resultsDir, 'results.json');
  if (!existsSync(file)) {
    return [];
  }
  const data = await readJsonFile(file);
  const segments = isRecord(data) && isRecord(data.meta) ? data.meta.segments : undefined;
  return Array.isArray(segments) ? segments.filter(isSegment) : [];
}

/**
 * One session for one planned run. Every way a session can fail to measure its arm becomes an
 * `infraError` row, which is never graded.
 */
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
    stratum: evalCase.stratum,
    arm,
    repeat,
    model: settings.model,
    startedAt,
    outcome: null,
    attempts: 1,
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
    sessionStartHooks: [],
    session: null,
    armAssertions: [],
    infraError: null,
  };

  let facts: WorkspaceFacts;
  try {
    await createWorkspace(evalCase, template, dir);
    if (arm !== 'baseline') {
      await copyPackInto(evalCase, dir);
    }
    facts = await inspectWorkspace(dir, evalCase.pack.id);
  } catch (error) {
    return { ...base, infraError: `workspace setup failed: ${errorMessage(error)}` };
  }

  try {
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
    if (isShuttingDown()) {
      return { ...base, wallMs: agent.durationMs, infraError: 'interrupted' };
    }

    const summary = summarizeTranscript(await readFile(transcriptPath, 'utf8'));
    const outcome = classifyOutcome(summary, agent);
    const armAssertions =
      outcome.kind === 'could-not-run'
        ? []
        : assertArm(arm, facts, summary, {
            model: settings.model,
            packId: evalCase.pack.id,
            pluginName: settings.pluginName,
          });
    const observed: RunRow = {
      ...base,
      outcome,
      agentExitCode: agent.exitCode,
      wallMs: agent.durationMs,
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
      sessionStartHooks: summary.sessionStartHooks,
      session: summary.session,
      armAssertions,
    };
    await saveAgentFiles(evalCase, dir, join(runDir, 'files.json'));

    if (outcome.kind === 'could-not-run') {
      return { ...observed, infraError: `could not run (${outcome.reason}): ${outcome.detail}` };
    }
    const violated = armAssertions.filter((assertion) => !assertion.passed);
    if (violated.length > 0) {
      return {
        ...observed,
        infraError: `arm-invalid: ${violated.map((assertion) => assertion.detail).join('; ')}`,
      };
    }
    const checks = await gradeWorkspace(evalCase, dir);
    return { ...observed, passed: checks.every((check) => check.passed), checks };
  } finally {
    if (!keepWorkspace) {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

/** In-place retries for a rate limit or an overload: wait 30 s, retry, wait 120 s, retry, give up. */
export const TRANSIENT_BACKOFF_MS = [30_000, 120_000] as const;

/** Exit code when the account ran out of quota or lost its login partway through. */
const EXIT_ACCOUNT_STOP = 4;

export interface AccountStop {
  reason: CouldNotRunReason;
  runId: string;
  detail: string;
  resetsAt: string | null;
}

export interface Scheduler {
  /** One session for the run, returned as a row (graded or infra error). */
  runSession: (run: PlannedRun) => Promise<RunRow>;
  /** Persists a run's final row. */
  record: (row: RunRow) => Promise<void>;
  /** Asked before a run starts; false skips it (the spending cap). */
  canStart: () => boolean;
  sleep: (ms: number) => Promise<void>;
}

/** Runs still owed by a results directory: no row yet, or an infra-error row. Plan order is kept. */
export function pendingRuns(
  planned: readonly PlannedRun[],
  existing: ReadonlyMap<string, RunRow>
): PlannedRun[] {
  return planned.filter((run) => {
    const row = existing.get(run.runId);
    return row === undefined || row.infraError !== null;
  });
}

function couldNotRunReason(row: RunRow): CouldNotRunReason | null {
  return row.outcome?.kind === 'could-not-run' ? row.outcome.reason : null;
}

/**
 * Runs `todo` in order on `concurrency` lanes. A rate limit or overload is retried in place with
 * backoff. The first usage-limit, auth, or billing outcome stops the schedule: no new run starts,
 * runs already in flight finish and are recorded. Returns that stop, or null when every run got
 * its turn.
 */
export async function runSchedule(
  todo: readonly PlannedRun[],
  concurrency: number,
  scheduler: Scheduler
): Promise<AccountStop | null> {
  let stop: AccountStop | null = null;
  await pool([...todo], concurrency, async (run) => {
    if (stop !== null || !scheduler.canStart()) {
      return;
    }
    let row = await scheduler.runSession(run);
    let attempts = 1;
    for (const backoffMs of TRANSIENT_BACKOFF_MS) {
      const reason = couldNotRunReason(row);
      if (stop !== null || reason === null || !TRANSIENT_REASONS.has(reason)) {
        break;
      }
      await scheduler.sleep(backoffMs);
      row = await scheduler.runSession(run);
      attempts += 1;
    }
    // Set before recording: another lane must not start a run while this row is being written.
    const outcome = row.outcome;
    if (
      stop === null &&
      outcome?.kind === 'could-not-run' &&
      ACCOUNT_STOP_REASONS.has(outcome.reason)
    ) {
      stop = {
        reason: outcome.reason,
        runId: row.runId,
        detail: outcome.detail,
        resetsAt: outcome.resetsAt,
      };
    }
    await scheduler.record({ ...row, attempts });
  });
  return stop;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });

function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The command that continues this results directory: the same options plus `--resume <dir>`. */
function resumeCommand(
  command: 'run' | 'smoke',
  argv: readonly string[],
  resultsDir: string
): string {
  const kept: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--resume') {
      index += 1;
    } else if (!arg.startsWith('--resume=')) {
      kept.push(arg);
    }
  }
  return [
    'npm',
    'run',
    'eval',
    '--',
    command,
    ...kept,
    '--resume',
    relative(process.cwd(), resultsDir),
  ]
    .map(shellQuote)
    .join(' ');
}

const ACCOUNT_STOP_TEXT: Record<string, string> = {
  'usage-limit': 'the account reached its usage limit',
  auth: 'Claude Code is not logged in or its login was rejected (run `claude` and /login, then resume)',
  billing: 'the account has a billing or credit problem',
};

const RUN_OPTIONS = {
  arms: { type: 'string' },
  model: { type: 'string' },
  'max-budget-usd-per-run': { type: 'string' },
  'max-total-usd': { type: 'string' },
  'plugin-dir': { type: 'string' },
  effort: { type: 'string' },
  resume: { type: 'string' },
  'keep-workspaces': { type: 'boolean', default: false },
} as const;

interface EvalPlan {
  command: 'run' | 'smoke';
  argv: readonly string[];
  cases: EvalCase[];
  arms: Arm[];
  runs: number;
  concurrency: number;
  settings: RunSettings;
  maxTotalUsd: number;
  resultsDir: string;
  keepWorkspaces: boolean;
}

/** Checks the options `run` and `smoke` share and resolves the plugin and the results directory. */
async function resolveSettings(
  values: {
    arms?: string | undefined;
    model?: string | undefined;
    'max-budget-usd-per-run'?: string | undefined;
    'max-total-usd'?: string | undefined;
    'plugin-dir'?: string | undefined;
    effort?: string | undefined;
    resume?: string | undefined;
  },
  cases: EvalCase[],
  freshResultsDir: string
): Promise<{ arms: Arm[]; settings: RunSettings; maxTotalUsd: number; resultsDir: string }> {
  const arms = parseArms(values.arms);
  const pluginDir = values['plugin-dir'] === undefined ? null : resolve(values['plugin-dir']);
  let pluginName: string | null = null;
  if (arms.includes('plugin')) {
    if (pluginDir === null) {
      throw new UsageError('the plugin arm needs --plugin-dir <path to the llm-docs plugin>');
    }
    const manifestPath = join(pluginDir, '.claude-plugin', 'plugin.json');
    if (!existsSync(manifestPath)) {
      throw new UsageError(`${pluginDir} has no .claude-plugin/plugin.json`);
    }
    const manifest = await readJsonFile(manifestPath);
    if (!isRecord(manifest) || typeof manifest.name !== 'string' || manifest.name.length === 0) {
      throw new UsageError(
        `${manifestPath} has no "name"; the plugin arm asserts the session loaded it by name`
      );
    }
    pluginName = manifest.name;
  }
  if (arms.some((arm) => arm !== 'baseline')) {
    await assertPacksPrepared(cases);
  }
  const resultsDir = values.resume === undefined ? freshResultsDir : resolve(values.resume);
  if (values.resume !== undefined && !existsSync(resultsDir)) {
    throw new UsageError(`--resume directory ${resultsDir} does not exist`);
  }
  return {
    arms,
    settings: {
      model: values.model ?? DEFAULT_MODEL,
      perRunUsd: parsePositiveNumber(
        values['max-budget-usd-per-run'],
        '--max-budget-usd-per-run',
        3
      ),
      pluginDir,
      pluginName,
      effort: values.effort ?? null,
    },
    maxTotalUsd: parsePositiveNumber(
      values['max-total-usd'],
      '--max-total-usd',
      Number.POSITIVE_INFINITY
    ),
    resultsDir,
  };
}

/**
 * Shared by `run` and `smoke`: runs the pending part of the plan, writes results.json and
 * summary.md after every run, and reports an account stop. Returns the rows in plan order.
 */
async function executePlan(plan: EvalPlan): Promise<{ rows: RunRow[]; exitCode: number }> {
  const { cases, arms, runs, settings, resultsDir } = plan;
  await mkdir(join(resultsDir, 'runs'), { recursive: true });
  const existing = await readRows(resultsDir);
  const planned = planRuns(cases, arms, runs);
  const todo = pendingRuns(planned, existing);
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

  // Unique per process: a smoke check and a run started in the same millisecond must not share
  // workspaces.
  await mkdir(join(tmpdir(), 'llm-docs-evals'), { recursive: true });
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'llm-docs-evals', `${timestamp()}-`));
  const rows = new Map(existing);
  const priorSegments = await readSegments(resultsDir);
  const segment: Segment = {
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    runsRecorded: 0,
    stoppedBecause: null,
  };
  let spent = [...existing.values()].reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
  let inFlight = 0;
  let skippedForBudget = 0;

  const writeResults = async (): Promise<void> => {
    segment.endedAt = new Date().toISOString();
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
      segments: [...priorSegments, segment],
      cases: cases.map((evalCase) => ({
        id: evalCase.id,
        stratum: evalCase.stratum,
        packageDocumentsAnswer: evalCase.packageDocumentsAnswer,
      })),
    };
    await writeJsonFileSafely(join(resultsDir, 'results.json'), {
      meta: {
        ...meta,
        cases: cases.map((evalCase) => ({
          id: evalCase.id,
          kind: evalCase.kind,
          stratum: evalCase.stratum,
          packageDocumentsAnswer: evalCase.packageDocumentsAnswer,
          library: evalCase.library,
        })),
        maxBudgetUsdPerRun: settings.perRunUsd,
        maxTotalUsd: Number.isFinite(plan.maxTotalUsd) ? plan.maxTotalUsd : null,
        allowedTools: ALLOWED_TOOLS,
        pluginDir: settings.pluginDir,
        effort: settings.effort,
      },
      rows: ordered,
      aggregates,
    });
    await writeFile(join(resultsDir, 'summary.md'), renderSummary(meta, ordered, aggregates));
  };

  const stop = await runSchedule(todo, plan.concurrency, {
    canStart: () => {
      if (spent + (inFlight + 1) * settings.perRunUsd > plan.maxTotalUsd) {
        skippedForBudget += 1;
        return false;
      }
      return true;
    },
    runSession: async (run) => {
      const template = templates.get(run.evalCase.id) ?? '';
      inFlight += 1;
      log(`start ${run.runId}`);
      try {
        const row = await executeRun(
          run,
          settings,
          template,
          workspaceRoot,
          resultsDir,
          plan.keepWorkspaces
        );
        spent += row.costUsd ?? 0;
        const reason = couldNotRunReason(row);
        if (reason !== null) {
          log(`      ${run.runId}: ${row.infraError ?? ''}`);
        }
        return row;
      } finally {
        inFlight -= 1;
      }
    },
    sleep: async (ms) => {
      log(`      waiting ${ms / 1000} s before retrying in place`);
      await sleep(ms);
    },
    record: async (row) => {
      rows.set(row.runId, row);
      segment.runsRecorded += 1;
      await writeJsonFileSafely(join(resultsDir, 'runs', row.runId, 'run.json'), row);
      await writeResults();
      const failed = row.checks.filter((check) => !check.passed).map((check) => check.name);
      log(
        `done  ${row.runId}: ${row.infraError ?? describeOutcome(row.outcome)}, ${row.infraError === null ? (row.passed ? 'PASS' : `FAIL (${failed.join(', ') || 'no checks'})`) : 'not graded'}, ` +
          `$${(row.costUsd ?? 0).toFixed(2)}, docs ${row.docsConsulted ? 'yes' : 'no'}, web ${row.webUsed ? 'yes' : 'no'} ` +
          `(spent $${spent.toFixed(2)})`
      );
    },
  });

  if (stop !== null) {
    segment.stoppedBecause = `${stop.reason} at ${stop.runId}`;
  }
  await writeResults();
  if (!plan.keepWorkspaces) {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
  if (skippedForBudget > 0) {
    log(
      `${skippedForBudget} run(s) not started because of --max-total-usd; rerun with --resume to continue`
    );
  }
  log(`wrote ${relative(process.cwd(), join(resultsDir, 'summary.md'))}`);

  const ordered = planned
    .map((run) => rows.get(run.runId))
    .filter((row): row is RunRow => row !== undefined);
  if (stop !== null) {
    const graded = ordered.filter((row) => row.infraError === null).length;
    log(
      `STOPPED: ${ACCOUNT_STOP_TEXT[stop.reason] ?? stop.reason} (run ${stop.runId}: ${stop.detail})`
    );
    if (stop.resetsAt !== null) {
      log(`The limit resets at ${stop.resetsAt}.`);
    }
    log(
      `${graded} of ${planned.length} planned run(s) have a graded result; ${planned.length - graded} remain (not started, or infra errors that will be retried).`
    );
    log(
      `No new run was started after the stop. Continue with:\n  ${resumeCommand(plan.command, plan.argv, resultsDir)}`
    );
    return { rows: ordered, exitCode: EXIT_ACCOUNT_STOP };
  }
  return { rows: ordered, exitCode: isShuttingDown() ? 130 : 0 };
}

async function runCommandMain(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      ...RUN_OPTIONS,
      cases: { type: 'string' },
      runs: { type: 'string' },
      concurrency: { type: 'string' },
    },
  });
  const cases = await loadCases(values.cases);
  const resolved = await resolveSettings(values, cases, join(RESULTS_DIR, timestamp()));
  const { exitCode } = await executePlan({
    command: 'run',
    argv,
    cases,
    ...resolved,
    runs: Math.floor(parsePositiveNumber(values.runs, '--runs', 1)),
    concurrency: Math.floor(parsePositiveNumber(values.concurrency, '--concurrency', 2)),
    keepWorkspaces: values['keep-workspaces'],
  });
  return exitCode;
}

/* ------------------------------------------------------------------------------------------ */
/* smoke                                                                                      */
/* ------------------------------------------------------------------------------------------ */

const SMOKE_CASE = 'zod-4-6';

/**
 * One case, once per arm, with exactly the `run` invocation: proves the pipeline end to end and
 * lets the operator read their usage meter before and after.
 */
async function smoke(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { ...RUN_OPTIONS, case: { type: 'string' } },
  });
  const caseId = values.case ?? SMOKE_CASE;
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(caseId)) {
    throw new UsageError(`--case takes one case id, got "${caseId}"`);
  }
  const cases = await loadCases(caseId);
  const resolved = await resolveSettings(values, cases, join(RESULTS_DIR, `smoke-${timestamp()}`));
  process.stdout.write(
    'Note your current Claude usage now (claude.ai Settings > Usage, or /usage in Claude Code), then compare it after this smoke check.\n'
  );
  process.stdout.write(
    `Smoke check: case ${caseId}, arms ${resolved.arms.join(', ')}, model ${resolved.settings.model}, at most $${(resolved.arms.length * resolved.settings.perRunUsd).toFixed(2)}.\n\n`
  );
  const { rows, exitCode } = await executePlan({
    command: 'smoke',
    argv,
    cases,
    ...resolved,
    runs: 1,
    concurrency: 1,
    keepWorkspaces: values['keep-workspaces'],
  });

  let problems = 0;
  for (const row of rows) {
    const graded = row.infraError === null;
    const verdict = graded ? (row.passed ? 'checks PASS' : 'checks FAIL') : 'not graded';
    process.stdout.write(
      `${row.arm}: ${describeOutcome(row.outcome)}, ${verdict}, $${(row.costUsd ?? 0).toFixed(2)}, ` +
        `${row.numTurns ?? 'n/a'} turn(s), ${(row.wallMs / 1000).toFixed(1)} s wall, ` +
        `docs consulted ${row.docsConsulted ? 'yes' : 'no'}, attempts ${row.attempts}\n`
    );
    if (row.infraError !== null) {
      problems += 1;
      process.stdout.write(`  infra error: ${row.infraError}\n`);
    }
    if (row.arm === 'plugin') {
      const outputs = row.sessionStartHooks
        .map((hook) => hook.output)
        .filter((text) => text.length > 0);
      process.stdout.write(
        row.sessionStartHooks.length === 0
          ? '  hook: did not run\n'
          : `  hook output: ${outputs.length === 0 ? '(ran, no output)' : outputs.join('\n  ')}\n`
      );
    }
    for (const assertion of row.armAssertions) {
      process.stdout.write(
        `  [${assertion.passed ? 'pass' : 'FAIL'}] ${assertion.name}: ${assertion.detail}\n`
      );
    }
  }
  if (exitCode !== 0) {
    return exitCode;
  }
  if (problems > 0 || rows.length < resolved.arms.length) {
    process.stdout.write(
      `\nSmoke check FAILED: ${problems} session(s) could not run or did not measure their arm.\n`
    );
    return 1;
  }
  process.stdout.write('\nSmoke check passed: every session ran and every arm assertion held.\n');
  return 0;
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
    case 'smoke':
      return smoke(rest);
    default:
      process.stderr.write(USAGE);
      return command === undefined || command === '--help' ? 0 : 2;
  }
}

// Imported by the unit tests for the scheduling logic; only a direct invocation runs a command.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      if (error instanceof UsageError || isCaseError(error)) {
        log(error.message);
        process.exitCode = 2;
      } else {
        log(
          error instanceof Error && error.stack !== undefined ? error.stack : errorMessage(error)
        );
        process.exitCode = 3;
      }
    }
  );
}
