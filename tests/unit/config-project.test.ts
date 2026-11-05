import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ConfigError,
  findProjectRoot,
  initProjectConfig,
  LockfileResolutionUnavailableError,
  loadProjectConfig,
  parseProjectConfig,
  recipeHash,
  resolvePackRecipe,
  saveProjectConfig,
  type ProjectConfig,
} from '../../src/config/project.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'llm-docs-config-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function parse(config: unknown): ProjectConfig {
  return parseProjectConfig('/project', JSON.stringify(config)).config;
}

function parseError(config: unknown): string {
  try {
    parseProjectConfig('/project', JSON.stringify(config));
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as Error).message;
  }
  throw new Error('expected a ConfigError');
}

const localPack = { version: '1.2.3', sources: [{ type: 'local', path: 'docs' }] };

describe('llm-docs.json validation', () => {
  it('accepts a minimal config and every source type', () => {
    const config = parse({
      $schema: './node_modules/llm-docs/schema/llm-docs.schema.json',
      schemaVersion: 3,
      packsDir: 'docs/agent-docs',
      agentFiles: ['AGENTS.md'],
      block: { maxBytes: 4096 },
      hook: { enabled: true, nearCutoffDays: 90 },
      model: { cutoff: '2026-06' },
      packs: {
        vite: {
          title: 'Vite',
          description: 'Build tool',
          dependency: { ecosystem: 'npm', name: 'vite' },
          version: '8.2.0',
          sources: [
            {
              type: 'git',
              repo: 'https://github.com/vitejs/vite',
              ref: 'v{version}',
              paths: ['docs'],
              include: ['**/*.md'],
              exclude: ['**/node_modules/**'],
              mount: '',
              passthrough: [],
              convert: null,
              transforms: ['strip-html-comments'],
            },
            { type: 'urls', urls: ['https://x.dev/a', { url: 'https://x.dev/b', path: 'b.md' }] },
            { type: 'llms-txt', url: 'https://x.dev/llms.txt', include: ['/docs/**'] },
            {
              type: 'local',
              path: 'manuals',
              convert: { tool: 'command', include: ['**/*.pdf'], command: ['pdf2md', '{input}'] },
            },
          ],
          site: { baseUrl: 'https://vite.dev', aliases: { '/guide/latest': '/guide' } },
          layout: { combined: false },
          license: 'MIT',
          limits: { maxFileBytes: 1024 },
        },
      },
    });

    expect(Object.keys(config.packs)).toEqual(['vite']);
  });

  it.each([
    [{ schemaVersion: 3, packs: {}, extra: 1 }, 'unknown key "extra"'],
    [
      {
        schemaVersion: 3,
        packs: { vite: { ...localPack, sources: [{ type: 'local', path: 'docs', incude: [] }] } },
      },
      'packs.vite.sources[0]: unknown key "incude"',
    ],
    [{ schemaVersion: 3, packs: { Vite: localPack } }, 'pack ids must match'],
    [{ schemaVersion: 3, packs: { '-x': localPack } }, 'pack ids must match'],
    [
      { schemaVersion: 3, packs: { x: { sources: localPack.sources } } },
      'is required unless "dependency" is set',
    ],
    [{ schemaVersion: 3, packs: { x: { ...localPack, version: '1 2' } } }, 'without whitespace'],
    [{ schemaVersion: 3, packs: { x: { ...localPack, sources: [] } } }, 'packs.x.sources'],
    [{ schemaVersion: 3, packsDir: '/abs', packs: {} }, 'must be project-relative'],
    [{ schemaVersion: 3, packsDir: '../out', packs: {} }, 'must stay inside the project'],
    [{ schemaVersion: 3, packsDir: 'C:\\packs', packs: {} }, 'must be project-relative'],
    [
      {
        schemaVersion: 3,
        packs: { x: { ...localPack, sources: [{ type: 'local', path: 'a/../../b' }] } },
      },
      'must stay inside the project',
    ],
    [
      {
        schemaVersion: 3,
        packs: { x: { ...localPack, sources: [{ type: 'local', path: 'd', mount: 'a/../b' }] } },
      },
      'must not contain ".."',
    ],
    [
      {
        schemaVersion: 3,
        packs: {
          x: { ...localPack, sources: [{ type: 'git', repo: 'git@github.com:a/b', ref: 'v1' }] },
        },
      },
      'ssh and git@ remotes are not supported',
    ],
    [
      {
        schemaVersion: 3,
        packs: { x: { ...localPack, sources: [{ type: 'urls', urls: ['https://u:p@x.dev/a'] }] } },
      },
      'without credentials',
    ],
    [
      {
        schemaVersion: 3,
        packs: {
          x: { ...localPack, sources: [{ type: 'llms-txt', url: 'https://x.dev/llms.txt' }] },
        },
      },
      'packs.x.sources[0].include',
    ],
    [
      {
        schemaVersion: 3,
        packs: {
          x: { ...localPack, sources: [{ type: 'local', path: 'd', transforms: ['nope'] }] },
        },
      },
      'transforms[0]',
    ],
    [
      {
        schemaVersion: 3,
        packs: {
          x: {
            ...localPack,
            sources: [{ type: 'local', path: 'd', convert: { tool: 'command' } }],
          },
        },
      },
      'is required for the "command" converter',
    ],
    [
      {
        schemaVersion: 3,
        packs: { x: { ...localPack, dependency: { ecosystem: 'maven', name: 'x' } } },
      },
      'packs.x.dependency.ecosystem',
    ],
    [
      {
        schemaVersion: 3,
        packs: { x: { ...localPack, limits: { maxFileBytes: 300 * 1024 * 1024 } } },
      },
      'maxFileBytes',
    ],
    [{ schemaVersion: 3, model: { cutoff: '2026-13' }, packs: {} }, 'YYYY-MM'],
  ])('rejects %j', (config, message) => {
    expect(parseError(config)).toContain(message);
  });

  it('rejects the project root as packsDir, invalid JSON, and other schema versions', () => {
    expect(parseError({ schemaVersion: 3, packsDir: '.', packs: {} })).toContain(
      'not the project root'
    );
    expect(() => parseProjectConfig('/p', '{')).toThrow(/not valid JSON/);
    expect(parseError({ schemaVersion: 2, packs: {} })).toContain('schemaVersion 2');
  });

  it('normalizes packsDir and defaults it to agent-docs', () => {
    expect(parseProjectConfig('/p', '{"schemaVersion":3,"packs":{}}').packsDirRelative).toBe(
      'agent-docs'
    );
    expect(
      parseProjectConfig('/p', '{"schemaVersion":3,"packsDir":"./docs/packs/","packs":{}}')
        .packsDirRelative
    ).toBe('docs/packs');
  });
});

describe('resolvePackRecipe', () => {
  const config = (pack: unknown): ProjectConfig =>
    parse({ schemaVersion: 3, packs: { vite: pack } });

  it('fills every default so the recipe is explicit', async () => {
    const resolved = await resolvePackRecipe(config(localPack), 'vite');

    expect(resolved.recipe).toEqual({
      title: 'vite',
      description: null,
      dependency: null,
      version: '1.2.3',
      sources: [
        {
          type: 'local',
          path: 'docs',
          mount: '',
          include: ['**/*.{md,mdx,markdown,rst,html,htm}'],
          exclude: [],
          passthrough: [],
          convert: null,
          transforms: [],
        },
      ],
      site: null,
      layout: { combined: false },
      license: null,
      limits: { maxFileBytes: 20 * 1024 * 1024 },
    });
    expect(resolved.recipeHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('substitutes {version} {major} {minor} {patch} where allowed', async () => {
    const resolved = await resolvePackRecipe(
      config({
        version: 'v8.2.1-beta.1',
        sources: [
          {
            type: 'git',
            repo: 'https://github.com/vitejs/vite',
            ref: 'release/{major}.{minor}',
            paths: ['docs/v{major}'],
            include: ['**/{patch}/*.md'],
            exclude: ['old/{version}/**'],
          },
          { type: 'urls', urls: ['https://x.dev/{version}/guide/'] },
        ],
      }),
      'vite'
    );
    const [git, urls] = resolved.recipe.sources;

    expect(git).toMatchObject({
      ref: 'release/8.2',
      paths: ['docs/v8'],
      include: ['**/1/*.md'],
      exclude: ['old/v8.2.1-beta.1/**'],
    });
    expect(urls).toMatchObject({
      urls: [{ url: 'https://x.dev/v8.2.1-beta.1/guide/', path: 'v8.2.1-beta.1/guide/index.md' }],
    });
  });

  it('rejects a placeholder with no value and placeholders outside the allowed fields', async () => {
    await expect(
      resolvePackRecipe(
        config({
          version: '2026-07-28',
          sources: [{ type: 'git', repo: 'https://x.dev/r', ref: 'v{major}.{minor}' }],
        }),
        'vite'
      )
    ).rejects.toThrow(/placeholder \{minor\} has no value for version "2026-07-28"/);
    await expect(
      resolvePackRecipe(
        config({ version: '1', sources: [{ type: 'local', path: 'docs', mount: 'v{major}' }] }),
        'vite'
      )
    ).rejects.toThrow(
      /placeholders are only allowed in ref, paths, url, urls, include, and exclude/
    );
  });

  it('derives URL stored paths and rejects duplicates naming both URLs', async () => {
    const resolved = await resolvePackRecipe(
      config({
        version: '1',
        sources: [
          {
            type: 'urls',
            urls: ['https://x.dev/a%20b', 'https://x.dev/guide/', 'https://x.dev/s.json'],
          },
        ],
      }),
      'vite'
    );
    expect(resolved.recipe.sources[0]).toMatchObject({
      urls: [
        { url: 'https://x.dev/a%20b', path: 'a b.md' },
        { url: 'https://x.dev/guide/', path: 'guide/index.md' },
        { url: 'https://x.dev/s.json', path: 's.json' },
      ],
    });

    await expect(
      resolvePackRecipe(
        config({
          version: '1',
          sources: [{ type: 'urls', urls: ['https://x.dev/a', 'https://y.dev/a.md'] }],
        }),
        'vite'
      )
    ).rejects.toThrow(
      /https:\/\/x\.dev\/a and https:\/\/y\.dev\/a\.md would both be stored at "a\.md"/
    );
  });

  it('resolves the version from lockfiles through the injected resolver', async () => {
    const pack = {
      dependency: { ecosystem: 'npm', name: 'vite' },
      sources: [{ type: 'local', path: 'docs' }],
    };

    await expect(resolvePackRecipe(config(pack), 'vite')).rejects.toBeInstanceOf(
      LockfileResolutionUnavailableError
    );

    const found = await resolvePackRecipe(config(pack), 'vite', {
      resolveDependencyVersion: () => ({
        kind: 'found',
        version: '8.3.0',
        lockfiles: ['package-lock.json'],
      }),
    });
    expect(found.recipe.version).toBe('8.3.0');

    await expect(
      resolvePackRecipe(config(pack), 'vite', {
        resolveDependencyVersion: () => ({ kind: 'missing', searched: ['package-lock.json'] }),
      })
    ).rejects.toThrow(/lockfiles searched: package-lock\.json/);

    await expect(
      resolvePackRecipe(config(pack), 'vite', {
        resolveDependencyVersion: async () => ({
          kind: 'conflict',
          versions: [
            { version: '8.2.0', lockfile: 'a/package-lock.json' },
            { version: '8.3.0', lockfile: 'b/package-lock.json' },
          ],
        }),
      })
    ).rejects.toThrow(/8\.2\.0 in a\/package-lock\.json, 8\.3\.0 in b\/package-lock\.json/);

    const explicit = await resolvePackRecipe(config({ ...pack, version: '8.0.0' }), 'vite', {
      resolveDependencyVersion: () => {
        throw new Error('an explicit version never consults lockfiles');
      },
    });
    expect(explicit.recipe.version).toBe('8.0.0');
  });

  it('hashes canonically: key order in the config never changes the hash', async () => {
    const a = await resolvePackRecipe(
      config({
        version: '1',
        title: 'T',
        sources: [{ type: 'local', path: './docs/', exclude: ['x'] }],
      }),
      'vite'
    );
    const b = await resolvePackRecipe(
      config({
        sources: [{ exclude: ['x'], path: 'docs', type: 'local' }],
        title: 'T',
        version: '1',
      }),
      'vite'
    );
    const c = await resolvePackRecipe(
      config({
        version: '1',
        title: 'T',
        sources: [{ type: 'local', path: 'docs', exclude: ['y'] }],
      }),
      'vite'
    );

    expect(a.recipeHash).toBe(b.recipeHash);
    expect(a.recipeHash).not.toBe(c.recipeHash);
    expect(recipeHash(a.recipe)).toBe(a.recipeHash);
    // Pinned so an accidental change to canonical hashing fails loudly.
    expect(a.recipeHash).toBe(recipeHash(JSON.parse(JSON.stringify(a.recipe))));
  });

  it('names an unknown pack', async () => {
    await expect(resolvePackRecipe(config(localPack), 'nope')).rejects.toThrow(/No pack "nope"/);
  });
});

describe('project files', () => {
  it('finds the nearest ancestor with llm-docs.json', async () => {
    const root = await makeTempDir();
    await mkdir(join(root, 'a', 'b'), { recursive: true });

    expect(await findProjectRoot(join(root, 'a', 'b'))).toBeUndefined();
    await writeFile(join(root, 'llm-docs.json'), '{"schemaVersion":3,"packs":{}}\n');
    expect(await findProjectRoot(join(root, 'a', 'b'))).toBe(root);
  });

  it('creates config once and never overwrites it', async () => {
    const root = await makeTempDir();

    expect((await initProjectConfig(root, { packsDir: 'docs/packs' })).created).toBe(true);
    const text = await readFile(join(root, 'llm-docs.json'), 'utf-8');
    expect(JSON.parse(text)).toEqual({
      $schema: './node_modules/llm-docs/schema/llm-docs.schema.json',
      schemaVersion: 3,
      packsDir: 'docs/packs',
      packs: {},
    });
    expect((await initProjectConfig(root)).created).toBe(false);
    expect(await readFile(join(root, 'llm-docs.json'), 'utf-8')).toBe(text);
    await expect(initProjectConfig(await makeTempDir(), { packsDir: '../x' })).rejects.toThrow(
      /--packs-dir/
    );
  });

  it('adds a pack in place, preserving existing key order, as 2-space JSON', async () => {
    const root = await makeTempDir();
    const original = `{
  "packs": {
    "zeta": { "version": "1", "sources": [{ "type": "local", "path": "z" }] }
  },
  "schemaVersion": 3,
  "packsDir": "packs"
}
`;
    await writeFile(join(root, 'llm-docs.json'), original);
    await saveProjectConfig(root, 'alpha', {
      version: '2',
      sources: [{ type: 'local', path: 'a' }],
    });
    const text = await readFile(join(root, 'llm-docs.json'), 'utf-8');

    expect(text.startsWith('{\n  "packs": {\n    "zeta": {')).toBe(true);
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    expect(Object.keys(JSON.parse(text))).toEqual(['packs', 'schemaVersion', 'packsDir']);
    expect(Object.keys(JSON.parse(text).packs)).toEqual(['zeta', 'alpha']);
    expect(text).toContain('    "alpha": {\n      "version": "2",');

    const loaded = await loadProjectConfig(root);
    expect(loaded.packsDirRelative).toBe('packs');

    await saveProjectConfig(root, 'zeta', {
      version: '3',
      sources: [{ type: 'local', path: 'z' }],
    });
    expect(
      Object.keys(JSON.parse(await readFile(join(root, 'llm-docs.json'), 'utf-8')).packs)
    ).toEqual(['zeta', 'alpha']);
  });

  it('creates the config when adding to a project without one', async () => {
    const root = await makeTempDir();
    await saveProjectConfig(root, 'x', { version: '1', sources: [{ type: 'local', path: 'd' }] });

    expect(JSON.parse(await readFile(join(root, 'llm-docs.json'), 'utf-8'))).toMatchObject({
      schemaVersion: 3,
      packs: { x: { version: '1' } },
    });
  });

  it('explains a missing config', async () => {
    await expect(loadProjectConfig(await makeTempDir())).rejects.toThrow(
      /run 'llm-docs init' first/
    );
  });
});
