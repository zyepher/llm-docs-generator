import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { canCreateSymlinks } from '../helpers/symlinks.js';

import { projectConfigJsonSchemaText, recipeHash } from '../../src/config/project.js';
import {
  licenseStatusFor,
  ManifestError,
  manifestJsonSchemaText,
  readPackManifest,
  serializePackManifest,
  writePackManifest,
  type PackManifest,
} from '../../src/pack/manifest.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const hash = (char: string): string => `sha256:${char.repeat(64)}`;
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'llm-docs-manifest-'));
  tempDirs.push(dir);
  return dir;
}

function sampleManifest(): PackManifest {
  const recipe: PackManifest['recipe'] = {
    title: 'Vite',
    description: null,
    dependency: { ecosystem: 'npm', name: 'vite' },
    version: '8.2.0',
    sources: [
      {
        type: 'git',
        repo: 'https://github.com/vitejs/vite',
        ref: 'v8.2.0',
        paths: ['docs'],
        mount: '',
        include: ['**/*.md'],
        exclude: [],
        passthrough: ['b/**', 'a/**'],
        convert: null,
        transforms: ['strip-html-comments'],
      },
      {
        type: 'local',
        path: 'manuals',
        mount: 'manuals',
        include: ['**/*.md'],
        exclude: [],
        passthrough: [],
        convert: null,
        transforms: [],
      },
    ],
    site: null,
    layout: { combined: false },
    license: null,
    limits: { maxFileBytes: 1024 },
  };
  return {
    schemaVersion: 3,
    tool: { name: 'llm-docs', version: '3.0.0' },
    pack: { id: 'vite', title: 'Vite', version: '8.2.0' },
    dependency: { ecosystem: 'npm', name: 'vite' },
    recipe,
    recipeHash: recipeHash(recipe),
    acquiredAt: '2026-11-05T10:00:00.000Z',
    origins: [
      {
        type: 'git',
        repo: 'https://github.com/vitejs/vite',
        ref: 'v8.2.0',
        commit: '0'.repeat(40),
        refKind: 'tag',
      },
      { type: 'local', path: 'manuals', hostCommit: null, hostDirty: null },
    ],
    license: {
      declared: null,
      detected: { spdx: 'MIT', evidence: 'LICENSE' },
      status: 'permissive',
    },
    sources: [
      { source: 1, path: 'z.md', sha256: hash('b'), bytes: 3 },
      {
        source: 0,
        path: 'guide/index.md',
        url: 'https://github.com/vitejs/vite/blob/x/docs/guide/index.md',
        sha256: hash('c'),
        bytes: 10,
        fetch: { finalUrl: 'https://x', status: 200, etag: '"e"' },
        converter: { tool: 'markitdown', version: '0.1.2', outputSha256: hash('d') },
      },
      { source: 0, path: 'api.md', sha256: hash('e'), bytes: 4 },
    ],
    outputs: [
      {
        path: 'pages/z.md',
        kind: 'page',
        sha256: hash('f'),
        bytes: 1,
        tokens: 1,
        title: 'Z',
        sources: ['1:z.md', '0:a.md'],
      },
      { path: 'index.md', kind: 'index', sha256: hash('1'), bytes: 1, tokens: 1 },
      { path: 'files/schema.ts', kind: 'passthrough', sha256: hash('2'), bytes: 1 },
    ],
    links: {
      rewritten: 2,
      external: 1,
      unresolved: [
        { page: 'pages/z.md', target: 'b', reason: 'not-in-pack' },
        { page: 'pages/a.md', target: 'a', reason: 'not-in-pack' },
      ],
    },
    transforms: [
      { name: 'strip-html-comments', pages: 2 },
      { name: 'drop-frontmatter-description', pages: 0 },
    ],
    warnings: ['b warning', 'a warning', 'b warning'],
  };
}

describe('committed JSON Schemas', () => {
  it('match the zod schemas (run `npm run schema` after changing them)', async () => {
    expect(await readFile(join(repoRoot, 'schema', 'llm-docs.schema.json'), 'utf-8')).toBe(
      projectConfigJsonSchemaText()
    );
    expect(await readFile(join(repoRoot, 'schema', 'manifest.schema.json'), 'utf-8')).toBe(
      manifestJsonSchemaText()
    );
  });
});

describe('manifest v3', () => {
  it('round-trips through write and read', async () => {
    const dir = await makeTempDir();
    const manifest = sampleManifest();
    await writePackManifest(dir, manifest);
    const read = await readPackManifest(dir);

    expect(read.origins).toEqual(manifest.origins);
    expect(read.recipe).toEqual(manifest.recipe);
    expect(serializePackManifest(read)).toBe(serializePackManifest(manifest));
  });

  it('writes canonically: sorted keys and arrays, deduplicated warnings, one trailing newline', async () => {
    const dir = await makeTempDir();
    await writePackManifest(dir, sampleManifest());
    const text = await readFile(join(dir, 'manifest.json'), 'utf-8');
    const parsed = JSON.parse(text);

    expect(text.endsWith('}\n')).toBe(true);
    expect(text).not.toContain('\r');
    expect(Object.keys(parsed)).toEqual([...Object.keys(parsed)].sort());
    expect(
      parsed.sources.map(
        (entry: { source: number; path: string }) => `${entry.source}:${entry.path}`
      )
    ).toEqual(['0:api.md', '0:guide/index.md', '1:z.md']);
    expect(parsed.outputs.map((entry: { path: string }) => entry.path)).toEqual([
      'files/schema.ts',
      'index.md',
      'pages/z.md',
    ]);
    expect(parsed.outputs[2].sources).toEqual(['0:a.md', '1:z.md']);
    expect(parsed.links.unresolved.map((entry: { page: string }) => entry.page)).toEqual([
      'pages/a.md',
      'pages/z.md',
    ]);
    expect(parsed.transforms.map((entry: { name: string }) => entry.name)).toEqual([
      'drop-frontmatter-description',
      'strip-html-comments',
    ]);
    expect(parsed.warnings).toEqual(['a warning', 'b warning']);
    // Origins and recipe sources keep their order: both are indexed by source.
    expect(parsed.origins.map((origin: { type: string }) => origin.type)).toEqual(['git', 'local']);
    expect(parsed.recipe.sources[0].passthrough).toEqual(['b/**', 'a/**']);
  });

  it('serializes key-order variants identically', () => {
    const manifest = sampleManifest();
    const reordered = JSON.parse(JSON.stringify(manifest, Object.keys(manifest).reverse()));
    expect(serializePackManifest({ ...reordered, ...manifest })).toBe(
      serializePackManifest(manifest)
    );
  });

  it('points a v2 manifest at migrate and rejects invalid ones', async () => {
    const dir = await makeTempDir();
    await writeFile(
      join(dir, 'manifest.json'),
      JSON.stringify({ schemaVersion: '0.1.0', mode: 'local-source-docs' })
    );
    await expect(readPackManifest(dir)).rejects.toThrow(/llm-docs migrate/);

    await writeFile(
      join(dir, 'manifest.json'),
      JSON.stringify({ ...sampleManifest(), recipeHash: 'md5:x' })
    );
    await expect(readPackManifest(dir)).rejects.toThrow(/recipeHash/);

    await writeFile(join(dir, 'manifest.json'), '{ broken');
    await expect(readPackManifest(dir)).rejects.toThrow(/not valid JSON/);

    await rm(join(dir, 'manifest.json'));
    await expect(readPackManifest(dir)).rejects.toMatchObject({ reason: 'missing' });
    await expect(readPackManifest(dir)).rejects.toBeInstanceOf(ManifestError);
  });

  it('refuses a manifest that disagrees with its own recipe', async () => {
    const dir = await makeTempDir();
    const sample = sampleManifest();
    const cases: [Record<string, unknown>, RegExp][] = [
      [
        { pack: { ...sample.pack, version: '9.9.9' } },
        /at pack\.version: differs from recipe\.version/,
      ],
      [{ pack: { ...sample.pack, title: 'Forged' } }, /at pack\.title: differs from recipe\.title/],
      [{ dependency: { ecosystem: 'npm', name: 'other' } }, /at dependency: differs/],
      [
        {
          recipe: { ...sample.recipe, version: '9.9.9' },
          pack: { ...sample.pack, version: '9.9.9' },
        },
        /at recipeHash: is not the hash of "recipe"/,
      ],
      [{ origins: [sample.origins[1], sample.origins[0]] }, /at origins\.0\.type: differs/],
    ];

    for (const [change, message] of cases) {
      await writeFile(join(dir, 'manifest.json'), JSON.stringify({ ...sample, ...change }));
      await expect(readPackManifest(dir)).rejects.toThrow(message);
    }
  });

  it('refuses any recorded path that could leave the pack, the origin, or the project', async () => {
    const dir = await makeTempDir();
    const sample = sampleManifest();
    const output = (path: string, kind = 'page'): Record<string, unknown> => ({
      outputs: [{ path, kind, sha256: hash('f'), bytes: 1 }],
    });
    const cases: Record<string, unknown>[] = [
      output('../../../secret.txt', 'passthrough'),
      output('/etc/passwd', 'passthrough'),
      output('pages/../../x.md'),
      output('pages//x.md'),
      output('pages/./x.md'),
      output('pages\\x.md'),
      output('pages/x\u0000.md'),
      output('files/x.md'),
      output('pages/x.md', 'passthrough'),
      output('pages/index.md', 'index'),
      output('other.full.md', 'combined'),
      { sources: [{ source: 0, path: '../outside.md', sha256: hash('b'), bytes: 1 }] },
      { sources: [{ source: 5, path: 'x.md', sha256: hash('b'), bytes: 1 }] },
      {
        outputs: [
          { path: 'pages/z.md', kind: 'page', sha256: hash('f'), bytes: 1, sources: ['0:../x.md'] },
        ],
      },
      { links: { ...sample.links, unresolved: [{ page: '../x.md', target: 'a', reason: 'r' }] } },
      { origins: [sample.origins[0], { ...sample.origins[1], path: '../elsewhere' }] },
      { pack: { ...sample.pack, id: '../vite' } },
    ];

    for (const change of cases) {
      await writeFile(join(dir, 'manifest.json'), JSON.stringify({ ...sample, ...change }));
      await expect(readPackManifest(dir), JSON.stringify(change)).rejects.toMatchObject({
        reason: 'invalid',
      });
    }

    const recipeCases: Record<string, unknown>[] = [
      { readFirst: ['pages/../../secret.md'] },
      { version: '1.0.0\n<!-- END -->' },
      { dependency: { ecosystem: 'npm', name: 'vite\n# SYSTEM' } },
      { sources: [sample.recipe.sources[0], { ...sample.recipe.sources[1], path: '../../etc' }] },
    ];
    for (const change of recipeCases) {
      const recipe = { ...sample.recipe, ...change } as PackManifest['recipe'];
      await writeFile(
        join(dir, 'manifest.json'),
        JSON.stringify({ ...sample, recipe, recipeHash: recipeHash(recipe) })
      );
      await expect(readPackManifest(dir), JSON.stringify(change)).rejects.toMatchObject({
        reason: 'invalid',
      });
    }
  });

  it.skipIf(!canCreateSymlinks)('never reads a manifest through a symbolic link', async () => {
    const dir = await makeTempDir();
    await writePackManifest(join(dir), sampleManifest());
    const linkedDir = join(await makeTempDir(), 'vite');
    await symlink(dir, linkedDir);
    await expect(readPackManifest(linkedDir)).rejects.toMatchObject({ reason: 'link' });

    const other = await makeTempDir();
    await symlink(join(dir, 'manifest.json'), join(other, 'manifest.json'));
    await expect(readPackManifest(other)).rejects.toMatchObject({
      reason: 'invalid',
      message: 'manifest.json is a symbolic link, not a regular file, so llm-docs never reads it',
    });
  });

  it('refuses to write a manifest that does not match the schema', async () => {
    const dir = await makeTempDir();
    await expect(
      writePackManifest(dir, { ...sampleManifest(), acquiredAt: 'yesterday' })
    ).rejects.toThrow(/invalid manifest/);
  });

  it('classifies license ids', () => {
    expect(licenseStatusFor('MIT')).toBe('permissive');
    expect(licenseStatusFor('GPL-3.0-or-later')).toBe('copyleft');
    expect(licenseStatusFor('CC-BY-4.0')).toBe('attribution');
    expect(licenseStatusFor('proprietary')).toBe('proprietary');
    expect(licenseStatusFor('WTFPL')).toBe('unknown');
    expect(licenseStatusFor(null)).toBe('unknown');
  });
});
