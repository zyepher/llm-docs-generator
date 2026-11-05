import { describe, expect, it } from 'vitest';

import type { TransformName } from '../../src/config/project.js';
import {
  collectHeadings,
  convertMarkdownPage,
  createPackLinkRewriter,
  findLinkTargets,
  headingAnchors,
  scanMarkdownRegions,
  type MarkdownRegionKind,
  type MarkdownSyntaxOptions,
} from '../../src/pack/markdown.js';

/** The text of every region of `kind`, in order. */
function regionTexts(
  text: string,
  kind: MarkdownRegionKind,
  options: MarkdownSyntaxOptions = {}
): string[] {
  return scanMarkdownRegions(text, options)
    .filter((region) => region.kind === kind)
    .map((region) => text.slice(region.start, region.end));
}

function codeTexts(text: string, options: MarkdownSyntaxOptions = {}): string[] {
  return scanMarkdownRegions(text, options)
    .filter((region) => region.kind !== 'text' && region.kind !== 'html')
    .map((region) => text.slice(region.start, region.end));
}

describe('scanMarkdownRegions', () => {
  it('covers the whole text with sorted, disjoint regions', () => {
    const text = 'a `b`\n\n```\nc\n```\n<div>\nd\n</div>\n\n    e\n';
    const regions = scanMarkdownRegions(text);
    let cursor = 0;

    for (const region of regions) {
      expect(region.start).toBe(cursor);
      expect(region.end).toBeGreaterThan(region.start);
      cursor = region.end;
    }
    expect(cursor).toBe(text.length);
  });

  it('closes a fence only with the same character and at least the opening length', () => {
    const text = '````md\n```\nstill code\n~~~~\n````\nafter\n';
    expect(regionTexts(text, 'fenced-code')).toEqual(['````md\n```\nstill code\n~~~~\n````\n']);

    const tildes = '~~~\n```\n~~~~~\ntext\n';
    expect(regionTexts(tildes, 'fenced-code')).toEqual(['~~~\n```\n~~~~~\n']);
  });

  it('does not close a fence with a line that has an info string', () => {
    const text = '```\n``` js\n```\nafter\n';
    expect(regionTexts(text, 'fenced-code')).toEqual(['```\n``` js\n```\n']);
  });

  it('runs an unclosed fence to the end of the document', () => {
    expect(regionTexts('text\n```\nno close\n[x](y.md)', 'fenced-code')).toEqual([
      '```\nno close\n[x](y.md)',
    ]);
  });

  it('rejects a backtick fence whose info string contains a backtick', () => {
    expect(codeTexts('``` a`b\nnot code\n')).toEqual([]);
  });

  it('finds fences inside list items and blockquotes, and ends them with the container', () => {
    const list = '1. Install:\n\n   ```bash\n   npm i\n   ```\n\n2. Next\n';
    expect(regionTexts(list, 'fenced-code')).toEqual(['   ```bash\n   npm i\n   ```\n']);

    const quote = '> ```js\n> const a = 1;\nlazy text\n';
    expect(regionTexts(quote, 'fenced-code')).toEqual(['> ```js\n> const a = 1;\n']);
    expect(regionTexts(quote, 'text')).toEqual(['lazy text\n']);

    const nested = '- item\n  > ```\n  > code\n  > ```\n- next\n';
    expect(regionTexts(nested, 'fenced-code')).toEqual(['  > ```\n  > code\n  > ```\n']);
  });

  it('marks indented code but not an indented paragraph continuation or list content', () => {
    const text = 'para\n    continuation\n\n    real code\n\n- item\n\n    item paragraph\n';
    expect(regionTexts(text, 'indented-code')).toEqual(['    real code\n']);
  });

  it('has no indented code in MDX and allows indented fences there', () => {
    const text =
      '<Tabs>\n  <TabItem>\n\n    ```bash\n    npm i\n    ```\n\n  </TabItem>\n</Tabs>\n';
    expect(regionTexts(text, 'fenced-code', { mdx: true })).toEqual([
      '    ```bash\n    npm i\n    ```\n',
    ]);
    expect(regionTexts('text\n\n    not code in mdx\n', 'indented-code', { mdx: true })).toEqual(
      []
    );
  });

  it('matches code spans by backtick run length and honors escapes', () => {
    expect(regionTexts('a ``x ` y`` b `c` d', 'code-span')).toEqual(['``x ` y``', '`c`']);
    expect(regionTexts('unmatched `` run ` here', 'code-span')).toEqual([]);
    expect(regionTexts('\\`not a span` but `this one`', 'code-span')).toEqual(['` but `']);
    expect(regionTexts('span `across\nlines` ok', 'code-span')).toEqual(['`across\nlines`']);
    expect(regionTexts('no `span\n\nacross paragraphs`', 'code-span')).toEqual([]);
    expect(regionTexts('# Head `x\nnext` para', 'code-span')).toEqual([]);
  });

  it('treats inline HTML comments and autolinks as opaque for code spans', () => {
    expect(regionTexts('a <!-- `x` --> and <https://a.dev/`b`> `c`', 'code-span')).toEqual(['`c`']);
  });

  it('marks CommonMark HTML blocks and JSX flow lines', () => {
    const text =
      '<div>\n*raw*\n\n</div>\n\n<!--\nmulti\n-->\ntext\n\n<Tabs>\n```js\nx\n```\n</Tabs>\n';
    expect(regionTexts(text, 'html')).toEqual([
      '<div>\n*raw*\n',
      '</div>\n',
      '<!--\nmulti\n-->\n',
      '<Tabs>\n',
      '</Tabs>\n',
    ]);
    expect(regionTexts(text, 'fenced-code')).toEqual(['```js\nx\n```\n']);
  });

  it('does not let a type 7 HTML tag interrupt a paragraph', () => {
    expect(regionTexts('para\n<span>\nmore\n', 'html')).toEqual([]);
  });
});

describe('findLinkTargets', () => {
  it('finds inline links, images, definitions, autolinks, and HTML attributes outside code', () => {
    const text = [
      'See [a](./a.md "title") and ![img](<my image.png>) and [`code` text](b.md#frag).',
      '`[not](x.md)` and <a href="h.md">x</a> <img src=\'i.png\'>',
      '',
      '[ref]: ./r.md',
      '> [quoted]: <./q.md>',
      '',
      '```',
      '[no](y.md)',
      '```',
      '',
      '    [indented](z.md)',
      '',
      '<https://x.dev/page> <Card href="/jsx-prop" />',
      '[parens](a_(b).md) [escaped]\\(x.md)',
    ].join('\n');

    expect(findLinkTargets(text).map((link) => [link.kind, link.target])).toEqual([
      ['inline', './a.md'],
      ['image', 'my image.png'],
      ['inline', 'b.md#frag'],
      ['html-attribute', 'h.md'],
      ['html-attribute', 'i.png'],
      ['reference-definition', './r.md'],
      ['reference-definition', './q.md'],
      ['autolink', 'https://x.dev/page'],
      ['inline', 'a_(b).md'],
    ]);
  });

  it('reports offsets that slice out the target', () => {
    const text = 'x [a](./a.md) <a href="h.md"> [r]: no\n\n[d]: <./d.md>\n';
    for (const link of findLinkTargets(text)) {
      expect(text.slice(link.start, link.end)).toBe(link.target);
    }
  });

  it('ignores links inside HTML comments', () => {
    expect(findLinkTargets('<!-- [a](a.md) <a href="b.md"> -->')).toEqual([]);
  });
});

describe('headings', () => {
  it('collects ATX and setext headings outside code', () => {
    const text = '# One #\n\n```\n# not\n```\n\nTwo\n===\n\n> ## Quoted\n';
    expect(collectHeadings(text)).toEqual([
      { level: 1, text: 'One' },
      { level: 1, text: 'Two' },
      { level: 2, text: 'Quoted' },
    ]);
  });

  it('builds anchors with duplicate suffixes and HTML ids', () => {
    const anchors = headingAnchors('# Intro\n## Setup `npm`\n## Setup npm\n<a id="custom"></a>\n');
    expect([...anchors]).toEqual(['intro', 'setup-npm', 'setup-npm-1', 'custom']);
  });
});

const identity = createPackLinkRewriter({
  recipe: {
    title: 't',
    description: null,
    dependency: null,
    version: '1',
    sources: [],
    site: null,
    layout: { combined: false },
    license: null,
    limits: { maxFileBytes: 1 },
  },
  origins: [],
  pages: [],
  passthrough: [],
});

function convert(
  text: string,
  options: { syntax?: 'markdown' | 'mdx'; transforms?: TransformName[]; path?: string } = {}
) {
  return convertMarkdownPage({
    text,
    syntax: options.syntax ?? 'markdown',
    sourceIndex: 0,
    sourcePath: options.path ?? 'guide/page.md',
    outputPath: 'pages/guide/page.md',
    transforms: options.transforms ?? [],
    provenance: { packId: 'vite', version: '8.2.0', source: 'docs/guide/page.md' },
    rewriteLinks: identity,
  });
}

/** The page body after the provenance line and its blank line. */
function body(text: string, options: Parameters<typeof convert>[1] = {}): string {
  const result = convert(text, options).text;
  return result.slice(result.indexOf('\n') + 2);
}

describe('convertMarkdownPage', () => {
  it('starts with the provenance line, keeps content as written, and ends with one newline', () => {
    const result = convert('# Title\r\n\r\nText *as* written.  \r\n\r\n\r\n');

    expect(result.text).toBe(
      '<!-- llm-docs: vite@8.2.0 | source: docs/guide/page.md -->\n\n# Title\n\nText *as* written.\n'
    );
    expect(result.title).toBe('Title');
  });

  it('keeps an empty page to the provenance line', () => {
    expect(convert('').text).toBe('<!-- llm-docs: vite@8.2.0 | source: docs/guide/page.md -->\n');
  });

  it('escapes a comment terminator in the provenance source', () => {
    const result = convertMarkdownPage({
      text: 'x',
      syntax: 'markdown',
      sourceIndex: 0,
      sourcePath: 'a.md',
      outputPath: 'pages/a.md',
      transforms: [],
      provenance: { packId: 'p', version: '1', source: 'docs/a-->b.md' },
      rewriteLinks: identity,
    });
    expect(result.text.split('\n')[0]).toBe('<!-- llm-docs: p@1 | source: docs/a--&gt;b.md -->');
  });

  it('turns YAML frontmatter into an H1 and a first paragraph', () => {
    const page = convert(
      '---\ntitle: "Install: quick"\ndescription: Get started.\nsidebar: 2\n---\nBody.\n'
    );
    expect(page.text.slice(page.text.indexOf('\n') + 2)).toBe(
      '# Install: quick\n\nGet started.\n\nBody.\n'
    );
    expect(page.title).toBe('Install: quick');
  });

  it('keeps an existing H1 and places the description after it', () => {
    expect(body('---\ntitle: Ignored\ndescription: Lead.\n---\n\n# Real\n\nBody.\n')).toBe(
      '# Real\n\nLead.\n\nBody.\n'
    );
    expect(convert('---\ntitle: Front\n---\n# Real\n').title).toBe('Real');
  });

  it('reads TOML frontmatter', () => {
    expect(body('+++\ntitle = "Toml"\ndescription = "Desc"\n+++\nBody\n')).toBe(
      '# Toml\n\nDesc\n\nBody\n'
    );
  });

  it('leaves a leading thematic break that is not frontmatter alone', () => {
    expect(body('---\n- a\n- b\n---\ntext\n')).toBe('---\n- a\n- b\n---\ntext\n');
  });

  it('falls back to the file name for the title', () => {
    expect(convert('No heading.', { path: 'guide/getting-started.mdx' }).title).toBe(
      'getting-started'
    );
  });

  it('applies drop-frontmatter-description and counts it', () => {
    const result = convert('---\ntitle: T\ndescription: D\n---\nBody\n', {
      transforms: ['drop-frontmatter-description'],
    });
    expect(result.text).toContain('# T\n\nBody\n');
    expect(result.text).not.toContain('D\n');
    expect(result.changedBy).toEqual(['drop-frontmatter-description']);
    expect(convert('Body', { transforms: ['drop-frontmatter-description'] }).changedBy).toEqual([]);
  });

  it('strips the exact Mintlify banner and nothing fuzzier', () => {
    const banner =
      '> ## Documentation Index\n> Fetch the complete documentation index at: https://modelcontextprotocol.io/llms.txt\n> Use this file to discover all available pages before exploring further.\n\n# Lifecycle\n';
    const stripped = convert(banner, { transforms: ['strip-mintlify-banner'] });
    expect(stripped.text.slice(stripped.text.indexOf('\n') + 2)).toBe('# Lifecycle\n');
    expect(stripped.changedBy).toEqual(['strip-mintlify-banner']);

    const near = '> ## Documentation index\n> Fetch the complete documentation index at: x\n';
    expect(convert(near, { transforms: ['strip-mintlify-banner'] }).changedBy).toEqual([]);
    expect(body(banner)).toContain('Documentation Index');
  });

  it('strips HTML comments outside code only', () => {
    const text =
      'a <!-- inline --> b\n\n<!-- whole\nline -->\n\nc\n\n```html\n<!-- kept -->\n```\n\n`<!-- span -->`\n';
    const result = convert(text, { transforms: ['strip-html-comments'] });
    expect(result.text.slice(result.text.indexOf('\n') + 2)).toBe(
      'a  b\n\nc\n\n```html\n<!-- kept -->\n```\n\n`<!-- span -->`\n'
    );
    expect(result.changedBy).toEqual(['strip-html-comments']);
  });

  it('unwraps Docusaurus Tabs with labels and dedented code, removing top-level imports', () => {
    const source = [
      "import Tabs from '@theme/Tabs';",
      "import TabItem from '@theme/TabItem';",
      '',
      '# Install',
      '',
      '<Tabs groupId="package-manager">',
      '  <TabItem value="npm" label="npm" default>',
      '',
      '    ```bash',
      '    npm install vite',
      '    ```',
      '',
      '  </TabItem>',
      '  <TabItem value="yarn" label="Yarn">',
      '    ```bash',
      '    yarn add vite',
      '    ```',
      '  </TabItem>',
      '</Tabs>',
      '',
      'After `<Tabs>` text.',
      '',
      '```mdx',
      "import Tabs from '@theme/Tabs';",
      '<Tabs><TabItem value="x">kept</TabItem></Tabs>',
      '```',
    ].join('\n');

    expect(body(source, { syntax: 'mdx' })).toBe(
      [
        '# Install',
        '',
        '**npm**',
        '',
        '```bash',
        'npm install vite',
        '```',
        '',
        '**Yarn**',
        '',
        '```bash',
        'yarn add vite',
        '```',
        '',
        'After `<Tabs>` text.',
        '',
        '```mdx',
        "import Tabs from '@theme/Tabs';",
        '<Tabs><TabItem value="x">kept</TabItem></Tabs>',
        '```',
        '',
      ].join('\n')
    );
  });

  it('unwraps Mintlify CodeGroup and Card, keeping the Card title as a bold line', () => {
    const source = [
      '<CodeGroup>',
      '```bash npm',
      'npm i mint',
      '```',
      '```bash yarn',
      'yarn add mint',
      '```',
      '</CodeGroup>',
      '',
      '<CardGroup cols={2}>',
      '  <Card title="Quickstart" icon="rocket" href="/quickstart">',
      '    Get going.',
      '  </Card>',
      '  <Card',
      '    title={"Multi line"}',
      '    href="/x"',
      '  />',
      '</CardGroup>',
    ].join('\n');

    expect(body(source, { syntax: 'mdx' })).toBe(
      [
        '```bash npm',
        'npm i mint',
        '```',
        '```bash yarn',
        'yarn add mint',
        '```',
        '',
        '**Quickstart**',
        '',
        'Get going.',
        '',
        '**Multi line**',
        '',
      ].join('\n')
    );
  });

  it('unwraps a Nextra Callout and an inline Note, and counts unknown components', () => {
    const source = [
      "import { Callout } from 'nextra/components'",
      '',
      '<Callout type="warning" emoji="!">',
      '  Back up **first**. See [docs](./backup.md).',
      '</Callout>',
      '',
      '<Note>Inline note.</Note>',
      '',
      '<Playground code={`<b>{1}</b>`} />',
      '<Playground />',
      '<Chart.Bar data={[1, 2]} />',
    ].join('\n');
    const result = convert(source, { syntax: 'mdx' });

    expect(result.text.slice(result.text.indexOf('\n') + 2)).toBe(
      [
        'Back up **first**. See [docs](./backup.md).',
        '',
        'Inline note.',
        '',
        '<Playground code={`<b>{1}</b>`} />',
        '<Playground />',
        '<Chart.Bar data={[1, 2]} />',
        '',
      ].join('\n')
    );
    expect([...result.unknownComponents]).toEqual([
      ['Playground', 2],
      ['Chart.Bar', 1],
    ]);
  });

  it('keeps import and export lines that are not top-level ESM', () => {
    const source = [
      'To import them, then run setup.',
      'export default text in a paragraph',
      '',
      '<Steps>',
      "import nested from 'x'",
      '</Steps>',
      '',
      'export const meta = {',
      "  title: 'x',",
      '}',
      '',
      'End.',
    ].join('\n');

    expect(body(source, { syntax: 'mdx' })).toBe(
      [
        'To import them, then run setup.',
        'export default text in a paragraph',
        '',
        "import nested from 'x'",
        '',
        'End.',
        '',
      ].join('\n')
    );
  });

  it('removes imports only in MDX files', () => {
    expect(body("import X from 'y'\n\nText\n")).toBe("import X from 'y'\n\nText\n");
  });

  it('passes VitePress containers through untouched', () => {
    const source =
      '::: tip Heads up\nUse `vite build`.\n:::\n\n::: code-group\n```sh [npm]\nnpm i\n```\n:::\n';
    expect(body(source)).toBe(source);
    expect(body(source, { syntax: 'mdx' })).toBe(source);
  });

  it('keeps the DocC handling: metadata removed, tabs unwrapped, references unwrapped', () => {
    const source = [
      '# ``SlothCreator``',
      '',
      '@Metadata {',
      '    @DisplayName("Sloth Creator")',
      '}',
      '',
      'Build sloths with <doc:GettingStarted>.',
      '',
      '@TabNavigator {',
      '    @Tab("Swift") {',
      '        ```swift',
      '        let s = Sloth()',
      '        ```',
      '    }',
      '}',
      '',
      '`<doc:Kept>` in code.',
      '',
      '@Tutorial(time: 20) {',
      '    Kept content.',
      '}',
    ].join('\n');
    const result = body(source);

    expect(result).not.toContain('@Metadata');
    expect(result).toContain('Build sloths with GettingStarted.');
    expect(result).toContain('### Swift\n\n```swift\nlet s = Sloth()\n```');
    expect(result).toContain('`<doc:Kept>` in code.');
    expect(result).toContain('@Tutorial(time: 20) {\n    Kept content.\n}');
  });

  it('keeps the comment-directive tab dialect working', () => {
    const source =
      '## Setup\n\n<!-- ::start:tabs variant="bundler" -->\n\n# Vite\n\nUse vite.\n\n<!-- ::end:tabs -->\n';
    expect(body(source)).toContain('### Vite (bundler)');
    expect(convert(source).title).toBe('page');
  });

  it('hands the converted body to the link rewriter', () => {
    const result = convertMarkdownPage({
      text: 'See [a](a.mdx).',
      syntax: 'markdown',
      sourceIndex: 2,
      sourcePath: 'x/b.md',
      outputPath: 'pages/x/b.md',
      transforms: [],
      provenance: { packId: 'p', version: '1', source: 's' },
      rewriteLinks: (page) => ({
        text: page.text.replace('a.mdx', 'a.md'),
        rewritten: 1,
        external: 0,
        unresolved: [],
        plainTextConversions: 0,
      }),
    });

    expect(result.text).toContain('See [a](a.md).');
    expect(result.links.rewritten).toBe(1);
  });
});
