import { describe, expect, it } from 'vitest';

import {
  escapeIndexText,
  renderIndexPage,
  type IndexPageInput,
} from '../../src/pack/index-page.js';
import { encodeLinkPath } from '../../src/pack/links.js';
import { findLinkTargets } from '../../src/pack/markdown.js';

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
    files: [],
    readFirst: [],
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
        'Open the page for the API you need and read it before writing code against it. Search `pages/` for exact symbol names. Pages are upstream text at the pinned version. Guides, when this pack has any, are the digests in `guides/` written for this project: they link into the pages and never outrank them.',
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

  it('lists passthrough files with their sizes after the pages, and nothing when there are none', () => {
    const files = [
      { path: 'files/schema/schema.ts', bytes: 98765 },
      { path: 'files/a [b].json', bytes: 2 },
      { path: 'files/schema/schema.json', bytes: 123456 },
    ];
    const text = renderIndexPage(input({ files }));

    expect(text.slice(text.indexOf('## Files'))).toBe(
      [
        '## Files',
        '',
        'These files are byte-identical copies of the upstream files, kept as they are rather than converted to pages.',
        '',
        '- [a \\[b\\].json](files/a%20%5Bb%5D.json) (2 bytes)',
        '- [schema/schema.json](files/schema/schema.json) (123456 bytes)',
        '- [schema/schema.ts](files/schema/schema.ts) (98765 bytes)',
        '',
      ].join('\n')
    );
    expect(text.indexOf('## Files')).toBeGreaterThan(text.indexOf('## Pages'));
    expect(renderIndexPage(input({ files: [...files].reverse() }))).toBe(text);
    expect(renderIndexPage(input())).not.toContain('## Files');
  });

  it('groups the files by top-level directory when there are more than twenty', () => {
    const files = [
      ...Array.from({ length: 20 }, (_, index) => ({
        path: `files/schema/part-${String(index).padStart(2, '0')}.json`,
        bytes: index,
      })),
      { path: 'files/notes.txt', bytes: 5 },
    ];
    const text = renderIndexPage(input({ files }));
    const section = text.slice(text.indexOf('## Files'));

    expect(section.split('\n').slice(0, 9)).toEqual([
      '## Files',
      '',
      'These files are byte-identical copies of the upstream files, kept as they are rather than converted to pages.',
      '',
      '### Top level',
      '',
      '- [notes.txt](files/notes.txt) (5 bytes)',
      '',
      '### schema',
    ]);
    expect(section).toContain('- [schema/part-19.json](files/schema/part-19.json) (19 bytes)\n');
    expect(renderIndexPage(input({ files: files.slice(1) }))).not.toContain('### schema');
  });

  it('puts a Read first section between the reading notes and the pages, in recipe order', () => {
    const text = renderIndexPage(
      input({
        readFirst: [
          {
            path: 'pages/guide/index.md',
            fragment: null,
            title: 'Getting | `Started`',
            heading: null,
          },
          {
            path: 'pages/api/a b.md',
            fragment: 'breaking-changes',
            title: 'A',
            heading: 'Breaking [changes]',
          },
          { path: 'files/notes.txt', fragment: null, title: 'files/notes.txt', heading: null },
        ],
      })
    );

    expect(text).toContain(
      [
        'never outrank them.',
        '',
        '## Read first',
        '',
        'Start with these pages before writing code against Vite 8.2.0. They were marked as the ones to read first for this version, usually because they describe what changed.',
        '',
        '- [Getting \\| Started](pages/guide/index.md)',
        '- [A: Breaking \\[changes\\]](pages/api/a%20b.md#breaking-changes)',
        '- [files/notes.txt](files/notes.txt)',
        '',
        '## Pages',
        '',
      ].join('\n')
    );
    expect(renderIndexPage(input())).not.toContain('## Read first');
  });

  it('describes local origins and unknown licenses', () => {
    const text = renderIndexPage(
      input({
        origins: [
          { type: 'local', path: 'manuals', hostCommit: '0123456789abcdef', hostDirty: true },
        ],
        license: { declared: null, detected: null, status: 'unknown' },
      })
    );

    expect(text).toContain(
      'from the project folder `manuals` (host repository commit 0123456789ab, with uncommitted changes). License: unknown;'
    );
  });

  it('escapes upstream titles for tables and caps their length', () => {
    expect(escapeIndexText('a|b`c\u0007d\n<e>')).toBe('a\\|bc d \\<e\\>');
    expect(escapeIndexText('x'.repeat(200))).toHaveLength(120);
    expect(encodeLinkPath('pages/a (1)/#b.md')).toBe('pages/a%20%281%29/%23b.md');
  });

  it('percent-encodes parentheses in link destinations, so a link never ends early', () => {
    const text = renderIndexPage(
      input({
        pages: [{ path: 'pages/api/call(a).md', title: 'Call', tokens: 1 }],
        files: [{ path: 'files/data (1).json', bytes: 2 }],
      })
    );
    const targets = findLinkTargets(text)
      .map((link) => link.target)
      .filter((target) => target.startsWith('pages/') || target.startsWith('files/'));

    expect(targets).toEqual(['pages/api/call%28a%29.md', 'files/data%20%281%29.json']);
    expect(targets.every((target) => !/[()]/.test(target))).toBe(true);
    expect(targets.map(decodeURIComponent)).toEqual([
      'pages/api/call(a).md',
      'files/data (1).json',
    ]);
  });
});
