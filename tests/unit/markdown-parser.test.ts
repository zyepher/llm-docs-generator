/**
 * Markdown parser coverage: the DocNode tree for single files and directories
 * (titles, heading nesting, code fences, link definitions, tab directives,
 * blockquotes) and the original-file source line ranges recorded per section.
 */

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { canCreateSymlinks } from '../helpers/symlinks.js';

import { FormatDetector } from '../../src/core/detector.js';
import { ContentBlockType, DocNodeType, type DocNode } from '../../src/core/models.js';
import { FormatType } from '../../src/parsers/base.js';
import { MarkdownFormatParser } from '../../src/parsers/markdown/index.js';
import { MarkdownParser } from '../../src/parsers/markdown/parser.js';

const FIXTURE_DOCS = join(
  dirname(fileURLToPath(import.meta.url)),
  '../fixtures/markdown-parser/docs'
);
const FIXTURE_FILES = [
  'api/router.md',
  'guide/intro.md',
  'no-frontmatter.md',
  'overview.md',
  'plain.md',
];

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'llm-docs-markdown-parser-'));
  tempDirs.push(dir);
  return dir;
}

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const path = join(root, ...relativePath.split('/'));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf-8');
  }
}

async function parseLines(lines: string[], fileName = 'doc.md') {
  const dir = await createTempDir();
  const filePath = join(dir, fileName);
  await writeFile(filePath, lines.join('\n'), 'utf-8');
  return await new MarkdownParser(filePath).parse();
}

function collectText(node: DocNode): string {
  const ownContent = node.content.map((block) => block.content).join('\n');
  const childContent = node.children.map((child) => collectText(child)).join('\n');
  return [node.title, ownContent, childContent].filter(Boolean).join('\n');
}

function collectNodes(node: DocNode): DocNode[] {
  return [node, ...node.children.flatMap((child) => collectNodes(child))];
}

function findByTitle(root: DocNode, title: string): DocNode | undefined {
  return collectNodes(root).find((node) => node.title === title);
}

/** Extract fenced code block bodies from Markdown source, fence-aware. */
function extractFencedBlocks(text: string): string[] {
  const lines = text.split('\n');
  const blocks: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const open = lines[index]?.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (open?.[1] !== undefined) {
      const marker = open[1];
      const body: string[] = [];
      index += 1;
      while (index < lines.length) {
        const close = lines[index]?.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
        if (
          close?.[1] !== undefined &&
          close[1][0] === marker[0] &&
          close[1].length >= marker.length
        ) {
          break;
        }
        body.push(lines[index] ?? '');
        index += 1;
      }
      blocks.push(body.join('\n'));
    }
    index += 1;
  }
  return blocks;
}

describe('markdown directory fixture', () => {
  it('titles each file by frontmatter title, then first H1, then file name', async () => {
    const root = await new MarkdownFormatParser().parse(FIXTURE_DOCS);

    expect(root.type).toBe(DocNodeType.ROOT);
    expect(root.children.map((child) => child.title)).toEqual([
      'Router API',
      'Introduction',
      'Heading Title Only',
      'Overview',
      'plain',
    ]);

    const text = collectText(root);
    expect(text).not.toContain('id: router');
    expect(text).not.toMatch(/^title: /m);
  });

  it('nests headings down to H6 and keeps author-numbered heading text verbatim', async () => {
    const root = await new MarkdownFormatParser().parse(FIXTURE_DOCS);
    const configStep = findByTitle(root, '1. Create the config file');

    expect(configStep?.metadata.get('level')).toBe(3);
    const nested = configStep?.children[0];
    const deeper = nested?.children[0];
    const deepest = deeper?.children[0];
    expect(nested).toMatchObject({ title: 'Nested detail', type: DocNodeType.ITEM });
    expect(deeper).toMatchObject({ title: 'Deeper detail', type: DocNodeType.ITEM });
    expect(deepest).toMatchObject({
      title: 'Deepest detail at the floor',
      type: DocNodeType.ITEM,
    });
    expect(deepest?.metadata.get('level')).toBe(6);
    expect(findByTitle(root, '2. Second Step')).toBeDefined();
  });

  it('composes comment-directive tab headings and drops the directive markers', async () => {
    const root = await new MarkdownFormatParser().parse(FIXTURE_DOCS);
    const titles = collectNodes(root).map((node) => node.title);

    expect(titles).toEqual(
      expect.arrayContaining([
        'npm (package-managers)',
        'pnpm (package-managers)',
        'React (framework)',
        'Solid (framework)',
      ])
    );
    for (const bare of ['React', 'Solid', 'npm', 'pnpm']) {
      expect(titles).not.toContain(bare);
    }

    const text = collectText(root);
    expect(text).not.toContain('::start:tabs');
    expect(text).not.toContain('::end:framework');
  });

  it('captures reference definitions as metadata and leaves link syntax in prose', async () => {
    const root = await new MarkdownFormatParser().parse(FIXTURE_DOCS);
    const intro = root.children.find((child) => child.title === 'Introduction');

    expect(intro?.metadata.get('linkDefinitions')).toEqual({
      site: { href: 'https://example.com/site' },
    });
    const prose = intro?.content[0]?.content ?? '';
    expect(prose).toContain('[reference site][site]');
    expect(prose).toContain('[in-pack page](../api/router.md#usage)');
    expect(prose).toContain('[in-page anchor](#setup)');
    expect(collectText(root)).not.toContain('[site]: https://example.com/site');
  });

  it('keeps fence info strings verbatim, including an empty one for a bare fence', async () => {
    const root = await new MarkdownFormatParser().parse(FIXTURE_DOCS);
    const deepest = findByTitle(root, 'Deepest detail at the floor');

    expect(deepest?.content).toEqual([
      expect.objectContaining({
        type: ContentBlockType.CODE,
        language: '',
        content: 'bare fence body with no info string',
      }),
      expect.objectContaining({
        type: ContentBlockType.CODE,
        language: 'ts title="vite.config.ts"',
        content: 'export default { plugins: [] }',
      }),
    ]);
  });

  it('reproduces every source fenced code block byte-for-byte as a code block', async () => {
    const root = await new MarkdownFormatParser().parse(FIXTURE_DOCS);
    const codeBlocks = collectNodes(root)
      .flatMap((node) => node.content)
      .filter((block) => block.type === ContentBlockType.CODE)
      .map((block) => block.content);

    const sourceBlocks: string[] = [];
    for (const file of FIXTURE_FILES) {
      sourceBlocks.push(...extractFencedBlocks(await readFile(join(FIXTURE_DOCS, file), 'utf-8')));
    }
    expect(sourceBlocks.length).toBeGreaterThan(0);
    for (const block of sourceBlocks) {
      expect(codeBlocks).toContain(block);
    }
  });
});

describe('markdown directory merging', () => {
  it.skipIf(!canCreateSymlinks)(
    'merges .md and .mdx files in sorted path order under a root named for the directory',
    async () => {
      const base = await createTempDir();
      const source = join(base, 'docs-source');
      await writeTree(source, {
        'index.md': ['# Project Docs', '', 'Intro text.', '', '## Install', '', 'Run setup.'].join(
          '\n'
        ),
        'guides/usage.mdx': [
          "import { Note } from './Note'",
          '',
          '# Usage Guide',
          '',
          '<Note>Use the public API.</Note>',
          '',
          '## Example',
          '',
          '```tsx',
          'export const example = <Widget />',
          '```',
        ].join('\n'),
        'ignored.txt': '# Not parsed\n',
      });
      await writeFile(
        join(base, 'outside-linked.md'),
        '# Linked Secret\n\nThis must not be parsed.\n',
        'utf-8'
      );
      await symlink(join(base, 'outside-linked.md'), join(source, 'linked.md'));

      const root = await new MarkdownFormatParser().parse(source);

      expect(root).toMatchObject({ type: DocNodeType.ROOT, id: 'root', title: 'docs-source' });
      expect(root.metadata.get('count')).toBe(2);
      expect(root.children.map((child) => child.title)).toEqual(['Usage Guide', 'Project Docs']);
      // Directory merging keeps H2s as sections; only single files map them to categories.
      expect(root.children[1]?.children[0]).toMatchObject({
        type: DocNodeType.SECTION,
        title: 'Install',
      });

      const text = collectText(root);
      expect(text).toContain('export const example = <Widget />');
      expect(text).not.toContain("import { Note } from './Note'");
      expect(text).not.toContain('Not parsed');
      expect(text).not.toContain('Linked Secret');
    }
  );

  it('parses a nested DocC-style directory and keeps @-prefixed prose that is not a directive', async () => {
    const base = await createTempDir();
    const source = join(base, 'TSPL.docc');
    await writeTree(source, {
      'GuidedTour.md': ['# A Swift Tour', '', 'Swift lets you write expressive code.'].join('\n'),
      'LanguageGuide/BasicOperators.md': [
        '# Basic Operators',
        '',
        'Operators are unary, binary, or ternary.',
        '',
        '## Assignment Operator',
        '',
        'Assignment updates a value.',
      ].join('\n'),
      'ReferenceManual/Declarations/Attributes.md': [
        '# Attributes',
        '',
        'Attributes provide more information about declarations.',
        '',
        '## Declaration Attributes',
        '',
        '@available describes platform availability.',
      ].join('\n'),
    });

    const root = await new MarkdownFormatParser().parse(source);

    expect(root.title).toBe('TSPL.docc');
    expect(root.children.map((child) => child.title)).toEqual([
      'A Swift Tour',
      'Basic Operators',
      'Attributes',
    ]);
    expect(root.children[1]?.children.map((child) => child.title)).toEqual(['Assignment Operator']);
    const declarationAttributes = root.children[2]?.children[0];
    expect(declarationAttributes?.title).toBe('Declaration Attributes');
    expect(declarationAttributes?.content.map((block) => block.content)).toContain(
      '@available describes platform availability.'
    );
  });
});

describe('markdown single files', () => {
  it('parses Markdown in a non-markdown extension when the format is given explicitly', async () => {
    const dir = await createTempDir();
    const path = join(dir, 'Guide Notes.txt');
    await writeFile(
      path,
      ['# Guide Notes', '', 'Plain markdown in a text file.', '', '## Steps', '', 'Run it.'].join(
        '\n'
      ),
      'utf-8'
    );

    const parser = new MarkdownFormatParser();
    expect(await parser.detect(path)).toBe(false);

    const detector = new FormatDetector();
    await expect(detector.detect(path)).rejects.toThrow(/Unable to detect format/);
    expect(await detector.detect(path, FormatType.MARKDOWN)).toBe(FormatType.MARKDOWN);

    const docNode = await parser.parse(path);
    expect(docNode.title).toBe('Guide Notes');
    expect(docNode.children).toEqual([
      expect.objectContaining({ type: DocNodeType.CATEGORY, title: 'Steps' }),
    ]);
  });

  it('annotates blockquotes and keeps every quoted line', async () => {
    const dir = await createTempDir();
    const path = join(dir, 'notes.md');
    await writeFile(
      path,
      ['## Notes', '', '> [!NOTE]', '> First line.', '> Second line.', '', 'Plain paragraph.'].join(
        '\n'
      ),
      'utf-8'
    );

    const notes = (await new MarkdownFormatParser().parse(path)).children[0];
    const [quote, plain] = notes?.content ?? [];

    expect(quote?.content).toBe('[!NOTE]\nFirst line.\nSecond line.');
    expect(quote?.annotations?.get('style')).toBe('blockquote');
    expect(plain?.content).toBe('Plain paragraph.');
    expect(plain?.annotations).toBeUndefined();
  });

  it('keeps block text exactly as the lexer has always produced it', async () => {
    const doc = await parseLines([
      '<div>raw html</div>',
      '',
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |',
      '',
      '---',
      '',
      '> quoted',
      '>',
      'after',
      '',
      '    indented',
      '\tindented with a tab',
      'end',
    ]);

    expect(doc.content).toEqual([
      { type: 'prose', content: '<div>raw html</div>\n\n' },
      { type: 'prose', content: '| a | b |\n| - | - |\n| 1 | 2 |\n\n' },
      { type: 'prose', content: '---\n\n' },
      { type: 'blockquote', content: 'quoted' },
      { type: 'prose', content: 'after' },
      { type: 'code', content: 'indented\nindented with a tab', language: '' },
      { type: 'prose', content: 'end' },
    ]);
  });
});

describe('markdown parser source line ranges', () => {
  it('assigns heading-line ranges from the original file, skipping frontmatter and fenced code', async () => {
    const doc = await parseLines([
      '---', // 1
      'title: Guide', // 2
      '---', // 3
      '', // 4
      'Intro paragraph.', // 5
      '', // 6
      '## Setup', // 7
      '', // 8
      'Setup prose.', // 9
      '', // 10
      '```bash', // 11
      '# not a heading', // 12
      '```', // 13
      '', // 14
      '### Deep', // 15
      '', // 16
      'Deep prose.', // 17
      '', // 18
      '## Usage', // 19
      '', // 20
      'Usage prose.', // 21
      '',
    ]);

    expect(doc.sourceLines).toEqual({ start: 1, end: 6 });
    const setup = doc.sections[0];
    const usage = doc.sections[1];
    expect(setup?.title).toBe('Setup');
    expect(setup?.sourceLines).toEqual({ start: 7, end: 14 });
    expect(setup?.children[0]?.sourceLines).toEqual({ start: 15, end: 18 });
    expect(usage?.sourceLines).toEqual({ start: 19, end: 21 });
  });

  it('keeps hoisted single-H1 children on their real heading lines and extends the document range over the H1 body', async () => {
    const doc = await parseLines([
      '# Title', // 1
      '', // 2
      'Lead paragraph.', // 3
      '', // 4
      '## First', // 5
      '', // 6
      'First body.', // 7
      '',
    ]);

    // Single H1 equal to the title is hoisted: its content becomes document
    // content, so the document range covers lines 1-4 (H1 own extent).
    expect(doc.title).toBe('Title');
    expect(doc.sourceLines).toEqual({ start: 1, end: 4 });
    expect(doc.sections[0]?.title).toBe('First');
    expect(doc.sections[0]?.sourceLines).toEqual({ start: 5, end: 7 });
  });

  it('locates setext headings and covers a headingless document as a whole-file range', async () => {
    const setext = await parseLines([
      'Overview', // 1
      '========', // 2
      '', // 3
      'Body.', // 4
      '',
    ]);
    // The setext H1 equals the title, so it hoists; the document range covers
    // the whole H1 extent starting at its heading line.
    expect(setext.sourceLines).toEqual({ start: 1, end: 4 });

    const headingless = await parseLines(['Just prose.', '', 'More prose.', '']);
    expect(headingless.sections).toEqual([]);
    expect(headingless.sourceLines).toEqual({ start: 1, end: 3 });
  });

  it('disambiguates duplicate heading titles by document order', async () => {
    const doc = await parseLines([
      '## Options', // 1
      '', // 2
      'First options.', // 3
      '', // 4
      '## Options', // 5
      '', // 6
      'Second options.', // 7
      '',
    ]);

    expect(doc.sections[0]?.sourceLines).toEqual({ start: 1, end: 4 });
    expect(doc.sections[1]?.sourceLines).toEqual({ start: 5, end: 7 });
  });

  it('omits the range for a heading synthesized by cleaning instead of guessing', async () => {
    const doc = await parseLines([
      '## Real', // 1
      '', // 2
      '@TabNavigator {', // 3
      '   @Tab("Synthesized") {', // 4
      '      Tab body.', // 5
      '   }', // 6
      '}', // 7
      '',
    ]);

    const real = doc.sections[0];
    expect(real?.sourceLines).toEqual({ start: 1, end: 7 });
    // The @Tab title becomes a synthesized H3 with no original heading line.
    const synthesized = real?.children[0];
    expect(synthesized?.title).toBe('Synthesized');
    expect(synthesized?.sourceLines).toBeUndefined();
  });

  it('carries section line ranges onto the DocNode metadata', async () => {
    const dir = await createTempDir();
    const path = join(dir, 'ranges.md');
    await writeFile(path, ['## One', '', 'Body.', '', '## Two', '', 'More.', ''].join('\n'));

    const docNode = await new MarkdownFormatParser().parse(path);
    expect(docNode.children.map((child) => child.metadata.get('sourceLines'))).toEqual([
      { start: 1, end: 4 },
      { start: 5, end: 7 },
    ]);
  });
});
