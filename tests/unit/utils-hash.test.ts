import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { isFileNotFoundError } from '../../src/utils/guards.js';
import { sha256File, sha256Hex, sha256Prefixed } from '../../src/utils/hash.js';

// Reference digests computed independently with `shasum -a 256`.
const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const BYTE_FF = 'a8100ae6aa1940d0b663bb31cd466142ebbdbd5187131b92d93818987832eb89';
const E_ACUTE_UTF8 = '4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c';
const E_ACUTE_LATIN1 = 'de2e331d891ae267a7009cb45b4e8830f170e0c937288ea2731a1941c7a53b0d';
const MILLION_A = 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'llm-docs-hash-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('sha256Hex', () => {
  it('matches the reference digests', () => {
    expect(sha256Hex('')).toBe(EMPTY);
    expect(sha256Hex('abc')).toBe(ABC);
    expect(sha256Hex(Buffer.from('abc'))).toBe(ABC);
  });

  it('hashes strings as UTF-8 and buffers verbatim', () => {
    expect(sha256Hex('é')).toBe(E_ACUTE_UTF8);
    expect(sha256Hex(Buffer.from([0xe9]))).toBe(E_ACUTE_LATIN1);
    expect(sha256Hex(Buffer.from([0xff]))).toBe(BYTE_FF);
  });
});

describe('sha256Prefixed', () => {
  it('prefixes the hex digest with sha256:', () => {
    expect(sha256Prefixed('abc')).toBe(`sha256:${ABC}`);
    expect(sha256Prefixed(Buffer.from([0xff]))).toBe(`sha256:${BYTE_FF}`);
  });
});

describe('sha256File', () => {
  it('hashes the file bytes exactly as the in-memory helper hashes them', async () => {
    const dir = await makeTempDir();
    const bytes = Buffer.from([0x00, 0xff, 0xe9, 0x0a, 0x0d, 0x0a]);
    await writeFile(join(dir, 'empty'), '');
    await writeFile(join(dir, 'bytes'), bytes);

    expect(await sha256File(join(dir, 'empty'))).toBe(`sha256:${EMPTY}`);
    expect(await sha256File(join(dir, 'bytes'))).toBe(sha256Prefixed(bytes));
  });

  it('streams a file larger than one read chunk', async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, 'big'), 'a'.repeat(1_000_000));

    expect(await sha256File(join(dir, 'big'))).toBe(`sha256:${MILLION_A}`);
  });

  it('rejects a missing file with a not-found filesystem error', async () => {
    const dir = await makeTempDir();
    const error: unknown = await sha256File(join(dir, 'missing')).catch(
      (caught: unknown) => caught
    );

    expect(isFileNotFoundError(error)).toBe(true);
  });
});
