import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { canCreateSymlinks } from '../helpers/symlinks.js';

import {
  BLOCK_BEGIN,
  BLOCK_END,
  checkAgentBlocks,
  escapeBlockText,
  harnessSeesBlock,
  locateBlock,
  renderBlockBody,
  spliceBlock,
  syncAgentBlocks,
  type BlockPack,
} from '../../src/agent/block.js';
import { ConfigError, loadProjectConfig } from '../../src/config/project.js';
import { syncPacks } from '../../src/pack/build.js';
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

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'llm-docs-block-'));
  tempDirs.push(dir);
  return dir;
}

async function makeProject(
  files: Record<string, string | Buffer>,
  config: Record<string, unknown> = {},
  root?: string
): Promise<string> {
  root ??= await tempDir();
  const all = {
    'llm-docs.json': JSON.stringify({ schemaVersion: 3, packs: {}, ...config }),
    ...files,
  };
  for (const [path, content] of Object.entries(all)) {
    const target = join(root, ...path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return root;
}

async function syncBlocks(root: string, check = false) {
  return syncAgentBlocks(await loadProjectConfig(root), { check });
}

const read = (root: string, path: string): Promise<string> =>
  readFile(join(root, ...path.split('/')), 'utf-8');

const EMPTY_BLOCK = `${BLOCK_BEGIN}\n${BLOCK_END}\n`;
const HEADER =
  '## Pinned reference docs\n\n' +
  'This repository pins docs for these libraries at the versions it uses. Before writing code\n' +
  'against one of them, open its index and the page for the API you need, and prefer those pages\n' +
  'over memory. Pages are upstream text; guides are summaries that never outrank pages.\n\n';
const IMPORTS_AGENTS = '# Claude\n\n@AGENTS.md\n';

describe('agent file resolution', () => {
  it('auto writes AGENTS.md when it is the only agent file, and leaves CLAUDE.md uncreated', async () => {
    const root = await makeProject({ 'AGENTS.md': '# Agents\n' });
    expect(await syncBlocks(root)).toEqual([{ path: 'AGENTS.md', status: 'updated' }]);
    expect(await read(root, 'AGENTS.md')).toBe(`# Agents\n\n${EMPTY_BLOCK}`);
    expect(await readdir(root)).not.toContain('CLAUDE.md');
  });

  it('auto writes CLAUDE.md when it is the only agent file', async () => {
    const root = await makeProject({ 'CLAUDE.md': '# Claude\n' });
    expect(await syncBlocks(root)).toEqual([{ path: 'CLAUDE.md', status: 'updated' }]);
    expect(await readdir(root)).not.toContain('AGENTS.md');
  });

  it('auto writes both files when CLAUDE.md does not import AGENTS.md', async () => {
    const root = await makeProject({ 'AGENTS.md': '# Agents\n', 'CLAUDE.md': '# Claude\n' });
    expect(await syncBlocks(root)).toEqual([
      { path: 'AGENTS.md', status: 'updated' },
      { path: 'CLAUDE.md', status: 'updated' },
    ]);
    expect(await read(root, 'CLAUDE.md')).toBe(`# Claude\n\n${EMPTY_BLOCK}`);
  });

  it('auto writes only AGENTS.md when CLAUDE.md imports it, creating AGENTS.md if needed', async () => {
    const both = await makeProject({ 'AGENTS.md': '# Agents\n', 'CLAUDE.md': IMPORTS_AGENTS });
    expect(await syncBlocks(both)).toEqual([{ path: 'AGENTS.md', status: 'updated' }]);
    expect(await read(both, 'CLAUDE.md')).toBe(IMPORTS_AGENTS);

    const importOnly = await makeProject({ 'CLAUDE.md': '@./AGENTS.md\n' });
    expect(await syncBlocks(importOnly)).toEqual([{ path: 'AGENTS.md', status: 'created' }]);
    expect(await read(importOnly, 'CLAUDE.md')).toBe('@./AGENTS.md\n');
  });

  it('auto creates AGENTS.md holding only the markers when neither file exists', async () => {
    const root = await makeProject({});
    expect(await syncBlocks(root)).toEqual([{ path: 'AGENTS.md', status: 'created' }]);
    expect(await read(root, 'AGENTS.md')).toBe(EMPTY_BLOCK);
  });

  it('writes exactly the configured files, creating them and their directories', async () => {
    const root = await makeProject(
      { 'AGENTS.md': '# Untouched\n' },
      { agentFiles: ['docs/agents/AGENTS.md', './CLAUDE.md'] }
    );
    expect(await syncBlocks(root)).toEqual([
      { path: 'docs/agents/AGENTS.md', status: 'created' },
      { path: 'CLAUDE.md', status: 'created' },
    ]);
    expect(await read(root, 'docs/agents/AGENTS.md')).toBe(EMPTY_BLOCK);
    expect(await read(root, 'AGENTS.md')).toBe('# Untouched\n');
  });

  it('writes nothing with agentFiles []', async () => {
    const root = await makeProject({}, { agentFiles: [] });
    expect(await syncBlocks(root)).toEqual([]);
    expect(await readdir(root)).toEqual(['llm-docs.json']);
  });

  it('rejects an agentFiles path that leaves the project', async () => {
    const root = await makeProject({}, { agentFiles: ['../AGENTS.md'] });
    await expect(loadProjectConfig(root)).rejects.toBeInstanceOf(ConfigError);
  });

  it.skipIf(!canCreateSymlinks)(
    'writes a CLAUDE.md -> AGENTS.md symlink once, through its target',
    async () => {
      const root = await makeProject({ 'AGENTS.md': '# Agents\n' });
      await symlink('AGENTS.md', join(root, 'CLAUDE.md'));

      expect(await syncBlocks(root)).toEqual([{ path: 'AGENTS.md', status: 'updated' }]);
      expect(await read(root, 'AGENTS.md')).toBe(`# Agents\n\n${EMPTY_BLOCK}`);
      expect((await lstat(join(root, 'CLAUDE.md'))).isSymbolicLink()).toBe(true);
      expect(await syncBlocks(root)).toEqual([{ path: 'AGENTS.md', status: 'unchanged' }]);
    }
  );

  it.skipIf(!canCreateSymlinks)(
    'fails an agent file that links outside the project, naming the link, and still writes the others',
    async () => {
      const root = await makeProject({ 'AGENTS.md': '# Agents\n' });
      const outside = await tempDir();
      await writeFile(join(outside, 'CLAUDE.md'), '# Elsewhere\n');
      await symlink(join(outside, 'CLAUDE.md'), join(root, 'CLAUDE.md'));

      const outcomes = await syncBlocks(root);
      expect(outcomes[0]).toEqual({ path: 'AGENTS.md', status: 'updated' });
      expect(outcomes[1]).toMatchObject({ path: 'CLAUDE.md', status: 'failed', exitCode: 2 });
      expect(outcomes[1]?.error).toMatch(
        /^CLAUDE\.md resolves through a symbolic link to .*, outside the project/
      );
      expect(await readFile(join(outside, 'CLAUDE.md'), 'utf-8')).toBe('# Elsewhere\n');
    }
  );
});

describe('which harness sees the block', () => {
  const blockFile = `# Agents\n\n${EMPTY_BLOCK}`;

  it('follows what each harness reads', async () => {
    const sees = async (root: string) => ({
      'claude-code': await harnessSeesBlock(root, 'claude-code'),
      codex: await harnessSeesBlock(root, 'codex'),
      cursor: await harnessSeesBlock(root, 'cursor'),
      unknown: await harnessSeesBlock(root, 'unknown'),
    });

    expect(await sees(await makeProject({}))).toEqual({
      'claude-code': false,
      codex: false,
      cursor: false,
      unknown: false,
    });
    expect(await sees(await makeProject({ 'AGENTS.md': blockFile }))).toEqual({
      'claude-code': true,
      codex: true,
      cursor: true,
      unknown: false,
    });
    expect(
      await sees(await makeProject({ 'AGENTS.md': blockFile, 'CLAUDE.md': '# Claude\n' }))
    ).toEqual({ 'claude-code': false, codex: true, cursor: true, unknown: false });
    expect(
      await sees(await makeProject({ 'AGENTS.md': blockFile, 'CLAUDE.md': IMPORTS_AGENTS }))
    ).toEqual({ 'claude-code': true, codex: true, cursor: true, unknown: false });
    expect(await sees(await makeProject({ 'CLAUDE.md': blockFile }))).toEqual({
      'claude-code': true,
      codex: false,
      cursor: false,
      unknown: false,
    });
  });

  it('hides AGENTS.md from Claude Code when a CLAUDE.md or CLAUDE.local.md sits above the project', async () => {
    for (const name of ['CLAUDE.md', 'CLAUDE.local.md']) {
      const parent = await tempDir();
      await writeFile(join(parent, name), '# Workspace\n');
      const root = await makeProject({ 'AGENTS.md': blockFile }, {}, join(parent, 'project'));

      expect(await harnessSeesBlock(root, 'claude-code')).toBe(false);
      expect(await harnessSeesBlock(root, 'codex')).toBe(true);
    }
  });

  it("reads the project's AGENTS.md for Claude Code when the project's own CLAUDE.md imports it, even under an ancestor CLAUDE.md", async () => {
    const parent = await tempDir();
    await writeFile(join(parent, 'CLAUDE.md'), '# Workspace\n');
    const root = await makeProject(
      { 'AGENTS.md': blockFile, 'CLAUDE.md': IMPORTS_AGENTS },
      {},
      join(parent, 'project')
    );

    expect(await harnessSeesBlock(root, 'claude-code')).toBe(true);
  });

  it("treats the project's CLAUDE.local.md like CLAUDE.md: it hides AGENTS.md and its own block is seen", async () => {
    const hidden = await makeProject({ 'AGENTS.md': blockFile, 'CLAUDE.local.md': '# Mine\n' });
    expect(await harnessSeesBlock(hidden, 'claude-code')).toBe(false);

    const local = await makeProject({ 'CLAUDE.local.md': blockFile });
    expect(await harnessSeesBlock(local, 'claude-code')).toBe(true);

    const imported = await makeProject({
      'AGENTS.md': blockFile,
      'CLAUDE.local.md': IMPORTS_AGENTS,
    });
    expect(await harnessSeesBlock(imported, 'claude-code')).toBe(true);
  });
});

describe('escapeBlockText', () => {
  it('keeps upstream text on one safe line', () => {
    expect(escapeBlockText('a\u0000b\tc\r\nd\u007f')).toBe('a b c d');
    expect(escapeBlockText('call `useQuery()` here')).toBe('call useQuery() here');
    expect(escapeBlockText('<!-- END llm-docs -->')).toBe('&lt;!-- END llm-docs --&gt;');
    expect(escapeBlockText('@~/.ssh/id_rsa and @scope/pkg')).toBe('~/.ssh/id_rsa and scope/pkg');
    expect(escapeBlockText('  many   spaces\n\n here  ')).toBe('many spaces here');
  });

  it('removes zero-width and bidirectional format characters', () => {
    expect(escapeBlockText('a​b‍c‮d⁦e⁩f﻿g­h')).toBe('abcdefgh');
  });

  it('caps at 80 characters without splitting a character or an entity', () => {
    expect(escapeBlockText('x'.repeat(80))).toBe('x'.repeat(80));
    expect(escapeBlockText('x'.repeat(81))).toBe(`${'x'.repeat(77)}...`);

    const emoji = escapeBlockText('\u{1F600}'.repeat(100));
    expect(emoji).toBe(`${'\u{1F600}'.repeat(77)}...`);
    expect(Array.from(emoji)).toHaveLength(80);

    expect(escapeBlockText('<'.repeat(30))).toBe(`${'&lt;'.repeat(19)}...`);
  });
});

describe('renderBlockBody', () => {
  const packs: BlockPack[] = [
    {
      label: 'Vite 8.2.0',
      indexPath: 'agent-docs/vite/index.md',
      description: 'Build tool',
      topics: ['config', 'guide', 'guides'],
    },
    {
      label: 'MCP spec 2026-07-28',
      indexPath: 'agent-docs/mcp/index.md',
      description: null,
      topics: ['schema', 'specification'],
    },
    {
      label: 'Zöd 4.1.0',
      indexPath: 'agent-docs/zod/index.md',
      description: 'Schemas ✓',
      topics: ['api'],
    },
  ];
  const full = [
    '- Vite 8.2.0: `agent-docs/vite/index.md` (config, guide, guides). Build tool',
    '- MCP spec 2026-07-28: `agent-docs/mcp/index.md` (schema, specification)',
    '- Zöd 4.1.0: `agent-docs/zod/index.md` (api). Schemas ✓',
  ];
  const bare = [
    '- Vite 8.2.0: `agent-docs/vite/index.md`',
    '- MCP spec 2026-07-28: `agent-docs/mcp/index.md`',
    '- Zöd 4.1.0: `agent-docs/zod/index.md`',
  ];
  const more = (count: number): string => `- ...and ${count} more: see agent-docs/`;
  const body = (...lines: string[]): string => `${HEADER}${lines.join('\n')}\n`;
  const bytes = (text: string): number => Buffer.byteLength(text, 'utf-8');
  const render = (maxBytes: number): string | null =>
    renderBlockBody(packs, 'agent-docs', maxBytes);

  it('is empty without packs', () => {
    expect(renderBlockBody([], 'agent-docs', 4096)).toBe('');
  });

  it('lists every pack in full when the budget allows', () => {
    const expected = body(...full);
    expect(render(bytes(expected))).toBe(expected);
    expect(render(bytes(expected))).toBe(render(bytes(expected)));
  });

  it('measures the budget in UTF-8 bytes', () => {
    const expected = body(...full);
    expect(expected.length).toBeLessThan(bytes(expected));
    expect(render(expected.length)).toBe(body(full[0] ?? '', full[1] ?? '', bare[2] ?? ''));
  });

  it('drops topics and descriptions from the last pack backwards', () => {
    expect(render(bytes(body(...full)) - 1)).toBe(
      body(full[0] ?? '', full[1] ?? '', bare[2] ?? '')
    );
    const lastTwoBare = body(full[0] ?? '', ...bare.slice(1));
    expect(render(bytes(lastTwoBare))).toBe(lastTwoBare);
    expect(render(bytes(lastTwoBare) - 1)).toBe(body(...bare));
  });

  it('then keeps the first bare lines and counts the rest', () => {
    expect(render(bytes(body(...bare)) - 1)).toBe(body(...bare.slice(0, 2), more(1)));
    expect(render(bytes(body(...bare.slice(0, 2), more(1))) - 1)).toBe(
      body(bare[0] ?? '', more(2))
    );
    expect(render(bytes(body(more(3))))).toBe(body(more(3)));
    expect(render(bytes(body(more(3))) - 1)).toBeNull();
  });
});

describe('locating and splicing the block', () => {
  const block = (...lines: string[]): string =>
    `${[BLOCK_BEGIN, ...lines, BLOCK_END].join('\n')}\n`;

  it('appends to an empty or new file, and after one blank line otherwise', () => {
    expect(spliceBlock(null, '')).toBe(EMPTY_BLOCK);
    expect(spliceBlock('', 'A\nB\n')).toBe(block('A', 'B'));
    expect(spliceBlock('# Title', 'A\n')).toBe(`# Title\n\n${block('A')}`);
    expect(spliceBlock('# Title\n', 'A\n')).toBe(`# Title\n\n${block('A')}`);
    expect(spliceBlock('# Title\n\n', 'A\n')).toBe(`# Title\n\n${block('A')}`);
  });

  it('replaces a block in the middle and leaves the text around it byte-identical', () => {
    const before = '# Title\n\nIntro  \n\n';
    const after = '\n## After\n\ttrailing';
    expect(spliceBlock(`${before}${block('old', 'lines')}${after}`, 'new\n')).toBe(
      `${before}${block('new')}${after}`
    );
  });

  it('follows CRLF line endings', () => {
    expect(spliceBlock('# Title\r\n', 'A\nB\n')).toBe(
      `# Title\r\n\r\n${BLOCK_BEGIN}\r\nA\r\nB\r\n${BLOCK_END}\r\n`
    );
    const crlf = `# Title\r\n\r\n${BLOCK_BEGIN}\r\nold\r\n${BLOCK_END}\r\nafter\r\n`;
    expect(spliceBlock(crlf, 'new\n')).toBe(
      `# Title\r\n\r\n${BLOCK_BEGIN}\r\nnew\r\n${BLOCK_END}\r\nafter\r\n`
    );
  });

  it('ignores markers inside fenced and indented code', () => {
    const documented = `# Docs\n\n\`\`\`md\n${BLOCK_BEGIN}\n${BLOCK_END}\n\`\`\`\n`;
    expect(locateBlock(documented)).toEqual({ kind: 'absent' });
    expect(spliceBlock(documented, 'A\n')).toBe(`${documented}\n${block('A')}`);

    const loneInCode = `~~~\n${BLOCK_BEGIN}\n~~~\n\n${block('real')}`;
    expect(spliceBlock(loneInCode, 'A\n')).toBe(`~~~\n${BLOCK_BEGIN}\n~~~\n\n${block('A')}`);
  });

  it('reports mismatched markers instead of guessing', () => {
    expect(locateBlock(`a\n${BLOCK_BEGIN}\nb\n`)).toEqual({
      kind: 'mismatched',
      detail: 'a BEGIN marker on line 2 without an END',
    });
    expect(locateBlock(`${BLOCK_END}\n${BLOCK_BEGIN}\n`)).toEqual({
      kind: 'mismatched',
      detail: 'the END marker on line 1 comes before the BEGIN marker on line 2',
    });
    expect(locateBlock(`${block('a')}\n${block('b')}`)).toEqual({
      kind: 'mismatched',
      detail: 'BEGIN markers on lines 1, 5',
    });
    expect(() => spliceBlock(`${BLOCK_END}\n`, '')).toThrow(ConfigError);
  });
});

describe('syncAgentBlocks', () => {
  it('fails a file with mismatched markers, naming the fix, and still writes the others', async () => {
    const lone = `# Claude\n\n${BLOCK_BEGIN}\nkept\n`;
    const root = await makeProject({ 'AGENTS.md': '# Agents\n', 'CLAUDE.md': lone });

    expect(await syncBlocks(root)).toEqual([
      { path: 'AGENTS.md', status: 'updated' },
      {
        path: 'CLAUDE.md',
        status: 'failed',
        exitCode: 2,
        error:
          "mismatched llm-docs markers (a BEGIN marker on line 3 without an END); fix or remove them by hand, then run 'llm-docs sync'.",
      },
    ]);
    expect(await read(root, 'CLAUDE.md')).toBe(lone);
  });

  it('refuses a file that is not valid UTF-8, leaving its bytes as they were', async () => {
    const bytes = Buffer.from([0x23, 0x20, 0x41, 0xff, 0xfe, 0x0a]);
    const root = await makeProject({ 'AGENTS.md': bytes });
    const message =
      'AGENTS.md is not valid UTF-8, so llm-docs will not rewrite it; save it as UTF-8, or leave it out of "agentFiles" in llm-docs.json.';

    expect(await syncBlocks(root)).toEqual([
      { path: 'AGENTS.md', status: 'failed', exitCode: 2, error: message },
    ]);
    expect(await checkAgentBlocks(await loadProjectConfig(root))).toEqual([
      { status: 'fail', path: 'AGENTS.md', message },
    ]);
    expect(await readFile(join(root, 'AGENTS.md'))).toEqual(bytes);
  });

  it('keeps every byte outside the markers, byte order mark included', async () => {
    const before = Buffer.from('﻿# Agents\r\n\r\nNotes: café ✓\r\n\r\n', 'utf-8');
    const after = Buffer.from('\r\n## After\r\n\ttail \u{1F600}', 'utf-8');
    const stale = Buffer.from(`${BLOCK_BEGIN}\r\nold\r\n${BLOCK_END}\r\n`, 'utf-8');
    const root = await makeProject({ 'AGENTS.md': Buffer.concat([before, stale, after]) });

    expect(await syncBlocks(root)).toEqual([{ path: 'AGENTS.md', status: 'updated' }]);
    const written = await readFile(join(root, 'AGENTS.md'));
    const block = Buffer.from(`${BLOCK_BEGIN}\r\n${BLOCK_END}\r\n`, 'utf-8');
    expect(written).toEqual(Buffer.concat([before, block, after]));

    const appended = await makeProject({ 'AGENTS.md': before });
    await syncBlocks(appended);
    const appendedBytes = await readFile(join(appended, 'AGENTS.md'));
    expect(appendedBytes.subarray(0, before.length)).toEqual(before);
    expect(appendedBytes.subarray(before.length)).toEqual(block);
  });

  it('finds a block on the first line of a file that starts with a byte order mark', async () => {
    const tail = Buffer.from('\nAfter\n', 'utf-8');
    const root = await makeProject({
      'AGENTS.md': Buffer.concat([Buffer.from(`﻿${BLOCK_BEGIN}\nold\n${BLOCK_END}\n`), tail]),
    });

    expect(await syncBlocks(root)).toEqual([{ path: 'AGENTS.md', status: 'updated' }]);
    expect(await readFile(join(root, 'AGENTS.md'))).toEqual(
      Buffer.concat([Buffer.from(`﻿${EMPTY_BLOCK}`, 'utf-8'), tail])
    );
    expect(await syncBlocks(root)).toEqual([{ path: 'AGENTS.md', status: 'unchanged' }]);
  });

  it('reports an agent file that cannot be read without losing the pack report', async () => {
    const root = await makeProject(
      { 'docs/index.md': '# Home\n', 'AGENTS.md/keep.txt': 'a directory, not a file\n' },
      { packs: { docs: { version: '1.0.0', sources: [{ type: 'local', path: 'docs' }] } } }
    );
    const message =
      'AGENTS.md is a directory, not a file; rename it, or set "agentFiles" in llm-docs.json to the files the llm-docs block goes into.';

    const report = await syncPacks(root, undefined);
    expect(report.packs).toMatchObject([{ id: 'docs', status: 'built' }]);
    expect(report.agentBlocks).toEqual([
      { path: 'AGENTS.md', status: 'failed', exitCode: 2, error: message },
    ]);
    expect(await checkAgentBlocks(await loadProjectConfig(root))).toEqual([
      { status: 'fail', path: 'AGENTS.md', message },
    ]);
  });

  it('refuses to append a block into an unclosed code fence', async () => {
    const root = await makeProject({ 'AGENTS.md': '# Agents\n\n```sh\nnpm test\n' });
    expect(await syncBlocks(root)).toMatchObject([
      { path: 'AGENTS.md', status: 'failed', exitCode: 2 },
    ]);
    expect(await read(root, 'AGENTS.md')).toBe('# Agents\n\n```sh\nnpm test\n');
  });

  it('reports what it would write under check, writing nothing', async () => {
    const root = await makeProject(
      { 'CLAUDE.md': '# Claude\n' },
      { agentFiles: ['AGENTS.md', 'CLAUDE.md'] }
    );
    expect(await syncBlocks(root, true)).toEqual([
      { path: 'AGENTS.md', status: 'would-create' },
      { path: 'CLAUDE.md', status: 'would-update' },
    ]);
    expect(await readdir(root)).not.toContain('AGENTS.md');
    expect(await read(root, 'CLAUDE.md')).toBe('# Claude\n');
  });

  it('is idempotent: a second run reports unchanged and does not touch the file', async () => {
    const root = await makeProject({ 'AGENTS.md': '# Agents\n' });
    await syncBlocks(root);
    const before = await stat(join(root, 'AGENTS.md'));
    const text = await read(root, 'AGENTS.md');

    expect(await syncBlocks(root)).toEqual([{ path: 'AGENTS.md', status: 'unchanged' }]);
    expect(await syncBlocks(root, true)).toEqual([{ path: 'AGENTS.md', status: 'unchanged' }]);
    expect(await read(root, 'AGENTS.md')).toBe(text);
    expect((await stat(join(root, 'AGENTS.md'))).mtimeMs).toBe(before.mtimeMs);
  });

  it('writes the same bytes for the same packs, in llm-docs.json order', async () => {
    const docs = {
      'docs/index.md': '# Home\n',
      'docs/guide/start.md': '# Start\n',
      'docs/api/b.md': '# B\n',
    };
    const packs = {
      zeta: { title: 'Zeta `@x`', version: '2.0.0', sources: [{ type: 'local', path: 'docs' }] },
      alpha: {
        title: 'Alpha',
        description: 'Line one\nline two',
        version: '1.0.0',
        sources: [{ type: 'local', path: 'docs' }],
      },
    };
    const first = await makeProject(docs, { packs, agentFiles: ['AGENTS.md'] });
    const second = await makeProject(docs, { packs, agentFiles: ['AGENTS.md'] });

    for (const root of [first, second]) {
      await syncPacks(root, undefined);
      await syncBlocks(root);
    }

    const expected = `${BLOCK_BEGIN}\n${body(
      '- Zeta x 2.0.0: `agent-docs/zeta/index.md` (api, guide)',
      '- Alpha 1.0.0: `agent-docs/alpha/index.md` (api, guide). Line one line two'
    )}${BLOCK_END}\n`;
    expect(await read(first, 'AGENTS.md')).toBe(expected);
    expect(await read(second, 'AGENTS.md')).toBe(expected);
  });

  function body(...lines: string[]): string {
    return `${HEADER}${lines.join('\n')}\n`;
  }
});
