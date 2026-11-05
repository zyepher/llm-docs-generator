import { Effect, Result } from 'effect';
import { describe, expect, it } from 'vitest';

import { loadRate, RateUnavailable } from '../src/fetch-rate.js';
import type { RateQuote } from '../src/rates.js';

// Pin the Effect 4 API: the pipeline never fails and succeeds with effect's Result.
const pinned: Effect.Effect<Result.Result<RateQuote, RateUnavailable>, never, never> = loadRate(
  async () => 1,
  { retries: 0 }
);
const pinnedWithCache: Effect.Effect<
  Result.Result<RateQuote, RateUnavailable>,
  never,
  never
> = loadRate(async () => 1, { retries: 1, cachedRate: 1.5 });

function source(
  failuresBeforeSuccess: number,
  rate: number
): { fetchRate: () => Promise<number>; calls: () => number } {
  let calls = 0;
  return {
    fetchRate: async () => {
      calls += 1;
      if (calls <= failuresBeforeSuccess) {
        throw new Error(`upstream 503 (call ${calls})`);
      }
      return rate;
    },
    calls: () => calls,
  };
}

describe('loadRate', () => {
  it('is lazy: nothing is fetched until the effect runs', async () => {
    const upstream = source(0, 1.1);
    const program = loadRate(upstream.fetchRate, { retries: 3 });
    expect(upstream.calls()).toBe(0);
    await Effect.runPromise(program);
    expect(upstream.calls()).toBe(1);
  });

  it('returns the live rate after transient failures', async () => {
    const upstream = source(2, 4.2);
    const result = await Effect.runPromise(loadRate(upstream.fetchRate, { retries: 3 }));
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) {
      expect(result.success).toEqual({ rate: 4.2, source: 'live' });
    }
    expect(upstream.calls()).toBe(3);
  });

  it('falls back to the cached rate when every attempt fails', async () => {
    const upstream = source(Number.POSITIVE_INFINITY, 0);
    const result = await Effect.runPromise(
      loadRate(upstream.fetchRate, { retries: 2, cachedRate: 3.75 })
    );
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) {
      expect(result.success).toEqual({ rate: 3.75, source: 'cache' });
    }
    expect(upstream.calls()).toBe(3);
  });

  it('fails with RateUnavailable and the attempt count when there is no cached rate', async () => {
    const upstream = source(Number.POSITIVE_INFINITY, 0);
    const result = await Effect.runPromise(loadRate(upstream.fetchRate, { retries: 2 }));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(RateUnavailable);
      expect(result.failure._tag).toBe('RateUnavailable');
      expect(result.failure.attempts).toBe(3);
    }
    expect(upstream.calls()).toBe(3);
  });

  it('makes a single attempt when retries is 0', async () => {
    const upstream = source(Number.POSITIVE_INFINITY, 0);
    const result = await Effect.runPromise(loadRate(upstream.fetchRate, { retries: 0 }));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.attempts).toBe(1);
    }
    expect(upstream.calls()).toBe(1);
  });

  it('builds effects that run to a Result', async () => {
    expect(Result.isResult(await Effect.runPromise(pinned))).toBe(true);
    expect(Result.isResult(await Effect.runPromise(pinnedWithCache))).toBe(true);
  });
});
