import { describe, expect, it } from 'vitest';

import type { EvalCase } from '../../evals/lib/cases.js';
import {
  applyReadFirstRule,
  type CaseRule,
  namedMajors,
  namesMajor,
  type RuleOutput,
  ruleProblems,
} from '../../evals/lib/read-first-rule.js';
import type { ChangeDocument } from '../../src/core/package-discovery.js';

function pagesFor(paths: string[]): Map<string, string> {
  return new Map(paths.map((path) => [path, `pages/${path}`]));
}

describe('read-first rule', () => {
  it('puts migration and upgrade guides first, then breaking, what is new, release notes, changelogs', () => {
    const documents: ChangeDocument[] = [
      { path: 'CHANGELOG.md', pattern: 'changelog' },
      { path: 'HISTORY.md', pattern: 'history' },
      { path: 'RELEASE_NOTES.md', pattern: 'release-notes' },
      { path: 'docs/whats-new.md', pattern: 'whats-new' },
      { path: 'docs/breaking.md', pattern: 'breaking' },
      { path: 'docs/deep/upgrading.md', pattern: 'upgrading' },
    ];
    const output = applyReadFirstRule({
      documents,
      takenPaths: ['.'],
      pageOf: pagesFor(documents.map((document) => document.path)),
      major: '2',
    });

    expect(output.candidates.map((candidate) => candidate.path)).toEqual([
      'docs/deep/upgrading.md',
      'docs/breaking.md',
      'docs/whats-new.md',
      'RELEASE_NOTES.md',
      'CHANGELOG.md',
      'HISTORY.md',
    ]);
    expect(output.readFirst).toEqual([
      'pages/docs/deep/upgrading.md',
      'pages/docs/breaking.md',
      'pages/docs/whats-new.md',
    ]);
  });

  it('ranks a path naming the pinned major before a shallower one that does not', () => {
    const documents: ChangeDocument[] = [
      { path: 'docs/migration/support-2026-07-28.md', pattern: 'migration' },
      { path: 'skills/upgrade-to-v2/references/auth.md', pattern: 'upgrade' },
      { path: 'docs/migration/index.md', pattern: 'migration' },
      { path: 'docs/migration/upgrade-to-v2.md', pattern: 'upgrade' },
    ];
    const output = applyReadFirstRule({
      documents,
      takenPaths: ['docs', 'skills'],
      pageOf: pagesFor(documents.map((document) => document.path)),
      major: '2',
    });

    expect(output.readFirst).toEqual([
      'pages/docs/migration/upgrade-to-v2.md',
      'pages/skills/upgrade-to-v2/references/auth.md',
      'pages/docs/migration/index.md',
    ]);
  });

  it('recognizes the major as v<major>, <major>.x, or -<major>, and nothing longer', () => {
    expect(namesMajor('docs/migration/migration_v15.md', '15')).toBe(true);
    expect(namesMajor('docs/4.x/upgrade.md', '4')).toBe(true);
    expect(namesMajor('appendix/35-migrating-to-sveltekit-3.md', '3')).toBe(true);
    expect(namesMajor('guides/migrating-to-v5.md', '4')).toBe(false);
    expect(namesMajor('docs/v20/upgrade.md', '2')).toBe(false);
    expect(namesMajor('docs/dev2/upgrade.md', '2')).toBe(false);
    expect(namesMajor('docs/14.x/upgrade.md', '4')).toBe(false);
    expect(namesMajor('migration/support-2026-07-28.md', '2')).toBe(false);
  });

  it('reads every major a path names, in each recognized form, and none from a date', () => {
    expect(namedMajors('guides/migrating-to-v5.md')).toEqual(['5']);
    expect(namedMajors('docs/4.x/upgrade.md')).toEqual(['4']);
    expect(namedMajors('appendix/30-migrating-to-sveltekit-2.md')).toEqual(['2']);
    expect(namedMajors('packages/docs-v3/MIGRATION.md')).toEqual(['3']);
    expect(namedMajors('migration/v3-to-v4.md')).toEqual(['3', '4']);
    expect(namedMajors('migration/3-to-4.md')).toEqual(['4', '3']);
    expect(namedMajors('blog/zod-4-6.md')).toEqual(['4', '6']);
    expect(namedMajors('migration/support-2026-07-28.md')).toEqual([]);
    expect(namedMajors('docs/dev2/CHANGELOG.md')).toEqual([]);
    expect(namedMajors('docs/4.0_migration.md')).toEqual([]);
  });

  it('drops a candidate that names only other majors and keeps one that names the pinned major', () => {
    const accepted = [
      'docs/migration/upgrade-to-v4.md',
      'docs/4.x/upgrade.md',
      'appendix/35-migrating-to-v-4.md',
      'migration/v3-to-v4.md',
      'migration/4-to-5.md',
      'docs-v4/MIGRATION.md',
      'CHANGELOG.md',
    ];
    const rejected = [
      'guides/migrating-to-v5.md',
      'docs/3.x/upgrade.md',
      'appendix/30-migrating-to-sveltekit-3.md',
      'migration/v2-to-v3.md',
      'migration/2-to-3.md',
      'docs-v3/MIGRATION.md',
      'docs/v14/upgrade.md',
    ];
    const documents: ChangeDocument[] = [...accepted, ...rejected].map((path) => ({
      path,
      pattern: path === 'CHANGELOG.md' ? 'changelog' : 'migration',
    }));
    const output = applyReadFirstRule({
      documents,
      takenPaths: ['.'],
      pageOf: pagesFor(documents.map((document) => document.path)),
      major: '4',
    });

    expect(output.candidates.map((candidate) => candidate.path).sort()).toEqual(
      [...accepted].sort()
    );
    expect(output.additions).toEqual([]);
  });

  it('keeps a guide for another major in the taken paths while dropping it as a candidate', () => {
    const output = applyReadFirstRule({
      documents: [{ path: 'docs/guides/migrating-to-v5.md', pattern: 'migrating' }],
      takenPaths: ['docs/api'],
      pageOf: new Map(),
      major: '4',
    });

    expect(output).toEqual({
      additions: ['docs/guides/migrating-to-v5.md'],
      candidates: [],
      readFirst: [],
    });
  });

  it('adds change documents outside the taken paths and takes only pages as candidates', () => {
    const output = applyReadFirstRule({
      documents: [
        { path: 'CHANGELOG.md', pattern: 'changelog' },
        { path: 'packages/core/CHANGELOG.md', pattern: 'changelog' },
        { path: 'docs/MIGRATION.rst', pattern: 'migration' },
        { path: 'docs/guide/upgrade.md', pattern: 'upgrade' },
      ],
      takenPaths: ['docs', 'README.md'],
      // The include globs left the .rst file out of the pack.
      pageOf: new Map([['docs/guide/upgrade.md', 'pages/guide/upgrade.md']]),
      major: '9',
    });

    expect(output.additions).toEqual(['CHANGELOG.md', 'packages/core/CHANGELOG.md']);
    expect(output.candidates.map((candidate) => candidate.page)).toEqual([
      'pages/guide/upgrade.md',
    ]);
    expect(output.readFirst).toEqual(['pages/guide/upgrade.md']);
  });

  it('chooses nothing when no change document is a page', () => {
    const output = applyReadFirstRule({
      documents: [],
      takenPaths: ['docs'],
      pageOf: new Map(),
      major: '1',
    });

    expect(output).toEqual({ additions: [], candidates: [], readFirst: [] });
  });
});

describe('read-first rule check', () => {
  function evalCase(readFirst: unknown): EvalCase {
    const pack: Record<string, unknown> = {
      title: 'Lib',
      dependency: { ecosystem: 'npm', name: 'lib' },
      sources: [{ type: 'git', repo: 'https://github.com/o/lib', ref: 'v{version}', paths: ['.'] }],
    };
    if (readFirst !== undefined) {
      pack.readFirst = readFirst;
    }
    return {
      id: 'lib-2',
      title: 'Lib',
      kind: 'post-cutoff',
      stratum: 'type-invisible',
      packageDocumentsAnswer: 'none',
      library: { name: 'lib', version: '2.0.0', released: '2026-10-01' },
      notes: '',
      maxTurns: 1,
      timeoutSeconds: 1,
      dir: '/nonexistent',
      task: '',
      checks: [],
      pack: { id: 'lib', pack, sourceTypes: ['git'] },
    };
  }

  function applied(output: RuleOutput): CaseRule {
    return {
      status: 'applied',
      evidence: {
        via: 'discover',
        repo: 'https://github.com/o/lib',
        ref: 'v2.0.0',
        commit: 'a'.repeat(40),
        documents: [],
        more: 0,
      },
      target: { index: 0, repo: 'https://github.com/o/lib', ref: 'v{version}', paths: ['.'] },
      pagesProblem: null,
      output,
    };
  }

  const rule = applied({
    additions: [],
    candidates: [],
    readFirst: ['pages/MIGRATION.md', 'pages/CHANGELOG.md'],
  });

  it('passes a pack.json whose readFirst is exactly the rule output', () => {
    expect(ruleProblems(evalCase(['pages/MIGRATION.md', 'pages/CHANGELOG.md']), rule)).toEqual([]);
  });

  it('fails a hand-edited readFirst: a fragment, another page, or another order', () => {
    for (const edited of [
      ['pages/MIGRATION.md#linkify', 'pages/CHANGELOG.md'],
      ['pages/MIGRATION.md', 'pages/api.md'],
      ['pages/CHANGELOG.md', 'pages/MIGRATION.md'],
      undefined,
    ]) {
      const problems = ruleProblems(evalCase(edited), rule);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('read-first-rule --write');
    }
  });

  it('fails a readFirst on a case where the rule finds no candidate', () => {
    const none = applied({ additions: [], candidates: [], readFirst: [] });
    expect(ruleProblems(evalCase(undefined), none)).toEqual([]);
    expect(ruleProblems(evalCase(['pages/api.md']), none)).toHaveLength(1);
  });

  it('fails while a change document is not taken, naming it', () => {
    const pending = applied({ additions: ['CHANGELOG.md'], candidates: [], readFirst: [] });
    expect(ruleProblems(evalCase(undefined), pending)[0]).toContain('CHANGELOG.md');
  });
});
