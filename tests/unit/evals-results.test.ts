import { describe, expect, it } from 'vitest';

import type { Arm, Stratum } from '../../evals/lib/cases.js';
import {
  buildAggregates,
  type CaseFacts,
  renderSummary,
  type RunRow,
  type SummaryMeta,
} from '../../evals/lib/results.js';

const ARMS: Arm[] = ['baseline', 'pack'];

function row(caseId: string, stratum: Stratum, arm: Arm, repeat: number, passed: boolean): RunRow {
  return {
    runId: `${caseId}.${arm}.${repeat}`,
    caseId,
    kind: stratum === 'control' ? 'control' : 'post-cutoff',
    stratum,
    arm,
    repeat,
    model: 'claude-opus-5-5',
    startedAt: '2026-11-22T00:00:00.000Z',
    outcome: { kind: 'completed' },
    attempts: 1,
    agentExitCode: 0,
    wallMs: 1,
    passed,
    checks: [],
    costUsd: 1,
    numTurns: 3,
    durationMs: 1,
    docsConsulted: arm === 'pack',
    docsPaths: [],
    webUsed: false,
    webSearches: 0,
    webFetches: 0,
    webTargets: [],
    toolCalls: {},
    permissionDenials: [],
    sessionStartHooks: [],
    hookNote: null,
    session: null,
    armAssertions: [],
    infraError: null,
  };
}

const CASES: CaseFacts[] = [
  { id: 'visible-case', stratum: 'type-visible', packageDocumentsAnswer: 'types' },
  { id: 'invisible-case', stratum: 'type-invisible', packageDocumentsAnswer: 'none' },
  { id: 'control-case', stratum: 'control', packageDocumentsAnswer: 'docs' },
];

// Two repeats per case and arm: the pack helps only where the compiler is silent.
const ROWS: RunRow[] = [1, 2].flatMap((repeat) => [
  row('visible-case', 'type-visible', 'baseline', repeat, true),
  row('visible-case', 'type-visible', 'pack', repeat, true),
  row('invisible-case', 'type-invisible', 'baseline', repeat, false),
  row('invisible-case', 'type-invisible', 'pack', repeat, repeat === 1),
  row('control-case', 'control', 'baseline', repeat, true),
  row('control-case', 'control', 'pack', repeat, true),
]);

const META: SummaryMeta = {
  timestamp: 'test',
  model: 'claude-opus-5-5',
  claudeVersion: '2.1.330',
  runsPerCell: 2,
  arms: ARMS,
  gitCommit: 'abc1234',
  segments: [],
  cases: CASES,
};

describe('results per stratum', () => {
  it('reports pass rates per arm within each stratum', () => {
    const { byStratum } = buildAggregates(ROWS, ARMS);
    expect(Object.keys(byStratum).sort()).toEqual(['control', 'type-invisible', 'type-visible']);
    expect(byStratum['type-invisible']?.baseline).toMatchObject({ runs: 2, passed: 0 });
    expect(byStratum['type-invisible']?.pack).toMatchObject({ runs: 2, passed: 1, passRate: 0.5 });
    expect(byStratum['type-visible']?.baseline).toMatchObject({ runs: 2, passed: 2 });
    expect(byStratum.control?.pack).toMatchObject({ runs: 2, passed: 2 });
  });

  it('leaves infra errors out of a stratum rate', () => {
    const rows = [
      ...ROWS,
      {
        ...row('invisible-case', 'type-invisible', 'baseline', 3, false),
        infraError: 'interrupted',
      },
    ];
    expect(buildAggregates(rows, ARMS).byStratum['type-invisible']?.baseline).toMatchObject({
      runs: 2,
      infraErrors: 1,
    });
  });

  it('shows the stratum table and each case stratum and package evidence in summary.md', () => {
    const summary = renderSummary(META, ROWS, buildAggregates(ROWS, ARMS));
    expect(summary).toContain('## Pass rate by stratum');
    expect(summary).toContain('| type-invisible | 0/2 (0%) | 1/2 (50%) |');
    expect(summary).toContain('| type-visible | 2/2 (100%) | 2/2 (100%) |');
    expect(summary).toContain('| Case | Stratum | Package documents it | baseline | pack |');
    expect(summary).toContain('| invisible-case | type-invisible | none | 0/2 (0%) | 1/2 (50%) |');
    expect(summary).toContain('| control-case | control | docs | 2/2 (100%) | 2/2 (100%) |');
    expect(summary).not.toContain(String.fromCharCode(0x2014));
  });
});
