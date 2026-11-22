import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfigError, loadProjectConfig } from '../../src/config/project.js';
import { syncPacks } from '../../src/pack/build.js';
import {
  assessCitations,
  citedPageText,
  citedSection,
  extractCitations,
  stampGuides,
} from '../../src/pack/guides.js';
import { SyncLockedError, withPacksLock } from '../../src/pack/lock.js';
import { ALLOW_TEMP_SOURCES_ENV } from '../../src/sources/acquire.js';
import { sha256Prefixed } from '../../src/utils/hash.js';

const tempDirs: string[] = [];
let previousAllow: string | undefined;

beforeEach(() => {
  previousAllow = process.env[ALLOW_TEMP_SOURCES_ENV];
  process.env[ALLOW_TEMP_SOURCES_ENV] = '1';
});

afterEach(async () => {
  if (previousAllow === undefined) {
    delete process.env[ALLOW_TEMP_SOURCES_ENV];
  } else {
    process.env[ALLOW_TEMP_SOURCES_ENV] = previousAllow;
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, ...path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

const API_PAGE = [
  '# API',
  '',
  'Intro.',
  '',
  '## Install',
  '',
  'Run it.',
  '',
  '### Options',
  '',
  'Some options.',
  '',
  '## Usage',
  '',
  'First usage.',
  '',
  '## Usage',
  '',
  'Second usage.',
  '',
  '```md',
  '## Not a heading',
  '```',
  '',
].join('\n');
const INSTALL_SECTION = '## Install\n\nRun it.\n\n### Options\n\nSome options.\n\n';

const DOCS = {
  'docs/guide/api.md': API_PAGE,
  'docs/guide/start.md': '# Start\n\nBegin here.\n',
  'docs/data/schema.json': '{"a":1}\n',
};

function packRecipe(version = '1.0.0'): Record<string, unknown> {
  return {
    title: 'Demo',
    version,
    license: 'MIT',
    sources: [
      {
        type: 'local',
        path: 'docs',
        include: ['**/*.md', 'data/*.json'],
        passthrough: ['data/*.json'],
      },
    ],
  };
}

async function setRecipe(root: string, version = '1.0.0'): Promise<void> {
  await writeFile(
    join(root, 'llm-docs.json'),
    `${JSON.stringify({ schemaVersion: 3, agentFiles: [], packs: { demo: packRecipe(version) } }, null, 2)}\n`
  );
}

/** A built local pack `demo` whose guides are `guides`. */
async function builtPack(guides: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'llm-docs-guides-'));
  tempDirs.push(root);
  await writeFiles(root, DOCS);
  await setRecipe(root);
  const report = await syncPacks(root, undefined);
  expect(report.packs[0]).toMatchObject({ status: 'built' });
  await writeFiles(join(root, 'agent-docs', 'demo', 'guides'), guides);
  return root;
}

const packDir = (root: string): string => join(root, 'agent-docs', 'demo');
const lockFile = (root: string): string => join(packDir(root), 'guides', 'citations.lock.json');
const readLock = async (root: string): Promise<string> => readFile(lockFile(root), 'utf-8');
const stamp = async (root: string, guides: string[] = [], cwd = root) =>
  stampGuides(await loadProjectConfig(root), 'demo', guides, cwd);

async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

const GUIDE_A =
  '# Plugins digest\n\nInstall with [install](../pages/guide/api.md#install), start at [start](../pages/guide/start.md).\n';
const GUIDE_B = '# Schema notes\n\nThe [schema](../files/data/schema.json).\n';

describe('extractCitations', () => {
  it('resolves links relative to the guide into pages/ and files/, deduplicated and sorted', () => {
    const text = [
      '[a](../../pages/guide/api.md#install) and again [a2](../../pages/guide/api.md#install)',
      '[whole](../../pages/guide/start.md) [empty fragment](../../pages/guide/start.md#)',
      '[query](../../pages/guide/api.md?plain=1#usage-1)',
      '[encoded](../../pages/guide/my%20page.md) [csharp](../../pages/c%23/intro.md#types)',
      '![diagram](../../files/data/schema.json)',
      '[ref][r]',
      '',
      '[r]: ../../pages/guide/api.md#options',
    ].join('\n');

    expect(extractCitations('guides/sub/a.md', text)).toEqual({
      citations: [
        { target: 'files/data/schema.json', path: 'files/data/schema.json', fragment: null },
        { target: 'pages/c%23/intro.md#types', path: 'pages/c#/intro.md', fragment: 'types' },
        {
          target: 'pages/guide/api.md#install',
          path: 'pages/guide/api.md',
          fragment: 'install',
        },
        {
          target: 'pages/guide/api.md#options',
          path: 'pages/guide/api.md',
          fragment: 'options',
        },
        {
          target: 'pages/guide/api.md#usage-1',
          path: 'pages/guide/api.md',
          fragment: 'usage-1',
        },
        { target: 'pages/guide/my page.md', path: 'pages/guide/my page.md', fragment: null },
        { target: 'pages/guide/start.md', path: 'pages/guide/start.md', fragment: null },
      ],
      outsidePack: [],
    });
  });

  it('ignores links in code, links elsewhere, and reports only escapes aimed at pages or files', () => {
    const text = [
      '`[code](../pages/a.md)`',
      '',
      '```md',
      '[fenced](../pages/b.md)',
      '```',
      '',
      '    [indented](../pages/c.md)',
      '',
      '[other guide](b.md) [index](../index.md) [web](https://example.com/pages/x.md)',
      '[anchor](#local) [absolute](/pages/x.md) [protocol](//cdn.example/pages/x.md)',
      '[project code](../../../src/index.ts) [other pack](../../vite/pages/x.md)',
      '[too high](../../pages/guide/api.md) [mail](mailto:a@b.c)',
    ].join('\n');

    expect(extractCitations('guides/a.md', text)).toEqual({
      citations: [],
      outsidePack: ['../../pages/guide/api.md'],
    });
  });
});

describe('citedSection', () => {
  it('runs from the heading to the next heading of the same or a higher level', () => {
    expect(citedSection(API_PAGE, 'install')).toBe(INSTALL_SECTION);
    expect(citedSection(API_PAGE, 'options')).toBe('### Options\n\nSome options.\n\n');
    expect(citedSection(API_PAGE, 'api')).toBe(API_PAGE);
  });

  it('suffixes duplicate slugs, runs the last section to the end, and skips headings in code', () => {
    expect(citedSection(API_PAGE, 'usage')).toBe('## Usage\n\nFirst usage.\n\n');
    expect(citedSection(API_PAGE, 'usage-1')).toBe(
      '## Usage\n\nSecond usage.\n\n```md\n## Not a heading\n```\n'
    );
    expect(citedSection(API_PAGE, 'not-a-heading')).toBeUndefined();
    expect(citedSection(API_PAGE, 'Install')).toBeUndefined();
  });

  it('understands setext headings', () => {
    const page = 'Title\n=====\n\nIntro.\n\nPart\n----\n\nBody.\n\nNext\n----\n';
    expect(citedSection(page, 'part')).toBe('Part\n----\n\nBody.\n\n');
    expect(citedSection(page, 'title')).toBe(page);
  });
});

describe('citedPageText', () => {
  it('drops only the provenance line the build adds', () => {
    expect(
      citedPageText('<!-- llm-docs: demo@1.0.0 | source: docs/a.md -->\n\n# A\n\nBody.\n')
    ).toBe('# A\n\nBody.\n');
    expect(citedPageText('<!-- llm-docs: demo@1.0.0 | source: docs/a.md -->\n')).toBe('');
    expect(citedPageText('# A\n\n<!-- llm-docs: x -->\n')).toBe('# A\n\n<!-- llm-docs: x -->\n');
  });
});

describe('stampGuides', () => {
  it('stamps every guide into a canonical lock and reports nothing to change on a second run', async () => {
    const root = await builtPack({ 'a.md': GUIDE_A, 'nested/b.md': GUIDE_B });

    const result = await stamp(root);
    expect(result).toEqual({
      packId: 'demo',
      lockPath: 'agent-docs/demo/guides/citations.lock.json',
      changed: true,
      guides: [
        { path: 'guides/a.md', sha256: sha256Prefixed(GUIDE_A), citations: 2 },
        { path: 'guides/nested/b.md', sha256: sha256Prefixed(GUIDE_B), citations: 0 },
      ],
      removed: [],
      warnings: [],
    });
    // guides/nested/b.md links ../files/..., which from guides/nested/ is guides/files/: not a citation.
    const expected = `${JSON.stringify(
      {
        guides: {
          'guides/a.md': {
            citations: [
              {
                sectionSha256: sha256Prefixed(INSTALL_SECTION),
                target: 'pages/guide/api.md#install',
              },
              {
                sectionSha256: sha256Prefixed('# Start\n\nBegin here.\n'),
                target: 'pages/guide/start.md',
              },
            ],
            sha256: sha256Prefixed(GUIDE_A),
          },
          'guides/nested/b.md': { citations: [], sha256: sha256Prefixed(GUIDE_B) },
        },
        schemaVersion: 1,
      },
      null,
      2
    )}\n`;
    expect(await readLock(root)).toBe(expected);

    const again = await stamp(root);
    expect(again.changed).toBe(false);
    expect(await readLock(root)).toBe(expected);

    // The same content written in another key and citation order is rewritten canonically.
    const reordered = JSON.parse(expected);
    reordered.guides['guides/a.md'].citations.reverse();
    await writeFile(
      lockFile(root),
      JSON.stringify({ schemaVersion: 1, guides: reordered.guides }, null, 4)
    );
    expect((await stamp(root)).changed).toBe(true);
    expect(await readLock(root)).toBe(expected);
    expect(await pathExists(join(root, 'agent-docs', '.llm-docs.lock'))).toBe(false);
  });

  it('hashes passthrough files byte for byte', async () => {
    const root = await builtPack({ 'b.md': GUIDE_B });
    await stamp(root);
    expect(JSON.parse(await readLock(root)).guides['guides/b.md'].citations).toEqual([
      { target: 'files/data/schema.json', sectionSha256: sha256Prefixed('{"a":1}\n') },
    ]);
  });

  it('stamps a subset named any of three ways and leaves the other entries alone', async () => {
    const root = await builtPack({ 'a.md': GUIDE_A, 'b.md': GUIDE_B });
    await stamp(root);
    const before = JSON.parse(await readLock(root));

    await writeFile(join(packDir(root), 'guides', 'a.md'), `${GUIDE_A}\nMore.\n`);
    await writeFile(join(packDir(root), 'guides', 'b.md'), `${GUIDE_B}\nMore.\n`);

    for (const [arg, cwd] of [
      ['a.md', root],
      ['guides/a.md', root],
      ['agent-docs/demo/guides/a.md', root],
      [join('..', 'guides', 'a.md'), join(packDir(root), 'pages')],
    ] as const) {
      const result = await stamp(root, [arg], cwd);
      expect(result.guides.map((guide) => guide.path)).toEqual(['guides/a.md']);
    }

    const after = JSON.parse(await readLock(root));
    expect(after.guides['guides/a.md'].sha256).toBe(sha256Prefixed(`${GUIDE_A}\nMore.\n`));
    expect(after.guides['guides/b.md']).toEqual(before.guides['guides/b.md']);

    await expect(stamp(root, ['c.md', 'docs/guide/api.md'])).rejects.toThrow(
      'Not a guide of pack "demo": c.md, docs/guide/api.md.'
    );
  });

  it('refuses, listing every unresolved citation, and writes nothing', async () => {
    const root = await builtPack({
      'a.md': GUIDE_A,
      'bad.md': [
        '# Bad',
        '',
        '[gone](../pages/guide/missing.md)',
        '[renamed](../pages/guide/api.md#setup)',
        '[fragment on data](../files/data/schema.json#a)',
        '[too high](../../pages/guide/api.md)',
      ].join('\n'),
    });

    const error = await stamp(root).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConfigError);
    expect(String(error)).toContain(
      '4 citations do not resolve: ' +
        'guides/bad.md: ../../pages/guide/api.md (the link leaves the pack; write it relative to the guide); ' +
        'guides/bad.md: files/data/schema.json#a (a fragment only resolves on a Markdown page); ' +
        'guides/bad.md: pages/guide/api.md#setup (no heading on the page has this slug); ' +
        'guides/bad.md: pages/guide/missing.md (no such file in the pack)'
    );
    expect(await pathExists(lockFile(root))).toBe(false);

    // Stamping only the good guide is fine.
    await stamp(root, ['a.md']);
    expect(Object.keys(JSON.parse(await readLock(root)).guides)).toEqual(['guides/a.md']);
  });

  it('refuses to stamp against pages that no longer match the manifest', async () => {
    const root = await builtPack({ 'a.md': GUIDE_A });
    await writeFile(join(packDir(root), 'pages', 'guide', 'start.md'), '# Start\n\nEdited.\n');

    await expect(stamp(root)).rejects.toThrow(
      "cited files differ from the manifest (pages/guide/start.md); run 'llm-docs sync demo' first"
    );
    expect(await pathExists(lockFile(root))).toBe(false);
  });

  it('drops and reports entries whose guide is gone, and replaces an invalid lock', async () => {
    const root = await builtPack({ 'a.md': GUIDE_A, 'b.md': GUIDE_B });
    await stamp(root);
    await rm(join(packDir(root), 'guides', 'b.md'));

    const result = await stamp(root, ['a.md']);
    expect(result.removed).toEqual(['guides/b.md']);
    expect(Object.keys(JSON.parse(await readLock(root)).guides)).toEqual(['guides/a.md']);

    await writeFile(lockFile(root), '{ not json');
    const repaired = await stamp(root);
    expect(repaired.warnings).toEqual([
      expect.stringContaining(
        'The previous agent-docs/demo/guides/citations.lock.json was invalid (not readable JSON'
      ),
    ]);
    expect((await assessCitations(packDir(root))).kind).toBe('assessed');
  });

  it('holds the packs lock: refused while a sync holds it, and a sync is refused meanwhile', async () => {
    const root = await builtPack({ 'a.md': GUIDE_A });
    const packsDir = join(root, 'agent-docs');

    await withPacksLock(packsDir, 'llm-docs sync', async () => {
      await expect(stamp(root)).rejects.toThrow(SyncLockedError);
    });
    await withPacksLock(packsDir, 'llm-docs guides stamp demo', async () => {
      await expect(syncPacks(root, undefined)).rejects.toThrow("'llm-docs guides stamp demo'");
    });
    expect(await pathExists(lockFile(root))).toBe(false);
    await stamp(root);
    expect(await readdir(packsDir)).not.toContain('.llm-docs.lock');
  });

  it('refuses a pack with nothing to stamp or no build', async () => {
    const root = await builtPack({});
    await expect(stamp(root)).rejects.toThrow('Pack "demo" has no guides to stamp');
    await rm(join(packDir(root), 'manifest.json'));
    await expect(stamp(root)).rejects.toThrow(
      'Pack "demo" cannot be stamped: manifest.json is missing; run \'llm-docs sync demo\' first.'
    );
    await rm(packDir(root), { recursive: true });
    await expect(stamp(root)).rejects.toThrow(
      "No pack directory agent-docs/demo/; build the pack with 'llm-docs sync demo' first."
    );
  });
});

describe('assessCitations', () => {
  it('reports every state against the pack as it is now', async () => {
    const root = await builtPack({});
    expect(await assessCitations(packDir(root))).toEqual({ kind: 'no-guides' });

    await writeFiles(join(packDir(root), 'guides'), { 'a.md': GUIDE_A, 'b.md': GUIDE_B });
    expect(await assessCitations(packDir(root))).toEqual({
      kind: 'assessed',
      unstamped: ['guides/a.md', 'guides/b.md'],
      guides: [],
    });

    await stamp(root);
    expect(await assessCitations(packDir(root))).toEqual({
      kind: 'assessed',
      unstamped: [],
      guides: [
        {
          path: 'guides/a.md',
          missing: false,
          edited: false,
          citations: [
            { target: 'pages/guide/api.md#install', state: 'ok' },
            { target: 'pages/guide/start.md', state: 'ok' },
          ],
        },
        {
          path: 'guides/b.md',
          missing: false,
          edited: false,
          citations: [{ target: 'files/data/schema.json', state: 'ok' }],
        },
      ],
    });

    // Upstream rewrites the Install section and drops the start page; a guide is edited, one deleted.
    await writeFiles(root, { 'docs/guide/api.md': API_PAGE.replace('Run it.', 'Run it twice.') });
    await rm(join(root, 'docs', 'guide', 'start.md'));
    await syncPacks(root, undefined);
    await writeFile(join(packDir(root), 'guides', 'a.md'), `${GUIDE_A}\nEdited.\n`);
    await rm(join(packDir(root), 'guides', 'b.md'));
    await writeFile(join(packDir(root), 'guides', 'c.md'), '# New\n');

    expect(await assessCitations(packDir(root))).toEqual({
      kind: 'assessed',
      unstamped: ['guides/c.md'],
      guides: [
        {
          path: 'guides/a.md',
          missing: false,
          edited: true,
          citations: [
            { target: 'pages/guide/api.md#install', state: 'section-changed' },
            { target: 'pages/guide/start.md', state: 'unresolved', reason: 'no-such-file' },
          ],
        },
        { path: 'guides/b.md', missing: true },
      ],
    });
  });

  it('keeps whole-page citations stable when only the version in the provenance line moves', async () => {
    const root = await builtPack({ 'a.md': GUIDE_A });
    await stamp(root);
    await setRecipe(root, '1.0.1');
    expect((await syncPacks(root, undefined)).packs[0]).toMatchObject({
      status: 'built',
      reason: 'the recipe changed',
    });
    expect(await readFile(join(packDir(root), 'pages', 'guide', 'start.md'), 'utf-8')).toContain(
      'demo@1.0.1'
    );

    const assessment = await assessCitations(packDir(root));
    expect(assessment).toMatchObject({
      kind: 'assessed',
      guides: [
        {
          path: 'guides/a.md',
          citations: [
            { target: 'pages/guide/api.md#install', state: 'ok' },
            { target: 'pages/guide/start.md', state: 'ok' },
          ],
        },
      ],
    });
  });

  it('turns a corrupt or hand-edited lock into a typed result', async () => {
    const root = await builtPack({ 'a.md': GUIDE_A });
    await stamp(root);
    const valid = JSON.parse(await readLock(root));

    for (const [lock, message] of [
      ['[]', 'expected object'],
      ['{"schemaVersion": 2, "guides": {}}', 'schemaVersion'],
      [
        JSON.stringify({
          ...valid,
          guides: {
            'guides/a.md': {
              ...valid.guides['guides/a.md'],
              citations: [{ target: '../x.md', sectionSha256: valid.guides['guides/a.md'].sha256 }],
            },
          },
        }),
        'must be a path under pages/ or files/',
      ],
      [JSON.stringify({ ...valid, guides: { 'guides/../x.md': {} } }), 'guides'],
    ] as const) {
      await writeFile(lockFile(root), lock);
      const assessment = await assessCitations(packDir(root));
      expect(assessment.kind).toBe('invalid-lock');
      expect(assessment.kind === 'invalid-lock' ? assessment.message : '').toContain(message);
    }
  });
});
