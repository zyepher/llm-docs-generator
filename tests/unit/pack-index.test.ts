import { describe, expect, it } from 'vitest';

import {
  escapeIndexText,
  linkPath,
  renderIndexPage,
  type IndexPageInput,
} from '../../src/pack/index-page.js';

const recipe: IndexPageInput['recipe'] = {
  title: 'Vite',
  description: null,
  dependency: null,
  version: '8.2.0',
  sources: [],
  site: null,
  layout: { combined: false },
  license: null,
  limits: { maxFileBytes: 1 },
};

function input(overrides: Partial<IndexPageInput> = {}): IndexPageInput {
  return {
    pack: { id: 'vite', title: 'Vite', version: '8.2.0' },
    recipe,
    origins: [
      {
        type: 'git',
        repo: 'https://github.com/vitejs/vite.git',
        ref: 'v8.2.0',
        commit: 'abcdef0123456789abcdef0123456789abcdef01',
        refKind: 'tag',
      },
    ],
    acquiredAt: '2026-11-05T10:00:00.000Z',
    license: {
      declared: null,
      detected: { spdx: 'MIT', evidence: 'LICENSE' },
      status: 'permissive',
    },
    sources: [],
    pages: [
      { path: 'pages/guide/index.md', title: 'Getting | `Started`\nnow', tokens: 600 },
      { path: 'pages/api/z.md', title: 'Z', tokens: 3 },
      { path: 'pages/readme.md', title: 'Readme', tokens: 10 },
      { path: 'pages/api/a b.md', title: 'A', tokens: 4 },
    ],
    guides: [],
    ...overrides,
  };
}

describe('renderIndexPage', () => {
  it('renders the title, provenance, reading notes, and grouped page tables deterministically', () => {
    const text = renderIndexPage(input());

    expect(text).toBe(
      [
        '# Vite 8.2.0',
        '',
        'Pinned reference docs for Vite 8.2.0, acquired on 2026-11-05 from the git repository [vitejs/vite](https://github.com/vitejs/vite) at commit [abcdef012345](https://github.com/vitejs/vite/commit/abcdef0123456789abcdef0123456789abcdef01) (tag v8.2.0). License: MIT (detected from LICENSE).',
        '',
        '## How to read this pack',
        '',
        'Open the page for the API you need and read it before writing code against it. Search `pages/` for exact symbol names. Pages are upstream text at the pinned version; guides are digests written for this project and never outrank pages.',
        '',
        '## Pages',
        '',
        '### Top level',
        '',
        '| Page | Title | Tokens |',
        '| --- | --- | --- |',
        '| [readme.md](pages/readme.md) | Readme | 10 |',
        '',
        '### api',
        '',
        '| Page | Title | Tokens |',
        '| --- | --- | --- |',
        '| [api/a b.md](pages/api/a%20b.md) | A | 4 |',
        '| [api/z.md](pages/api/z.md) | Z | 3 |',
        '',
        '### guide',
        '',
        '| Page | Title | Tokens |',
        '| --- | --- | --- |',
        '| [guide/index.md](pages/guide/index.md) | Getting \\| Started now | 600 |',
        '',
      ].join('\n')
    );
    expect(renderIndexPage(input({ pages: [...input().pages].reverse() }))).toBe(text);
  });

  it('lists guides and describes local origins and unknown licenses', () => {
    const text = renderIndexPage(
      input({
        origins: [
          { type: 'local', path: 'manuals', hostCommit: '0123456789abcdef', hostDirty: true },
        ],
        license: { declared: null, detected: null, status: 'unknown' },
        guides: [
          { path: 'guides/02-b.md', title: 'B' },
          { path: 'guides/01-a.md', title: 'A [draft]' },
        ],
      })
    );

    expect(text).toContain(
      'from the project folder `manuals` (host repository commit 0123456789ab, with uncommitted changes). License: unknown;'
    );
    expect(text).toContain(
      '## Guides\n\n- [A \\[draft\\]](guides/01-a.md)\n- [B](guides/02-b.md)\n\n## Pages'
    );
  });

  it('escapes upstream titles for tables and caps their length', () => {
    expect(escapeIndexText('a|b`c\u0007d\n<e>')).toBe('a\\|bc d \\<e\\>');
    expect(escapeIndexText('x'.repeat(200))).toHaveLength(120);
    expect(linkPath('pages/a (1)/#b.md')).toBe('pages/a%20(1)/%23b.md');
  });
});
