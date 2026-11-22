/**
 * The packs-directory advisory lock (spec 2.6). Every process that writes
 * inside `packsDir` holds it for the whole write, so two writers never move
 * or delete files under each other.
 */

import { randomBytes } from 'node:crypto';
import { lstat, open, rename, rm, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

import { ConfigError } from '../config/project.js';
import { isFileNotFoundError, isRecord } from '../utils/guards.js';
import { readRegularFile, RefusedFileError } from '../utils/safe-write.js';

export const LOCK_FILE = '.llm-docs.lock';
const LOCK_STALE_MS = 60 * 60 * 1000;
/** A lock this young may still be mid-write, so unreadable is not yet stale. */
const UNREADABLE_GRACE_MS = 5_000;

/** Another llm-docs run holds the packs directory lock: a runtime failure (exit 3). */
export class SyncLockedError extends Error {
  override name = 'SyncLockedError';
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined;
}

/** The lock as found on disk, judged; undefined when no lock is there. */
interface HeldLock {
  bytes: Buffer;
  stale: boolean;
  holder: string;
}

/**
 * Read and judge the lock at `path`. Only a regular file can be a lock this
 * tool wrote; anything else (a link, a directory, a named pipe) is a config
 * error, never read through or deleted.
 */
async function inspectLock(path: string): Promise<HeldLock | undefined> {
  let bytes: Buffer;

  try {
    bytes = await readRegularFile(path, { followLinks: false });
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return undefined;
    }
    if (error instanceof RefusedFileError) {
      throw new ConfigError(
        `${error.message}. llm-docs keeps its lock at that path and only uses a file it created itself; remove ${path} and run the command again.`
      );
    }
    throw error;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf-8'));
  } catch {
    // Unreadable or half-written: stale once it is old enough not to be mid-write.
    const age = Date.now() - (await lstat(path)).mtimeMs;
    return { bytes, stale: age > UNREADABLE_GRACE_MS, holder: 'an unknown process' };
  }

  const pid = isRecord(raw) && typeof raw.pid === 'number' ? raw.pid : undefined;
  const startedAt = isRecord(raw) && typeof raw.startedAt === 'string' ? raw.startedAt : '';
  const command = isRecord(raw) && typeof raw.command === 'string' ? raw.command : 'llm-docs';
  const started = Date.parse(startedAt);
  // A start time in the future is judged by its distance from now too, so a clock
  // jump or a forged timestamp cannot hold the lock until that date.
  const stale =
    pid === undefined ||
    !isProcessAlive(pid) ||
    Number.isNaN(started) ||
    Math.abs(Date.now() - started) > LOCK_STALE_MS;

  return {
    bytes,
    stale,
    holder: `'${command}' (pid ${pid ?? '?'}, started ${startedAt || 'unknown'})`,
  };
}

/**
 * Remove the stale lock `judged` so this run can create its own. Two runs
 * can judge the same lock stale; each claims it by renaming it to a name only
 * it uses, and keeps going only when what it moved is still that stale lock.
 * Anything else (a fresh lock another run created after the judgement) is
 * put back untouched, so at most one run ever removes a given lock.
 */
async function takeOverStaleLock(path: string, judged: Buffer, attempt: string): Promise<void> {
  const current = await inspectLock(path);
  if (current === undefined || !current.stale || !current.bytes.equals(judged)) {
    return;
  }

  const claimed = `${path}.${attempt}.stale`;
  try {
    await rename(path, claimed);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return;
    }
    throw error;
  }

  const moved = await inspectLock(claimed).catch(() => undefined);
  if (moved?.stale === true && moved.bytes.equals(judged)) {
    await rm(claimed, { force: true });
    return;
  }
  await rename(claimed, path);
}

/** Take the advisory lock with exclusive create; a stale lock is replaced once. */
async function acquireLock(packsDir: string, command: string): Promise<() => Promise<void>> {
  const path = join(packsDir, LOCK_FILE);
  const attempt = randomBytes(8).toString('hex');
  // The token makes this run's lock bytes unique, so "is the lock on disk mine" is a byte compare.
  const text = `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), command, token: attempt })}\n`;

  for (let round = 0; round < 2; round += 1) {
    let handle: FileHandle;
    try {
      handle = await open(path, 'wx');
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') {
        throw error;
      }

      const held = await inspectLock(path);
      if (held === undefined) {
        continue;
      }
      if (!held.stale) {
        throw new SyncLockedError(
          `Another llm-docs run holds ${path}: ${held.holder}. Wait for it to finish, or delete the lock file if that process is gone.`
        );
      }
      await takeOverStaleLock(path, held.bytes, attempt);
      continue;
    }

    try {
      await handle.writeFile(text);
    } finally {
      await handle.close();
    }

    const onDisk = await readRegularFile(path, { followLinks: false }).catch(() => undefined);
    if (onDisk?.toString('utf-8') !== text) {
      throw new SyncLockedError(
        `Another llm-docs run replaced ${path} while this run was taking it. Run the command again once that run finishes.`
      );
    }

    return async () => {
      const current = await readRegularFile(path, { followLinks: false }).catch(() => undefined);
      if (current?.toString('utf-8') === text) {
        await rm(path, { force: true });
      }
    };
  }

  throw new SyncLockedError(
    `Could not take the lock ${path}: another llm-docs run kept taking it. Run the command again once it finishes, or delete the lock file if no llm-docs process is running.`
  );
}

/**
 * Run `work` holding `<packsDir>/.llm-docs.lock`, released even when `work`
 * throws. A held lock fails fast with SyncLockedError instead of waiting.
 */
export async function withPacksLock<T>(
  packsDir: string,
  command: string,
  work: () => Promise<T>
): Promise<T> {
  const release = await acquireLock(packsDir, command);

  try {
    return await work();
  } finally {
    await release();
  }
}
