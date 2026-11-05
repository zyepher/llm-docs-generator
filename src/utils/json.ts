import { readFile } from 'node:fs/promises';

import { writeTextFileSafely } from './safe-write.js';

/**
 * Read and JSON-parse a UTF-8 file, returning the parsed value as `unknown`.
 *
 * Centralizes the read-then-parse that callers all performed inline. It
 * deliberately does NOT catch: every caller wraps it in its own try/catch and
 * maps ENOENT (missing file) versus SyntaxError (malformed JSON) to a
 * domain-specific error, so the rejection behavior is identical to the inline
 * `JSON.parse(await readFile(path, 'utf-8'))` it replaces.
 */
export async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf-8'));
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
