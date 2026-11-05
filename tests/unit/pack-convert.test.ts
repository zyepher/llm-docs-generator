import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { syncPacks } from '../../src/pack/build.js';
import { readPackManifest } from '../../src/pack/manifest.js';
import { verifyPacks, type VerifyReport } from '../../src/pack/verify.js';
import { ALLOW_TEMP_SOURCES_ENV, type SelectedConversion } from '../../src/sources/acquire.js';
import { createDocumentConverter } from '../../src/sources/convert.js';
import { sha256Prefixed } from '../../src/utils/hash.js';
import { installFakeConverters, writeCommandConverter } from '../helpers/fake-converters.js';

const tempDirs: string[] = [];
const ENV_KEYS = [ALLOW_TEMP_SOURCES_ENV, 'PATH', 'LLM_DOCS_CACHE_DIR', 'FAKE_CONVERTER_LOG'];
let savedEnv: Record<string, string | undefined> = {};
let binDir: string;
let cacheDir: string;
let logPath: string;

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), prefix));
  tempDirs.push(dir);
  return dir;
}

// Installed once: the first run of a new executable is slow on some systems (macOS scans it).
let toolsDir: string;

beforeAll(async () => {
  toolsDir = await mkdtemp(join(await realpath(tmpdir()), 'llm-docs-tools-'));
  binDir = join(toolsDir, 'bin');
  await installFakeConverters(binDir);
});

afterAll(async () => {
  await rm(toolsDir, { recursive: true, force: true });
});

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const state = await tempDir('llm-docs-state-');
  cacheDir = join(state, 'cache');
  logPath = join(state, 'conversions.log');
  process.env[ALLOW_TEMP_SOURCES_ENV] = '1';
  process.env.PATH = `${binDir}${delimiter}${savedEnv.PATH ?? ''}`;
  process.env.LLM_DOCS_CACHE_DIR = cacheDir;
  process.env.FAKE_CONVERTER_LOG = logPath;
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
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

async function makeProject(source: Record<string, unknown>, files: Record<string, string>) {
  const root = await tempDir('llm-docs-convert-');
  await writeFiles(root, files);
  await setSource(root, source);
  return root;
}

async function setSource(root: string, source: Record<string, unknown>): Promise<void> {
  const pack = { version: '1.0.0', sources: [{ type: 'local', path: 'docs', ...source }] };
  await writeFile(
    join(root, 'llm-docs.json'),
    JSON.stringify({ schemaVersion: 3, packs: { manuals: pack } })
  );
}

const page = (root: string, path: string): Promise<string> =>
  readFile(join(root, 'agent-docs', 'manuals', ...path.split('/')), 'utf-8');

async function conversionLog(): Promise<string[]> {
  try {
    return (await readFile(logPath, 'utf-8')).trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function problems(report: VerifyReport): string[] {
  return report.results.flatMap((result) =>
    result.findings
      .filter((finding) => finding.status === 'fail' || finding.status === 'warn')
      .map((finding) => `${result.check} ${finding.status}: ${finding.message}`)
  );
}

const DOCS = {
  'docs/index.md': '# Manuals\n\nSee the [spec sheet](spec.md).\n',
  'docs/spec.pdf': 'Operating voltage: 12 V\n',
  'docs/install.docx': 'Hold the reset button.\n',
};

describe('markitdown and docling converters', () => {
  it('converts documents with markitdown through the Markdown page path', async () => {
    const root = await makeProject({ convert: { tool: 'markitdown' } }, DOCS);
    const report = await syncPacks(root, undefined);

    expect(report.packs).toEqual([expect.objectContaining({ status: 'built' })]);
    expect(await page(root, 'pages/spec.md')).toBe(
      '<!-- llm-docs: manuals@1.0.0 | source: docs/spec.pdf -->\n\n# spec.pdf\n\nConverted by markitdown: Operating voltage: 12 V\n'
    );

    const manifest = await readPackManifest(join(root, 'agent-docs', 'manuals'));
    const spec = manifest.sources.find((entry) => entry.path === 'spec.pdf');
    expect(spec).toMatchObject({
      sha256: sha256Prefixed(DOCS['docs/spec.pdf']),
      converter: {
        tool: 'markitdown',
        version: 'markitdown 0.1.9',
        outputSha256: sha256Prefixed(
          '# spec.pdf\n\nConverted by markitdown: Operating voltage: 12 V\n'
        ),
      },
    });
    expect(manifest.outputs.find((output) => output.path === 'pages/spec.md')).toMatchObject({
      kind: 'page',
      title: 'spec.pdf',
      sources: ['0:spec.pdf'],
    });
    expect(manifest.sources.find((entry) => entry.path === 'index.md')?.converter).toBeUndefined();

    const verify = await verifyPacks(root, undefined);
    expect(problems(verify)).toEqual([]);
    expect(verify.results.find((result) => result.check === 'conversion')?.status).toBe('pass');
  });

  it('runs docling with the documented arguments and records the first --version line', async () => {
    const root = await makeProject({ convert: { tool: 'docling' } }, DOCS);
    await syncPacks(root, undefined);

    expect(await page(root, 'pages/install.md')).toContain(
      'Converted by docling: Hold the reset button.\n\n<!-- image (placeholder) -->'
    );
    const manifest = await readPackManifest(join(root, 'agent-docs', 'manuals'));
    expect(
      manifest.sources.find((entry) => entry.path === 'install.docx')?.converter
    ).toMatchObject({ tool: 'docling', version: 'Docling version: 2.147.0' });
  });

  it('carries a file matched by both passthrough and convert byte-identical', async () => {
    const root = await makeProject(
      { convert: { tool: 'markitdown' }, passthrough: ['**/*.pdf'] },
      { ...DOCS, 'docs/index.md': '# Manuals\n\nSee the [spec sheet](../files/spec.pdf).\n' }
    );
    await syncPacks(root, undefined);

    expect(await page(root, 'files/spec.pdf')).toBe(DOCS['docs/spec.pdf']);
    expect(await conversionLog()).toEqual(['markitdown install.docx']);
  });

  it('names the install command when the tool is missing', async () => {
    const root = await makeProject({ convert: { tool: 'markitdown' } }, DOCS);
    // A PATH with nothing on it, so a real markitdown on this machine cannot be found either.
    process.env.PATH = await tempDir('llm-docs-empty-path-');
    const report = await syncPacks(root, undefined);

    expect(report.packs[0]).toMatchObject({ status: 'failed', exitCode: 3 });
    expect(report.packs[0]?.error).toContain("install it with: pipx install 'markitdown[all]'");
  });

  it('fails with the file and the stderr tail on a non-zero exit, and on empty output', async () => {
    const root = await makeProject(
      { convert: { tool: 'markitdown' } },
      { ...DOCS, 'docs/spec.pdf': 'FAIL here\n' }
    );
    const failed = await syncPacks(root, undefined);

    expect(failed.packs[0]).toMatchObject({ status: 'failed', exitCode: 3 });
    expect(failed.packs[0]?.error).toMatch(
      /^Converting docs\/spec\.pdf with markitdown failed: exit code 1; stderr: Traceback .*ValueError: cannot parse spec\.pdf$/
    );

    await writeFile(join(root, 'docs', 'spec.pdf'), 'EMPTY\n');
    const empty = await syncPacks(root, undefined);
    expect(empty.packs[0]?.error).toBe(
      'Converting docs/spec.pdf with markitdown failed: it produced empty output'
    );
  });

  it('reuses cached conversions across rebuilds and misses on new input or a new version', async () => {
    const root = await makeProject({ convert: { tool: 'markitdown' } }, DOCS);
    await syncPacks(root, undefined);
    expect((await conversionLog()).sort()).toEqual([
      'markitdown install.docx',
      'markitdown spec.pdf',
    ]);

    // An unchanged pack is skipped without converting anything.
    expect((await syncPacks(root, undefined)).packs[0]?.status).toBe('unchanged');
    expect(await conversionLog()).toHaveLength(2);

    // Another file changes: the pack rebuilds, but unchanged documents come from the cache.
    await writeFile(join(root, 'docs', 'index.md'), '# Manuals v2\n');
    expect((await syncPacks(root, undefined)).packs[0]?.status).toBe('built');
    expect(await conversionLog()).toHaveLength(2);

    // A changed document is converted again; the other still comes from the cache.
    await writeFile(join(root, 'docs', 'spec.pdf'), 'Operating voltage: 24 V\n');
    await syncPacks(root, undefined);
    expect((await conversionLog()).slice(2)).toEqual(['markitdown spec.pdf']);
    expect(await page(root, 'pages/spec.md')).toContain('24 V');

    // A new tool version misses the cache for every document.
    process.env.FAKE_MARKITDOWN_VERSION = '0.2.0';
    try {
      await writeFile(join(root, 'docs', 'index.md'), '# Manuals v3\n');
      await syncPacks(root, undefined);
    } finally {
      delete process.env.FAKE_MARKITDOWN_VERSION;
    }
    expect((await conversionLog()).slice(3).sort()).toEqual([
      'markitdown install.docx',
      'markitdown spec.pdf',
    ]);
    const manifest = await readPackManifest(join(root, 'agent-docs', 'manuals'));
    expect(manifest.sources.find((entry) => entry.path === 'spec.pdf')?.converter?.version).toBe(
      'markitdown 0.2.0'
    );
  });
});

describe('command converters', () => {
  it('reads {output} when the argv names it, else stdout', async () => {
    const script = await writeCommandConverter(await tempDir('llm-docs-command-'));
    const include = ['**/*.pdf'];
    const root = await makeProject(
      {
        convert: {
          tool: 'command',
          include,
          command: [process.execPath, script, '{input}', '--out', '{output}'],
        },
      },
      DOCS
    );
    await syncPacks(root, undefined);
    expect(await page(root, 'pages/spec.md')).toContain(
      'Converted by command: Operating voltage: 12 V'
    );
    const manifest = await readPackManifest(join(root, 'agent-docs', 'manuals'));
    expect(manifest.sources.find((entry) => entry.path === 'spec.pdf')?.converter).toMatchObject({
      tool: 'command',
      version: process.version,
    });

    await setSource(root, {
      convert: { tool: 'command', include, command: [process.execPath, script, '{input}'] },
    });
    expect((await syncPacks(root, undefined)).packs[0]).toMatchObject({
      status: 'built',
      reason: 'the recipe changed',
    });
    expect(await page(root, 'pages/spec.md')).toContain('Converted by command');
    expect(await conversionLog()).toEqual(['command spec.pdf', 'command spec.pdf']);
  });

  it('requires an {input} placeholder', async () => {
    const root = await makeProject(
      { convert: { tool: 'command', include: ['**/*.pdf'], command: [process.execPath, 'x'] } },
      DOCS
    );
    const report = await syncPacks(root, undefined);
    expect(report.packs[0]).toMatchObject({ status: 'failed', exitCode: 2 });
    expect(report.packs[0]?.error).toContain('{input} placeholder');
  });

  it('kills a converter that runs past its timeout', async () => {
    const work = await tempDir('llm-docs-timeout-');
    const pidFile = join(work, 'pid');
    const input = join(work, 'slow.pdf');
    await writeFile(input, 'SLEEP\n');
    const converter = await createDocumentConverter(
      // Long enough for a cold node start on a loaded CI machine to write its pid.
      { tool: 'markitdown', include: ['**/*.pdf'], command: null, timeoutSeconds: 3 },
      {
        projectRoot: work,
        workDir: join(work, 'convert'),
        cacheDir: null,
        env: { ...process.env, FAKE_PID_FILE: pidFile },
      }
    );
    const selected: SelectedConversion = {
      kind: 'convert',
      sourceIndex: 0,
      outputPath: 'pages/slow.md',
      file: {
        path: 'slow.pdf',
        absolutePath: input,
        sha256: sha256Prefixed('SLEEP\n'),
        bytes: 6,
        sourceLabel: 'docs/slow.pdf',
      },
    };
    const started = Date.now();

    await expect(converter.convert(selected, undefined)).rejects.toThrow(
      /^Converting docs\/slow\.pdf with markitdown failed: it ran longer than 3 s and was stopped/
    );
    expect(Date.now() - started).toBeLessThan(15_000);

    const pid = Number(await readFile(pidFile, 'utf-8'));
    let alive = true;
    for (let attempt = 0; attempt < 50 && alive; attempt += 1) {
      try {
        process.kill(pid, 0);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });

  it('refuses inputs over the size cap before running anything', async () => {
    const work = await tempDir('llm-docs-cap-');
    const converter = await createDocumentConverter(
      { tool: 'markitdown', include: ['**/*.pdf'], command: null, timeoutSeconds: 5 },
      { projectRoot: work, workDir: join(work, 'convert'), cacheDir: null }
    );
    await expect(
      converter.convert(
        {
          kind: 'convert',
          sourceIndex: 0,
          outputPath: 'pages/big.md',
          file: {
            path: 'big.pdf',
            absolutePath: join(work, 'big.pdf'),
            sha256: sha256Prefixed('x'),
            bytes: 201 * 1024 * 1024,
            sourceLabel: 'docs/big.pdf',
          },
        },
        undefined
      )
    ).rejects.toThrow('over the 209715200 byte converter input limit');
    expect(await conversionLog()).toEqual([]);
  });
});

describe('agent conversions', () => {
  const AGENT = { convert: { tool: 'agent', include: ['**/*.pdf'] } };
  const AGENT_DOCS = {
    ...DOCS,
    'docs/spec.pdf.md': '# Spec sheet\n\nThe agent read the PDF: 12 V.\n',
  };

  it('uses the sibling .md and records both hashes', async () => {
    const root = await makeProject(AGENT, AGENT_DOCS);
    const report = await syncPacks(root, undefined);

    expect(report.packs[0]).toMatchObject({ status: 'built' });
    expect(await page(root, 'pages/spec.md')).toBe(
      '<!-- llm-docs: manuals@1.0.0 | source: docs/spec.pdf -->\n\n# Spec sheet\n\nThe agent read the PDF: 12 V.\n'
    );

    const manifest = await readPackManifest(join(root, 'agent-docs', 'manuals'));
    const original = sha256Prefixed(AGENT_DOCS['docs/spec.pdf']);
    const output = sha256Prefixed(AGENT_DOCS['docs/spec.pdf.md']);
    expect(manifest.sources.filter((entry) => entry.path.startsWith('spec.pdf'))).toEqual([
      {
        source: 0,
        path: 'spec.pdf',
        sha256: original,
        bytes: 24,
        converter: { tool: 'agent', version: null, outputSha256: output, inputSha256: original },
      },
      { source: 0, path: 'spec.pdf.md', sha256: output, bytes: 44 },
    ]);
    expect(manifest.outputs.map((entry) => entry.path)).not.toContain('pages/spec.pdf.md');
    expect(manifest.outputs.find((entry) => entry.path === 'pages/spec.md')?.sources).toEqual([
      '0:spec.pdf',
      '0:spec.pdf.md',
    ]);
    expect(problems(await verifyPacks(root, undefined))).toEqual([]);
  });

  it('fails the pack when the agent has not written the conversion yet', async () => {
    const root = await makeProject(AGENT, DOCS);
    const report = await syncPacks(root, undefined);

    expect(report.packs[0]).toMatchObject({ status: 'failed', exitCode: 2 });
    expect(report.packs[0]?.error).toContain(
      'docs/spec.pdf is converted by an agent, but docs/spec.pdf.md does not exist'
    );
  });

  it('reports a stale conversion in verify and sync until the agent rewrites the .md', async () => {
    const root = await makeProject(AGENT, AGENT_DOCS);
    await syncPacks(root, undefined);

    // The original changes; the agent's conversion does not.
    await writeFile(join(root, 'docs', 'spec.pdf'), 'Operating voltage: 24 V\n');
    expect(problems(await verifyPacks(root, undefined))).toEqual([
      "conversion fail: stale agent conversion: docs/spec.pdf changed since the last sync; have an agent convert it again into spec.pdf.md, then run 'llm-docs sync manuals'",
    ]);

    const stale = await syncPacks(root, undefined);
    expect(stale.packs[0]).toMatchObject({ status: 'built', reason: 'source files changed' });
    expect(stale.packs[0]?.warnings).toContain(
      'Agent conversion docs/spec.pdf.md is stale: docs/spec.pdf changed after it was written; convert the document again into docs/spec.pdf.md, then sync.'
    );
    expect(problems(await verifyPacks(root, undefined))).toEqual([
      "conversion fail: stale agent conversion: docs/spec.pdf changed after spec.pdf.md was written; have an agent convert it again into spec.pdf.md, then run 'llm-docs sync manuals'",
    ]);

    // Still stale on a rebuild for another reason.
    await writeFile(join(root, 'docs', 'index.md'), '# Manuals v2\n');
    expect((await syncPacks(root, undefined)).packs[0]?.warnings.join('\n')).toContain('is stale');

    // The agent rewrites the conversion: fresh again.
    await writeFile(join(root, 'docs', 'spec.pdf.md'), '# Spec sheet\n\nNow 24 V.\n');
    const fresh = await syncPacks(root, undefined);
    expect(fresh.packs[0]?.warnings.join('\n')).not.toContain('is stale');
    expect(problems(await verifyPacks(root, undefined))).toEqual([]);
    expect(await page(root, 'pages/spec.md')).toContain('Now 24 V.');
  });
});
