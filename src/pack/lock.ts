/**
 * The packs-directory advisory lock (spec 2.6). Every process that writes
 * inside `packsDir` holds it for the whole write, so two writers never move
 * or delete files under each other.
 */

import { open, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { isRecord } from '../utils/guards.js';
import { readJsonFile } from '../utils/json.js';

export const LOCK_FILE = '.llm-docs.lock';
const LOCK_STALE_MS = 60 * 60 * 1000;

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

async function lockIsStale(path: string): Promise<{ stale: boolean; holder: string }> {
  let raw: unknown;

  try {
    raw = await readJsonFile(path);
  } catch {
    // Unreadable or half-written: stale once it is old enough not to be mid-write.
    const age = Date.now() - (await stat(path)).mtimeMs;
    return { stale: age > 5_000, holder: 'an unknown process' };
  }

  const pid = isRecord(raw) && typeof raw.pid === 'number' ? raw.pid : undefined;
  const startedAt = isRecord(raw) && typeof raw.startedAt === 'string' ? raw.startedAt : '';
  const command = isRecord(raw) && typeof raw.command === 'string' ? raw.command : 'llm-docs';
  const started = Date.parse(startedAt);
  const stale =
    pid === undefined ||
    !isProcessAlive(pid) ||
    Number.isNaN(started) ||
    Date.now() - started > LOCK_STALE_MS;

  return { stale, holder: `'${command}' (pid ${pid ?? '?'}, started ${startedAt || 'unknown'})` };
}

/** Take the advisory lock with exclusive create; a stale lock is replaced once. */
async function acquireLock(packsDir: string, command: string): Promise<() => Promise<void>> {
  const path = join(packsDir, LOCK_FILE);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, 'wx');
      try {
        await handle.writeFile(
          `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), command })}\n`
        );
      } finally {
        await handle.close();
      }
      return () => rm(path, { force: true });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
        throw error;
      }

      const { stale, holder } = await lockIsStale(path);

      if (!stale || attempt > 0) {
        throw new SyncLockedError(
          `Another llm-docs run holds ${join(packsDir, LOCK_FILE)}: ${holder}. Wait for it to finish, or delete the lock file if that process is gone.`
        );
      }

      await rm(path, { force: true });
    }
  }

  throw new SyncLockedError(`Could not take the lock in ${packsDir}.`);
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
