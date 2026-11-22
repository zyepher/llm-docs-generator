import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfigError, loadProjectConfigIfPresent } from '../../src/config/project.js';
import type { ResolvedDependency } from '../../src/deps/lockfiles.js';
import type { ReleaseInfo } from '../../src/deps/registries.js';
import {
  computeStatus,
  formatStatusBrief,
  formatStatusHuman,
  gatherProjectStatus,
  type ComputeStatusInput,
  type GatherStatusOptions,
  type PackStatusInput,
  type StatusCutoff,
} from '../../src/deps/status.js';
import { syncPacks } from '../../src/pack/build.js';
import { ALLOW_TEMP_SOURCES_ENV } from '../../src/sources/acquire.js';
import { ALLOW_PRIVATE_NETWORK_ENV } from '../../src/sources/http.js';

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
    title: id,
    version: '1.0.0',
    dependency: null,
    versionPinned: false,
    recipeChanged: false,
    indexPath: `agent-docs/${id}/index.md`,
    readFirst: [],
    inConfig: true,
    ...overrides,
  };
}

const BRIEF_OPTIONS = { maxChars: 2000 };

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
            indexPath: null,
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
        cutoff: { cutoff: '2026-06', label: 'Claude Opus 5.5', source: 'table', assumed: false },
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
      nextStep: 'llm-docs discover --package npm:next@16.1.0',
    });
    expect(report.nearCutoff.map((release) => release.name)).toEqual(['django', 'hono']);
    expect(report.recent).toEqual([]);
    expect(report.directDependencies).toBe(7);
    expect(report.unknownReleaseDates).toBe(1);
    expect(report.cutoff).toEqual({
      cutoff: '2026-06',
      label: 'Claude Opus 5.5',
      source: 'table',
      assumed: false,
    });
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
        cutoff: { cutoff: '2026-06', label: 'x', source: 'table', assumed: false },
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

describe('computeStatus next steps and pack releases', () => {
  it('gives every pack and dependency row its own next step', () => {
    const report = computeStatus(
      baseInput({
        dependencies: [
          dep('vite', '8.2.0'),
          dep('zod', '4.1.0'),
          dep('nio', '2.60.0', {
            ecosystem: 'swiftpm',
            name: 'swift-nio',
            lockfile: 'Package.resolved',
            repositoryUrl: 'https://github.com/apple/swift-nio.git',
          }),
        ],
        releases: releases({ 'swiftpm:swift-nio@2.60.0': '2026-09-01T00:00:00.000Z' }),
        cutoff: { cutoff: '2026-06', label: 'x', source: 'table', assumed: false },
        packs: [
          pack('ok', { recipeChanged: false }),
          pack('vite', { version: '8.1.0', dependency: { ecosystem: 'npm', name: 'vite' } }),
          pack('zod', {
            version: '4.0.0',
            versionPinned: true,
            dependency: { ecosystem: 'npm', name: 'zod' },
          }),
          pack('mcp', { recipeChanged: true }),
          pack('later', { indexPath: null }),
          pack('legacy', { inConfig: false }),
        ],
      })
    );

    expect(Object.fromEntries(report.packs.map((entry) => [entry.id, entry.nextStep]))).toEqual({
      later: 'llm-docs sync later',
      legacy: "run 'llm-docs sync --prune' to delete it, or add packs.legacy back to llm-docs.json",
      mcp: 'llm-docs sync mcp',
      ok: null,
      vite: 'llm-docs sync vite',
      zod: "set packs.zod.version in llm-docs.json to 4.1.0 (or remove it to follow the lockfile), then run 'llm-docs sync zod'",
    });
    expect(report.afterCutoff.map((release) => release.nextStep)).toEqual([
      'llm-docs discover --package swiftpm:https://github.com/apple/swift-nio.git@2.60.0',
    ]);
  });

  it("dates each bound pack's own version and places it in the cutoff windows", () => {
    const bound = (name: string, version: string): Partial<PackStatusInput> => ({
      version,
      dependency: { ecosystem: 'npm', name },
    });
    const report = computeStatus(
      baseInput({
        dependencies: [dep('a', '2.0.0'), dep('b', '1.0.0'), dep('c', '1.0.0')],
        releases: releases({
          'npm:a@1.0.0': '2026-08-01T00:00:00.000Z',
          'npm:a@2.0.0': '2026-10-01T00:00:00.000Z',
          'npm:b@1.0.0': '2026-05-01T00:00:00.000Z',
          'npm:c@1.0.0': '2025-01-01T00:00:00.000Z',
        }),
        cutoff: { cutoff: '2026-06', label: 'x', source: 'table', assumed: false },
        packs: [
          pack('a', bound('a', '1.0.0')),
          pack('b', bound('b', '1.0.0')),
          pack('c', bound('c', '1.0.0')),
          pack('d', bound('d', '1.0.0')),
        ],
      })
    );

    expect(
      report.packs.map((entry) => [entry.id, entry.state, entry.publishedAt, entry.releaseWindow])
    ).toEqual([
      ['a', 'stale-pack', '2026-08-01T00:00:00.000Z', 'after-cutoff'],
      ['b', 'ok', '2026-05-01T00:00:00.000Z', 'near-cutoff'],
      ['c', 'ok', '2025-01-01T00:00:00.000Z', null],
      ['d', 'ok', null, null],
    ]);
    expect(report.afterCutoff).toEqual([]);
    expect(report.nearCutoff).toEqual([]);
  });
});

describe('formatStatusBrief', () => {
  const cutoff: StatusCutoff = {
    cutoff: '2026-06',
    label: 'Claude Opus 5.5',
    source: 'table',
    assumed: false,
  };
  const DEPENDENCIES_FOOTER =
    'Before using their APIs, read their current docs rather than relying on memory, or create a pinned docs pack with the `add-docs` skill.';

  it('returns an empty string when there is nothing to say', () => {
    const report = computeStatus(
      baseInput({
        dependencies: [dep('lodash', '4.17.21')],
        releases: releases({ 'npm:lodash@4.17.21': '2021-02-20T00:00:00.000Z' }),
        cutoff,
        packs: [pack('vite')],
      })
    );

    expect(formatStatusBrief(report, BRIEF_OPTIONS)).toBe('');
  });

  it('lists packs needing a rebuild, then pinned docs newer than the cutoff, then dependencies without a pack', () => {
    const report = computeStatus(
      baseInput({
        dependencies: [
          dep('vite', '8.2.0'),
          dep('zod', '4.1.0'),
          dep('next', '16.1.0'),
          dep('hono', '4.9.0'),
          dep('Django', '6.0.0', { ecosystem: 'pypi', name: 'django', lockfile: 'uv.lock' }),
        ],
        releases: releases({
          'npm:vite@8.1.0': '2026-06-20T00:00:00.000Z',
          'npm:zod@4.1.0': '2026-09-30T00:00:00.000Z',
          'npm:next@16.1.0': '2026-10-21T18:00:00.000Z',
          'npm:hono@4.9.0': '2026-05-10T00:00:00.000Z',
          'pypi:django@6.0.0': '2026-08-01T00:00:00.000Z',
        }),
        cutoff,
        packs: [
          pack('vite', { version: '8.1.0', dependency: { ecosystem: 'npm', name: 'vite' } }),
          pack('zod', {
            title: 'Zod `@schemas`',
            version: '4.1.0',
            dependency: { ecosystem: 'npm', name: 'zod' },
          }),
          pack('mcp', { version: '2026-07-28' }),
          pack('notes', { indexPath: null }),
        ],
      })
    );

    expect(formatStatusBrief(report, BRIEF_OPTIONS)).toBe(
      [
        'Pinned docs packs that need a rebuild:',
        '- notes: configured but never built. Fix: `llm-docs sync notes`',
        '- vite: docs are for 8.1.0 but the lockfile resolves 8.2.0. Fix: `llm-docs sync vite`',
        '',
        'Pinned docs for libraries released after or close to your training data cutoff (Claude Opus 5.5, through 2026-06). Your memory of these libraries predates these versions: read the pinned pages before writing code against them. Newest first:',
        '- Zod schemas 4.1.0 (released 2026-09-30, after cutoff): `agent-docs/zod/index.md`',
        '- vite 8.1.0 (released 2026-06-20, near cutoff): `agent-docs/vite/index.md`',
        '',
        'Direct dependencies released after or close to your training data cutoff (Claude Opus 5.5, through 2026-06) with no pinned docs, newest first:',
        '- next 16.1.0 (npm, released 2026-10-21, after cutoff)',
        '- django 6.0.0 (pypi, released 2026-08-01, after cutoff)',
        '- hono 4.9.0 (npm, released 2026-05-10, near cutoff)',
        DEPENDENCIES_FOOTER,
      ].join('\n')
    );
  });

  it('names the config edit when the stale pack pins its version', () => {
    const report = computeStatus(
      baseInput({
        dependencies: [dep('vite', '8.2.0')],
        packs: [
          pack('vite', {
            version: '8.1.0',
            versionPinned: true,
            dependency: { ecosystem: 'npm', name: 'vite' },
          }),
        ],
      })
    );

    expect(formatStatusBrief(report, BRIEF_OPTIONS)).toBe(
      [
        'Pinned docs packs that need a rebuild:',
        "- vite: docs are for 8.1.0 but the lockfile resolves 8.2.0. Fix: set packs.vite.version in llm-docs.json to 8.2.0 (or remove it to follow the lockfile), then run 'llm-docs sync vite'",
      ].join('\n')
    );
  });

  it('uses neutral wording and the recent window when no cutoff is known, and caps dependencies at 8', () => {
    const names = Array.from({ length: 10 }, (_, index) => `pkg-${index}`);
    const day = (index: number): string =>
      new Date(NOW.getTime() - (index + 1) * 86_400_000).toISOString();
    const report = computeStatus(
      baseInput({
        dependencies: names.map((name) => dep(name, '1.0.0')),
        releases: releases({
          ...Object.fromEntries(names.map((name, index) => [`npm:${name}@1.0.0`, day(index)])),
          'npm:vite@8.1.0': '2026-10-01T00:00:00.000Z',
        }),
        packs: [pack('vite', { version: '8.1.0', dependency: { ecosystem: 'npm', name: 'vite' } })],
      })
    );
    const lines = formatStatusBrief(report, BRIEF_OPTIONS).split('\n');

    expect(lines.slice(0, 3)).toEqual([
      'Pinned docs for libraries released in the last 180 days. Your training data may predate these versions: read the pinned pages before writing code against them. Newest first:',
      '- vite 8.1.0 (released 2026-10-01): `agent-docs/vite/index.md`',
      '',
    ]);
    expect(lines.slice(3)).toEqual([
      'Recently released dependencies (your training data may predate them), released in the last 180 days with no pinned docs, newest first:',
      ...names
        .slice(0, 8)
        .map((name, index) => `- ${name} 1.0.0 (npm, released ${day(index).slice(0, 10)})`),
      '- and 2 more (run `llm-docs status`)',
      DEPENDENCIES_FOOTER,
    ]);
  });

  it('cuts from the bottom up: the last item first, a row at a time, then whole items', () => {
    const names = Array.from({ length: 10 }, (_, index) => `dep-${index}`);
    const report = computeStatus(
      baseInput({
        dependencies: [
          dep('alpha', '2.0.0'),
          dep('beta', '2.0.0'),
          ...names.map((name) => dep(name, '1.0.0')),
        ],
        releases: releases({
          'npm:alpha@1.0.0': '2026-08-01T00:00:00.000Z',
          'npm:beta@1.0.0': '2026-07-01T00:00:00.000Z',
          ...Object.fromEntries(
            names.map((name, index) => [
              `npm:${name}@1.0.0`,
              `2026-09-${String(10 + index).padStart(2, '0')}T00:00:00.000Z`,
            ])
          ),
        }),
        cutoff,
        packs: [
          pack('alpha', { version: '1.0.0', dependency: { ecosystem: 'npm', name: 'alpha' } }),
          pack('beta', { version: '1.0.0', dependency: { ecosystem: 'npm', name: 'beta' } }),
        ],
      })
    );
    const brief = (maxChars: number): string => formatStatusBrief(report, { maxChars });
    const full = brief(10_000);
    const [rebuild = '', pinned = '', dependencies = ''] = full.split('\n\n');

    expect(rebuild.split('\n')).toHaveLength(3);
    expect(pinned.split('\n')).toHaveLength(3);
    expect(dependencies.split('\n')).toHaveLength(11);
    expect(brief(full.length)).toBe(full);

    const oneLess = brief(full.length - 1);
    expect(oneLess.split('\n\n').slice(0, 2)).toEqual([rebuild, pinned]);
    expect(oneLess.split('\n\n')[2]?.split('\n')).toEqual([
      ...dependencies.split('\n').slice(0, 8),
      '- and 3 more (run `llm-docs status`)',
      DEPENDENCIES_FOOTER,
    ]);

    const pinnedCut = [
      rebuild,
      '',
      ...pinned.split('\n').slice(0, 2),
      '- and 1 more (run `llm-docs status`)',
    ].join('\n');
    expect(brief(pinnedCut.length)).toBe(pinnedCut);
    expect(brief(rebuild.length)).toBe(rebuild);
    expect(brief(20)).toBe('');
    for (const maxChars of [100, 500, 1000, 1500, full.length - 1]) {
      expect(brief(maxChars).length).toBeLessThanOrEqual(maxChars);
    }
  });

  describe('read-first pages on pinned rows', () => {
    const readFirstReport = (extraDependencies: ResolvedDependency[] = []) =>
      computeStatus(
        baseInput({
          dependencies: [
            dep('one', '1.0.0'),
            dep('two', '1.0.0'),
            dep('three', '1.0.0'),
            dep('none', '1.0.0'),
            ...extraDependencies,
          ],
          releases: releases({
            'npm:one@1.0.0': '2026-10-04T00:00:00.000Z',
            'npm:two@1.0.0': '2026-10-03T00:00:00.000Z',
            'npm:three@1.0.0': '2026-10-02T00:00:00.000Z',
            'npm:none@1.0.0': '2026-10-01T00:00:00.000Z',
            'npm:next@16.1.0': '2026-10-21T00:00:00.000Z',
          }),
          cutoff,
          packs: [
            pack('one', {
              title: 'One',
              dependency: { ecosystem: 'npm', name: 'one' },
              readFirst: ['agent-docs/one/pages/guide/migration.md'],
            }),
            pack('two', {
              title: 'Two',
              dependency: { ecosystem: 'npm', name: 'two' },
              readFirst: ['agent-docs/two/pages/upgrade.md', 'agent-docs/two/files/CHANGELOG.md'],
            }),
            pack('three', {
              title: 'Three',
              dependency: { ecosystem: 'npm', name: 'three' },
              readFirst: [
                'agent-docs/three/pages/api.md#breaking-changes',
                'agent-docs/three/pages/api.md#removed',
                'agent-docs/three/pages/b`ad.md',
                'agent-docs/three/pages/whats-new.md',
                'agent-docs/three/pages/migrate.md',
              ],
            }),
            pack('none', { title: 'None', dependency: { ecosystem: 'npm', name: 'none' } }),
          ],
        })
      );
    const NONE_ROW = '- None 1.0.0 (released 2026-10-01, after cutoff): `agent-docs/none/index.md`';
    const ROWS = [
      '- One 1.0.0 (released 2026-10-04, after cutoff): read `agent-docs/one/pages/guide/migration.md` first, then `agent-docs/one/index.md`',
      '- Two 1.0.0 (released 2026-10-03, after cutoff): read `agent-docs/two/pages/upgrade.md` and `agent-docs/two/files/CHANGELOG.md` first, then `agent-docs/two/index.md`',
      '- Three 1.0.0 (released 2026-10-02, after cutoff): read `agent-docs/three/pages/api.md` and `agent-docs/three/pages/whats-new.md` first, then `agent-docs/three/index.md`',
      NONE_ROW,
    ];
    const SHORT = [
      '- One 1.0.0 (released 2026-10-04, after cutoff): `agent-docs/one/index.md`',
      '- Two 1.0.0 (released 2026-10-03, after cutoff): `agent-docs/two/index.md`',
      '- Three 1.0.0 (released 2026-10-02, after cutoff): `agent-docs/three/index.md`',
      NONE_ROW,
    ];

    it('names at most two read-first paths per row, fragments dropped, repeats merged, unsafe paths left out', () => {
      const report = readFirstReport();
      const lines = formatStatusBrief(report, BRIEF_OPTIONS).split('\n');

      expect(lines.slice(1)).toEqual(ROWS);
      expect(report.packs.find((entry) => entry.id === 'three')?.readFirst).toHaveLength(5);
    });

    it('drops read-first paths from the last row up before dropping any row, and only after the items below', () => {
      const full = formatStatusBrief(readFirstReport([dep('next', '16.1.0')]), {
        maxChars: 10_000,
      });
      const brief = (maxChars: number): string =>
        formatStatusBrief(readFirstReport([dep('next', '16.1.0')]), { maxChars });
      const [heading = '', ...rest] = full.split('\n');
      const pinned = (rows: string[]): string => [heading, ...rows].join('\n');

      expect(rest.slice(0, 4)).toEqual(ROWS);
      expect(brief(pinned(ROWS).length)).toBe(pinned(ROWS));

      const lastShort = pinned([...ROWS.slice(0, 2), ...SHORT.slice(2)]);
      expect(brief(pinned(ROWS).length - 1)).toBe(lastShort);

      const allShort = pinned(SHORT);
      expect(brief(allShort.length)).toBe(allShort);
      expect(brief(allShort.length - 1)).toBe(
        pinned([...SHORT.slice(0, 3), '- and 1 more (run `llm-docs status`)'])
      );
    });
  });

  it('escapes lockfile names and versions before they reach an agent', () => {
    const report = computeStatus(
      baseInput({
        dependencies: [dep('evil‮`@x', '1.0.0<b>')],
        releases: releases({ 'npm:evil‮`@x@1.0.0<b>': '2026-09-01T00:00:00.000Z' }),
        cutoff,
      })
    );

    expect(formatStatusBrief(report, BRIEF_OPTIONS).split('\n')[1]).toBe(
      '- evilx 1.0.0&lt;b&gt; (npm, released 2026-09-01, after cutoff)'
    );
  });
});

describe('formatStatusHuman', () => {
  it('renders the pack table and dependency lists, each row with its next step', () => {
    const report = computeStatus(
      baseInput({
        dependencies: [
          dep('vite', '8.2.0'),
          dep('zod', '4.1.0'),
          dep('next', '16.1.0'),
          dep('mystery', '1.0.0'),
        ],
        releases: releases({
          'npm:vite@8.1.0': '2026-06-20T00:00:00.000Z',
          'npm:zod@4.1.0': '2026-09-30T00:00:00.000Z',
          'npm:next@16.1.0': '2026-10-21T18:00:00.000Z',
          'npm:mystery@1.0.0': null,
        }),
        cutoff: { cutoff: '2026-06', label: 'Claude Opus 5.5', source: 'table', assumed: false },
        packs: [
          pack('vite', { version: '8.1.0', dependency: { ecosystem: 'npm', name: 'vite' } }),
          pack('zod', {
            version: '4.1.0',
            dependency: { ecosystem: 'npm', name: 'zod' },
            readFirst: [
              'agent-docs/zod/pages/v4/changelog.md',
              'agent-docs/zod/pages/api.md#errors',
            ],
          }),
        ],
      })
    );

    expect(formatStatusHuman(report)).toBe(
      [
        'Packs:',
        '  ID    VERSION  DEPENDENCY  LOCKFILE  STATE       RELEASED                   READ FIRST  NEXT',
        '  vite  8.1.0    npm:vite    8.2.0     stale-pack  2026-06-20 (near cutoff)   -           llm-docs sync vite',
        '  zod   4.1.0    npm:zod     4.1.0     ok          2026-09-30 (after cutoff)  2           -',
        '',
        'Model training data cutoff: 2026-06 (Claude Opus 5.5).',
        '',
        'Direct dependencies released after the cutoff without a pack:',
        '  NAME  VERSION  ECOSYSTEM  RELEASED    NEXT',
        '  next  16.1.0   npm        2026-10-21  llm-docs discover --package npm:next@16.1.0',
        '',
        '4 direct dependencies checked; 2 with an unknown release date.',
        '',
      ].join('\n')
    );
  });

  it('names the model and where it came from, and marks a cutoff from a settings default as assumed', () => {
    const lines = (input: Partial<ComputeStatusInput>): string[] =>
      formatStatusHuman(computeStatus(baseInput(input)))
        .split('\n')
        .filter((line) => line.includes('Model') || line.includes('default'));

    expect(
      lines({
        model: { id: 'opus', source: 'settings', file: '/home/me/.claude/settings.json' },
        cutoff: {
          cutoff: '2026-06',
          label: 'Claude Opus 5.5 (alias opus)',
          source: 'table',
          assumed: true,
        },
      })
    ).toEqual([
      'Model: opus (assumed from a settings file).',
      '  This is the default in /home/me/.claude/settings.json; a session started with another model differs. Pass --model to name it.',
      'Model training data cutoff: 2026-06 (Claude Opus 5.5 (alias opus)), assuming that default.',
    ]);
    expect(
      lines({
        model: { id: 'claude-sonnet-5', source: 'env' },
        cutoff: { cutoff: '2026-01', label: 'Claude Sonnet 5', source: 'table', assumed: false },
      })
    ).toEqual([
      'Model: claude-sonnet-5 (ANTHROPIC_MODEL).',
      'Model training data cutoff: 2026-01 (Claude Sonnet 5).',
    ]);
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

describe('gatherProjectStatus', () => {
  const cleanups: (() => Promise<void>)[] = [];
  const GATHER_NOW = new Date('2026-11-22T00:00:00.000Z');
  const DATES: Record<string, string> = {
    'hono/versions/4.13.16': '2026-09-02T10:00:00.000Z',
    'date-fns/versions/2.30.0': '2023-04-28T00:00:00.000Z',
    'zod/versions/4.1.0': '2026-06-25T00:00:00.000Z',
    'zod/versions/4.0.0': '2026-05-01T00:00:00.000Z',
  };

  beforeEach(() => {
    vi.stubEnv(ALLOW_PRIVATE_NETWORK_ENV, '1');
    vi.stubEnv(ALLOW_TEMP_SOURCES_ENV, '1');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
    }
  });

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(await realpath(tmpdir()), 'llm-docs-status-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    return dir;
  }

  /** A deps.dev stand-in: dates from DATES, a 404 for anything else, and `hang` never answers. */
  async function registry(hang: string[] = []): Promise<{ base: string; requests: string[] }> {
    const requests: string[] = [];
    const server = createServer((request, response: ServerResponse) => {
      const url = request.url ?? '';
      requests.push(url);
      if (hang.some((name) => url.includes(`/packages/${name}/`))) {
        return;
      }
      const key = url.replace('/v3/systems/npm/packages/', '');
      const publishedAt = DATES[decodeURIComponent(key)];
      response.writeHead(publishedAt === undefined ? 404 : 200, {
        'content-type': 'application/json',
      });
      response.end(JSON.stringify(publishedAt === undefined ? {} : { publishedAt }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    );
    const { port } = server.address() as AddressInfo;
    return { base: `http://127.0.0.1:${port}`, requests };
  }

  async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
    for (const [path, content] of Object.entries(files)) {
      const target = join(root, ...path.split('/'));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
  }

  function npmLock(versions: Record<string, string>): Record<string, string> {
    const dependencies = Object.fromEntries(
      Object.entries(versions).map(([name, version]) => [name, `^${version}`])
    );
    const installed = Object.fromEntries(
      Object.entries(versions).map(([name, version]) => [
        `node_modules/${name}`,
        { version, resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz` },
      ])
    );
    return {
      'package.json': JSON.stringify({ name: 'app', version: '1.0.0', dependencies }),
      'package-lock.json': JSON.stringify({
        name: 'app',
        version: '1.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: { '': { name: 'app', version: '1.0.0', dependencies }, ...installed },
      }),
    };
  }

  const LOCK = npmLock({ hono: '4.13.16', 'date-fns': '2.30.0', zod: '4.1.0' });

  async function gather(
    root: string,
    options: Partial<GatherStatusOptions> & { endpoint?: string } = {}
  ) {
    const { endpoint, ...rest } = options;
    return gatherProjectStatus(
      { projectRoot: root, loaded: await loadProjectConfigIfPresent(root) },
      {
        offline: false,
        env: {},
        homeDir: await tempDir(),
        cacheDir: join(root, '.cache'),
        now: GATHER_NOW,
        ...(endpoint === undefined
          ? {}
          : { endpoints: { depsDev: endpoint, npmRegistry: endpoint } }),
        ...rest,
      }
    );
  }

  it('analyses dependencies in a project with no llm-docs.json', async () => {
    const root = await tempDir();
    await writeFiles(root, LOCK);
    const { base } = await registry();

    const status = await gather(root, { endpoint: base, cutoff: '2026-06' });

    expect(status.loaded).toBeNull();
    expect(status.report.packs).toEqual([]);
    expect(status.report.afterCutoff.map((release) => [release.name, release.nextStep])).toEqual([
      ['hono', 'llm-docs discover --package npm:hono@4.13.16'],
    ]);
    expect(status.report.nearCutoff.map((release) => release.name)).toEqual(['zod']);
    expect(status.report.directDependencies).toBe(3);
    expect(status.report.unknownReleaseDates).toBe(0);
    expect(status.pendingReleaseDates).toBe(0);
    expect(status.cutoff).toMatchObject({ cutoff: '2026-06', source: 'flag' });
  });

  it('reads only the cache when offline', async () => {
    const root = await tempDir();
    await writeFiles(root, LOCK);
    const { base, requests } = await registry();

    const cold = await gather(root, { endpoint: base, offline: true, cutoff: '2026-06' });
    expect(requests).toEqual([]);
    expect(cold.report.unknownReleaseDates).toBe(3);
    expect(cold.report.afterCutoff).toEqual([]);
    expect(cold.pendingReleaseDates).toBe(0);

    await gather(root, { endpoint: base, cutoff: '2026-06' });
    const fetched = requests.length;
    expect(fetched).toBe(3);

    const warm = await gather(root, { endpoint: base, offline: true, cutoff: '2026-06' });
    expect(requests).toHaveLength(fetched);
    expect(warm.report.unknownReleaseDates).toBe(0);
    expect(warm.report.afterCutoff.map((release) => release.name)).toEqual(['hono']);
  });

  it('resolves the cutoff from --cutoff, then config, then the environment, then the model', async () => {
    const root = await tempDir();
    const configured = await tempDir();
    await writeFiles(configured, {
      'llm-docs.json': JSON.stringify({
        schemaVersion: 3,
        model: { cutoff: '2025-01' },
        packs: {},
      }),
    });
    const cutoffOf = async (
      at: string,
      options: Partial<GatherStatusOptions>
    ): Promise<[string | undefined, string | undefined, unknown]> => {
      const status = await gather(at, { offline: true, ...options });
      expect(status.report.model).toEqual(status.model);
      return [status.cutoff?.source, status.cutoff?.cutoff, status.model];
    };
    const env = { LLM_DOCS_MODEL_CUTOFF: '2025-03' };
    const flag = { id: 'claude-opus-5-5', source: 'flag' } as const;

    expect(await cutoffOf(configured, { cutoff: '2026-02', env, model: flag })).toEqual([
      'flag',
      '2026-02',
      flag,
    ]);
    expect(await cutoffOf(configured, { env, model: flag })).toEqual(['config', '2025-01', flag]);
    expect(await cutoffOf(root, { env, model: flag })).toEqual(['env', '2025-03', flag]);
    expect(await cutoffOf(root, { model: flag })).toEqual(['table', '2026-06', flag]);
    expect(await cutoffOf(root, { env: { ANTHROPIC_MODEL: 'claude-opus-5' } })).toEqual([
      'table',
      '2026-05',
      { id: 'claude-opus-5', source: 'env' },
    ]);
    expect(
      await cutoffOf(root, { model: { id: 'some-unknown-model', source: 'payload' } })
    ).toEqual([undefined, undefined, { id: 'some-unknown-model', source: 'payload' }]);
    expect((await gather(root, { offline: true, model: flag })).report.cutoff).toEqual({
      cutoff: '2026-06',
      label: 'Claude Opus 5.5',
      source: 'table',
      assumed: false,
    });

    // A settings file holds only the default model, so its cutoff is an assumption.
    await writeFiles(root, { '.claude/settings.json': JSON.stringify({ model: 'opus' }) });
    const fromSettings = await gather(root, { offline: true });
    expect(fromSettings.model).toEqual({
      id: 'opus',
      source: 'settings',
      file: join(root, '.claude', 'settings.json'),
    });
    expect(fromSettings.report.cutoff).toEqual({
      cutoff: '2026-06',
      label: 'Claude Opus 5.5 (alias opus)',
      source: 'table',
      assumed: true,
    });
    // An explicit cutoff is stated, whatever the model.
    expect((await gather(root, { offline: true, env })).report.cutoff?.assumed).toBe(false);

    await expect(gather(root, { offline: true, cutoff: '2026-6' })).rejects.toThrow(
      new ConfigError('--cutoff must be a YYYY-MM month (for example 2026-06), got "2026-6".')
    );
  });

  it('reports each pack state with its next step, and the built packs newer than the cutoff', async () => {
    const root = await tempDir();
    const local = [{ type: 'local', path: 'docs' }];
    const packs = {
      hono: { title: 'Hono', dependency: { ecosystem: 'npm', name: 'hono' }, sources: local },
      zod: {
        title: 'Zod',
        version: '4.0.0',
        dependency: { ecosystem: 'npm', name: 'zod' },
        sources: local,
      },
      notes: { version: '1.0.0', sources: local },
      gone: { version: '1.0.0', sources: local },
    };
    const config = (value: Record<string, unknown>) =>
      JSON.stringify({ schemaVersion: 3, agentFiles: [], packs: value });
    await writeFiles(root, {
      ...LOCK,
      'docs/index.md': '# Docs\n',
      'llm-docs.json': config(packs),
    });
    const built = await syncPacks(root, undefined);
    expect(built.packs.map((entry) => entry.status)).toEqual(['built', 'built', 'built', 'built']);

    await writeFiles(root, {
      'llm-docs.json': config({
        hono: packs.hono,
        zod: packs.zod,
        notes: { ...packs.notes, description: 'Edited since the build' },
        later: { version: '2.0.0', sources: local },
      }),
    });
    const { base } = await registry();
    const status = await gather(root, { endpoint: base, cutoff: '2026-06' });

    expect(
      status.report.packs.map((entry) => [
        entry.id,
        entry.state,
        entry.version,
        entry.releaseWindow,
        entry.indexPath,
        entry.nextStep,
      ])
    ).toEqual([
      [
        'gone',
        'orphan',
        '1.0.0',
        null,
        'agent-docs/gone/index.md',
        "run 'llm-docs sync --prune' to delete it, or add packs.gone back to llm-docs.json",
      ],
      ['hono', 'ok', '4.13.16', 'after-cutoff', 'agent-docs/hono/index.md', null],
      ['later', 'missing', '2.0.0', null, null, 'llm-docs sync later'],
      [
        'notes',
        'recipe-changed',
        '1.0.0',
        null,
        'agent-docs/notes/index.md',
        'llm-docs sync notes',
      ],
      [
        'zod',
        'stale-pack',
        '4.0.0',
        'near-cutoff',
        'agent-docs/zod/index.md',
        "set packs.zod.version in llm-docs.json to 4.1.0 (or remove it to follow the lockfile), then run 'llm-docs sync zod'",
      ],
    ]);
    expect(status.report.afterCutoff).toEqual([]);
    expect(status.report.nearCutoff).toEqual([]);
    expect(status.packs.map((entry) => entry.id)).toEqual([
      'hono',
      'zod',
      'notes',
      'later',
      'gone',
    ]);
  });

  it('counts release dates cut off by the time budget as pending, and never caches them', async () => {
    const root = await tempDir();
    await writeFiles(root, LOCK);
    const { base } = await registry(['hono']);

    const status = await gather(root, { endpoint: base, cutoff: '2026-06', budgetMs: 300 });

    expect(status.pendingReleaseDates).toBe(1);
    expect(status.report.unknownReleaseDates).toBe(1);
    expect(status.report.nearCutoff.map((release) => release.name)).toEqual(['zod']);
  });

  it('stops the scan and the lookups when its signal aborts', async () => {
    const root = await tempDir();
    await writeFiles(root, LOCK);
    const { requests } = await registry();

    const status = await gather(root, { signal: AbortSignal.abort(), cutoff: '2026-06' });

    expect(status.report.directDependencies).toBe(0);
    expect(status.warnings).toContain(
      'Dependency scan stopped at its time limit; lockfiles not read by then were left out.'
    );
    expect(requests).toEqual([]);
  });
});
