import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { Arm, EvalCase } from '../../evals/lib/cases.js';
import type { RunRow } from '../../evals/lib/results.js';
import {
  classifyOutcome,
  type ProcessEnd,
  type SessionOutcome,
  summarizeTranscript,
} from '../../evals/lib/transcript.js';
import {
  type PlannedRun,
  pendingRuns,
  planRuns,
  runSchedule,
  type Scheduler,
  TRANSIENT_BACKOFF_MS,
} from '../../evals/run.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'evals');
const ENDED: ProcessEnd = { timedOut: false, exitCode: 0, stderr: '' };

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

function outcomeOf(jsonl: string, end: ProcessEnd = ENDED): SessionOutcome {
  return classifyOutcome(summarizeTranscript(jsonl), end);
}

describe('session outcome from observed Claude Code 2.1.330 transcripts', () => {
  it('grades a session that finished its turn', () => {
    expect(outcomeOf(fixture('observed-completed-plugin.jsonl'))).toEqual({ kind: 'completed' });
  });

  it('never grades an unknown model, even though the result reports num_turns 1', () => {
    const jsonl = fixture('observed-model-not-found.jsonl');
    expect(summarizeTranscript(jsonl).result?.numTurns).toBe(1);
    expect(outcomeOf(jsonl, { timedOut: false, exitCode: 1, stderr: '' })).toMatchObject({
      kind: 'could-not-run',
      reason: 'model-unavailable',
      resetsAt: null,
    });
  });

  it('never grades a rejected credential', () => {
    expect(
      outcomeOf(fixture('observed-auth-invalid-key.jsonl'), {
        timedOut: false,
        exitCode: 1,
        stderr: '',
      })
    ).toMatchObject({
      kind: 'could-not-run',
      reason: 'auth',
      detail: 'Invalid API key · Fix external API key',
    });
  });
});

describe('session outcome from documented shapes', () => {
  it('reads a usage limit and its reset time from the rate limit event', () => {
    expect(outcomeOf(fixture('documented-usage-limit.jsonl'))).toEqual({
      kind: 'could-not-run',
      reason: 'usage-limit',
      detail: "You've hit your session limit · resets 3:45pm",
      resetsAt: new Date(1795651200 * 1000).toISOString(),
    });
  });

  it('tells a usage limit from a throttle by its message when no rate limit event came', () => {
    const withoutEvent = fixture('documented-usage-limit.jsonl')
      .split('\n')
      .filter((line) => !line.includes('rate_limit_event'))
      .join('\n');
    expect(outcomeOf(withoutEvent)).toMatchObject({
      reason: 'usage-limit',
      resetsAt: '3:45pm (as reported)',
    });
  });

  it.each([
    ['documented-rate-limit.jsonl', 'rate-limit'],
    ['documented-overloaded.jsonl', 'overloaded'],
    ['documented-billing.jsonl', 'billing'],
    ['documented-network.jsonl', 'network'],
  ])('%s could not run (%s)', (name, reason) => {
    expect(outcomeOf(fixture(name))).toMatchObject({ kind: 'could-not-run', reason });
  });

  it('grades the turn cap and the budget cap as they stand', () => {
    expect(outcomeOf(fixture('documented-turn-cap.jsonl'))).toEqual({ kind: 'turn-cap' });
    expect(outcomeOf(fixture('documented-budget-cap.jsonl'))).toEqual({ kind: 'budget-cap' });
  });

  it('grades a wall timeout, unless the session was still retrying the API when it was killed', () => {
    const init = fixture('documented-turn-cap.jsonl').split('\n')[0] ?? '';
    const timedOut: ProcessEnd = { timedOut: true, exitCode: null, stderr: '' };
    expect(outcomeOf(init, timedOut)).toEqual({ kind: 'timeout' });
    expect(outcomeOf(fixture('documented-killed-while-retrying.jsonl'), timedOut)).toMatchObject({
      kind: 'could-not-run',
      reason: 'overloaded',
    });
  });

  it('never grades a session that wrote no result', () => {
    expect(
      outcomeOf('', { timedOut: false, exitCode: 1, stderr: 'Not logged in · Please run /login\n' })
    ).toMatchObject({
      kind: 'could-not-run',
      reason: 'auth',
    });
    expect(
      outcomeOf('{"type":"system","subtype":"init"}', {
        timedOut: false,
        exitCode: 137,
        stderr: '',
      })
    ).toMatchObject({
      kind: 'could-not-run',
      reason: 'no-result',
      detail: 'no result event (exit 137)',
    });
  });

  it('grades an error ending the session caused itself, and keeps the reason', () => {
    const result = JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      terminal_reason: 'prompt_too_long',
      num_turns: 12,
      result: 'Prompt is too long',
    });
    expect(outcomeOf(result)).toEqual({ kind: 'ended-early', terminalReason: 'prompt_too_long' });
  });

  it('never grades a startup failure', () => {
    const result = JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      startup_failure_reason: 'config_file_invalid',
      num_turns: 0,
      result: '',
    });
    expect(outcomeOf(result)).toMatchObject({ kind: 'could-not-run', reason: 'startup-failure' });
  });
});

/* ------------------------------------------------------------------------------------------ */

function fakeCase(id: string): EvalCase {
  return {
    id,
    title: id,
    kind: 'post-cutoff',
    stratum: 'type-visible',
    packageDocumentsAnswer: 'none',
    library: { name: id, version: '1.0.0', released: '2026-10-01' },
    notes: '',
    maxTurns: 30,
    timeoutSeconds: 900,
    dir: `/nonexistent/${id}`,
    task: 'task',
    checks: [],
    pack: { id, pack: {}, sourceTypes: [] },
  };
}

function rowFor(run: PlannedRun, outcome: SessionOutcome): RunRow {
  return {
    runId: run.runId,
    caseId: run.evalCase.id,
    kind: run.evalCase.kind,
    stratum: run.evalCase.stratum,
    arm: run.arm,
    repeat: run.repeat,
    model: 'claude-opus-5-5',
    startedAt: '2026-11-22T00:00:00.000Z',
    outcome,
    attempts: 1,
    agentExitCode: 0,
    wallMs: 1,
    passed: outcome.kind === 'completed',
    checks: [],
    costUsd: 0,
    numTurns: 1,
    durationMs: 1,
    docsConsulted: false,
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
    infraError: outcome.kind === 'could-not-run' ? `could not run (${outcome.reason})` : null,
  };
}

const couldNotRun = (
  reason: Extract<SessionOutcome, { kind: 'could-not-run' }>['reason']
): SessionOutcome => ({
  kind: 'could-not-run',
  reason,
  detail: reason,
  resetsAt: reason === 'usage-limit' ? '2026-11-22T15:45:00.000Z' : null,
});

/**
 * A completed plugin session whose arm assertions failed on the hook note: `empty` when the hook
 * gave nothing, `different` when it gave another note, `empty-unloaded` when the plugin also
 * failed to load.
 */
type HookAttempt = 'empty' | 'different' | 'empty-unloaded';

function hookRow(run: PlannedRun, attempt: HookAttempt): RunRow {
  const verdict = attempt === 'different' ? 'different' : 'empty';
  const failed = [
    ...(attempt === 'empty-unloaded'
      ? [{ name: 'plugin loaded', passed: false, detail: 'plugin llm-docs did not load' }]
      : []),
    { name: 'plugin hook note', passed: false, detail: `the note was ${verdict}` },
  ];
  return {
    ...rowFor(run, { kind: 'completed' }),
    passed: false,
    hookNote: {
      verdict,
      expected: 'the stored note',
      actual: verdict === 'empty' ? '' : 'another note',
    },
    armAssertions: [{ name: 'model', passed: true, detail: 'session model' }, ...failed],
    infraError: `arm-invalid: ${failed.map((assertion) => assertion.detail).join('; ')}`,
  };
}

/** A scheduler whose sessions answer from a script keyed by run id, one entry per attempt. */
function scriptedScheduler(script: Record<string, Array<SessionOutcome | HookAttempt>>) {
  const started: string[] = [];
  const recorded: RunRow[] = [];
  const slept: number[] = [];
  const scheduler: Scheduler = {
    canStart: () => true,
    runSession: async (run) => {
      started.push(run.runId);
      const attempt = script[run.runId]?.shift() ?? { kind: 'completed' };
      return typeof attempt === 'string' ? hookRow(run, attempt) : rowFor(run, attempt);
    },
    record: async (row) => {
      recorded.push(row);
    },
    sleep: async (ms) => {
      slept.push(ms);
    },
  };
  return { scheduler, started, recorded, slept };
}

const ARMS: Arm[] = ['baseline', 'pack', 'plugin'];

describe('scheduling', () => {
  const planned = planRuns([fakeCase('a'), fakeCase('b')], ARMS, 2);

  it('plans repeat first, then case, then arm', () => {
    expect(planned.map((run) => run.runId)).toEqual([
      'a.baseline.1',
      'a.pack.1',
      'a.plugin.1',
      'b.baseline.1',
      'b.pack.1',
      'b.plugin.1',
      'a.baseline.2',
      'a.pack.2',
      'a.plugin.2',
      'b.baseline.2',
      'b.pack.2',
      'b.plugin.2',
    ]);
  });

  it.each(['usage-limit', 'auth', 'billing'] as const)(
    'stops starting runs at the first %s outcome and reports it',
    async (reason) => {
      const fake = scriptedScheduler({ 'a.plugin.1': [couldNotRun(reason)] });
      const stop = await runSchedule(planned, 1, fake.scheduler);
      expect(fake.started).toEqual(['a.baseline.1', 'a.pack.1', 'a.plugin.1']);
      expect(fake.recorded.map((row) => row.runId)).toEqual(fake.started);
      expect(stop).toEqual({
        reason,
        runId: 'a.plugin.1',
        detail: reason,
        resetsAt: reason === 'usage-limit' ? '2026-11-22T15:45:00.000Z' : null,
      });
      expect(fake.slept).toEqual([]);
    }
  );

  it('lets a run already in flight finish and records it after a stop', async () => {
    let releaseFirst = (): void => {};
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started: string[] = [];
    const recorded: string[] = [];
    const stop = await runSchedule(planned, 2, {
      canStart: () => true,
      runSession: async (run) => {
        started.push(run.runId);
        if (run.runId === 'a.baseline.1') {
          await firstHeld;
          return rowFor(run, couldNotRun('usage-limit'));
        }
        return rowFor(run, couldNotRun('usage-limit'));
      },
      record: async (row) => {
        recorded.push(row.runId);
        releaseFirst();
      },
      sleep: async () => {},
    });
    expect(started).toEqual(['a.baseline.1', 'a.pack.1']);
    expect(recorded).toEqual(['a.pack.1', 'a.baseline.1']);
    expect(stop?.runId).toBe('a.pack.1');
  });

  it('starts nothing new while the row that stopped the run is still being written', async () => {
    const started: string[] = [];
    await runSchedule(planned, 2, {
      canStart: () => true,
      runSession: async (run) => {
        started.push(run.runId);
        return rowFor(
          run,
          run.runId === 'a.baseline.1' ? couldNotRun('usage-limit') : { kind: 'completed' }
        );
      },
      record: async (row) => {
        if (row.runId === 'a.baseline.1') {
          // A slow write: the other lane gets many turns before this one returns.
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      },
      sleep: async () => {},
    });
    expect(started).toEqual(['a.baseline.1', 'a.pack.1']);
  });

  it('retries a rate limit in place after 30 s, then 120 s, and records only the final attempt', async () => {
    const fake = scriptedScheduler({
      'a.baseline.1': [couldNotRun('rate-limit'), couldNotRun('overloaded'), { kind: 'completed' }],
    });
    const stop = await runSchedule(planned.slice(0, 2), 1, fake.scheduler);
    expect(stop).toBeNull();
    expect(fake.slept).toEqual([30_000, 120_000]);
    expect(fake.started).toEqual(['a.baseline.1', 'a.baseline.1', 'a.baseline.1', 'a.pack.1']);
    expect(fake.recorded.map((row) => [row.runId, row.attempts, row.infraError])).toEqual([
      ['a.baseline.1', 3, null],
      ['a.pack.1', 1, null],
    ]);
  });

  it('records a transient error as an infra error after two retries and keeps going', async () => {
    const fake = scriptedScheduler({
      'a.baseline.1': [
        couldNotRun('overloaded'),
        couldNotRun('overloaded'),
        couldNotRun('overloaded'),
      ],
    });
    const stop = await runSchedule(planned.slice(0, 2), 1, fake.scheduler);
    expect(stop).toBeNull();
    expect(fake.slept).toEqual([...TRANSIENT_BACKOFF_MS]);
    expect(fake.recorded[0]).toMatchObject({
      runId: 'a.baseline.1',
      attempts: 3,
      infraError: 'could not run (overloaded)',
    });
    expect(fake.recorded[1]?.runId).toBe('a.pack.1');
  });

  it('retries a plugin session whose hook gave nothing in place, on the transient schedule', async () => {
    const fake = scriptedScheduler({ 'a.plugin.1': ['empty', { kind: 'completed' }] });
    expect(await runSchedule(planned.slice(0, 3), 1, fake.scheduler)).toBeNull();
    expect(fake.slept).toEqual([30_000]);
    expect(fake.recorded.map((row) => [row.runId, row.attempts, row.infraError])).toEqual([
      ['a.baseline.1', 1, null],
      ['a.pack.1', 1, null],
      ['a.plugin.1', 2, null],
    ]);
  });

  it('records a hook that stays silent as an infra error with both notes after two retries', async () => {
    const fake = scriptedScheduler({ 'a.plugin.1': ['empty', 'empty', 'empty'] });
    await runSchedule(planned.slice(2, 3), 1, fake.scheduler);
    expect(fake.slept).toEqual([...TRANSIENT_BACKOFF_MS]);
    expect(fake.recorded).toHaveLength(1);
    expect(fake.recorded[0]).toMatchObject({
      attempts: 3,
      infraError: 'arm-invalid: the note was empty',
      hookNote: { verdict: 'empty', expected: 'the stored note', actual: '' },
    });
  });

  it('does not retry a hook that gave another note, or one that failed with the plugin', async () => {
    for (const attempt of ['different', 'empty-unloaded'] as const) {
      const fake = scriptedScheduler({ 'a.plugin.1': [attempt] });
      await runSchedule(planned.slice(2, 3), 1, fake.scheduler);
      expect(fake.slept).toEqual([]);
      expect(fake.recorded[0]?.attempts).toBe(1);
      expect(fake.recorded[0]?.infraError).toMatch(/^arm-invalid: /);
    }
  });

  it('does not retry or stop on other could-not-run reasons', async () => {
    const fake = scriptedScheduler({ 'a.baseline.1': [couldNotRun('network')] });
    expect(await runSchedule(planned.slice(0, 2), 1, fake.scheduler)).toBeNull();
    expect(fake.started).toEqual(['a.baseline.1', 'a.pack.1']);
    expect(fake.slept).toEqual([]);
  });

  it('skips runs the spending cap refuses', async () => {
    const fake = scriptedScheduler({});
    let allowed = 1;
    fake.scheduler.canStart = () => allowed-- > 0;
    await runSchedule(planned.slice(0, 3), 1, fake.scheduler);
    expect(fake.started).toEqual(['a.baseline.1']);
  });

  it('resumes exactly the runs with no row or an infra-error row, in plan order', async () => {
    const existing = new Map<string, RunRow>();
    for (const run of planned) {
      if (['a.baseline.1', 'a.pack.1', 'b.baseline.1', 'a.pack.2'].includes(run.runId)) {
        existing.set(run.runId, rowFor(run, { kind: 'completed' }));
      } else if (['a.plugin.1', 'b.plugin.2'].includes(run.runId)) {
        existing.set(run.runId, rowFor(run, couldNotRun('usage-limit')));
      } else if (run.runId === 'b.pack.1') {
        existing.set(run.runId, rowFor(run, { kind: 'turn-cap' }));
      }
    }
    const todo = pendingRuns(planned, existing);
    expect(todo.map((run) => run.runId)).toEqual([
      'a.plugin.1',
      'b.plugin.1',
      'a.baseline.2',
      'a.plugin.2',
      'b.baseline.2',
      'b.pack.2',
      'b.plugin.2',
    ]);
    const fake = scriptedScheduler({});
    await runSchedule(todo, 2, fake.scheduler);
    expect(fake.started).toEqual(todo.map((run) => run.runId));
  });
});
