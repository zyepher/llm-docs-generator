import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { isFileNotFoundError } from '../../src/utils/guards.js';
import { canonicalJsonStringify, readJsonFile, writeJsonFileSafely } from '../../src/utils/json.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'llm-docs-json-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('canonicalJsonStringify', () => {
  it('sorts object keys by UTF-16 code unit at every depth and keeps array order', () => {
    const value = {
      zeta: [{ b: 1, a: 2 }, 'z', 'a'],
      é: 1,
      a: { y: true, B: null, x: 'x' },
      B: 0,
    };

    expect(canonicalJsonStringify(value)).toBe(
      '{"B":0,"a":{"B":null,"x":"x","y":true},"zeta":[{"a":2,"b":1},"z","a"],"é":1}'
    );
  });

  it('gives the same bytes for structurally equal values built in any key order', () => {
    const first = { name: 'demo', sources: [{ type: 'local', path: 'docs' }], limits: { max: 1 } };
    const second = { limits: { max: 1 }, sources: [{ path: 'docs', type: 'local' }], name: 'demo' };

    expect(canonicalJsonStringify(first)).toBe(canonicalJsonStringify(second));
    expect(canonicalJsonStringify(first, 2)).toBe(canonicalJsonStringify(second, 2));
  });

  it('orders integer-like keys numerically first, whatever the insertion order', () => {
    // These bytes feed recorded hashes (recipeHash, manifest.json), so they are pinned exactly.
    expect(canonicalJsonStringify({ b: 1, '10': 2, a: 3, '2': 4 })).toBe(
      '{"2":4,"10":2,"a":3,"b":1}'
    );
    expect(canonicalJsonStringify({ '2': 4, a: 3, '10': 2, b: 1 })).toBe(
      '{"2":4,"10":2,"a":3,"b":1}'
    );
  });

  it('drops undefined-valued keys and indents when asked', () => {
    expect(canonicalJsonStringify({ b: undefined, a: [1] }, 2)).toBe('{\n  "a": [\n    1\n  ]\n}');
  });

  it('keeps a parsed __proto__ key as data', () => {
    const parsed: unknown = JSON.parse('{"z":1,"__proto__":{"polluted":true}}');

    expect(canonicalJsonStringify(parsed)).toBe('{"__proto__":{"polluted":true},"z":1}');
    expect(Object.prototype).not.toHaveProperty('polluted');
  });
});

describe('readJsonFile', () => {
  it('parses a JSON file', async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, 'a.json'), '{"a":[1,"two",null]}');

    expect(await readJsonFile(join(dir, 'a.json'))).toEqual({ a: [1, 'two', null] });
  });

  it('rejects a missing file with a not-found filesystem error', async () => {
    const dir = await makeTempDir();
    const error: unknown = await readJsonFile(join(dir, 'missing.json')).catch(
      (caught: unknown) => caught
    );

    expect(isFileNotFoundError(error)).toBe(true);
  });

  it('rejects malformed JSON with a SyntaxError', async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, 'bad.json'), '{"a": 1,}');

    await expect(readJsonFile(join(dir, 'bad.json'))).rejects.toBeInstanceOf(SyntaxError);
  });
});

describe('writeJsonFileSafely', () => {
  it('writes two-space JSON with a trailing newline that reads back equal', async () => {
    const dir = await makeTempDir();
    const path = join(dir, 'out.json');
    const value = { b: [1, 2], a: { nested: 'é' } };

    await writeJsonFileSafely(path, value);

    expect(await readFile(path, 'utf-8')).toBe(
      '{\n  "b": [\n    1,\n    2\n  ],\n  "a": {\n    "nested": "é"\n  }\n}\n'
    );
    expect(await readJsonFile(path)).toEqual(value);
    expect(await readdir(dir)).toEqual(['out.json']);
  });

  it('overwrites an existing file', async () => {
    const dir = await makeTempDir();
    const path = join(dir, 'out.json');
    await writeFile(path, '{"old": "a long previous value that must not survive"}\n');

    await writeJsonFileSafely(path, { new: 1 });

    expect(await readFile(path, 'utf-8')).toBe('{\n  "new": 1\n}\n');
  });
});
