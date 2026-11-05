import { isRecord } from '../../src/utils/guards.js';
import type { Arm, CaseKind } from './cases.js';
import type { TranscriptSummary } from './transcript.js';
import type { CheckResult } from './workspace.js';

export interface RunRow {
  runId: string;
  caseId: string;
  kind: CaseKind;
  arm: Arm;
  repeat: number;
  model: string;
  startedAt: string;
  /** How the agent process ended: the result subtype, or timeout / no-result / spawn-error. */
  agentOutcome: string;
  agentExitCode: number | null;
  wallMs: number;
  passed: boolean;
  checks: CheckResult[];
  costUsd: number | null;
  numTurns: number | null;
  durationMs: number | null;
  docsConsulted: boolean;
  docsPaths: string[];
  webUsed: boolean;
  webSearches: number;
  webFetches: number;
  webTargets: string[];
  toolCalls: Record<string, number>;
  permissionDenials: string[];
  sessionStartHookOutput: string[];
  session: TranscriptSummary['session'];
  /** Set when the run could not be carried out (workspace setup, missing CLI); excluded from rates. */
  infraError: string | null;
}

/** Shallow shape check for rows read back from disk (resume, cost history). */
export function isRunRow(value: unknown): value is RunRow {
  return (
    isRecord(value) &&
    typeof value.runId === 'string' &&
    typeof value.caseId === 'string' &&
    typeof value.arm === 'string' &&
    typeof value.model === 'string' &&
    typeof value.passed === 'boolean' &&
    Array.isArray(value.checks) &&
    (value.costUsd === null || typeof value.costUsd === 'number') &&
    (value.infraError === null || typeof value.infraError === 'string')
  );
}

export interface Aggregate {
  runs: number;
  passed: number;
  passRate: number | null;
  meanCostUsd: number | null;
  totalCostUsd: number;
  docsConsultedRate: number | null;
  webUseRate: number | null;
  meanTurns: number | null;
  infraErrors: number;
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function aggregate(rows: RunRow[]): Aggregate {
  const valid = rows.filter((row) => row.infraError === null);
  const costs = valid.map((row) => row.costUsd).filter((cost): cost is number => cost !== null);
  const turns = valid.map((row) => row.numTurns).filter((n): n is number => n !== null);
  const rate = (predicate: (row: RunRow) => boolean): number | null =>
    valid.length === 0 ? null : valid.filter(predicate).length / valid.length;
  return {
    runs: valid.length,
    passed: valid.filter((row) => row.passed).length,
    passRate: rate((row) => row.passed),
    meanCostUsd: mean(costs),
    totalCostUsd: costs.reduce((sum, cost) => sum + cost, 0),
    docsConsultedRate: rate((row) => row.docsConsulted),
    webUseRate: rate((row) => row.webUsed),
    meanTurns: mean(turns),
    infraErrors: rows.length - valid.length,
  };
}

export interface Aggregates {
  overall: Record<string, Aggregate>;
  byKind: Record<string, Record<string, Aggregate>>;
  byCase: Record<string, Record<string, Aggregate>>;
}

/** Pass rates and means per arm, per arm within each case kind, and per arm within each case. */
export function buildAggregates(rows: RunRow[], arms: readonly Arm[]): Aggregates {
  const byArm = (subset: RunRow[]): Record<string, Aggregate> =>
    Object.fromEntries(
      arms.map((arm) => [arm, aggregate(subset.filter((row) => row.arm === arm))])
    );
  const caseIds = [...new Set(rows.map((row) => row.caseId))].sort();
  const kinds = [...new Set(rows.map((row) => row.kind))].sort();
  return {
    overall: byArm(rows),
    byKind: Object.fromEntries(
      kinds.map((kind) => [kind, byArm(rows.filter((row) => row.kind === kind))])
    ),
    byCase: Object.fromEntries(
      caseIds.map((id) => [id, byArm(rows.filter((row) => row.caseId === id))])
    ),
  };
}

const pct = (value: number | null): string =>
  value === null ? 'n/a' : `${Math.round(value * 100)}%`;
const usd = (value: number | null): string => (value === null ? 'n/a' : `$${value.toFixed(2)}`);

function cell(agg: Aggregate | undefined): string {
  if (!agg || agg.runs === 0) {
    return 'n/a';
  }
  return `${agg.passed}/${agg.runs} (${pct(agg.passRate)})`;
}

export interface SummaryMeta {
  timestamp: string;
  model: string;
  claudeVersion: string;
  runsPerCell: number;
  arms: readonly Arm[];
  gitCommit: string;
}

/** Human-readable summary. Plain Markdown tables, no em-dashes. */
export function renderSummary(meta: SummaryMeta, rows: RunRow[], aggregates: Aggregates): string {
  const arms = meta.arms;
  const lines: string[] = [];
  lines.push(`# Eval results ${meta.timestamp}`);
  lines.push('');
  lines.push(
    `Model \`${meta.model}\`, Claude Code ${meta.claudeVersion}, ${meta.runsPerCell} run(s) per case and arm, repository commit \`${meta.gitCommit}\`.`
  );
  lines.push('');
  lines.push('## Pass rate by arm');
  lines.push('');
  lines.push(`| Scope | ${arms.join(' | ')} |`);
  lines.push(`|---|${arms.map(() => '---').join('|')}|`);
  lines.push(`| All cases | ${arms.map((arm) => cell(aggregates.overall[arm])).join(' | ')} |`);
  for (const [kind, perArm] of Object.entries(aggregates.byKind)) {
    lines.push(`| ${kind} | ${arms.map((arm) => cell(perArm[arm])).join(' | ')} |`);
  }
  lines.push('');
  lines.push('## Pass rate by case');
  lines.push('');
  lines.push(`| Case | ${arms.join(' | ')} |`);
  lines.push(`|---|${arms.map(() => '---').join('|')}|`);
  for (const [caseId, perArm] of Object.entries(aggregates.byCase)) {
    lines.push(`| ${caseId} | ${arms.map((arm) => cell(perArm[arm])).join(' | ')} |`);
  }
  lines.push('');
  lines.push('## Behaviour by arm');
  lines.push('');
  lines.push(
    '| Arm | Mean cost | Total cost | Mean turns | Docs consulted | Web used | Infra errors |'
  );
  lines.push('|---|---|---|---|---|---|---|');
  for (const arm of arms) {
    const agg = aggregates.overall[arm];
    if (!agg) {
      continue;
    }
    lines.push(
      `| ${arm} | ${usd(agg.meanCostUsd)} | ${usd(agg.totalCostUsd)} | ${agg.meanTurns === null ? 'n/a' : agg.meanTurns.toFixed(1)} | ${pct(agg.docsConsultedRate)} | ${pct(agg.webUseRate)} | ${agg.infraErrors} |`
    );
  }
  lines.push('');
  lines.push('## Runs');
  lines.push('');
  lines.push('| Run | Outcome | Passed | Failed checks | Cost | Turns | Docs | Web |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const row of rows) {
    const failed = row.checks.filter((check) => !check.passed).map((check) => check.name);
    lines.push(
      `| ${row.runId} | ${row.infraError === null ? row.agentOutcome : 'infra error'} | ${row.passed ? 'yes' : 'no'} | ${failed.join(', ') || 'none'} | ${usd(row.costUsd)} | ${row.numTurns ?? 'n/a'} | ${row.docsConsulted ? 'yes' : 'no'} | ${row.webUsed ? `${row.webSearches}s/${row.webFetches}f` : 'no'} |`
    );
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}
