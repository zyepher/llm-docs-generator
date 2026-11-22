import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  errorMessage,
  isFileNotFoundError,
  isNonEmptyString,
  isRecord,
} from '../../src/utils/guards.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'llm-docs-guards-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function readError(path: string): Promise<unknown> {
  return readFile(path).then(
    () => undefined,
    (error: unknown) => error
  );
}

describe('isRecord', () => {
  it('accepts plain and prototype-less objects', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
    expect(isRecord(JSON.parse('{"__proto__":1}'))).toBe(true);
  });

  it('rejects arrays, null, and primitives', () => {
    for (const value of [[], [1], null, undefined, 'a', 1, true, Symbol('s')]) {
      expect(isRecord(value)).toBe(false);
    }
  });
});

describe('isNonEmptyString', () => {
  it('accepts any string with at least one character, whitespace included', () => {
    expect(isNonEmptyString('a')).toBe(true);
    expect(isNonEmptyString(' ')).toBe(true);
  });

  it('rejects the empty string and non-strings', () => {
    for (const value of ['', null, undefined, 0, ['a'], { length: 1 }]) {
      expect(isNonEmptyString(value)).toBe(false);
    }
  });
});

describe('errorMessage', () => {
  it('returns the message of an Error or a subclass', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage(new TypeError('bad type'))).toBe('bad type');
  });

  it('stringifies anything else that was thrown', () => {
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage(42)).toBe('42');
    expect(errorMessage(undefined)).toBe('undefined');
    expect(errorMessage(null)).toBe('null');
  });
});

describe('isFileNotFoundError', () => {
  it('recognizes a missing path and a path through a file as not found', async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, 'file'), 'x');

    expect(isFileNotFoundError(await readError(join(dir, 'missing')))).toBe(true);
    expect(isFileNotFoundError(await readError(join(dir, 'file', 'child')))).toBe(true);
  });

  it('does not treat other failures or non-errors as not found', async () => {
    const dir = await makeTempDir();

    expect(isFileNotFoundError(await readError(dir))).toBe(false);
    expect(isFileNotFoundError(new Error('ENOENT'))).toBe(false);
    expect(isFileNotFoundError({ code: 'ENOENT' })).toBe(false);
    expect(isFileNotFoundError(undefined)).toBe(false);
  });
});
