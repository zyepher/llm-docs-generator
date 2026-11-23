import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { normalizeRepositoryUrl } from '../src/core/package-discovery.js';
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
  isPluginArm,
  lintCase,
  listFiles,
  loadCases,
  PREPARED_DIRS,
  PREPARED_STAMP,
  type PluginArm,
  RESULTS_DIR,
  STRATA,
  STRATUM_CHECKS,
} from './lib/cases.js';
import {
  checkHookNote,
  type ExpectedHookNote,
  expectedNoteProblems,
  HOOK_NOTE_ATTEMPTS,
  hookNotePath,
  type NoteExpectation,
  readExpectedHookNote,
  settleHookNote,
} from './lib/hook-note.js';
import { installSignalHandlers, isShuttingDown, runProcess } from './lib/proc.js';
import {
  type CaseRule,
  evaluateCase,
  READ_FIRST_CACHE_DIR,
  ruleProblems,
  writeRule,
} from './lib/read-first-rule.js';
import {
  buildAggregates,
  isSegment,
  readRunRow,
  renderSummary,
  type RunRow,
  type Segment,
} from './lib/results.js';
import {
  ACCOUNT_STOP_REASONS,
  type CouldNotRunReason,
  classifyOutcome,
  describeOutcome,
  hookText,
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
                 on tests/fixtures/evals/suppressions, and that every pack.json follows the
                 read-first rule (needs prepare-packs first).
  prepare-packs  --llm-docs <cli entry> [--plugin-dir <path>] [--model M] [--cases <globs>]
                 Build each case's docs pack with the llm-docs CLI into .cache/packs/<id>, an
                 initialized project with no packs into .cache/packs-note/<id>, and a pack of only
                 the case's read-first pages into .cache/packs-changes/<id>. With --plugin-dir,
                 also run the plugin's session-start hook in the workspace of each arm that loads
                 the plugin (ANTHROPIC_MODEL=M, default claude-opus-5-5) and store the note it must
                 inject; the note, changes, and plugin arms of run and smoke need it.
  read-first-rule [--cases <globs>] [--write] [--refresh]
                 Compute each pack's readFirst from discover's change documents and the prepared
                 pack's pages (evals/README.md states the rule), print the table, and exit 1 when
                 a pack.json differs. --write updates pack.json; --refresh refetches the evidence
                 cached in .cache/read-first/. selftest runs the same check.
  plan           [--cases] [--arms] [--runs N] [--model M] [--max-budget-usd-per-run X]
                 [--assume-usd-per-run LOW-HIGH]
                 Print the run matrix and an estimated cost range.
  run            [--cases <globs>] [--arms baseline,note,changes,pack,plugin] [--runs N] [--model M]
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
const LLM_DOCS_CACHE_DIR = join(CACHE_DIR, 'llm-docs-cache');

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

export function parseArms(value: string | undefined): Arm[] {
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

  const ruleFailures: string[] = [];
  for (const evalCase of cases) {
    const problems = ruleProblems(evalCase, await evaluateCase(evalCase, false));
    ruleFailures.push(...problems.map((problem) => `${evalCase.id}: ${problem}`));
  }
  log(
    ruleFailures.length === 0
      ? 'ok   every pack.json follows the read-first rule'
      : 'BAD  read-first rule'
  );
  failures.push(...ruleFailures);

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

function pluginBundlePath(pluginDir: string): string {
  return join(pluginDir, 'bin', 'llm-docs.mjs');
}

/** A repository URL as normalizeRepositoryUrl writes it, lowercased; null when it is not one. */
function repositoryKey(declared: unknown): string | null {
  const url = isRecord(declared) ? declared.url : declared;
  if (typeof url !== 'string') {
    return null;
  }
  const normalized = normalizeRepositoryUrl(url);
  return 'url' in normalized ? normalized.url.toLowerCase() : null;
}

/**
 * What prepare-packs checks in a case's expected note (`expectedNoteProblems`): which of the
 * fixture's direct dependencies come from one of the pack's source repositories, read from the
 * installed package's own `repository` field, and whether the arm's workspace holds the pack.
 */
async function noteExpectation(
  evalCase: EvalCase,
  templateDir: string,
  pinned: boolean
): Promise<NoteExpectation> {
  const sources = Array.isArray(evalCase.pack.pack.sources) ? evalCase.pack.pack.sources : [];
  const packRepositories = new Set(
    sources.flatMap((source) => {
      const key = isRecord(source) && source.type === 'git' ? repositoryKey(source.repo) : null;
      return key === null ? [] : [key];
    })
  );
  const manifest = await readJsonFile(join(evalCase.dir, 'fixture', 'package.json'));
  const names = (field: string): string[] =>
    isRecord(manifest) && isRecord(manifest[field]) ? Object.keys(manifest[field]) : [];
  const dependencies = [];
  for (const name of [...names('dependencies'), ...names('devDependencies')]) {
    const installed = await readJsonFile(join(templateDir, 'node_modules', name, 'package.json'));
    const key = isRecord(installed) ? repositoryKey(installed.repository) : null;
    dependencies.push({ name, sharesPackRepository: key !== null && packRepositories.has(key) });
  }
  const binding = evalCase.pack.pack.dependency;
  return {
    kind: evalCase.kind,
    packId: evalCase.pack.id,
    library: evalCase.library.name,
    boundDependency: isRecord(binding) && typeof binding.name === 'string' ? binding.name : null,
    dependencies,
    pinned,
  };
}

/**
 * The note the plugin's hook gives the agent in this case's workspace for an arm that loads the
 * plugin, run as Claude Code runs it (hooks/hooks.json): `node <plugin>/bin/llm-docs.mjs hook
 * session-start` in the workspace, the headless payload on stdin, and the session's environment.
 * The workspace lives under the OS temp directory like run's, because the hook looks for a
 * CLAUDE.md above the project. Only the plugin arm's note must be non-empty.
 */
async function computeHookNote(
  evalCase: EvalCase,
  arm: PluginArm,
  pluginDir: string,
  model: string,
  root: string
): Promise<{ note: string } | { failure: string }> {
  const dir = join(root, `${evalCase.id}-${arm}-1`);
  await mkdir(dir, { recursive: true });
  await cp(join(evalCase.dir, 'fixture', 'package.json'), join(dir, 'package.json'));
  await cp(join(evalCase.dir, 'fixture', 'package-lock.json'), join(dir, 'package-lock.json'));
  await copyPackInto(evalCase, arm, dir);
  // The payload a headless session sends (measured with Claude Code 2.1.330): no model in it.
  const payload = JSON.stringify({
    session_id: 'prepare-packs',
    transcript_path: join(dir, 'transcript.jsonl'),
    cwd: dir,
    hook_event_name: 'SessionStart',
    source: 'startup',
  });
  const settled = await settleHookNote(async () => {
    const result = await runProcess(
      'node',
      [pluginBundlePath(pluginDir), 'hook', 'session-start'],
      {
        cwd: dir,
        env: { ...agentEnv(model), CLAUDECODE: '1' },
        timeoutMs: 30_000,
        input: payload,
      }
    );
    return hookText(result.stdout);
  }, arm !== 'plugin');
  if ('outputs' in settled) {
    return {
      failure: `the plugin hook did not print the same ${arm === 'plugin' ? 'non-empty ' : ''}note twice in a row in ${HOOK_NOTE_ATTEMPTS} runs (lengths ${settled.outputs.map((output) => output.length).join(', ')}); a loaded machine makes it miss its deadline, so prepare again when the machine is quieter, or read hook.log in ${LLM_DOCS_CACHE_DIR}`,
    };
  }
  // The session's workspace has another path, so a note that names this one could never match.
  if (settled.note.includes(tmpdir())) {
    return { failure: `the hook's note names the workspace path:\n${settled.note}` };
  }
  return settled;
}

async function preparePacks(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      cases: { type: 'string' },
      'llm-docs': { type: 'string' },
      'plugin-dir': { type: 'string' },
      model: { type: 'string' },
    },
  });
  const cliArg = values['llm-docs'];
  if (cliArg === undefined) {
    throw new UsageError('prepare-packs needs --llm-docs <path to the llm-docs CLI entry>');
  }
  const cliPath = resolve(cliArg);
  if (!existsSync(cliPath)) {
    throw new UsageError(`llm-docs CLI not found at ${cliPath}`);
  }
  const pluginDir = values['plugin-dir'] === undefined ? null : resolve(values['plugin-dir']);
  if (pluginDir !== null && !existsSync(pluginBundlePath(pluginDir))) {
    throw new UsageError(
      `${pluginBundlePath(pluginDir)} does not exist; --plugin-dir takes the llm-docs plugin directory`
    );
  }
  const model = values.model ?? DEFAULT_MODEL;
  const cases = await loadCases(values.cases);

  await assertCliSupports(cliPath, cases);

  const failures: string[] = [];
  const warnings: string[] = [];
  await mkdir(join(tmpdir(), 'llm-docs-evals'), { recursive: true });
  const noteRoot = await mkdtemp(join(tmpdir(), 'llm-docs-evals', 'hook-note-'));

  /**
   * Builds one prepared directory for a case: the fixture's manifest and lockfile (they let
   * `dependency` bindings resolve the pinned version), `llm-docs.json` with `packs`, then init,
   * sync, and, when there is a pack, verify. Then `status` warms the release-date cache the
   * session-start hook reads, so an arm with the plugin does not depend on a 1 second network
   * budget during the run (best effort). Returns what went wrong, or null.
   */
  const build = async (
    evalCase: EvalCase,
    dir: string,
    packs: Record<string, unknown>
  ): Promise<string | null> => {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await cp(join(evalCase.dir, 'fixture', 'package.json'), join(dir, 'package.json'));
    await cp(join(evalCase.dir, 'fixture', 'package-lock.json'), join(dir, 'package-lock.json'));
    await writeJsonFileSafely(join(dir, 'llm-docs.json'), {
      schemaVersion: 3,
      packsDir: 'agent-docs',
      agentFiles: ['AGENTS.md'],
      packs,
    });

    const hasPack = Object.keys(packs).length > 0;
    const steps: Array<[string, string[], number]> = [
      ['init', ['init', '--project', dir], 60_000],
      ['sync', ['sync', '--project', dir], 20 * 60_000],
    ];
    if (hasPack) {
      steps.push(['verify', ['verify', '--project', dir], 5 * 60_000]);
    }
    for (const [name, args, timeoutMs] of steps) {
      const result = await runCli(cliPath, args, dir, timeoutMs);
      if (result.exitCode !== 0) {
        return `llm-docs ${name} failed (exit ${String(result.exitCode)}${result.timedOut ? ', timed out' : ''})\n${result.stderr.slice(-3000)}`;
      }
    }

    const index = join(dir, 'agent-docs', evalCase.pack.id, 'index.md');
    if (hasPack && !existsSync(index)) {
      return `sync succeeded but ${relative(dir, index)} is missing`;
    }
    const agentsFile = join(dir, 'AGENTS.md');
    const agentsText = existsSync(agentsFile) ? await readFile(agentsFile, 'utf8') : '';
    if (
      !agentsText.includes('<!-- BEGIN llm-docs') ||
      !agentsText.includes('<!-- END llm-docs -->')
    ) {
      return 'sync succeeded but AGENTS.md has no managed block';
    }

    const status = await runCli(cliPath, ['status', '--project', dir, '--json'], dir, 2 * 60_000);
    if (status.exitCode !== 0) {
      log(
        `warning: llm-docs status failed in ${relative(process.cwd(), dir)}; the hook may lack release dates`
      );
    }
    return null;
  };

  /**
   * With --plugin-dir, stores the note the plugin's hook gives in the arm's workspace once it says
   * the right thing about the case's pack (`pinned`: whether the workspace holds it); then stamps
   * the arm's directory as prepared from the case's current pack.json. Returns the failures.
   */
  const finish = async (evalCase: EvalCase, arm: PluginArm, pinned: boolean): Promise<string[]> => {
    const label = arm === 'plugin' ? evalCase.id : `${evalCase.id} (${arm} arm)`;
    if (pluginDir !== null) {
      const computed = await computeHookNote(evalCase, arm, pluginDir, model, noteRoot);
      if ('failure' in computed) {
        return [`${label}: ${computed.failure}`];
      }
      const problems = expectedNoteProblems(
        computed.note,
        await noteExpectation(evalCase, await ensureTemplate(evalCase, log), pinned)
      );
      warnings.push(...problems.warnings.map((warning) => `${label}: ${warning}`));
      if (problems.failures.length > 0) {
        return problems.failures.map((problem) =>
          pinned
            ? `${label}: ${problem} (the pack recipe is bound to the wrong thing)`
            : `${label}: ${problem}`
        );
      }
      const stored: ExpectedHookNote = {
        model,
        pluginBundle: await sha256File(pluginBundlePath(pluginDir)),
        note: computed.note,
      };
      await writeJsonFileSafely(hookNotePath(evalCase.id, arm), stored);
      log(`${label}: expected hook note stored (${computed.note.length} characters)`);
    }
    await writeJsonFileSafely(join(PREPARED_DIRS[arm], evalCase.id, PREPARED_STAMP), {
      pack: packFingerprint(evalCase),
      cli: cliPath,
      preparedAt: new Date().toISOString(),
    });
    return [];
  };

  for (const evalCase of cases) {
    log(`preparing pack ${evalCase.pack.id} for ${evalCase.id}`);
    const full = await build(evalCase, join(PREPARED_DIRS.pack, evalCase.id), {
      [evalCase.pack.id]: evalCase.pack.pack,
    });
    if (full !== null) {
      failures.push(`${evalCase.id}: ${full}`);
      continue;
    }
    failures.push(...(await finish(evalCase, 'plugin', true)));

    log(`preparing the note arm's project (no packs) for ${evalCase.id}`);
    const note = await build(evalCase, join(PREPARED_DIRS.note, evalCase.id), {});
    failures.push(
      ...(note === null
        ? await finish(evalCase, 'note', false)
        : [`${evalCase.id} (note arm): ${note}`])
    );

    const pages = readFirstPages(evalCase);
    const changesDir = join(PREPARED_DIRS.changes, evalCase.id);
    log(
      pages.length === 0
        ? `preparing the changes arm's project for ${evalCase.id} (no read-first pages, so no pack)`
        : `preparing the changes arm's pack of ${pages.length} read-first page(s) for ${evalCase.id}`
    );
    const derived = pages.length === 0 ? { recipe: null } : await changesRecipe(evalCase, pages);
    if ('failure' in derived) {
      await rm(changesDir, { recursive: true, force: true });
      failures.push(`${evalCase.id} (changes arm): ${derived.failure}`);
      continue;
    }
    const changes = await build(
      evalCase,
      changesDir,
      derived.recipe === null ? {} : { [evalCase.pack.id]: derived.recipe }
    );
    const differ = changes === null ? await changesPagesProblem(evalCase, pages) : changes;
    failures.push(
      ...(differ === null
        ? await finish(evalCase, 'changes', pages.length > 0)
        : [`${evalCase.id} (changes arm): ${differ}`])
    );
  }
  await rm(noteRoot, { recursive: true, force: true });

  for (const warning of warnings) {
    log(`WARNING ${warning}`);
  }
  if (pluginDir === null) {
    log(
      'no expected hook notes computed (no --plugin-dir): run and smoke refuse the note, changes, and plugin arms until prepare-packs runs with --plugin-dir'
    );
  }
  if (failures.length > 0) {
    log(`prepare-packs FAILED:\n${failures.join('\n')}`);
    return 1;
  }
  log(
    `prepared ${cases.length} case(s) under ${[...new Set(Object.values(PREPARED_DIRS))].map((dir) => relative(process.cwd(), dir)).join(', ')}`
  );
  return 0;
}

/** The case's read-first pages as pack paths: fragments dropped, repeats merged, recipe order. */
function readFirstPages(evalCase: EvalCase): string[] {
  const targets = evalCase.pack.pack.readFirst;
  const paths = (Array.isArray(targets) ? targets : [])
    .filter((target): target is string => typeof target === 'string')
    .map((target) => target.replace(/#.*$/, ''));
  return [...new Set(paths)];
}

/**
 * The case's recipe narrowed to its read-first pages, derived from the full pack's manifest: each
 * source's `include` becomes exactly the stored paths of the read-first pages it produced, a
 * source that produced none is dropped, and every other field is kept. A page's first `sources`
 * entry in the manifest is the file it was built from, as `<source index>:<stored path>`. When the
 * manifest does not say that for a read-first page, this fails naming the page rather than guess.
 */
async function changesRecipe(
  evalCase: EvalCase,
  pages: readonly string[]
): Promise<{ recipe: Record<string, unknown> } | { failure: string }> {
  const manifestPath = join(
    PREPARED_DIRS.pack,
    evalCase.id,
    'agent-docs',
    evalCase.pack.id,
    'manifest.json'
  );
  const manifest = existsSync(manifestPath) ? await readJsonFile(manifestPath) : null;
  const outputs =
    isRecord(manifest) && Array.isArray(manifest.outputs) ? manifest.outputs.filter(isRecord) : [];
  const sources = Array.isArray(evalCase.pack.pack.sources) ? evalCase.pack.pack.sources : [];
  const includes = new Map<number, string[]>();
  const unknown: string[] = [];
  for (const page of pages) {
    const output = outputs.find((entry) => entry.kind === 'page' && entry.path === page);
    const first: unknown = Array.isArray(output?.sources) ? output.sources[0] : undefined;
    const match = typeof first === 'string' ? /^(\d+):(.+)$/.exec(first) : null;
    const index = match?.[1] === undefined ? -1 : Number(match[1]);
    const stored = match?.[2];
    if (stored === undefined || !isRecord(sources[index])) {
      unknown.push(page);
      continue;
    }
    includes.set(index, [...(includes.get(index) ?? []), stored]);
  }
  if (unknown.length > 0) {
    return {
      failure: `the full pack's manifest does not say which source and stored path produced ${unknown.map((page) => `\`${page}\``).join(', ')}, so the changes pack cannot be derived`,
    };
  }
  return {
    recipe: {
      ...evalCase.pack.pack,
      sources: sources.flatMap((source, index) => {
        const include = includes.get(index);
        return include === undefined || !isRecord(source) ? [] : [{ ...source, include }];
      }),
    },
  };
}

/** How the changes pack's pages differ from the case's read-first pages, or null when they do not. */
async function changesPagesProblem(
  evalCase: EvalCase,
  pages: readonly string[]
): Promise<string | null> {
  if (pages.length === 0) {
    return null;
  }
  const manifest = await readJsonFile(
    join(PREPARED_DIRS.changes, evalCase.id, 'agent-docs', evalCase.pack.id, 'manifest.json')
  );
  const built = (isRecord(manifest) && Array.isArray(manifest.outputs) ? manifest.outputs : [])
    .map((output) => (isRecord(output) ? output.path : undefined))
    .filter((path): path is string => typeof path === 'string' && path.startsWith('pages/'));
  const missing = pages.filter((page) => !built.includes(page));
  const extra = built.filter((page) => !pages.includes(page));
  if (missing.length === 0 && extra.length === 0) {
    return null;
  }
  const list = (paths: string[]): string => paths.map((path) => `\`${path}\``).join(', ');
  return `the changes pack's pages differ from the read-first pages: ${[
    ...(missing.length > 0 ? [`missing ${list(missing)}`] : []),
    ...(extra.length > 0 ? [`not read-first ${list(extra)}`] : []),
  ].join('; ')}`;
}

/** Throws unless every case has, for every selected arm, a directory prepared from its current pack.json. */
async function assertPacksPrepared(cases: EvalCase[], arms: readonly Arm[]): Promise<void> {
  const problems: string[] = [];
  const roots = new Set(arms.flatMap((arm) => (arm === 'baseline' ? [] : [PREPARED_DIRS[arm]])));
  for (const root of roots) {
    const name = relative(CACHE_DIR, root);
    for (const evalCase of cases) {
      const stampPath = join(root, evalCase.id, PREPARED_STAMP);
      if (!existsSync(stampPath)) {
        problems.push(`${evalCase.id}: nothing prepared in .cache/${name} (run prepare-packs)`);
        continue;
      }
      const stamp = await readJsonFile(stampPath);
      if (!isRecord(stamp) || stamp.pack !== packFingerprint(evalCase)) {
        problems.push(
          `${evalCase.id}: pack.json changed since prepare-packs built .cache/${name}; prepare again`
        );
      }
    }
  }
  if (problems.length > 0) {
    throw new UsageError(problems.join('\n'));
  }
}

/* ------------------------------------------------------------------------------------------ */
/* read-first-rule                                                                            */
/* ------------------------------------------------------------------------------------------ */

function ruleRow(evalCase: EvalCase, rule: CaseRule): string {
  if (rule.status === 'cannot-apply') {
    return `| \`${evalCase.id}\` | cannot apply: ${rule.reason} | | | | |`;
  }
  const { evidence, output } = rule;
  const code = (paths: string[]): string =>
    paths.length === 0 ? 'none' : paths.map((path) => `\`${path}\``).join(', ');
  const source =
    evidence.via === 'discover'
      ? `discover at \`${evidence.ref}\``
      : `${evidence.repo} at \`${evidence.ref.slice(0, 12)}\``;
  const listed = `${evidence.documents.length}${evidence.more > 0 ? ` (+${evidence.more} unlisted)` : ''}`;
  const pages = rule.pagesProblem === null ? String(output.candidates.length) : '?';
  return `| \`${evalCase.id}\` | ${source} | ${listed} | ${pages} | ${code(output.additions)} | ${code(output.readFirst)} |`;
}

async function readFirstRule(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      cases: { type: 'string' },
      write: { type: 'boolean', default: false },
      refresh: { type: 'boolean', default: false },
    },
  });
  const cases = await loadCases(values.cases);
  const rows = [
    '| Case | Evidence | Change documents | Candidates (pages) | Added to taken paths | Read first |',
    '|---|---|---|---|---|---|',
  ];
  let unresolved = 0;
  for (const evalCase of cases) {
    const rule = await evaluateCase(evalCase, values.refresh);
    rows.push(ruleRow(evalCase, rule));
    const problems = ruleProblems(evalCase, rule);
    const wrote = values.write ? await writeRule(evalCase, rule) : 'nothing';
    if (wrote === 'readFirst') {
      log(`${evalCase.id}: wrote readFirst into pack.json`);
    } else if (wrote === 'paths') {
      unresolved += 1;
      log(`${evalCase.id}: added the change documents to the taken paths; prepare its pack again`);
    } else if (problems.length > 0) {
      unresolved += 1;
      log(`${evalCase.id}: ${problems.join('; ')}`);
    }
  }
  process.stdout.write(`${rows.join('\n')}\n`);
  log(`evidence cached in ${relative(process.cwd(), READ_FIRST_CACHE_DIR)} (--refresh refetches)`);
  if (unresolved > 0) {
    log(
      values.write
        ? `${unresolved} case(s) still differ: prepare-packs for them, then read-first-rule --write again`
        : `${unresolved} case(s) differ from the read-first rule`
    );
    return 1;
  }
  return 0;
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
      for (const raw of data.rows) {
        const row = readRunRow(raw);
        if (row !== null) {
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
  for (const arm of arms.filter(isPluginArm)) {
    const ready = (
      await Promise.all(cases.map((evalCase) => readExpectedHookNote(evalCase.id, arm)))
    ).filter((stored) => stored?.model === model).length;
    process.stdout.write(
      `\nThe ${arm} arm asserts that each session's hook gave the note prepare-packs stored for ${model}: ` +
        `${ready} of ${cases.length} case(s) have one.` +
        (ready < cases.length
          ? ` Run \`npm run eval -- prepare-packs --llm-docs dist/cli.js --plugin-dir plugin --model ${model}\` first.\n`
          : '\n')
    );
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
 * The environment of every agent session, and of the hook run that computes its expected note.
 * The parent session's Claude Code variables must not leak into the agent under test (they carry
 * the parent's session id, effort level, and entrypoint). `ANTHROPIC_MODEL` names the evaluated
 * model: a headless session's SessionStart payload names none, so without it the plugin's hook
 * falls back to the operator's own `model` setting and states the wrong training cutoff.
 */
export function agentEnv(model: string): NodeJS.ProcessEnv {
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
  env.ANTHROPIC_MODEL = model;
  return env;
}

export interface RunSettings {
  model: string;
  perRunUsd: number;
  pluginDir: string | null;
  /** `name` from the plugin's manifest, which every arm with the plugin asserts the session loaded. */
  pluginName: string | null;
  /** Per arm with the plugin, case id to the note prepare-packs stored, which the arm asserts its hook gave. */
  hookNotes: Readonly<Record<PluginArm, ReadonlyMap<string, string>>>;
  effort: string | null;
}

/** The `claude` arguments and environment of one session; only the arguments differ by arm. */
export function agentInvocation(
  evalCase: EvalCase,
  arm: Arm,
  settings: RunSettings
): { args: string[]; env: NodeJS.ProcessEnv } {
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
  if (isPluginArm(arm) && settings.pluginDir !== null) {
    args.push('--plugin-dir', settings.pluginDir);
  }
  // Variadic option last, so it cannot swallow anything that follows.
  args.push('--allowedTools', ...ALLOWED_TOOLS);
  return { args, env: agentEnv(settings.model) };
}

/** What prepare-packs built for the arm: the packs directory, `AGENTS.md`, and `llm-docs.json`. */
async function copyPackInto(
  evalCase: EvalCase,
  arm: Exclude<Arm, 'baseline'>,
  dir: string
): Promise<void> {
  const prepared = join(PREPARED_DIRS[arm], evalCase.id);
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

async function claudeVersion(model: string): Promise<string> {
  const result = await runProcess('claude', ['--version'], {
    cwd: EVALS_DIR,
    timeoutMs: 30_000,
    env: agentEnv(model),
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
      const row = readRunRow(await readJsonFile(file));
      if (row !== null) {
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
    installedCodeRead: false,
    ownTestRuns: 0,
    typeCheckRuns: 0,
    toolCalls: {},
    permissionDenials: [],
    sessionStartHooks: [],
    hookNote: null,
    session: null,
    armAssertions: [],
    infraError: null,
  };

  let facts: WorkspaceFacts;
  try {
    await createWorkspace(evalCase, template, dir);
    if (arm !== 'baseline') {
      await copyPackInto(evalCase, arm, dir);
    }
    facts = await inspectWorkspace(dir, evalCase.pack.id);
  } catch (error) {
    return { ...base, infraError: `workspace setup failed: ${errorMessage(error)}` };
  }

  try {
    const transcriptPath = join(runDir, 'transcript.jsonl');
    const invocation = agentInvocation(evalCase, arm, settings);
    const agent = await runProcess('claude', invocation.args, {
      cwd: dir,
      env: invocation.env,
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
    const expectedNote = isPluginArm(arm) ? (settings.hookNotes[arm].get(evalCase.id) ?? '') : null;
    const armAssertions =
      outcome.kind === 'could-not-run'
        ? []
        : assertArm(arm, facts, summary, {
            model: settings.model,
            packId: evalCase.pack.id,
            pluginName: settings.pluginName,
            hookNote: expectedNote,
            hasReadFirst: readFirstPages(evalCase).length > 0,
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
      installedCodeRead: summary.installedCodeRead,
      ownTestRuns: summary.ownTestRuns,
      typeCheckRuns: summary.typeCheckRuns,
      toolCalls: summary.toolCalls,
      permissionDenials: summary.result?.permissionDenials ?? [],
      sessionStartHooks: summary.sessionStartHooks,
      hookNote:
        expectedNote === null ? null : checkHookNote(expectedNote, summary.sessionStartHooks),
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

/** In-place retries for a transient condition: wait 30 s, retry, wait 120 s, retry, give up. */
export const TRANSIENT_BACKOFF_MS = [30_000, 120_000] as const;

/**
 * Transient conditions: a rate limit or an overload, and a plugin hook that gave the agent nothing
 * when that was the only thing wrong (it missed its deadline on a loaded machine). A hook that gave
 * a different note is not retried: a rerun on the same machine would say the same.
 */
function isTransient(row: RunRow): boolean {
  const reason = couldNotRunReason(row);
  if (reason !== null) {
    return TRANSIENT_REASONS.has(reason);
  }
  return (
    row.hookNote?.verdict === 'empty' &&
    row.armAssertions.filter((assertion) => !assertion.passed).length === 1
  );
}

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
 * Runs `todo` in order on `concurrency` lanes. A transient condition (`isTransient`) is retried in
 * place with backoff. The first usage-limit, auth, or billing outcome stops the schedule: no new run starts,
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
      if (stop !== null || !isTransient(row)) {
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
  const pluginArms = arms.filter(isPluginArm);
  const pluginDir = values['plugin-dir'] === undefined ? null : resolve(values['plugin-dir']);
  let pluginName: string | null = null;
  if (pluginArms.length > 0) {
    if (pluginDir === null) {
      throw new UsageError(
        `the ${pluginArms.join(', ')} arm${pluginArms.length > 1 ? 's need' : ' needs'} --plugin-dir <path to the llm-docs plugin>`
      );
    }
    const manifestPath = join(pluginDir, '.claude-plugin', 'plugin.json');
    if (!existsSync(manifestPath)) {
      throw new UsageError(`${pluginDir} has no .claude-plugin/plugin.json`);
    }
    const manifest = await readJsonFile(manifestPath);
    if (!isRecord(manifest) || typeof manifest.name !== 'string' || manifest.name.length === 0) {
      throw new UsageError(
        `${manifestPath} has no "name"; an arm with the plugin asserts the session loaded it by name`
      );
    }
    pluginName = manifest.name;
  }
  const model = values.model ?? DEFAULT_MODEL;
  const hookNotes: Record<PluginArm, Map<string, string>> = {
    note: new Map(),
    changes: new Map(),
    plugin: new Map(),
  };
  await assertPacksPrepared(cases, arms);
  if (pluginDir !== null && pluginArms.length > 0) {
    const bundle = await sha256File(pluginBundlePath(pluginDir));
    const prepare = `prepare-packs --llm-docs dist/cli.js --plugin-dir ${relative(process.cwd(), pluginDir) || '.'} --model ${model}`;
    const problems: string[] = [];
    for (const arm of pluginArms) {
      for (const evalCase of cases) {
        const stored = await readExpectedHookNote(evalCase.id, arm);
        if (stored === null) {
          problems.push(
            `${evalCase.id}: no expected hook note for the ${arm} arm; it needs \`${prepare}\``
          );
        } else if (stored.model !== model) {
          problems.push(
            `${evalCase.id}: the ${arm} arm's expected hook note is for model ${stored.model}, not ${model}; run \`${prepare}\``
          );
        } else if (stored.pluginBundle !== bundle) {
          problems.push(
            `${evalCase.id}: the plugin's bin/llm-docs.mjs changed since the ${arm} arm's expected hook note was computed; run \`${prepare}\``
          );
        } else {
          hookNotes[arm].set(evalCase.id, stored.note);
        }
      }
    }
    if (problems.length > 0) {
      throw new UsageError(problems.join('\n'));
    }
  }
  const resultsDir = values.resume === undefined ? freshResultsDir : resolve(values.resume);
  if (values.resume !== undefined && !existsSync(resultsDir)) {
    throw new UsageError(`--resume directory ${resultsDir} does not exist`);
  }
  return {
    arms,
    settings: {
      model,
      perRunUsd: parsePositiveNumber(
        values['max-budget-usd-per-run'],
        '--max-budget-usd-per-run',
        3
      ),
      pluginDir,
      pluginName,
      hookNotes,
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

  const version = await claudeVersion(settings.model);
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
    if (isPluginArm(row.arm)) {
      const outputs = row.sessionStartHooks
        .map((hook) => hook.output)
        .filter((text) => text.length > 0);
      process.stdout.write(
        row.sessionStartHooks.length === 0
          ? '  hook: did not run\n'
          : `  hook output: ${outputs.length === 0 ? '(ran, no output)' : outputs.join('\n  ')}\n`
      );
      if (row.hookNote !== null && row.hookNote.verdict !== 'match') {
        process.stdout.write(`  expected hook note: ${row.hookNote.expected}\n`);
      }
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
    case 'read-first-rule':
      return readFirstRule(rest);
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
