import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, rename, rm, stat, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { isFileNotFoundError } from './guards.js';

/** Why a file the tool reads or rewrites by a fixed name is refused. */
export type FileRefusal =
  | { kind: 'not-regular'; found: string }
  | { kind: 'read-only' }
  | { kind: 'hard-linked'; links: number };

/** Callers add what to do next; the message only names the path and the problem. */
export class RefusedFileError extends Error {
  override name = 'RefusedFileError';

  constructor(
    readonly path: string,
    readonly refusal: FileRefusal
  ) {
    super(
      refusal.kind === 'not-regular'
        ? `${path} is ${refusal.found}, not a regular file`
        : refusal.kind === 'read-only'
          ? `${path} is read-only`
          : `${path} has ${refusal.links} hard links`
    );
  }
}

function fileType(stats: Stats): string {
  if (stats.isSymbolicLink()) {
    return 'a symbolic link';
  }
  if (stats.isDirectory()) {
    return 'a directory';
  }
  if (stats.isFIFO()) {
    return 'a named pipe';
  }
  if (stats.isSocket()) {
    return 'a socket';
  }
  return stats.isCharacterDevice() || stats.isBlockDevice() ? 'a device' : 'a special file';
}

/**
 * Read a file only when it is a regular file (see openRegularFile). A missing
 * file rejects with ENOENT, as readFile does.
 */
export async function readRegularFile(
  path: string,
  options: { followLinks: boolean }
): Promise<Buffer> {
  const handle = await openRegularFile(path, options);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/**
 * Open a file for reading only when it is a regular file; the caller closes
 * the handle. Opening a named pipe for reading blocks until something writes
 * to it, so the open is non-blocking and the type is checked on the opened
 * descriptor. With `followLinks: false` a symbolic link is refused too,
 * including one swapped in after the check.
 */
export async function openRegularFile(
  path: string,
  options: { followLinks: boolean }
): Promise<FileHandle> {
  if (!options.followLinks && (await lstat(path)).isSymbolicLink()) {
    throw new RefusedFileError(path, { kind: 'not-regular', found: 'a symbolic link' });
  }

  // Windows has neither flag, and no named pipes in the file system namespace.
  const flags =
    constants.O_RDONLY |
    (constants.O_NONBLOCK ?? 0) |
    (options.followLinks ? 0 : (constants.O_NOFOLLOW ?? 0));
  let handle: FileHandle;

  try {
    handle = await open(path, flags);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      throw error;
    }
    const stats = await (options.followLinks ? stat(path) : lstat(path)).catch(() => undefined);
    if (stats !== undefined && !stats.isFile()) {
      throw new RefusedFileError(path, { kind: 'not-regular', found: fileType(stats) });
    }
    throw error;
  }

  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new RefusedFileError(path, { kind: 'not-regular', found: fileType(stats) });
    }
  } catch (error) {
    await handle.close();
    throw error;
  }
  return handle;
}

/**
 * Replace `path` atomically (temp file, flush, rename) with `content`. The
 * replaced file's permission bits carry over; a new file gets the default.
 * Refuses, writing nothing, when `path` is anything but a regular file, when
 * it is read-only (the user protected it), or when it has other hard links
 * (a rename would leave them holding the old text).
 */
export async function writeTextFileSafely(path: string, content: string): Promise<void> {
  const existing = await assertSafeReplaceTarget(path);

  const dir = dirname(path);
  const tempPath = join(dir, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let tempFileCreated = false;

  try {
    const file = await open(tempPath, 'wx');
    tempFileCreated = true;

    try {
      await file.writeFile(content, 'utf-8');
      if (existing !== undefined) {
        await file.chmod(existing.mode & 0o777);
      }
      await file.sync();
    } finally {
      await file.close();
    }

    await assertSafeReplaceTarget(path);
    await rename(tempPath, path);
    tempFileCreated = false;
  } finally {
    if (tempFileCreated) {
      await rm(tempPath, { force: true });
    }
  }
}

async function assertSafeReplaceTarget(path: string): Promise<Stats | undefined> {
  let stats: Stats;

  try {
    stats = await lstat(path);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return undefined;
    }
    throw error;
  }

  if (!stats.isFile()) {
    throw new RefusedFileError(path, { kind: 'not-regular', found: fileType(stats) });
  }
  if ((stats.mode & 0o222) === 0) {
    throw new RefusedFileError(path, { kind: 'read-only' });
  }
  if (stats.nlink > 1) {
    throw new RefusedFileError(path, { kind: 'hard-linked', links: stats.nlink });
  }
  return stats;
}
