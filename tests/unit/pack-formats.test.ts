import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { syncPacks, type SyncOptions } from '../../src/pack/build.js';
import { readPackManifest } from '../../src/pack/manifest.js';
import { verifyPacks, type VerifyReport } from '../../src/pack/verify.js';
import { ALLOW_TEMP_SOURCES_ENV } from '../../src/sources/acquire.js';

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

async function makeProject(
  packs: Record<string, unknown>,
  files: Record<string, string>
): Promise<string> {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'llm-docs-formats-'));
  tempDirs.push(root);
  await writeFiles(root, {
    ...files,
    'llm-docs.json': `${JSON.stringify({ schemaVersion: 3, packs }, null, 2)}\n`,
  });
  return root;
}

function problems(report: VerifyReport): string[] {
  return report.results.flatMap((result) =>
    result.findings
      .filter((finding) => finding.status === 'fail' || finding.status === 'warn')
      .map(
        (finding) => `${result.check} ${finding.status}: ${finding.path ?? ''} ${finding.message}`
      )
  );
}

const clock: SyncOptions['now'] = () => new Date('2026-11-05T10:00:00.000Z');

const QUICKSTART = [
  'Quickstart',
  '==========',
  '',
  'Back to the `index <../index.md>`_.',
  '',
  'Installation',
  '------------',
  '',
  '.. code-block:: console',
  '',
  '   $ pip install widgets',
  '',
].join('\n');

const MIXED: Record<string, string> = {
  'docs/index.md': [
    '# Widgets',
    '',
    'Start with the [quickstart](guide/quickstart.rst), read the [client](api/client.html#options),',
    'browse the [pets API](api/petstore.yaml) or [the pets tag](/api/petstore/pets), and see',
    '[the changelog](../CHANGELOG.md).',
    '',
    '## Setup',
    '',
    'Jump to [setup](#setup) or to [installation](guide/quickstart.rst#installation).',
    '',
  ].join('\n'),
  'docs/guide/quickstart.rst': QUICKSTART,
  'docs/api/client.html': [
    '<title>Client</title>',
    '<nav><a href="/nowhere">Home</a></nav>',
    '<h1>Client</h1>',
    '<p>See <a href="../guide/quickstart.html#installation">installing</a>.</p>',
    '<h2>Options</h2>',
    '<p>Pass <code>timeout</code>.</p>',
  ].join('\n'),
  'docs/api/petstore.yaml': [
    'openapi: 3.0.3',
    'info: { title: Petstore, version: 1.0.0 }',
    'paths:',
    '  /pets:',
    '    get:',
    '      tags: [pets]',
    '      summary: List pets',
    "      responses: { '200': { description: OK } }",
    '',
  ].join('\n'),
  'CHANGELOG.md': '# Changelog\n',
};

const SOURCE = {
  type: 'local',
  path: 'docs',
  include: ['**/*.{md,rst,html}', 'api/petstore.yaml'],
};
const PACK = { title: 'Widgets', version: '2.0.0', license: 'MIT', sources: [SOURCE] };

describe('syncPacks: reStructuredText, HTML, and OpenAPI pages', () => {
  it('renders every format into pages whose links resolve, and verifies strictly', async () => {
    const root = await makeProject({ demo: PACK }, MIXED);
    const report = await syncPacks(root, undefined, { now: clock });
    expect(report.packs[0]).toMatchObject({ status: 'built' });

    const pack = join(root, 'agent-docs', 'demo');
    const manifest = await readPackManifest(pack);
    expect(manifest.outputs.map((output) => `${output.kind} ${output.path}`)).toEqual([
      'index index.md',
      'page pages/api/client.md',
      'page pages/api/petstore/index.md',
      'page pages/api/petstore/pets.md',
      'page pages/guide/quickstart.md',
      'page pages/index.md',
    ]);
    expect(
      manifest.outputs.find((output) => output.path === 'pages/api/petstore/pets.md')
    ).toMatchObject({ title: 'pets', sources: ['0:api/petstore.yaml'] });

    const index = await readFile(join(pack, 'pages', 'index.md'), 'utf-8');
    expect(index).toContain('[quickstart](guide/quickstart.md)');
    expect(index).toContain('[client](api/client.md#options)');
    expect(index).toContain('[pets API](api/petstore/index.md)');
    expect(index).toContain('[the pets tag](api/petstore/pets.md)');
    expect(index).toContain('[the changelog] (unresolved: ../CHANGELOG.md)');
    expect(index).toContain('[installation](guide/quickstart.md#installation)');
    expect(await readFile(join(pack, 'pages', 'guide', 'quickstart.md'), 'utf-8')).toBe(
      [
        '<!-- llm-docs: demo@2.0.0 | source: docs/guide/quickstart.rst -->',
        '',
        '# Quickstart',
        '',
        'Back to the [index](../index.md).',
        '',
        '## Installation',
        '',
        '```console',
        '$ pip install widgets',
        '```',
        '',
      ].join('\n')
    );
    const client = await readFile(join(pack, 'pages', 'api', 'client.md'), 'utf-8');
    expect(client).toContain('See [installing](../guide/quickstart.md#installation).');
    expect(client).not.toContain('nowhere');
    expect(manifest.links.unresolved).toEqual([
      { page: 'pages/index.md', target: '../CHANGELOG.md', reason: 'outside-source' },
    ]);
    expect(problems(await verifyPacks(root, undefined, { strict: true }))).toEqual([]);
  });

  it('takes OpenAPI documents only when an include names them', async () => {
    const root = await makeProject(
      { demo: { ...PACK, sources: [{ type: 'local', path: 'docs' }] } },
      MIXED
    );
    await syncPacks(root, undefined);
    const manifest = await readPackManifest(join(root, 'agent-docs', 'demo'));
    expect(manifest.outputs.some((output) => output.path.startsWith('pages/api/petstore'))).toBe(
      false
    );
  });

  it('rejects an OpenAPI tag page that collides with another page', async () => {
    const root = await makeProject(
      { demo: PACK },
      { ...MIXED, 'docs/api/petstore/pets.md': '# Pets\n' }
    );
    expect((await syncPacks(root, undefined)).packs[0]?.error).toMatch(
      /would both be written to pages\/api\/petstore\/pets\.md/
    );
  });

  it('names a file the parser rejects', async () => {
    const root = await makeProject(
      { demo: { ...PACK, sources: [{ ...SOURCE, include: ['api/broken.yaml'] }] } },
      { 'docs/api/broken.yaml': 'openapi: 3.0.0\npaths: []\n' }
    );
    expect((await syncPacks(root, undefined)).packs[0]?.error).toMatch(
      /docs\/api\/broken\.yaml could not be converted/
    );
  });
});
