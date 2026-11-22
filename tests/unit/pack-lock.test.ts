import { renameSync, writeFileSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { canCreateSymlinks } from '../helpers/symlinks.js';

import { ConfigError } from '../../src/config/project.js';
import { LOCK_FILE, SyncLockedError, withPacksLock } from '../../src/pack/lock.js';

const tempDirs: string[] = [];
const DEAD_PID = 999_999;

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function packsDir(): Promise<string> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'llm-docs-lock-'));
  tempDirs.push(dir);
  return dir;
}

function lockText(pid: number, startedAt: string, command: string): string {
  return `${JSON.stringify({ pid, startedAt, command })}\n`;
}

/**
 * Another run that judged the same stale lock finishes its takeover at the
 * moment this run asks whether the stale holder is alive: the lock on disk
 * becomes that run's fresh lock (held by a live pid). `atCall` picks which
 * liveness check of the dead pid triggers the swap.
 */
function competingTakeoverAt(dir: string, atCall: number, fresh: string): void {
  const kill = process.kill.bind(process);
  let calls = 0;
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid === DEAD_PID) {
      calls += 1;
      if (calls === atCall) {
        const draft = join(dir, 'competitor.tmp');
        writeFileSync(draft, fresh);
        renameSync(draft, join(dir, LOCK_FILE));
      }
    }
    return kill(pid, signal);
  });
}

describe('withPacksLock', () => {
  it('holds the lock while working and removes it after', async () => {
    const dir = await packsDir();
    const seen = await withPacksLock(dir, 'llm-docs sync', async () => readdir(dir));

    expect(seen).toEqual([LOCK_FILE]);
    expect(await readdir(dir)).toEqual([]);
  });

  it('never removes a fresh lock another run took after this run judged the old one stale', async () => {
    for (const atCall of [1, 2]) {
      const dir = await packsDir();
      await writeFile(
        join(dir, LOCK_FILE),
        lockText(DEAD_PID, new Date().toISOString(), 'llm-docs sync')
      );
      const fresh = lockText(process.pid, new Date().toISOString(), 'the other sync');
      competingTakeoverAt(dir, atCall, fresh);
      const work = vi.fn(async () => 'worked');

      await expect(withPacksLock(dir, 'llm-docs sync', work)).rejects.toThrow(SyncLockedError);

      expect(work).not.toHaveBeenCalled();
      expect(await readFile(join(dir, LOCK_FILE), 'utf-8')).toBe(fresh);
      expect(await readdir(dir)).toEqual([LOCK_FILE]);
      vi.restoreAllMocks();
    }
  });

  it('never lets two concurrent runs hold the lock taken over from a stale one', async () => {
    for (let round = 0; round < 10; round += 1) {
      const dir = await packsDir();
      await writeFile(join(dir, LOCK_FILE), lockText(DEAD_PID, new Date().toISOString(), 'x'));
      let holders = 0;
      let overlapped = false;
      const work = async (): Promise<void> => {
        holders += 1;
        overlapped ||= holders > 1;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
        holders -= 1;
      };

      await Promise.allSettled([withPacksLock(dir, 'a', work), withPacksLock(dir, 'b', work)]);

      expect(overlapped).toBe(false);
      expect(await readdir(dir)).toEqual([]);
    }
  });

  it('judges a start time in the future by its distance from now', async () => {
    const dir = await packsDir();
    await writeFile(
      join(dir, LOCK_FILE),
      lockText(process.pid, '2099-01-01T00:00:00.000Z', 'llm-docs sync')
    );

    expect(await withPacksLock(dir, 'llm-docs sync', async () => 'ran')).toBe('ran');
    expect(await readdir(dir)).toEqual([]);
  });

  it('keeps a live lock that started a minute from now, and a fresh unreadable one', async () => {
    const dir = await packsDir();
    const soon = new Date(Date.now() + 60_000).toISOString();
    await writeFile(join(dir, LOCK_FILE), lockText(process.pid, soon, 'llm-docs sync'));
    await expect(withPacksLock(dir, 'x', async () => 'ran')).rejects.toThrow(
      /Another llm-docs run holds .*'llm-docs sync'/
    );

    await writeFile(join(dir, LOCK_FILE), '');
    await expect(withPacksLock(dir, 'x', async () => 'ran')).rejects.toThrow(
      /holds .*: an unknown process\./
    );
  });

  it('takes over an empty lock once it is more than 5 seconds old', async () => {
    const dir = await packsDir();
    await writeFile(join(dir, LOCK_FILE), '');
    const old = new Date(Date.now() - 10_000);
    await utimes(join(dir, LOCK_FILE), old, old);

    expect(await withPacksLock(dir, 'llm-docs sync', async () => 'ran')).toBe('ran');
  });

  it('refuses a lock path that is a directory or a symbolic link, deleting nothing', async () => {
    const dir = await packsDir();
    await mkdir(join(dir, LOCK_FILE));
    await writeFile(join(dir, LOCK_FILE, 'keep.txt'), 'kept');
    const old = new Date(Date.now() - 10_000);
    await utimes(join(dir, LOCK_FILE), old, old);

    await expect(withPacksLock(dir, 'x', async () => 'ran')).rejects.toThrow(
      new ConfigError(
        `${join(dir, LOCK_FILE)} is a directory, not a regular file. llm-docs keeps its lock at that path and only uses a file it created itself; remove ${join(dir, LOCK_FILE)} and run the command again.`
      )
    );
    expect(await readFile(join(dir, LOCK_FILE, 'keep.txt'), 'utf-8')).toBe('kept');

    if (canCreateSymlinks) {
      const other = await packsDir();
      const outside = join(other, 'outside.json');
      await writeFile(outside, lockText(DEAD_PID, '2000-01-01T00:00:00.000Z', 'x'));
      await symlink(outside, join(other, LOCK_FILE));

      await expect(withPacksLock(other, 'x', async () => 'ran')).rejects.toThrow(
        /\.llm-docs\.lock is a symbolic link, not a regular file/
      );
      expect((await readdir(other)).sort()).toEqual([LOCK_FILE, 'outside.json']);
    }
  });
});
