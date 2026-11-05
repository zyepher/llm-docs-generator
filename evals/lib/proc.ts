import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';

/**
 * Child process handling for the eval runner. Every child runs in its own process group so a
 * timeout or Ctrl-C can kill the whole tree (claude spawns tool subprocesses, vitest spawns
 * workers). Live groups are tracked so the SIGINT handler never leaves orphans behind.
 */

const liveGroups = new Set<number>();
let shuttingDown = false;

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group already exited.
  }
}

export function installSignalHandlers(): void {
  const onSignal = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    process.stderr.write(
      `\n[evals] ${signal}: stopping ${liveGroups.size} child process group(s)\n`
    );
    for (const pid of liveGroups) {
      killGroup(pid, 'SIGTERM');
    }
    setTimeout(() => {
      for (const pid of liveGroups) {
        killGroup(pid, 'SIGKILL');
      }
      process.exit(130);
    }, 3000).unref();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}

export interface RunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** When set, stdout is streamed to this file instead of being buffered. */
  stdoutFile?: string;
  /** Bytes of combined output kept in memory (the tail is kept). */
  keepBytes?: number;
}

export interface RunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  /** Tail of stdout (empty when streamed to a file). */
  stdout: string;
  /** Tail of stderr. */
  stderr: string;
  spawnError: string | null;
}

class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.limit && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      this.size -= dropped?.length ?? 0;
    }
  }

  text(): string {
    const all = Buffer.concat(this.chunks);
    return all.subarray(Math.max(0, all.length - this.limit)).toString('utf8');
  }
}

/**
 * Run `command` without a shell, stdin from /dev/null, in a new process group. On timeout the
 * group gets SIGTERM, then SIGKILL after 10 seconds.
 */
export function runProcess(
  command: string,
  args: string[],
  options: RunOptions
): Promise<RunResult> {
  const keep = options.keepBytes ?? 64 * 1024;
  const stdoutTail = new TailBuffer(keep);
  const stderrTail = new TailBuffer(keep);
  const started = Date.now();

  return new Promise((resolve) => {
    if (shuttingDown) {
      resolve({
        exitCode: null,
        signal: null,
        timedOut: false,
        durationMs: 0,
        stdout: '',
        stderr: '',
        spawnError: 'runner is shutting down',
      });
      return;
    }

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const pid = child.pid;
    if (pid !== undefined) {
      liveGroups.add(pid);
    }

    const fileStream =
      options.stdoutFile === undefined
        ? null
        : createWriteStream(options.stdoutFile, { flags: 'w' });
    child.stdout.on('data', (chunk: Buffer) => {
      if (fileStream) {
        fileStream.write(chunk);
      } else {
        stdoutTail.push(chunk);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => stderrTail.push(chunk));

    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      if (pid !== undefined) {
        killGroup(pid, 'SIGTERM');
        killTimer = setTimeout(() => killGroup(pid, 'SIGKILL'), 10_000);
      }
    }, options.timeoutMs);

    let settled = false;
    const settle = (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
      spawnError: string | null
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      if (pid !== undefined) {
        // Reap anything the child left behind in its group (tool subprocesses, workers).
        killGroup(pid, 'SIGKILL');
        liveGroups.delete(pid);
      }
      const finish = (): void =>
        resolve({
          exitCode,
          signal,
          timedOut,
          durationMs: Date.now() - started,
          stdout: stdoutTail.text(),
          stderr: stderrTail.text(),
          spawnError,
        });
      if (fileStream) {
        fileStream.end(finish);
      } else {
        finish();
      }
    };

    child.on('error', (error) => settle(null, null, error.message));
    child.on('close', (exitCode, signal) => settle(exitCode, signal, null));
  });
}
