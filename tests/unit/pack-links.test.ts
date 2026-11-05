import { describe, expect, it } from 'vitest';

import type { ResolvedPackRecipe, ResolvedSource } from '../../src/config/project.js';
import { createPackLinkRewriter, routeKey } from '../../src/pack/links.js';
import type { ManifestOrigin } from '../../src/pack/manifest.js';
import type { LinkRewriteResult, PackFileRef } from '../../src/pack/markdown.js';

const COMMIT = 'a'.repeat(40);

const COMMON = {
  mount: '',
  include: ['**/*.md'],
  exclude: [],
  passthrough: [],
  convert: null,
  transforms: [],
} as const;

function localSource(path: string, mount = ''): ResolvedSource {
  return { type: 'local', path, ...COMMON, mount };
}

function recipe(
  sources: ResolvedSource[],
  site: ResolvedPackRecipe['site'] = null
): ResolvedPackRecipe {
  return {
    title: 'Demo',
    description: null,
    dependency: null,
    version: '1.0.0',
    sources,
    site,
    layout: { combined: false },
    license: null,
    limits: { maxFileBytes: 1_000_000 },
  };
}

const LOCAL_ORIGIN: ManifestOrigin = {
  type: 'local',
  path: 'docs',
  hostCommit: null,
  hostDirty: null,
};

/** A local page of source 0 (`docs/`), mounted at the pack root. */
function localPage(sourcePath: string, base = 'docs', mount = '', sourceIndex = 0): PackFileRef {
  return {
    sourceIndex,
    sourcePath,
    outputPath: ['pages', mount, sourcePath.replace(/\.[^./]+$/, '.md')]
      .filter((part) => part !== '')
      .join('/'),
    localPath: `${base}/${sourcePath}`,
  };
}

interface Setup {
  site?: ResolvedPackRecipe['site'];
  pages?: PackFileRef[];
  passthrough?: PackFileRef[];
  inventory?: string[];
}

const DEFAULT_PAGES = [
  localPage('index.md'),
  localPage('guide/intro.md'),
  localPage('guide/advanced/index.md'),
  localPage('guide/topic.md'),
  localPage('guide/topic/index.md'),
  localPage('api/router.md'),
  localPage('api/client.mdx'),
];

/** Rewrite `text` as the page `from` of a one-source local pack. */
function rewriteLocal(text: string, from = 'guide/intro.md', setup: Setup = {}): LinkRewriteResult {
  const pages = setup.pages ?? DEFAULT_PAGES;
  const rewrite = createPackLinkRewriter({
    recipe: recipe([localSource('docs')], setup.site ?? null),
    origins: [LOCAL_ORIGIN],
    pages,
    passthrough: setup.passthrough ?? [],
    inventories: [
      setup.inventory ?? [...pages, ...(setup.passthrough ?? [])].map((page) => page.sourcePath),
    ],
  });
  const page = pages.find((candidate) => candidate.sourcePath === from) ?? localPage(from);
  return rewrite({ ...page, text, mdx: from.endsWith('.mdx') });
}

const rewritten = (text: string, from?: string, setup?: Setup): string =>
  rewriteLocal(text, from, setup).text;

describe('routeKey', () => {
  it('drops page extensions, trailing slashes, and a trailing index', () => {
    expect(routeKey('guide/intro.md')).toBe('guide/intro');
    expect(routeKey('guide/intro.html')).toBe('guide/intro');
    expect(routeKey('guide/index.mdx')).toBe('guide');
    expect(routeKey('guide/')).toBe('guide');
    expect(routeKey('index.md')).toBe('');
    expect(routeKey('logo.png')).toBe('logo.png');
  });
});

describe('createPackLinkRewriter: relative links (spec 4.5 steps 1 and 2)', () => {
  it('keeps fragment-only targets and in-pack targets that already resolve', () => {
    const result = rewriteLocal('[a](#setup) [b](topic.md#usage) [c](../api/router.md)');
    expect(result.text).toBe('[a](#setup) [b](topic.md#usage) [c](../api/router.md)');
    expect(result.rewritten).toBe(0);
    expect(result.unresolved).toEqual([]);
  });

  it('resolves extension-less routes, .html routes, and index routes, keeping fragments', () => {
    expect(rewritten('[a](../api/router#createlink)')).toBe('[a](../api/router.md#createlink)');
    expect(rewritten('[a](../api/router.html)')).toBe('[a](../api/router.md)');
    expect(rewritten('[a](./advanced)')).toBe('[a](advanced/index.md)');
    expect(rewritten('[a](advanced/index)')).toBe('[a](advanced/index.md)');
    expect(rewritten('[a](../)')).toBe('[a](../index.md)');
    expect(rewritten('[a](../api/client)')).toBe('[a](../api/client.md)');
  });

  it('prefers the file for a route and the index for a directory-style target', () => {
    expect(rewritten('[a](./topic)')).toBe('[a](topic.md)');
    expect(rewritten('[a](./topic/)')).toBe('[a](topic/index.md)');
  });

  it('resolves bare targets and percent-encoded paths, and drops a query', () => {
    const pages = [localPage('a.md'), localPage('my page.md')];
    expect(rewritten('[x](my%20page.md?plain=1#top)', 'a.md', { pages })).toBe(
      '[x](my%20page.md#top)'
    );
    expect(rewritten('[x](<my page.md>)', 'a.md', { pages })).toBe('[x](<my%20page.md>)');
  });

  it('treats the link text as opaque: code spans and nested images', () => {
    expect(rewritten('- [`RouteOptions`](../api/router)')).toBe(
      '- [`RouteOptions`](../api/router.md)'
    );
    expect(rewritten('[![badge](https://img.shields.io/x.svg)](../api/router)')).toBe(
      '[![badge](https://img.shields.io/x.svg)](../api/router.md)'
    );
  });

  it('never touches links inside fenced code, indented code, or code spans', () => {
    const text = [
      '`[a](./gone.md)`',
      '',
      '```md',
      '[b](./gone.md)',
      '```',
      '',
      '    [c](./gone.md)',
    ].join('\n');
    const result = rewriteLocal(text);
    expect(result.text).toBe(text);
    expect(result.plainTextConversions).toBe(0);
  });

  it('rewrites reference definitions, images, and raw HTML href and src', () => {
    const passthrough: PackFileRef[] = [
      {
        sourceIndex: 0,
        sourcePath: 'img/d.png',
        outputPath: 'files/img/d.png',
        localPath: 'docs/img/d.png',
      },
    ];
    const text = [
      'See [router][r] and ![diagram](../img/d.png).',
      '',
      '<a href="../api/router">router</a> <img src="../img/d.png" alt="d">',
      '',
      '[r]: ../api/router#usage "Router"',
    ].join('\n');
    expect(rewritten(text, 'guide/intro.md', { passthrough })).toBe(
      [
        'See [router][r] and ![diagram](../../files/img/d.png).',
        '',
        '<a href="../api/router.md">router</a> <img src="../../files/img/d.png" alt="d">',
        '',
        '[r]: ../api/router.md#usage "Router"',
      ].join('\n')
    );
  });

  it('computes POSIX relative paths across sources and mounts', () => {
    const pages = [localPage('a.md', 'docs', 'v1', 0), localPage('b/c.md', 'guides', 'v2', 1)];
    const rewrite = createPackLinkRewriter({
      recipe: recipe([localSource('docs', 'v1'), localSource('guides', 'v2')]),
      origins: [LOCAL_ORIGIN, { ...LOCAL_ORIGIN, path: 'guides' }],
      pages,
      passthrough: [],
      inventories: [['a.md'], ['b/c.md']],
    });
    const page = pages[0];
    if (page === undefined) {
      throw new Error('no page');
    }
    expect(rewrite({ ...page, text: '[c](../guides/b/c.md#x)', mdx: false }).text).toBe(
      '[c](../v2/b/c.md#x)'
    );
  });

  it('counts absolute links as external and leaves them alone', () => {
    const result = rewriteLocal(
      '[a](https://example.com/x) <https://example.com/y> [m](mailto:a@b.c)'
    );
    expect(result.text).toBe(
      '[a](https://example.com/x) <https://example.com/y> [m](mailto:a@b.c)'
    );
    expect(result.external).toBe(3);
    expect(result.rewritten).toBe(0);
  });
});

describe('createPackLinkRewriter: site paths (spec 4.5 step 3)', () => {
  const site = { baseUrl: 'https://docs.example.com', aliases: { '/docs/latest': '/' } };

  it('matches site-absolute links against the pages’ site paths, with aliases', () => {
    expect(rewritten('[a](/api/router#x)', 'guide/intro.md', { site })).toBe(
      '[a](../api/router.md#x)'
    );
    expect(rewritten('[a](/docs/latest/guide/topic/)', 'guide/intro.md', { site })).toBe(
      '[a](topic/index.md)'
    );
    expect(rewritten('[a](/api/router.md)', 'guide/intro.md')).toBe('[a](../api/router.md)');
  });

  it('turns an unmatched site-absolute link into baseUrl + path', () => {
    const result = rewriteLocal('[a](/blog/post#top)', 'guide/intro.md', { site });
    expect(result.text).toBe('[a](https://docs.example.com/blog/post#top)');
    expect(result.external).toBe(1);
  });

  it('keeps baseUrl’s path prefix when building the absolute URL', () => {
    const prefixed = { baseUrl: 'https://example.com/docs/', aliases: {} };
    expect(rewritten('[a](/blog)', 'guide/intro.md', { site: prefixed })).toBe(
      '[a](https://example.com/docs/blog)'
    );
    expect(
      rewritten('[a](https://example.com/docs/api/router)', 'guide/intro.md', { site: prefixed })
    ).toBe('[a](../api/router.md)');
  });

  it('rewrites absolute URLs on the site to pack pages', () => {
    expect(rewritten('[a](https://docs.example.com/guide/topic#x)', 'index.md', { site })).toBe(
      '[a](guide/topic.md#x)'
    );
    expect(rewritten('[a](https://other.example.com/guide/topic)', 'index.md', { site })).toBe(
      '[a](https://other.example.com/guide/topic)'
    );
  });

  it('converts an unmatched site-absolute link to plain text without a baseUrl', () => {
    const result = rewriteLocal('See [the blog](/blog/post) now.');
    expect(result.text).toBe('See [the blog] (unresolved: /blog/post) now.');
    expect(result.unresolved).toEqual([
      { target: '/blog/post', reason: 'site-absolute-without-base-url' },
    ]);
    expect(result.plainTextConversions).toBe(1);
  });
});

describe('createPackLinkRewriter: targets outside the pack (spec 4.5 steps 4 and 5)', () => {
  it('sends a link to an excluded local page to the site when baseUrl is set', () => {
    const inventory = ['guide/intro.md', 'guide/excluded.md', 'guide/sub/a.md'];
    const pages = [localPage('guide/intro.md')];
    const site = { baseUrl: 'https://docs.example.com', aliases: {} };
    expect(
      rewritten('[x](excluded.md#y) [d](sub/)', 'guide/intro.md', { pages, inventory, site })
    ).toBe(
      '[x](https://docs.example.com/guide/excluded#y) [d](https://docs.example.com/guide/sub)'
    );
  });

  it('converts excluded, missing, and escaping local targets to plain text with reasons', () => {
    const inventory = ['guide/intro.md', 'guide/excluded.md', 'img/x.png'];
    const pages = [localPage('guide/intro.md')];
    const result = rewriteLocal(
      '[x](excluded.md) [y](gone.md) [z](../../outside.md) ![i](../img/x.png)',
      'guide/intro.md',
      { pages, inventory }
    );
    expect(result.text).toBe(
      '[x] (unresolved: excluded.md) [y] (unresolved: gone.md) [z] (unresolved: ../../outside.md) [i] (unresolved: ../img/x.png)'
    );
    expect(result.unresolved.map((entry) => entry.reason)).toEqual([
      'not-in-pack',
      'not-found',
      'outside-source',
      'not-in-pack',
    ]);
  });

  it('converts definitions and HTML attributes without breaking the markup', () => {
    const text = '[r]: ./gone.md "Gone"\n\n<a href="./gone.md">g</a> <img src=\'gone.png\'>';
    expect(rewritten(text)).toBe(
      '[r] (unresolved: ./gone.md) "Gone"\n\n<a data-unresolved-href="./gone.md">g</a> <img data-unresolved-src=\'gone.png\'>'
    );
  });

  it('keeps nested links working when the outer link is converted', () => {
    expect(rewritten('[![b](../api/router.md)](./gone.md)')).toBe(
      '[![b](../api/router.md)] (unresolved: ./gone.md)'
    );
  });

  it('pins out-of-pack targets of GitHub sources to the recorded commit', () => {
    const gitSource: ResolvedSource = {
      type: 'git',
      repo: 'https://github.com/acme/widgets',
      ref: 'v1',
      paths: ['docs'],
      ...COMMON,
    };
    const page: PackFileRef = {
      sourceIndex: 0,
      sourcePath: 'guide/intro.md',
      outputPath: 'pages/guide/intro.md',
      url: `https://github.com/acme/widgets/blob/${COMMIT}/docs/guide/intro.md`,
    };
    const origin: ManifestOrigin = {
      type: 'git',
      repo: 'https://github.com/acme/widgets',
      ref: 'v1',
      commit: COMMIT,
      refKind: 'tag',
    };
    const rewrite = createPackLinkRewriter({
      recipe: recipe([gitSource]),
      origins: [origin],
      pages: [page],
      passthrough: [],
    });
    const result = rewrite({
      ...page,
      text: '[a](../../src/index.ts#L3) [b](../../../../etc/passwd) [c](./intro.md)',
      mdx: false,
    });
    expect(result.text).toBe(
      `[a](https://github.com/acme/widgets/blob/${COMMIT}/src/index.ts#L3) [b] (unresolved: ../../../../etc/passwd) [c](intro.md)`
    );
    expect(result.unresolved).toEqual([
      { target: '../../../../etc/passwd', reason: 'outside-repository' },
    ]);

    const other = createPackLinkRewriter({
      recipe: recipe([{ ...gitSource, repo: 'https://gitlab.com/acme/widgets' }]),
      origins: [{ ...origin, repo: 'https://gitlab.com/acme/widgets' }],
      pages: [{ ...page, url: undefined }],
      passthrough: [],
    });
    expect(other({ ...page, url: undefined, text: '[a](../x.md)', mdx: false }).unresolved).toEqual(
      [{ target: '../x.md', reason: 'outside-pack-non-github-remote' }]
    );
  });

  it('resolves links of http-acquired pages in URL space', () => {
    const urlsSource: ResolvedSource = {
      type: 'urls',
      urls: [
        { url: 'https://x.dev/docs/a.md', path: 'docs/a.md' },
        { url: 'https://x.dev/docs/b.md', path: 'docs/b.md' },
      ],
      ...COMMON,
    };
    const pages: PackFileRef[] = [
      {
        sourceIndex: 0,
        sourcePath: 'docs/a.md',
        outputPath: 'pages/docs/a.md',
        url: 'https://x.dev/docs/a.md',
      },
      {
        sourceIndex: 0,
        sourcePath: 'docs/b.md',
        outputPath: 'pages/docs/b.md',
        url: 'https://x.dev/docs/b.md',
      },
    ];
    const rewrite = createPackLinkRewriter({
      recipe: recipe([urlsSource]),
      origins: [{ type: 'urls' }],
      pages,
      passthrough: [],
    });
    const page = pages[0];
    if (page === undefined) {
      throw new Error('no page');
    }
    expect(
      rewrite({
        ...page,
        text: '[b](./b) [c](./c.md#x) [r](/docs/b) [abs](https://x.dev/docs/b#y)',
        mdx: false,
      }).text
    ).toBe('[b](b.md) [c](https://x.dev/docs/c.md#x) [r](b.md) [abs](b.md#y)');
  });

  it('also rewrites links only Markdown rules see in an MDX page, as verify reads it', () => {
    const text = ['    ```js', '[x](./gone.md)', '    ```'].join('\n');
    const result = rewriteLocal(text, 'api/client.mdx');
    expect(result.text).toBe(['    ```js', '[x] (unresolved: ./gone.md)', '    ```'].join('\n'));
  });
});
