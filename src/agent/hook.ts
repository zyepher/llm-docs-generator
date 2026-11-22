/**
 * `llm-docs hook session-start` (spec 7.2): what a coding session is told
 * when it starts. The analysis is `gatherProjectStatus`, the same one
 * `llm-docs status` runs; this module owns what is hook-specific: the
 * payload, the harness and its output envelope, the deadline, the throttled
 * background warm-up, `hook.log`, and `sessionBrief` (the injected text, also
 * what `status --brief` prints).
 *
 * Failure policy: `runSessionStartHook` never rejects, writes stdout at most
 * once (a whole envelope), never writes stderr, and sends every problem to
 * `hook.log` in the cache directory, the only place it writes.
 */

import { spawn } from 'node:child_process';
import { constants, writeSync } from 'node:fs';
import { lstat, mkdir, open, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import { findProjectRoot, loadProjectConfigIfPresent } from '../config/project.js';
import { defaultCacheDir, type RegistryEndpoints } from '../deps/registries.js';
import { formatStatusBrief, gatherProjectStatus, type ProjectStatus } from '../deps/status.js';
import { errorMessage, isNonEmptyString, isRecord } from '../utils/guards.js';
import { sha256Hex } from '../utils/hash.js';
import { readRegularFile, writeTextFileSafely } from '../utils/safe-write.js';
import { blockBody, harnessSeesBlock, type Harness } from './block.js';

/** Every budget the hook keeps, in milliseconds counted from process start unless noted. */
export const HOOK_LIMITS = {
  /** The whole run (spec 7.2: under 1.5 s). */
  deadlineMs: 1_500,
  /** Reading the payload. */
  stdinMs: 1_000,
  stdinMaxBytes: 1024 * 1024,
  /** Network time for release dates missing from the cache. */
  networkMs: 1_000,
  /** Kept at the end of the deadline for the block check, rendering, and the write. */
  reserveMs: 150,
  /**
   * Largest lockfile the hook parses. Parsing is synchronous, so no deadline
   * can stop it: measured cold, YAML parses at 35 to 72 ms per MiB, TOML at
   * 16 to 24, JSON at 2 to 11, so a lockfile at this cap costs at most about
   * 300 ms. A larger one is left to `status`, which reads up to 64 MiB.
   */
  maxLockfileBytes: 4 * 1024 * 1024,
  /** Characters of injected text. */
  maxChars: 2_000,
  /** Wall-clock time between background warm-ups of one project. */
  warmIntervalMs: 6 * 60 * 60 * 1000,
  /** Bytes of hook.log before it rotates to hook.log.1. */
  logMaxBytes: 1024 * 1024,
} as const;

const LOG_FILE = 'hook.log';
const WARM_DIR = 'hook-warm';

/** Everything the hook touches outside itself, so tests run it with no process, network, or harness. */
export interface HookIo {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly homeDir: string;
  readonly platform: NodeJS.Platform;
  readonly stdin: AsyncIterable<string | Uint8Array>;
  /** Where release dates come from; the public registries when absent. */
  readonly registryEndpoints?: Partial<RegistryEndpoints>;
  /** Milliseconds since the process started; every hook budget counts from there. */
  elapsedMs(): number;
  /** Wall-clock time, for the warm-up throttle, the log, and release-date windows. */
  now(): Date;
  /** Write the whole text to stdout synchronously: the process exits right after the hook. */
  writeStdout(text: string): void;
  /** Start `llm-docs status --project <root>` detached, stdio ignored, unreferenced. */
  spawnWarmStatus(projectRoot: string): void;
}

/** The HookIo of a real run: this process, its stdin, and a detached copy of this CLI. */
export function nodeHookIo(): HookIo {
  return {
    env: process.env,
    cwd: process.cwd(),
    homeDir: homedir(),
    platform: process.platform,
    stdin: process.stdin,
    elapsedMs: () => performance.now(),
    now: () => new Date(),
    writeStdout: (text) => {
      writeSync(1, text);
    },
    spawnWarmStatus: (projectRoot) => {
      const script = process.argv[1];
      if (script === undefined) {
        return;
      }
      const child = spawn(
        process.execPath,
        [script, 'status', '--project', projectRoot, '--json'],
        {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        }
      );
      // The hook exits right after this; a child that fails to start has no one left to tell.
      child.on('error', () => undefined);
      child.unref();
    },
  };
}

/** The hook payload as the hook uses it, whichever harness sent it. */
interface HookPayload {
  cwd: string | undefined;
  /** Claude Code and Codex `model`, Cursor `model_id` or `model`. */
  model: string | undefined;
  /** Cursor `workspace_roots`. */
  workspaceRoots: readonly string[];
}

const EMPTY_PAYLOAD: HookPayload = { cwd: undefined, model: undefined, workspaceRoots: [] };

/** The payload only refines defaults, so anything unusable is EMPTY_PAYLOAD plus a reason to log. */
function parseHookPayload(text: string): { payload: HookPayload; problem: string | null } {
  if (text.trim() === '') {
    return { payload: EMPTY_PAYLOAD, problem: null };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { payload: EMPTY_PAYLOAD, problem: 'the payload on stdin is not JSON; ignored it' };
  }
  if (!isRecord(raw)) {
    return { payload: EMPTY_PAYLOAD, problem: 'the payload on stdin is not an object; ignored it' };
  }

  const trimmed = (value: unknown): string | undefined =>
    isNonEmptyString(value) && value.trim() !== '' ? value.trim() : undefined;
  const modelValue = raw.model ?? raw.model_id;
  const model = isRecord(modelValue) ? trimmed(modelValue.id) : trimmed(modelValue);
  const roots = Array.isArray(raw.workspace_roots) ? raw.workspace_roots : [];

  return {
    payload: {
      cwd: trimmed(raw.cwd),
      model,
      workspaceRoots: roots.flatMap((root) => {
        const value = trimmed(root);
        return value === undefined ? [] : [value];
      }),
    },
    problem: null,
  };
}

class StdinProblem extends Error {}

/** Everything on stdin, if it ends within `budgetMs` and stays under the size cap. */
async function readStdinWithin(
  stdin: AsyncIterable<string | Uint8Array>,
  budgetMs: number
): Promise<string> {
  const iterator = stdin[Symbol.asyncIterator]();
  const decoder = new TextDecoder();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((settle) => {
    timer = setTimeout(() => settle('timeout'), Math.max(0, budgetMs));
  });
  let text = '';
  let bytes = 0;

  try {
    while (true) {
      const next = await Promise.race([iterator.next(), timeout]);
      if (next === 'timeout') {
        throw new StdinProblem(`stdin did not end within ${Math.max(0, budgetMs)} ms; ignored it`);
      }
      if (next.done === true) {
        return text + decoder.decode();
      }
      const chunk = next.value;
      bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
      if (bytes > HOOK_LIMITS.stdinMaxBytes) {
        throw new StdinProblem(
          `the payload on stdin is over ${HOOK_LIMITS.stdinMaxBytes} bytes; ignored it`
        );
      }
      text += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    }
  } finally {
    clearTimeout(timer);
    void iterator.return?.().catch(() => undefined);
  }
}

/**
 * Cursor sets CURSOR_VERSION or CURSOR_PLUGIN_ROOT in hook processes, and
 * Claude Code sets CLAUDECODE=1. Anything else (Codex included) is `unknown`,
 * which gets the Claude Code and Codex envelope.
 */
export function detectHarness(env: NodeJS.ProcessEnv): Harness | 'unknown' {
  if (isNonEmptyString(env.CURSOR_VERSION) || isNonEmptyString(env.CURSOR_PLUGIN_ROOT)) {
    return 'cursor';
  }
  return env.CLAUDECODE === '1' ? 'claude-code' : 'unknown';
}

function envelope(harness: Harness | 'unknown', text: string): string {
  const output =
    harness === 'cursor'
      ? { additional_context: text }
      : { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } };
  return `${JSON.stringify(output)}\n`;
}

/**
 * The text a session gets, at most HOOK_LIMITS.maxChars characters:
 * `formatStatusBrief`, then, when packs are built and the files this harness
 * reads hold no managed block, the block's pack list rendered by the same
 * function sync writes with, cut to the characters left (its UTF-8 byte
 * budget never exceeds that many characters). Empty when there is nothing
 * to say.
 */
export async function sessionBrief(
  status: ProjectStatus,
  harness: Harness | 'unknown',
  ignored?: (problem: string) => void
): Promise<string> {
  const head = formatStatusBrief(status.report, { maxChars: HOOK_LIMITS.maxChars });

  if (status.loaded === null || (await harnessSeesBlock(status.projectRoot, harness, ignored))) {
    return head;
  }

  const left = HOOK_LIMITS.maxChars - head.length - (head === '' ? 0 : 2);
  const list = left > 0 ? await blockBody(status.loaded, status.packs, left) : null;

  if (list === null || list === '') {
    return head;
  }
  return head === '' ? list.trimEnd() : `${head}\n\n${list.trimEnd()}`;
}

/**
 * At most one warm-up per project per HOOK_LIMITS.warmIntervalMs: one marker
 * file per project holding the time of its last warm-up, so sessions in
 * different projects never rewrite each other's state. Two sessions racing
 * on one project can both spawn; that costs one redundant lookup, and the
 * release-date cache write is atomic.
 */
async function maybeWarm(io: HookIo, cacheDir: string, projectRoot: string): Promise<void> {
  const marker = join(cacheDir, WARM_DIR, sha256Hex(projectRoot).slice(0, 16));
  const text = await readRegularFile(marker, { followLinks: false }).then(
    (bytes) => bytes.toString('utf-8'),
    () => ''
  );
  const since = io.now().getTime() - Date.parse(text.trim());

  if (Number.isFinite(since) && since >= 0 && since < HOOK_LIMITS.warmIntervalMs) {
    return;
  }

  await mkdir(dirname(marker), { recursive: true });
  // A link at hook-warm/ would carry the marker write to wherever it points.
  if (!(await lstat(dirname(marker))).isDirectory()) {
    throw new Error(`${dirname(marker)} is not a directory; skipped the background warm-up`);
  }
  await writeTextFileSafely(marker, `${io.now().toISOString()}\n`);
  io.spawnWarmStatus(projectRoot);
}

/**
 * Append one line to `<cacheDir>/hook.log`, first moving it to hook.log.1 when
 * full. Never throws. Writes only into a regular file with one link: a
 * symbolic or hard link there would carry the line into some other file, and
 * opening a named pipe would block the hook.
 */
async function appendHookLog(io: HookIo, cacheDir: string, message: string): Promise<void> {
  const path = join(cacheDir, LOG_FILE);
  const line = `${io.now().toISOString()} ${message.replace(/\s*\n\s*/g, ' ')}\n`;

  try {
    await mkdir(cacheDir, { recursive: true });
    const existing = await lstat(path).catch(() => undefined);
    if (existing !== undefined && !existing.isFile()) {
      return;
    }
    if (
      existing !== undefined &&
      existing.size + Buffer.byteLength(line) > HOOK_LIMITS.logMaxBytes
    ) {
      await rename(path, `${path}.1`);
    }
    const handle = await open(
      path,
      constants.O_WRONLY |
        constants.O_APPEND |
        constants.O_CREAT |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0)
    );
    try {
      const opened = await handle.stat();
      if (opened.isFile() && opened.nlink === 1) {
        await handle.write(line);
      }
    } finally {
      await handle.close();
    }
  } catch {
    // The log is the hook's only error channel; with it gone, staying silent is the policy.
  }
}

/**
 * The hook. Resolves by the deadline at the latest and never rejects. Prints
 * nothing when `LLM_DOCS_HOOK=off`, when config sets `hook.enabled: false`,
 * when there is nothing to say, and when anything fails or runs late.
 */
export async function runSessionStartHook(io: HookIo): Promise<void> {
  if (io.env.LLM_DOCS_HOOK === 'off') {
    return;
  }

  const cacheDir = defaultCacheDir({ env: io.env, platform: io.platform, homeDir: io.homeDir });
  const log = (message: string): Promise<void> => appendHookLog(io, cacheDir, message);
  const left = (): number => HOOK_LIMITS.deadlineMs - io.elapsedMs();
  let expired = false;
  let printed = false;

  const run = async (): Promise<void> => {
    let payload = EMPTY_PAYLOAD;
    try {
      const parsed = parseHookPayload(
        await readStdinWithin(
          io.stdin,
          Math.min(HOOK_LIMITS.stdinMs, left() - HOOK_LIMITS.reserveMs)
        )
      );
      payload = parsed.payload;
      if (parsed.problem !== null) {
        await log(parsed.problem);
      }
    } catch (error) {
      if (!(error instanceof StdinProblem)) {
        throw error;
      }
      await log(error.message);
    }

    const harness = detectHarness(io.env);
    const projectDir = io.env.CLAUDE_PROJECT_DIR;
    const start = resolve(
      io.cwd,
      payload.cwd ??
        (isNonEmptyString(projectDir) ? projectDir : undefined) ??
        payload.workspaceRoots[0] ??
        io.cwd
    );
    const projectRoot = (await findProjectRoot(start)) ?? start;
    const loaded = await loadProjectConfigIfPresent(projectRoot).catch(async (error: unknown) => {
      await log(`${errorMessage(error)} (continuing with the dependency analysis only)`);
      return null;
    });

    if (loaded?.config.hook?.enabled === false) {
      return;
    }

    const ignoredCutoffs: string[] = [];
    const skippedSettings: string[] = [];
    const status = await gatherProjectStatus(
      { projectRoot, loaded },
      {
        ignoreInvalidCutoff: (problem) => ignoredCutoffs.push(problem),
        skippedSettingsFile: (problem) => skippedSettings.push(problem),
        offline: false,
        budgetMs: HOOK_LIMITS.networkMs,
        maxLockfileBytes: HOOK_LIMITS.maxLockfileBytes,
        signal: AbortSignal.timeout(Math.max(0, Math.floor(left() - HOOK_LIMITS.reserveMs))),
        ...(payload.model === undefined ? {} : { model: { id: payload.model, source: 'payload' } }),
        ...(io.registryEndpoints === undefined ? {} : { endpoints: io.registryEndpoints }),
        env: io.env,
        homeDir: io.homeDir,
        cacheDir,
        now: io.now(),
      }
    );
    for (const problem of [
      ...ignoredCutoffs.map((problem) => `${problem}; ignored it`),
      ...skippedSettings,
    ]) {
      await log(problem);
    }
    const ignored: string[] = [];
    const text = await sessionBrief(status, harness, (problem) => ignored.push(problem));
    for (const problem of ignored) {
      await log(problem);
    }

    if (expired || left() < 0) {
      expired = true;
      return;
    }
    if (text !== '') {
      io.writeStdout(envelope(harness, text));
      printed = true;
    }
    if (status.pendingReleaseDates > 0) {
      await maybeWarm(io, cacheDir, projectRoot);
    }
  };

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<'deadline'>((settle) => {
    timer = setTimeout(() => settle('deadline'), Math.max(0, left()));
  });

  try {
    const outcome = await Promise.race([run().then(() => 'done' as const), deadline]);
    if (outcome === 'deadline') {
      expired = true;
    }
  } catch (error) {
    await log(`session-start failed: ${errorMessage(error)}`);
  } finally {
    clearTimeout(timer);
  }

  if (expired) {
    await log(
      printed
        ? `session-start missed its ${HOOK_LIMITS.deadlineMs} ms deadline while starting the background warm-up, after it printed its note`
        : `session-start missed its ${HOOK_LIMITS.deadlineMs} ms deadline; printed nothing`
    );
  }
}
