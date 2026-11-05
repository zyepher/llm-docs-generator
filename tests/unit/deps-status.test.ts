import { describe, expect, it } from 'vitest';

import type { ResolvedDependency } from '../../src/deps/lockfiles.js';
import type { ReleaseInfo } from '../../src/deps/registries.js';
import {
  computeStatus,
  formatStatusBrief,
  formatStatusHuman,
  type ComputeStatusInput,
  type PackStatusInput,
} from '../../src/deps/status.js';

const NOW = new Date('2026-11-05T00:00:00.000Z');

function dep(
  name: string,
  version: string,
  overrides: Partial<ResolvedDependency> = {}
): ResolvedDependency {
  return {
    ecosystem: 'npm',
    name,
    version,
    direct: true,
    dev: false,
    lockfile: 'package-lock.json',
    ...overrides,
  };
}

function releases(entries: Record<string, string | null>): Map<string, ReleaseInfo> {
  return new Map(
    Object.entries(entries).map(([key, publishedAt]) => [
      key,
      { publishedAt, source: 'deps.dev', cached: true },
    ])
  );
}

function pack(id: string, overrides: Partial<PackStatusInput> = {}): PackStatusInput {
  return {
    id,
    version: '1.0.0',
    dependency: null,
    recipeChanged: false,
    synced: true,
    inConfig: true,
    ...overrides,
  };
}

const BRIEF_OPTIONS = {
  maxChars: 2000,
  packsDir: 'agent-docs',
  blockPresent: true,
  packIndexPaths: {},
};

function baseInput(overrides: Partial<ComputeStatusInput> = {}): ComputeStatusInput {
  return {
    dependencies: [],
    releases: new Map(),
    nearCutoffDays: 90,
    packs: [],
    now: NOW,
    ...overrides,
  };
}

describe('computeStatus packs', () => {
  it('classifies ok, stale-pack, recipe-changed, missing, and orphan', () => {
    const report = computeStatus(
      baseInput({
        dependencies: [
          dep('vite', '8.2.0'),
          dep('vite', '7.0.0', { direct: false }),
          dep('react', '19.1.0'),
          dep('zod', '4.0.0', { lockfile: 'apps/a/package-lock.json' }),
          dep('zod', '4.1.0', { lockfile: 'apps/b/package-lock.json' }),
        ],
        packs: [
          pack('vite', { version: '8.1.0', dependency: { ecosystem: 'npm', name: 'vite' } }),
          pack('react', { version: '19.1.0', dependency: { ecosystem: 'npm', name: 'react' } }),
          pack('zod', { version: '4.0.0', dependency: { ecosystem: 'npm', name: 'zod' } }),
          pack('zod-old', { version: '3.0.0', dependency: { ecosystem: 'npm', name: 'zod' } }),
          pack('mcp', { version: '2026-07-28', recipeChanged: true }),
          pack('next', {
            version: null,
            synced: false,
            dependency: { ecosystem: 'npm', name: 'next' },
          }),
          pack('legacy', { inConfig: false }),
          pack('django', { version: '5.1.2', dependency: { ecosystem: 'pypi', name: 'Django' } }),
        ],
      })
    );

    expect(report.packs.map((entry) => [entry.id, entry.state])).toEqual([
      ['django', 'ok'],
      ['legacy', 'orphan'],
      ['mcp', 'recipe-changed'],
      ['next', 'missing'],
      ['react', 'ok'],
      ['vite', 'stale-pack'],
      ['zod', 'ok'],
      ['zod-old', 'stale-pack'],
    ]);
    expect(report.packs.find((entry) => entry.id === 'vite')?.lockfile).toEqual({
      kind: 'found',
      version: '8.2.0',
      lockfiles: ['package-lock.json'],
    });
    expect(report.packs.find((entry) => entry.id === 'django')?.lockfile).toEqual({
      kind: 'missing',
      searched: [],
    });
    expect(report.packs.find((entry) => entry.id === 'mcp')?.lockfile).toBeUndefined();
  });
});

describe('computeStatus releases', () => {
  const dependencies = [
    dep('next', '16.1.0'),
    dep('react', '19.2.0'),
    dep('vite', '8.2.0'),
    dep('hono', '4.9.0', { dev: true }),
    dep('lodash', '4.17.21'),
    dep('mystery', '1.0.0'),
    dep('transitive-new', '1.0.0', { direct: false }),
    dep('Django', '6.0.0', { ecosystem: 'pypi', name: 'django', lockfile: 'uv.lock' }),
    dep('next', '16.1.0', { lockfile: 'apps/web/package-lock.json' }),
  ];
  const dates = releases({
    'npm:next@16.1.0': '2026-10-21T18:00:00.000Z',
    'npm:react@19.2.0': '2026-07-01T00:00:00.000Z',
    'npm:vite@8.2.0': '2026-09-15T00:00:00.000Z',
    'npm:hono@4.9.0': '2026-05-10T00:00:00.000Z',
    'npm:lodash@4.17.21': '2021-02-20T15:42:16.891Z',
    'npm:mystery@1.0.0': null,
    'npm:transitive-new@1.0.0': '2026-10-30T00:00:00.000Z',
    'pypi:django@6.0.0': '2026-06-30T23:59:59.000Z',
  });

  it('splits direct dependencies into after-cutoff and near-cutoff, excluding bound ones', () => {
    const report = computeStatus(
      baseInput({
        dependencies,
        releases: dates,
        cutoff: { cutoff: '2026-06', label: 'Claude Opus 5.5' },
        packs: [pack('vite', { version: '8.2.0', dependency: { ecosystem: 'npm', name: 'vite' } })],
      })
    );

    expect(report.afterCutoff.map((release) => `${release.name}@${release.version}`)).toEqual([
      'next@16.1.0',
      'react@19.2.0',
    ]);
    expect(report.afterCutoff[0]).toEqual({
      ecosystem: 'npm',
      name: 'next',
      version: '16.1.0',
      publishedAt: '2026-10-21T18:00:00.000Z',
      dev: false,
      lockfiles: ['apps/web/package-lock.json', 'package-lock.json'],
    });
    expect(report.nearCutoff.map((release) => release.name)).toEqual(['django', 'hono']);
    expect(report.recent).toEqual([]);
    expect(report.directDependencies).toBe(7);
    expect(report.unknownReleaseDates).toBe(1);
    expect(report.cutoff).toEqual({ cutoff: '2026-06', label: 'Claude Opus 5.5' });
  });

  it('treats the cutoff month as inclusive and the near window as days before its end', () => {
    const report = computeStatus(
      baseInput({
        dependencies: [dep('a', '1.0.0'), dep('b', '1.0.0'), dep('c', '1.0.0')],
        releases: releases({
          'npm:a@1.0.0': '2026-07-01T00:00:00.000Z',
          'npm:b@1.0.0': '2026-04-02T00:00:00.000Z',
          'npm:c@1.0.0': '2026-04-01T23:59:59.000Z',
        }),
        cutoff: { cutoff: '2026-06', label: 'x' },
        nearCutoffDays: 90,
      })
    );

    expect(report.afterCutoff.map((release) => release.name)).toEqual(['a']);
    expect(report.nearCutoff.map((release) => release.name)).toEqual(['b']);
  });

  it('falls back to a recent list relative to now when no cutoff is known', () => {
    const report = computeStatus(baseInput({ dependencies, releases: dates }));

    expect(report.cutoff).toBeNull();
    expect(report.afterCutoff).toEqual([]);
    expect(report.nearCutoff).toEqual([]);
    expect(report.recentDays).toBe(180);
    expect(report.recent.map((release) => release.name)).toEqual([
      'next',
      'vite',
      'react',
      'django',
      'hono',
    ]);
  });
});

describe('formatStatusBrief', () => {
  it('returns an empty string when there is nothing to say', () => {
    const report = computeStatus(
      baseInput({
        dependencies: [dep('lodash', '4.17.21')],
        releases: releases({ 'npm:lodash@4.17.21': '2021-02-20T00:00:00.000Z' }),
        cutoff: { cutoff: '2026-06', label: 'x' },
        packs: [pack('vite')],
      })
    );

    expect(formatStatusBrief(report, BRIEF_OPTIONS)).toBe('');
  });

  it('lists packs needing a rebuild, then after and near cutoff deps, then packs without a block', () => {
    const report = computeStatus(
      baseInput({
        dependencies: [
          dep('vite', '8.2.0'),
          dep('next', '16.1.0'),
          dep('hono', '4.9.0'),
          dep('Django', '6.0.0', { ecosystem: 'pypi', name: 'django', lockfile: 'uv.lock' }),
        ],
        releases: releases({
          'npm:next@16.1.0': '2026-10-21T18:00:00.000Z',
          'npm:hono@4.9.0': '2026-05-10T00:00:00.000Z',
          'pypi:django@6.0.0': '2026-08-01T00:00:00.000Z',
        }),
        cutoff: { cutoff: '2026-06', label: 'Claude Opus 5.5' },
        packs: [
          pack('vite', { version: '8.1.0', dependency: { ecosystem: 'npm', name: 'vite' } }),
          pack('mcp', { version: '2026-07-28' }),
          pack('zod', { version: null, synced: false }),
        ],
      })
    );

    expect(
      formatStatusBrief(report, {
        ...BRIEF_OPTIONS,
        blockPresent: false,
        packIndexPaths: { mcp: 'docs/mcp/index.md' },
      })
    ).toBe(
      [
        'Pinned docs packs that need a rebuild:',
        '- vite: docs are for 8.1.0 but the lockfile resolves 8.2.0. Fix: `llm-docs sync vite`',
        '- zod: configured but never built. Fix: `llm-docs sync zod`',
        '',
        'Direct dependencies released after or close to your training data cutoff (Claude Opus 5.5, through 2026-06) with no pinned docs, newest first:',
        '- next 16.1.0 (npm, released 2026-10-21, after cutoff)',
        '- django 6.0.0 (pypi, released 2026-08-01, after cutoff)',
        '- hono 4.9.0 (npm, released 2026-05-10, near cutoff)',
        'Before using their APIs, read their current docs rather than relying on memory, or create a pinned docs pack with the `add-docs` skill.',
        '',
        'Pinned reference docs in this repository (open the index and the page for the API you need before writing code against these libraries):',
        '- mcp 2026-07-28: `docs/mcp/index.md`',
        '- vite 8.1.0: `agent-docs/vite/index.md`',
      ].join('\n')
    );
  });

  it('uses neutral wording for the no-cutoff recent list and caps it at 8 entries', () => {
    const names = Array.from({ length: 10 }, (_, index) => `pkg-${index}`);
    const report = computeStatus(
      baseInput({
        dependencies: names.map((name) => dep(name, '1.0.0')),
        releases: releases(
          Object.fromEntries(
            names.map((name, index) => [
              `npm:${name}@1.0.0`,
              new Date(NOW.getTime() - (index + 1) * 86_400_000).toISOString(),
            ])
          )
        ),
      })
    );
    const lines = formatStatusBrief(report, BRIEF_OPTIONS).split('\n');

    expect(lines[0]).toBe(
      'Recently released dependencies (your training data may predate them), released in the last 180 days with no pinned docs, newest first:'
    );
    expect(lines.slice(1, 10)).toEqual([
      ...names.slice(0, 8).map((name, index) => {
        const day = new Date(NOW.getTime() - (index + 1) * 86_400_000).toISOString().slice(0, 10);
        return `- ${name} 1.0.0 (npm, released ${day})`;
      }),
      '- and 2 more (run `llm-docs status`)',
    ]);
  });

  it('truncates whole lines to maxChars', () => {
    const report = computeStatus(
      baseInput({
        packs: [
          pack('alpha', { version: '1.0.0', dependency: { ecosystem: 'npm', name: 'alpha' } }),
          pack('beta', { version: '1.0.0', dependency: { ecosystem: 'npm', name: 'beta' } }),
        ],
        dependencies: [dep('alpha', '2.0.0'), dep('beta', '2.0.0')],
      })
    );
    const full = formatStatusBrief(report, BRIEF_OPTIONS);
    const [header, first] = full.split('\n');
    const truncated = formatStatusBrief(report, {
      ...BRIEF_OPTIONS,
      maxChars: `${header}\n${first}`.length + 5,
    });

    expect(full.split('\n')).toHaveLength(3);
    expect(truncated).toBe(`${header}\n${first}`);
    expect(formatStatusBrief(report, { ...BRIEF_OPTIONS, maxChars: 10 })).toBe('');
  });
});

describe('formatStatusHuman', () => {
  it('renders the pack table and dependency lists', () => {
    const report = computeStatus(
      baseInput({
        dependencies: [dep('vite', '8.2.0'), dep('next', '16.1.0'), dep('mystery', '1.0.0')],
        releases: releases({
          'npm:next@16.1.0': '2026-10-21T18:00:00.000Z',
          'npm:mystery@1.0.0': null,
        }),
        cutoff: { cutoff: '2026-06', label: 'Claude Opus 5.5' },
        packs: [pack('vite', { version: '8.1.0', dependency: { ecosystem: 'npm', name: 'vite' } })],
      })
    );

    expect(formatStatusHuman(report)).toBe(
      [
        'Packs:',
        '  ID    VERSION  DEPENDENCY  LOCKFILE  STATE',
        '  vite  8.1.0    npm:vite    8.2.0     stale-pack',
        '',
        'Model training data cutoff: 2026-06 (Claude Opus 5.5).',
        '',
        'Direct dependencies released after the cutoff without a pack:',
        '  NAME  VERSION  ECOSYSTEM  RELEASED',
        '  next  16.1.0   npm        2026-10-21',
        '',
        'Next step: add a pack with `llm-docs add <id> --dependency <ecosystem>:<name> ...`.',
        '',
        '3 direct dependencies checked; 2 with an unknown release date.',
        '',
      ].join('\n')
    );
  });

  it('explains how to set a cutoff when none is known', () => {
    const output = formatStatusHuman(computeStatus(baseInput()));

    expect(output).toContain('Packs: none configured.');
    expect(output).toContain('Model training data cutoff: unknown');
    expect(output).toContain(
      'Direct dependencies released in the last 180 days without a pack: none.'
    );
  });
});
