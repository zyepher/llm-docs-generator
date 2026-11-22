import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { migrateV2Pack, type MigrationOutcome } from '../../src/config/migrate.js';
import { loadProjectConfig, resolvePackRecipe } from '../../src/config/project.js';

const fixtures = join(
  resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
  'tests',
  'fixtures',
  'migrate'
);
const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

type Manifest = Record<string, unknown> & {
  source: Record<string, unknown> & { git?: Record<string, unknown> };
};

async function fixture(name: string): Promise<Manifest> {
  return JSON.parse(await readFile(join(fixtures, name, 'manifest.json'), 'utf-8'));
}

/** A v2 pack directory named `name` holding `manifest` (or raw manifest text). */
async function writePack(name: string, manifest: unknown): Promise<string> {
  const dir = join(await makeTempDir('llm-docs-v2-'), name);
  await mkdir(dir);
  await writeFile(
    join(dir, 'manifest.json'),
    typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2)
  );
  return dir;
}

async function viteWith(edit: (manifest: Manifest) => void): Promise<Manifest> {
  const manifest = await fixture('vite-8');
  edit(manifest);
  return manifest;
}

function refusal(outcome: MigrationOutcome): { reason: string; message: string } {
  if (outcome.status !== 'refused') {
    throw new Error(`expected a refusal, got ${JSON.stringify(outcome)}`);
  }
  return { reason: outcome.reason, message: outcome.message };
}

function migrated(outcome: MigrationOutcome): Extract<MigrationOutcome, { status: 'migrated' }> {
  if (outcome.status !== 'migrated') {
    throw new Error(`expected a migration, got ${outcome.reason}: ${outcome.message}`);
  }
  return outcome;
}

describe('llm-docs migrate', () => {
  it('writes a git recipe pinned at the recorded commit, creating the config', async () => {
    const project = await makeTempDir('llm-docs-project-');
    const packDir = join(fixtures, 'vite-8');
    const before = await readFile(join(packDir, 'manifest.json'), 'utf-8');

    const outcome = migrated(
      await migrateV2Pack(packDir, { projectRoot: project, version: '8.1.5' })
    );

    const expected = {
      version: '8.1.5',
      sources: [
        {
          type: 'git',
          repo: 'https://github.com/vitejs/vite',
          ref: '5e7fe129a4dde4f41934083b25e490059985f4e6',
          paths: ['docs'],
          exclude: ['.vitepress/**', '_data/**', 'blog/**', 'public/**'],
        },
      ],
    };
    expect(outcome).toEqual({
      status: 'migrated',
      id: 'vite-8',
      pack: expected,
      configPath: join(project, 'llm-docs.json'),
      warnings: [],
    });

    const loaded = await loadProjectConfig(project);
    expect(loaded.config.packs).toEqual({ 'vite-8': expected });
    const resolved = await resolvePackRecipe(loaded.config, 'vite-8', {
      resolveDependencyVersion: () => ({ kind: 'missing', searched: [] }),
    });
    expect(resolved.recipe.sources[0]).toMatchObject({ type: 'git', paths: ['docs'] });
    expect(await readFile(join(packDir, 'manifest.json'), 'utf-8')).toBe(before);
  });

  it('asks for --version, showing the label and tags v2 kept as evidence', async () => {
    const project = await makeTempDir('llm-docs-project-');
    const { reason, message } = refusal(
      await migrateV2Pack(join(fixtures, 'tanstack-router'), { projectRoot: project })
    );

    expect(reason).toBe('version-required');
    expect(message).toContain('--version <v>');
    expect(message).toContain('"@tanstack/react-router 1.170.17 (tag release-2026-07-01-2138)"');
    expect(message).toContain('@tanstack/react-router@1.170.17');
    expect(message).toContain(', ...');
    await expect(readFile(join(project, 'llm-docs.json'))).rejects.toThrow();
  });

  it('normalizes every recorded remote form to https and warns when the transport changes', async () => {
    const project = await makeTempDir('llm-docs-project-');
    const cases: Array<[remote: string, repo: string]> = [
      ['https://github.com/TanStack/router.git', 'https://github.com/TanStack/router'],
      ['https://github.com/TanStack/router', 'https://github.com/TanStack/router'],
      ['git@github.com:TanStack/router.git', 'https://github.com/TanStack/router'],
      ['ssh://git@github.com/TanStack/router.git', 'https://github.com/TanStack/router'],
      ['ssh://git@GitHub.com:2222/TanStack/router.git/', 'https://github.com/TanStack/router'],
      ['git://example.com/team/docs.git', 'https://example.com/team/docs'],
      ['http://example.com/team/docs', 'https://example.com/team/docs'],
      ['file:///srv/git/docs.git', 'file:///srv/git/docs.git'],
    ];

    for (const [index, [remote, repo]] of cases.entries()) {
      const packDir = await writePack(
        'router',
        await viteWith((manifest) => {
          manifest.source.git = { ...manifest.source.git, remoteUrl: remote };
        })
      );
      const outcome = migrated(
        await migrateV2Pack(packDir, {
          projectRoot: project,
          id: `case-${index}`,
          version: '1.0.0',
        })
      );

      expect(outcome.pack.sources[0], remote).toMatchObject({ type: 'git', repo });
      const rewritten = !remote.startsWith('https:') && !remote.startsWith('file:');
      expect(outcome.warnings.some((warning) => warning.includes('fetched over https'))).toBe(
        rewritten
      );
    }
  });

  it('migrates a dirty working tree to its commit with a warning', async () => {
    const project = await makeTempDir('llm-docs-project-');
    const packDir = await writePack(
      'vite-8',
      await viteWith((manifest) => {
        manifest.source.git = { ...manifest.source.git, dirty: true };
      })
    );
    const outcome = migrated(
      await migrateV2Pack(packDir, { projectRoot: project, version: '8.1.5' })
    );

    expect(outcome.pack.sources[0]).toMatchObject({
      ref: '5e7fe129a4dde4f41934083b25e490059985f4e6',
    });
    expect(outcome.warnings).toEqual([
      'the v2 pack was built from a working tree with uncommitted changes, so the v3 pack built from commit 5e7fe129a4dd may differ from it.',
    ]);
  });

  it('takes the whole repository for a root source and merges both exclude records', async () => {
    const project = await makeTempDir('llm-docs-project-');
    const packDir = await writePack(
      'vite-8',
      await viteWith((manifest) => {
        manifest.source.git = { ...manifest.source.git, sourceRootFromRepo: '.' };
        manifest.source.excludeGlobs = ['team.md', 'blog/**', 'drafts/**'];
      })
    );
    const outcome = migrated(
      await migrateV2Pack(packDir, { projectRoot: project, version: '8.1.5' })
    );

    expect(outcome.pack.sources[0]).toMatchObject({
      paths: ['.'],
      exclude: ['.vitepress/**', '_data/**', 'blog/**', 'drafts/**', 'public/**', 'team.md'],
    });
  });

  it('turns a source that still exists inside the project into a local source', async () => {
    const project = await makeTempDir('llm-docs-project-');
    await mkdir(join(project, 'vendor', 'vite-docs'), { recursive: true });
    const packDir = await writePack(
      'vite-8',
      await viteWith((manifest) => {
        manifest.source.resolvedPath = join(project, 'vendor', 'vite-docs');
      })
    );
    const outcome = migrated(
      await migrateV2Pack(packDir, { projectRoot: project, version: '8.1.5' })
    );

    expect(outcome.pack).toEqual({
      version: '8.1.5',
      sources: [
        {
          type: 'local',
          path: 'vendor/vite-docs',
          exclude: ['.vitepress/**', '_data/**', 'blog/**', 'public/**'],
        },
      ],
    });
  });

  it('reports a lost origin for a missing or temp-directory source without a usable remote', async () => {
    const project = await makeTempDir('llm-docs-project-');
    const scratch = await makeTempDir('llm-docs-scratch-');
    const missing = join(fixtures, 'no-such-source');
    const withoutGit = (path: string) => (manifest: Manifest) => {
      manifest.source.resolvedPath = path;
      delete manifest.source.git;
    };
    const cases: Array<[label: string, packDir: string, recorded: string, where: string]> = [
      [
        'the real typescript-7 shape',
        join(fixtures, 'typescript-7'),
        (await fixture('typescript-7')).source.resolvedPath as string,
        'is lost',
      ],
      [
        'an existing temp directory',
        await writePack('scratch', await viteWith(withoutGit(scratch))),
        scratch,
        'is in the OS temp directory',
      ],
      [
        'a deleted path',
        await writePack('gone', await viteWith(withoutGit(missing))),
        missing,
        'no longer exists',
      ],
      [
        'a remote with no https form',
        await writePack(
          'local-remote',
          await viteWith((manifest) => {
            manifest.source.resolvedPath = missing;
            manifest.source.git = { ...manifest.source.git, remoteUrl: '../mirror/vite' };
          })
        ),
        missing,
        'no git remote v3 can fetch',
      ],
    ];

    for (const [label, packDir, recorded, where] of cases) {
      const { reason, message } = refusal(
        await migrateV2Pack(packDir, { projectRoot: project, version: '1.0.0' })
      );
      expect(reason, label).toBe('origin-lost');
      expect(message, label).toContain(recorded);
      expect(message, label).toContain(where);
      expect(message, label).toContain("'llm-docs add");
    }
    await expect(readFile(join(project, 'llm-docs.json'))).rejects.toThrow();
  });

  it('refuses an existing source outside the project that has no git remote', async () => {
    const project = await makeTempDir('llm-docs-project-');
    const packDir = await writePack(
      'vite-8',
      await viteWith((manifest) => {
        manifest.source.resolvedPath = fixtures;
        delete manifest.source.git;
      })
    );
    const { reason, message } = refusal(
      await migrateV2Pack(packDir, { projectRoot: project, version: '8.1.5' })
    );

    expect(reason).toBe('outside-project');
    expect(message).toContain(fixtures);
    expect(message).toContain('must live inside the project');
    expect(message).toContain("'llm-docs add vite-8 --git");
  });

  it('refuses manifests that are not v2 local-source-docs packs, naming what it found', async () => {
    const project = await makeTempDir('llm-docs-project-');
    const cases: Array<[manifest: unknown, reason: string, text: string]> = [
      [
        await viteWith((manifest) => {
          manifest.mode = 'configured-sdk';
        }),
        'unsupported-mode',
        '"configured-sdk"',
      ],
      [
        await viteWith((manifest) => {
          manifest.schemaVersion = '0.2.0';
        }),
        'unsupported-version',
        '"0.2.0"',
      ],
      [{ schemaVersion: 3, id: 'vite' }, 'already-v3', 'needs no migration'],
      ['{ not json', 'not-a-v2-pack', 'is not valid JSON'],
      [
        await viteWith((manifest) => {
          manifest.source.git = { ...manifest.source.git, commit: 'HEAD' };
        }),
        'not-a-v2-pack',
        'source.git.commit',
      ],
    ];

    for (const [manifest, reason, text] of cases) {
      const outcome = refusal(
        await migrateV2Pack(await writePack('vite-8', manifest), {
          projectRoot: project,
          version: '8.1.5',
        })
      );
      expect(outcome.reason).toBe(reason);
      expect(outcome.message).toContain(text);
    }

    const empty = await makeTempDir('llm-docs-v2-');
    expect(refusal(await migrateV2Pack(empty, { projectRoot: project }))).toMatchObject({
      reason: 'not-a-v2-pack',
      message: expect.stringContaining(`No manifest.json in ${empty}`),
    });
  });

  it('checks the pack id and the version, and never overwrites an existing pack', async () => {
    const project = await makeTempDir('llm-docs-project-');
    const vite = await fixture('vite-8');
    const oddName = await writePack('Vite_8', vite);

    expect(
      refusal(await migrateV2Pack(oddName, { projectRoot: project, version: '8.1.5' }))
    ).toMatchObject({ reason: 'invalid-id', message: expect.stringContaining('pass --id <id>') });
    expect(
      refusal(
        await migrateV2Pack(oddName, { projectRoot: project, id: 'Vite 8', version: '8.1.5' })
      )
    ).toMatchObject({ reason: 'invalid-id', message: expect.stringContaining('--id "Vite 8"') });
    expect(
      refusal(await migrateV2Pack(oddName, { projectRoot: project, id: 'vite', version: '8 1' }))
    ).toMatchObject({
      reason: 'invalid-recipe',
      message: expect.stringContaining('packs.vite version'),
    });

    for (const root of ['../../../etc', '/etc', 'docs/../../x']) {
      const escaping = await viteWith((manifest) => {
        manifest.source.git = { ...manifest.source.git, sourceRootFromRepo: root };
      });
      expect(
        refusal(
          await migrateV2Pack(await writePack(`escape-${root.length}`, escaping), {
            projectRoot: project,
            id: 'vite',
            version: '8.1.5',
          })
        ),
        root
      ).toMatchObject({
        reason: 'invalid-recipe',
        message: expect.stringContaining(
          `source.git.sourceRootFromRepo in the v2 manifest (git path "${root}" must be a relative path inside the repository`
        ),
      });
    }
    await expect(readFile(join(project, 'llm-docs.json'), 'utf-8')).rejects.toThrow(/ENOENT/);

    const existing = {
      schemaVersion: 3,
      packs: { 'vite-8': { version: '8.0.0', sources: [{ type: 'local', path: 'docs' }] } },
    };
    const configText = `${JSON.stringify(existing, null, 2)}\n`;
    await writeFile(join(project, 'llm-docs.json'), configText);
    const packDir = join(fixtures, 'vite-8');

    expect(
      refusal(await migrateV2Pack(packDir, { projectRoot: project, version: '8.1.5' }))
    ).toMatchObject({
      reason: 'id-exists',
      message: expect.stringContaining('pass --id <id> to migrate under another id'),
    });
    expect(await readFile(join(project, 'llm-docs.json'), 'utf-8')).toBe(configText);

    migrated(
      await migrateV2Pack(packDir, { projectRoot: project, id: 'vite-8.1', version: '8.1.5' })
    );
    const { config } = await loadProjectConfig(project);
    expect(Object.keys(config.packs)).toEqual(['vite-8', 'vite-8.1']);
    expect(config.packs['vite-8']).toEqual(existing.packs['vite-8']);
  });
});
