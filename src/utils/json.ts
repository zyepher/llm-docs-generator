import { isRecord } from './guards.js';
import { readRegularFile, writeTextFileSafely } from './safe-write.js';
import { compareStringsByCodeUnit } from './sort.js';

/**
 * Read and JSON-parse a UTF-8 file, returning the parsed value as `unknown`.
 * The file must be a regular file (readRegularFile): a named pipe or device
 * at a fixed name is refused with RefusedFileError instead of blocking the
 * command. Links are followed unless `followLinks` is false.
 *
 * It deliberately does NOT catch: every caller maps ENOENT (missing file),
 * RefusedFileError, and SyntaxError (malformed JSON) to its own error.
 */
export async function readJsonFile(
  path: string,
  options: { followLinks: boolean } = { followLinks: true }
): Promise<unknown> {
  return JSON.parse((await readRegularFile(path, options)).toString('utf-8'));
}

/**
 * Serialize `value` as pretty-printed JSON (trailing newline) and write it
 * atomically via the shared safe-write path (temp + rename, refuses to write
 * through a symlink or non-regular file), so a crash mid-write can never leave a
 * truncated JSON file behind.
 */
export async function writeJsonFileSafely(path: string, value: unknown): Promise<void> {
  await writeTextFileSafely(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Serialize `value` with object keys sorted (by code unit) at every depth, so
 * two structurally equal values always produce the same bytes. Integer-like
 * keys ("2", "10") are the exception: JavaScript objects always enumerate them
 * first in ascending numeric order, so they precede the other keys. The output
 * is still independent of insertion order, and it feeds recorded hashes, so
 * that ordering is part of the on-disk contract. Array order is kept: callers
 * that need sorted arrays sort them before serializing. Keys whose value is
 * `undefined` are dropped, as JSON.stringify does.
 */
export function canonicalJsonStringify(value: unknown, indent?: number): string {
  return JSON.stringify(sortKeysDeep(value), null, indent);
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }

  if (!isRecord(value)) {
    return value;
  }

  // fromEntries defines own properties, so a parsed `__proto__` key stays data.
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareStringsByCodeUnit)
      .map((key) => [key, sortKeysDeep(value[key])])
  );
}
