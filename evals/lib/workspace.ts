import { constants, existsSync } from 'node:fs';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { errorMessage, isRecord } from '../../src/utils/guards.js';
import { sha256File, sha256Hex } from '../../src/utils/hash.js';
import { readJsonFile } from '../../src/utils/json.js';
import { CACHE_DIR, type CheckSpec, type EvalCase, listFiles } from './cases.js';
import { runProcess } from './proc.js';

const TEMPLATE_STAMP = '.eval-template.json';

/** Hash of the fixture manifest and lockfile: the template is reused while this is unchanged. */
async function lockKey(evalCase: EvalCase): Promise<string> {
  const fixture = join(evalCase.dir, 'fixture');
  const pkg = await sha256File(join(fixture, 'package.json'));
  const lock = await sha256File(join(fixture, 'package-lock.json'));
  return sha256Hex(`${pkg}\n${lock}`);
}

/**
 * Installs the fixture's locked dependencies once into `.cache/templates/<id>` and returns that
 * directory. Workspaces copy `node_modules` from here, so agents never wait on npm and every arm
 * starts from the same installed tree.
 */
export async function ensureTemplate(
  evalCase: EvalCase,
  log: (line: string) => void
): Promise<string> {
  const templateDir = join(CACHE_DIR, 'templates', evalCase.id);
  const key = await lockKey(evalCase);
  const stampPath = join(templateDir, TEMPLATE_STAMP);
  if (existsSync(stampPath)) {
    const stamp = await readJsonFile(stampPath);
    if (isRecord(stamp) && stamp.lockKey === key && existsSync(join(templateDir, 'node_modules'))) {
      return templateDir;
    }
  }

  log(`installing ${evalCase.id} template (npm ci)`);
  const staging = `${templateDir}.staging-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  const fixture = join(evalCase.dir, 'fixture');
  await cp(join(fixture, 'package.json'), join(staging, 'package.json'));
  await cp(join(fixture, 'package-lock.json'), join(staging, 'package-lock.json'));
  const result = await runProcess(
    'npm',
    ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'],
    { cwd: staging, timeoutMs: 10 * 60_000 }
  );
  if (result.exitCode !== 0) {
    await rm(staging, { recursive: true, force: true });
    throw new Error(
      `npm ci failed for ${evalCase.id} (exit ${String(result.exitCode)}${result.timedOut ? ', timed out' : ''}):\n${result.stderr}`
    );
  }
  await writeFile(join(staging, TEMPLATE_STAMP), `${JSON.stringify({ lockKey: key }, null, 2)}\n`);
  await rm(templateDir, { recursive: true, force: true });
  await rename(staging, templateDir);
  return templateDir;
}

/** Recursive copy that keeps relative symlinks (node_modules/.bin) and clones files where the FS can. */
export async function copyTree(from: string, to: string): Promise<void> {
  await cp(from, to, {
    recursive: true,
    verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE,
  });
}

/**
 * A fresh workspace: the fixture files, then the template's node_modules. Overlays (solution,
 * naive, pack files) are applied by the caller.
 */
export async function createWorkspace(
  evalCase: EvalCase,
  templateDir: string,
  dir: string
): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await copyTree(join(evalCase.dir, 'fixture'), dir);
  await copyTree(join(templateDir, 'node_modules'), join(dir, 'node_modules'));
}

/** Copies every file of `overlayDir` over `dir`, except the names in `skip`. */
export async function overlay(
  overlayDir: string,
  dir: string,
  skip: readonly string[] = []
): Promise<void> {
  for (const rel of await listFiles(overlayDir)) {
    if (skip.includes(rel)) {
      continue;
    }
    const target = join(dir, rel);
    await mkdir(join(target, '..'), { recursive: true });
    await cp(join(overlayDir, rel), target);
  }
}

export interface CheckResult {
  name: string;
  passed: boolean;
  durationMs: number;
  /** Short reason or the tail of the command output. */
  detail: string;
}

const SUPPRESSION_PATTERNS: Array<[RegExp, string]> = [
  [/\bas\s+any\b/, '`as any`'],
  [/:\s*any\b/, '`: any`'],
  [/\bas\s+unknown\s+as\b/, '`as unknown as`'],
  [/@ts-(ignore|expect-error|nocheck)/, 'a @ts- directive'],
];

async function runBuiltin(
  evalCase: EvalCase,
  check: Extract<CheckSpec, { kind: 'builtin' }>,
  dir: string
): Promise<CheckResult> {
  const started = Date.now();
  const done = (passed: boolean, detail: string): CheckResult => ({
    name: check.name,
    passed,
    durationMs: Date.now() - started,
    detail,
  });

  if (check.builtin === 'deps-unchanged') {
    const changed: string[] = [];
    for (const file of ['package.json', 'package-lock.json']) {
      const fixturePath = join(evalCase.dir, 'fixture', file);
      const workspacePath = join(dir, file);
      if (!existsSync(workspacePath)) {
        changed.push(`${file} (deleted)`);
        continue;
      }
      if ((await sha256File(fixturePath)) !== (await sha256File(workspacePath))) {
        changed.push(file);
      }
    }
    return changed.length === 0
      ? done(true, 'package.json and package-lock.json are byte-identical to the fixture')
      : done(false, `changed: ${changed.join(', ')}`);
  }

  const hits: string[] = [];
  const srcDir = join(dir, 'src');
  if (existsSync(srcDir)) {
    for (const rel of await listFiles(srcDir)) {
      if (!/\.(ts|mts|cts|tsx|svelte)$/.test(rel)) {
        continue;
      }
      const lines = (await readFile(join(srcDir, rel), 'utf8')).split('\n');
      for (const [index, line] of lines.entries()) {
        for (const [pattern, label] of SUPPRESSION_PATTERNS) {
          if (pattern.test(line)) {
            hits.push(`src/${rel}:${index + 1} uses ${label}`);
          }
        }
      }
    }
  }
  return hits.length === 0
    ? done(true, 'no type suppressions in src/')
    : done(false, hits.join('\n'));
}

/**
 * Runs one command check. The program is resolved inside the workspace's node_modules/.bin so a
 * globally installed tool can never stand in for the pinned one.
 */
async function runCommand(
  check: Extract<CheckSpec, { kind: 'command' }>,
  dir: string
): Promise<CheckResult> {
  const [program, ...args] = check.command;
  const binDir = join(dir, 'node_modules', '.bin');
  const programPath = join(binDir, program);
  if (!existsSync(programPath)) {
    return {
      name: check.name,
      passed: false,
      durationMs: 0,
      detail: `${program} is not installed in the workspace`,
    };
  }
  const result = await runProcess(programPath, args, {
    cwd: dir,
    timeoutMs: check.timeoutSeconds * 1000,
    keepBytes: 16 * 1024,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      CI: '1',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    },
  });
  const passed = result.exitCode === 0 && !result.timedOut;
  const output = `${result.stdout}\n${result.stderr}`.trim();
  const reason = result.timedOut
    ? `timed out after ${check.timeoutSeconds}s`
    : (result.spawnError ?? `exit ${String(result.exitCode)}`);
  return {
    name: check.name,
    passed,
    durationMs: result.durationMs,
    detail: passed ? reason : `${reason}\n${output.slice(-4000)}`,
  };
}

/** Copies the hidden graders into the workspace and runs every check in order. */
export async function gradeWorkspace(evalCase: EvalCase, dir: string): Promise<CheckResult[]> {
  await overlay(join(evalCase.dir, 'checks'), dir, ['checks.json']);
  const results: CheckResult[] = [];
  for (const check of evalCase.checks) {
    try {
      results.push(
        check.kind === 'builtin'
          ? await runBuiltin(evalCase, check, dir)
          : await runCommand(check, dir)
      );
    } catch (error) {
      results.push({
        name: check.name,
        passed: false,
        durationMs: 0,
        detail: `check crashed: ${errorMessage(error)}`,
      });
    }
  }
  return results;
}
