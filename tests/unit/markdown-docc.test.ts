/**
 * Coverage for markdown structure fidelity (single-H1 hoisting, Unicode slugs)
 * and DocC block-directive handling, including the .docc fixture bundle.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { ContentBlockType, DocNodeType, type DocNode } from '../../src/core/models.js';
import { MarkdownFormatParser } from '../../src/parsers/markdown/index.js';
import { slugifyText } from '../../src/utils/slug.js';

const DOCC_FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../fixtures/docc/SamplePack.docc'
);

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'llm-docs-docc-'));
  tempDirs.push(dir);
  return dir;
}

async function parseMarkdown(content: string, filename = 'guide.md') {
  const dir = await createTempDir();
  const path = join(dir, filename);
  await writeFile(path, content, 'utf-8');
  return await new MarkdownFormatParser().parse(path);
}

function collectText(node: DocNode): string {
  const ownContent = node.content.map((block) => block.content).join('\n');
  const childContent = node.children.map((child) => collectText(child)).join('\n');
  return [node.title, ownContent, childContent].filter(Boolean).join('\n');
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('single-H1 hoisting', () => {
  it('does not re-nest the H1 that already became the document title', async () => {
    const docNode = await parseMarkdown(
      ['# My Library', '', 'Intro paragraph.', '', '## Setup', 'Install it.', ''].join('\n')
    );

    expect(docNode.title).toBe('My Library');
    expect(docNode.content.map((block) => block.content)).toContain('Intro paragraph.');
    expect(docNode.children.map((child) => child.title)).toEqual(['Setup']);
  });

  it('keeps nesting when a later H1 exists', async () => {
    const docNode = await parseMarkdown(
      ['# My Library', '', '## Setup', '', '# Appendix', 'Extra.', ''].join('\n')
    );

    expect(docNode.title).toBe('My Library');
    expect(docNode.children.map((child) => child.title)).toEqual(['My Library', 'Appendix']);
  });

  it('keeps nesting when the H1 does not match the frontmatter title', async () => {
    const docNode = await parseMarkdown(
      ['---', 'title: Authored Title', '---', '', '# Different Heading', '', '## Setup', ''].join(
        '\n'
      )
    );

    expect(docNode.title).toBe('Authored Title');
    expect(docNode.children.map((child) => child.title)).toEqual(['Different Heading']);
  });
});

describe('Unicode slugs', () => {
  it('keeps pure-ASCII slugs byte-identical to the old behavior', () => {
    expect(slugifyText('Sign in with OTP')).toBe('sign-in-with-otp');
    expect(slugifyText('  Weird -- Spacing!  ')).toBe('weird-spacing');
    expect(slugifyText('???')).toBe('section');
  });

  it('preserves non-Latin letters instead of collapsing to the fallback', () => {
    expect(slugifyText('快速入门')).toBe('快速入门');
    expect(slugifyText('Émigré Café')).toBe('émigré-café');
    expect(slugifyText('시작 하기')).toBe('시작-하기');
  });

  it('gives all-CJK markdown headings a real section id', async () => {
    const docNode = await parseMarkdown(['## 快速入门', '', '内容。', ''].join('\n'));
    expect(docNode.children[0]?.id).toBe('快速入门');
  });
});

describe('DocC block directives', () => {
  it('handles the .docc fixture bundle end to end', async () => {
    const parser = new MarkdownFormatParser();
    expect(await parser.detect(DOCC_FIXTURE)).toBe(true);

    const docNode = await parser.parse(DOCC_FIXTURE);
    const guide = docNode.children[0];
    expect(guide?.title).toBe('Getting Started');
    // The lone H1 is hoisted: the H2 sections are the guide's children.
    expect(guide?.children.map((child) => child.title)).toEqual(['Install', 'Layout', '快速入门']);
    expect(guide?.children[2]?.id).toBe('快速入门');

    const full = collectText(docNode);

    // Layout containers unwrap: content survives, directives do not.
    expect(full).toContain('The left column explains requests.');
    expect(full).toContain('The right column explains responses.');
    expect(full).toContain('Swift Package Manager');
    expect(full).toContain('Add the dependency to `Package.swift`.');
    expect(full).toContain('.package(url: "https://example.com/sample.git", from: "1.0.0")');
    expect(full).toContain("Add `pod 'Sample'` to your Podfile.");
    expect(guide?.children[0]?.children[0]?.content[1]).toMatchObject({
      type: ContentBlockType.CODE,
      language: 'swift',
    });

    // Media and snippet placeholders are deterministic single prose lines.
    const layoutProse = guide?.children[1]?.content.map((block) => block.content) ?? [];
    expect(layoutProse).toContain('![Sample architecture diagram](hero.png)');
    expect(layoutProse).toContain('[Video: Getting started tour](intro.mov)');
    expect(layoutProse).toContain('`Sample/Snippets/hello#setup`');

    // Comment and metadata blocks are gone, including nested braces.
    expect(full).not.toContain('Internal note');
    expect(full).not.toContain('@Metadata');
    expect(full).not.toContain('@DisplayName');
    expect(full).not.toContain('@PageColor');
    expect(full).not.toMatch(/@(?:Comment|Row|Column|TabNavigator|Tab|Image|Video|Snippet)\b/);

    // The DocC callout is kept as a blockquote.
    const callout = guide?.content.find(
      (block) => block.annotations?.get('style') === 'blockquote'
    );
    expect(callout?.content).toBe(
      'Important: Always pin an explicit version.\nThe pack records provenance for every file.'
    );
  });

  it('parses DocC-flavored Markdown into a typed DocNode hierarchy', async () => {
    const docNode = await parseMarkdown(
      [
        '@Metadata {',
        '  @DocumentationExtension(mergeBehavior: append)',
        '  @PageColor(purple)',
        '}',
        '',
        '<!-- parser-only comment that should be removed -->',
        '',
        '## Authentication',
        'Use <doc:SignInWithOTP> when you need passwordless access.',
        '',
        '@Options(scope: local) {',
        '  @AutomaticSeeAlso(disabled)',
        '}',
        '',
        '### Sign in with OTP',
        'Call the auth client and keep the session returned by <doc:AuthSession>.',
        '',
        '```swift',
        'try await supabase.auth.signInWithOTP(email: "person@example.com")',
        '```',
        '',
        '#### Parameters',
        'Pass an email address that can receive the magic link.',
        '',
        '```json',
        '{ "email": "person@example.com" }',
        '```',
        '',
        '## Storage',
        'Use storage buckets for user files.',
        '',
      ].join('\n'),
      'DocC Acceptance Guide.md'
    );

    expect(docNode.type).toBe(DocNodeType.SECTION);
    expect(docNode.title).toBe('DocC Acceptance Guide');
    expect(docNode.metadata.get('format')).toBe('markdown');

    const [authentication, storage] = docNode.children;
    expect(authentication).toMatchObject({
      type: DocNodeType.CATEGORY,
      id: 'authentication',
      title: 'Authentication',
    });
    expect(storage).toMatchObject({ type: DocNodeType.CATEGORY, id: 'storage', title: 'Storage' });

    const signInOperation = authentication?.children[0];
    expect(signInOperation).toMatchObject({
      type: DocNodeType.OPERATION,
      id: 'sign-in-with-otp',
      title: 'Sign in with OTP',
    });
    const parameters = signInOperation?.children[0];
    expect(parameters).toMatchObject({
      type: DocNodeType.ITEM,
      id: 'parameters',
      title: 'Parameters',
    });

    expect(authentication?.content[0]).toMatchObject({
      type: ContentBlockType.PROSE,
      content: 'Use SignInWithOTP when you need passwordless access.',
    });
    expect(signInOperation?.content[0]).toMatchObject({
      type: ContentBlockType.PROSE,
      content: 'Call the auth client and keep the session returned by AuthSession.',
    });
    expect(signInOperation?.content[1]).toMatchObject({
      type: ContentBlockType.CODE,
      language: 'swift',
      content: 'try await supabase.auth.signInWithOTP(email: "person@example.com")',
    });
    expect(parameters?.content[1]).toMatchObject({
      type: ContentBlockType.CODE,
      language: 'json',
      content: '{ "email": "person@example.com" }',
    });

    const parsedText = collectText(docNode);
    for (const residue of [
      '@Metadata',
      '@Options',
      '@DocumentationExtension',
      '@AutomaticSeeAlso',
      'PageColor',
      '<!--',
      'parser-only comment',
      '<doc:',
    ]) {
      expect(parsedText).not.toContain(residue);
    }
  });

  it('drops a single-line @Metadata block and keeps surrounding prose', async () => {
    const docNode = await parseMarkdown(
      ['## Guide', '', '@Metadata { @PageColor(purple) }', '', 'Real prose.', ''].join('\n')
    );

    const texts = docNode.children[0]?.content.map((block) => block.content) ?? [];
    expect(texts).toContain('Real prose.');
    expect(texts.join('\n')).not.toContain('@Metadata');
    expect(texts.join('\n')).not.toContain('PageColor');
  });

  it('drops an @Image placeholder without a source and any trailing block', async () => {
    const docNode = await parseMarkdown(
      [
        '## Guide',
        '',
        '@Image(alt: "No source") {',
        '  Accessibility text.',
        '}',
        '',
        'After.',
        '',
      ].join('\n')
    );

    const texts = docNode.children[0]?.content.map((block) => block.content).join('\n') ?? '';
    expect(texts).toContain('After.');
    expect(texts).not.toContain('Accessibility text.');
    expect(texts).not.toContain('@Image');
  });
});
