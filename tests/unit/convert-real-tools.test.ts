/**
 * OPTIONAL integration test against the real converters. Each case runs only
 * when that tool is on PATH (`pipx install docling`, `pipx install
 * 'markitdown[all]'`) and is skipped otherwise, so CI without them stays
 * green. It converts a small HTML document, which neither tool needs models
 * or optional extras for.
 */

import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { syncPacks } from '../../src/pack/build.js';
import { readPackManifest } from '../../src/pack/manifest.js';
import { verifyPacks } from '../../src/pack/verify.js';
import { ALLOW_TEMP_SOURCES_ENV } from '../../src/sources/acquire.js';

async function existsOnPath(name: string): Promise<boolean> {
  const names =
    process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`] : [name];
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter((entry) => entry !== '')) {
    for (const candidate of names) {
      try {
        await access(join(dir, candidate));
        return true;
      } catch {
        // Not in this directory.
      }
    }
  }
  return false;
}

const available = {
  docling: await existsOnPath('docling'),
  markitdown: await existsOnPath('markitdown'),
};
const tempDirs: string[] = [];
const savedEnv = {
  allow: process.env[ALLOW_TEMP_SOURCES_ENV],
  cache: process.env.LLM_DOCS_CACHE_DIR,
};

afterEach(async () => {
  for (const [key, value] of [
    [ALLOW_TEMP_SOURCES_ENV, savedEnv.allow],
    ['LLM_DOCS_CACHE_DIR', savedEnv.cache],
  ] as const) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('real converters (optional, skipped unless the tool is on PATH)', () => {
  for (const tool of ['markitdown', 'docling'] as const) {
    it.skipIf(!available[tool])(
      `converts an HTML document with the installed ${tool}`,
      async () => {
        const root = await mkdtemp(join(await realpath(tmpdir()), `llm-docs-real-${tool}-`));
        tempDirs.push(root);
        process.env[ALLOW_TEMP_SOURCES_ENV] = '1';
        process.env.LLM_DOCS_CACHE_DIR = join(root, '.cache');
        await mkdir(join(root, 'docs'));
        await writeFile(
          join(root, 'docs', 'guide.html'),
          '<!doctype html><html><head><title>Guide</title></head><body><h1>Real Tool Heading</h1><p>Hold the reset button for five seconds.</p></body></html>\n'
        );
        await writeFile(
          join(root, 'llm-docs.json'),
          JSON.stringify({
            schemaVersion: 3,
            packs: {
              guide: {
                version: '1.0.0',
                sources: [{ type: 'local', path: 'docs', convert: { tool, timeoutSeconds: 600 } }],
              },
            },
          })
        );

        const report = await syncPacks(root, undefined);
        expect(report.packs[0], report.packs[0]?.error).toMatchObject({ status: 'built' });

        const text = await readFile(
          join(root, 'agent-docs', 'guide', 'pages', 'guide.md'),
          'utf-8'
        );
        expect(text).toContain('Real Tool Heading');
        expect(text).toContain('Hold the reset button for five seconds.');

        const manifest = await readPackManifest(join(root, 'agent-docs', 'guide'));
        expect(manifest.sources[0]?.converter).toMatchObject({ tool });
        expect(manifest.sources[0]?.converter?.version).toEqual(expect.any(String));
        expect((await verifyPacks(root, undefined)).ok).toBe(true);
      },
      900_000
    );
  }
});
