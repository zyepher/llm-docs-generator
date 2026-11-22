import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import packageJson from '../../package.json';
import { canCreateSymlinks } from '../helpers/symlinks.js';

import {
  ConfigError,
  findProjectRoot,
  initProjectConfig,
  loadProjectConfig,
  parseProjectConfig,
  recipeHash,
  resolvePackRecipe,
  saveProjectConfig,
  type ProjectConfig,
  type ResolvePackOptions,
} from '../../src/config/project.js';

/** For recipes that pin a version: the lockfile is never consulted, and a consult is a miss. */
const PINNED: ResolvePackOptions = {
  resolveDependencyVersion: () => ({ kind: 'missing', searched: [] }),
};

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
          readFirst: [
            'pages/guide/migration.md',
            'pages/guide/api.md#breaking-changes',
            'files/CHANGELOG.md',
            'pages/v{major}/upgrade.md#to-{major}',
            'pages/guide/überblick.md#änderungen',
          ],
        },
      },
    });

    expect(Object.keys(config.packs)).toEqual(['vite']);
  });

  it.each([
    'https://raw.githubusercontent.com/Zyepher/llm-docs-generator/v3.0.0/schema/llm-docs.schema.json',
    './node_modules/llm-docs/schema/llm-docs.schema.json',
  ])('accepts $schema %s', ($schema) => {
    expect(parse({ $schema, schemaVersion: 3, packs: {} }).$schema).toBe($schema);
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
    ...[
      'guide/migration.md',
      '/pages/a.md',
      'pages/../index.md',
      'pages/a/../b.md',
      'pages\\a.md',
      'pages/./a.md',
      'pages//a.md',
      'pages/',
      'index.md',
      'guides/a.md',
      'pages/a.md#',
      'pages/a.md#two words',
    ].map((target): [unknown, string] => [
      { schemaVersion: 3, packs: { x: { ...localPack, readFirst: [target] } } },
      'packs.x.readFirst[0]: must be a pack-relative POSIX path under pages/ or files/',
    ]),
    [{ schemaVersion: 3, packs: { x: { ...localPack, readFirst: [] } } }, 'packs.x.readFirst'],
    [
      {
        schemaVersion: 3,
        packs: {
          x: {
            ...localPack,
            readFirst: [
              'pages/1.md',
              'pages/2.md',
              'pages/3.md',
              'pages/4.md',
              'pages/5.md',
              'pages/6.md',
            ],
          },
        },
      },
      'packs.x.readFirst',
    ],
    [
      { schemaVersion: 3, packs: { x: { ...localPack, readFirst: ['pages/a.md', 'pages/a.md'] } } },
      'packs.x.readFirst: must not repeat a target',
    ],
    [{ schemaVersion: 3, packs: { x: { ...localPack, covers: [] } } }, 'packs.x.covers'],
    [
      {
        schemaVersion: 3,
        packs: {
          x: {
            ...localPack,
            covers: Array.from({ length: 21 }, (_, index) => ({
              ecosystem: 'npm',
              name: `pkg-${index}`,
            })),
          },
        },
      },
      'packs.x.covers',
    ],
    [
      {
        schemaVersion: 3,
        packs: { x: { ...localPack, covers: [{ ecosystem: 'maven', name: 'x' }] } },
      },
      'packs.x.covers[0].ecosystem',
    ],
    [
      {
        schemaVersion: 3,
        packs: { x: { ...localPack, covers: [{ ecosystem: 'npm', name: '' }] } },
      },
      'packs.x.covers[0].name',
    ],
    [
      {
        schemaVersion: 3,
        packs: { x: { ...localPack, covers: [{ ecosystem: 'npm', name: 'a', version: '1' }] } },
      },
      'packs.x.covers[0]: unknown key "version"',
    ],
    [
      {
        schemaVersion: 3,
        packs: {
          x: {
            ...localPack,
            covers: [
              { ecosystem: 'pypi', name: 'Foo_Bar' },
              { ecosystem: 'pypi', name: 'foo-bar' },
            ],
          },
        },
      },
      'packs.x.covers: must not repeat a dependency',
    ],
    [
      {
        schemaVersion: 3,
        packs: {
          x: {
            ...localPack,
            dependency: { ecosystem: 'npm', name: '@mcp/server' },
            covers: [
              { ecosystem: 'npm', name: '@mcp/client' },
              { ecosystem: 'npm', name: '@mcp/server' },
            ],
          },
        },
      },
      'packs.x.covers[1]: is the pack\'s own "dependency"',
    ],
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
    const resolved = await resolvePackRecipe(config(localPack), 'vite', PINNED);

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
      'vite',
      PINNED
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
        'vite',
        PINNED
      )
    ).rejects.toThrow(/placeholder \{minor\} has no value for version "2026-07-28"/);
    await expect(
      resolvePackRecipe(
        config({ version: '1', sources: [{ type: 'local', path: 'docs', mount: 'v{major}' }] }),
        'vite',
        PINNED
      )
    ).rejects.toThrow(
      /placeholders are only allowed in ref, paths, url, urls, include, exclude, readFirst, and the targets of site\.aliases/
    );
  });

  it('substitutes placeholders in site.aliases targets and refuses them in alias keys and baseUrl', async () => {
    const site = (aliases: Record<string, string>, baseUrl = 'https://x.dev') => ({
      ...localPack,
      version: '2026-07-28',
      site: { baseUrl, aliases },
    });
    const resolved = await resolvePackRecipe(
      config(site({ '/specification/latest': '/specification/{version}', '/docs': '/docs' })),
      'vite',
      PINNED
    );
    expect(resolved.recipe.site).toEqual({
      baseUrl: 'https://x.dev',
      aliases: { '/specification/latest': '/specification/2026-07-28', '/docs': '/docs' },
    });

    await expect(
      resolvePackRecipe(config(site({ '/spec/{version}': '/spec' })), 'vite', PINNED)
    ).rejects.toThrow(
      /packs\.vite\.site\.aliases\["\/spec\/\{version\}"\]: placeholders are only allowed in/
    );
    await expect(
      resolvePackRecipe(config(site({}, 'https://x.dev/{version}')), 'vite', PINNED)
    ).rejects.toThrow(/packs\.vite\.site\.baseUrl: placeholders are only allowed in/);
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
      'vite',
      PINNED
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
        'vite',
        PINNED
      )
    ).rejects.toThrow(
      /https:\/\/x\.dev\/a and https:\/\/y\.dev\/a\.md would both be stored at "a\.md"/
    );
    await expect(
      resolvePackRecipe(
        config({
          version: '1',
          sources: [{ type: 'urls', urls: ['https://x.dev/Straße', 'https://x.dev/STRASSE'] }],
        }),
        'vite',
        PINNED
      )
    ).rejects.toThrow(
      'https://x.dev/Straße and https://x.dev/STRASSE would both be stored at "Straße.md" and "STRASSE.md" (one path on a case- or normalization-insensitive file system)'
    );
  });

  it('resolves the version from lockfiles through the resolver', async () => {
    const pack = {
      dependency: { ecosystem: 'npm', name: 'vite' },
      sources: [{ type: 'local', path: 'docs' }],
    };

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
      'vite',
      PINNED
    );
    const b = await resolvePackRecipe(
      config({
        sources: [{ exclude: ['x'], path: 'docs', type: 'local' }],
        title: 'T',
        version: '1',
      }),
      'vite',
      PINNED
    );
    const c = await resolvePackRecipe(
      config({
        version: '1',
        title: 'T',
        sources: [{ type: 'local', path: 'docs', exclude: ['y'] }],
      }),
      'vite',
      PINNED
    );

    expect(a.recipeHash).toBe(b.recipeHash);
    expect(a.recipeHash).not.toBe(c.recipeHash);
    expect(recipeHash(a.recipe)).toBe(a.recipeHash);
    // Pinned so an accidental change to canonical hashing fails loudly.
    expect(a.recipeHash).toBe(recipeHash(JSON.parse(JSON.stringify(a.recipe))));
  });

  // Recorded from the code before readFirst existed (commit 82878fb on v3/redesign), for
  // `localPack` resolved with every default. Packs built then hold this recipeHash, so a
  // change here would report every existing pack as recipe-changed.
  const LOCAL_PACK_HASH_BEFORE_READ_FIRST =
    'sha256:3b753a53f683da7844197fdd72fa481be5f4316afbaa906d200147f65dab17ea';

  it('keeps the recipe hash of a pack whose aliases hold no placeholder', async () => {
    const aliases = { '/guide/latest': '/guide/v1', '/api/next': '/api' };
    const resolved = await resolvePackRecipe(
      config({ ...localPack, site: { baseUrl: 'https://x.dev', aliases } }),
      'vite',
      PINNED
    );

    // Recorded from the code before alias targets took placeholders (commit 8971a52).
    expect(resolved.recipeHash).toBe(
      'sha256:cf3a2f57c871b8037253f4f2f91bbbee0723d2c5d5c2ea10564d61a1f9271a7b'
    );
  });

  it('keeps the recipe hash of a pack without readFirst, and changes it with the field', async () => {
    const without = await resolvePackRecipe(config(localPack), 'vite', PINNED);
    const one = await resolvePackRecipe(
      config({ ...localPack, readFirst: ['pages/migration.md'] }),
      'vite',
      PINNED
    );
    const other = await resolvePackRecipe(
      config({ ...localPack, readFirst: ['pages/migration.md#breaking'] }),
      'vite',
      PINNED
    );

    expect(without.recipeHash).toBe(LOCAL_PACK_HASH_BEFORE_READ_FIRST);
    expect(Object.hasOwn(without.recipe, 'readFirst')).toBe(false);
    expect(one.recipe.readFirst).toEqual(['pages/migration.md']);
    expect(new Set([without.recipeHash, one.recipeHash, other.recipeHash]).size).toBe(3);
  });

  it('keeps the recipe hash of a pack without covers, and records covers in recipe order', async () => {
    const without = await resolvePackRecipe(config(localPack), 'vite', PINNED);
    const covers = [
      { ecosystem: 'npm', name: '@mcp/client' },
      { ecosystem: 'pypi', name: 'mcp_extras' },
    ];
    const withCovers = await resolvePackRecipe(config({ ...localPack, covers }), 'vite', PINNED);
    const reordered = await resolvePackRecipe(
      config({ ...localPack, covers: [...covers].reverse() }),
      'vite',
      PINNED
    );

    expect(without.recipeHash).toBe(LOCAL_PACK_HASH_BEFORE_READ_FIRST);
    expect(Object.hasOwn(without.recipe, 'covers')).toBe(false);
    expect(withCovers.recipe.covers).toEqual(covers);
    // Pinned like the hash above, so the recorded form of covers cannot drift unnoticed.
    expect(withCovers.recipeHash).toBe(
      'sha256:d2e867424e011de5a77530a3d764dfd9d4a09897f26953995a38325de30a0689'
    );
    expect(reordered.recipeHash).not.toBe(withCovers.recipeHash);
  });

  it('substitutes placeholders in readFirst and re-checks the result', async () => {
    const resolved = await resolvePackRecipe(
      config({
        ...localPack,
        version: 'v8.2.1',
        readFirst: ['pages/v{major}/migration-{version}.md#to-{major}{minor}', 'files/{patch}.md'],
      }),
      'vite',
      PINNED
    );
    expect(resolved.recipe.readFirst).toEqual(['pages/v8/migration-v8.2.1.md#to-82', 'files/1.md']);

    await expect(
      resolvePackRecipe(
        config({ ...localPack, version: '2026-07-28', readFirst: ['pages/v{minor}.md'] }),
        'vite',
        PINNED
      )
    ).rejects.toThrow(/packs\.vite\.readFirst\[0\]: placeholder \{minor\} has no value/);
    await expect(
      resolvePackRecipe(
        config({ ...localPack, version: 'a/../../b', readFirst: ['pages/{version}.md'] }),
        'vite',
        PINNED
      )
    ).rejects.toThrow(
      /"pages\/a\/\.\.\/\.\.\/b\.md" \(from "pages\/\{version\}\.md"\) is not a path under pages\/ or files\//
    );
    await expect(
      resolvePackRecipe(
        config({ ...localPack, version: '1.0', readFirst: ['pages/{version}.md', 'pages/1.0.md'] }),
        'vite',
        PINNED
      )
    ).rejects.toThrow(/"pages\/1\.0\.md" is listed twice once placeholders are substituted/);
  });

  it('names an unknown pack', async () => {
    await expect(resolvePackRecipe(config(localPack), 'nope', PINNED)).rejects.toThrow(
      /No pack "nope"/
    );
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
      $schema: `https://raw.githubusercontent.com/Zyepher/llm-docs-generator/v${packageJson.version}/schema/llm-docs.schema.json`,
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

  it.skipIf(!canCreateSymlinks)(
    'rejects a packsDir that leaves the project through a symlink, on load, init, and save',
    async () => {
      const base = await makeTempDir();
      const root = join(base, 'project');
      const outside = join(base, 'outside');
      await mkdir(root);
      await mkdir(outside);
      await symlink(outside, join(root, 'agent-docs'), 'dir');

      await expect(initProjectConfig(root)).rejects.toThrow(
        /packsDir "agent-docs" resolves to .*outside.* through a symbolic link/
      );
      await expect(
        saveProjectConfig(root, 'x', {
          version: '1',
          sources: [{ type: 'local', path: 'docs' }],
        })
      ).rejects.toThrow(ConfigError);
      expect(await readdir(root)).toEqual(['agent-docs']);

      await writeFile(join(root, 'llm-docs.json'), '{"schemaVersion":3,"packs":{}}\n');
      await expect(loadProjectConfig(root)).rejects.toThrow(ConfigError);
      expect(await readdir(outside)).toEqual([]);
    }
  );

  it.skipIf(!canCreateSymlinks)(
    'accepts a packsDir symlink that stays inside the project, and a symlinked project root',
    async () => {
      const base = await makeTempDir();
      const root = join(base, 'project');
      await mkdir(join(root, 'docs', 'packs'), { recursive: true });
      await symlink(join(root, 'docs', 'packs'), join(root, 'agent-docs'), 'dir');
      await symlink(root, join(base, 'alias'), 'dir');
      await writeFile(join(root, 'llm-docs.json'), '{"schemaVersion":3,"packs":{}}\n');

      expect((await loadProjectConfig(root)).packsDirRelative).toBe('agent-docs');
      expect((await loadProjectConfig(join(base, 'alias'))).packsDirRelative).toBe('agent-docs');
    }
  );
});
