import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { HOOK_LIMITS } from '../../src/agent/hook.js';
import { isFileNotFoundError } from '../../src/utils/guards.js';

export interface HookProcessResult {
  code: number;
  stdout: string;
  stderr: string;
  /** What this run wrote to hook.log. */
  log: string;
}

const ATTEMPTS = 5;

/**
 * Runs `node <cli> hook session-start` as a real process until one run finishes
 * inside the hook's deadline. The deadline counts from process start, so it
 * includes loading the CLI, and a run that misses it prints nothing by design
 * and records the miss in hook.log. On a loaded machine that outcome is
 * expected, so such a run is retried; the test fails only when every one of
 * ATTEMPTS runs misses.
 */
export async function runHookProcess(options: {
  cli: string;
  stdin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  cacheDir: string;
}): Promise<HookProcessResult> {
  const logPath = join(options.cacheDir, 'hook.log');
  const missed = `missed its ${HOOK_LIMITS.deadlineMs} ms deadline`;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    await rm(logPath, { force: true });
    const result = await new Promise<Omit<HookProcessResult, 'log'>>((resolveResult) => {
      const child = execFile(
        process.execPath,
        [options.cli, 'hook', 'session-start'],
        { cwd: options.cwd, env: options.env },
        (error, stdout, stderr) => {
          const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
          resolveResult({ code, stdout, stderr });
        }
      );
      // The hook may exit without reading its payload (switched off, or past its deadline).
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(options.stdin);
    });
    const log = await readFile(logPath, 'utf-8').catch((error: unknown) => {
      if (isFileNotFoundError(error)) {
        return '';
      }
      throw error;
    });

    if (!log.includes(missed)) {
      return { ...result, log };
    }
  }
  throw new Error(`The session-start hook ${missed} in all ${ATTEMPTS} runs.`);
}
