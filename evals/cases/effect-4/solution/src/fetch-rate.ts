import { Data, Effect, type Result } from 'effect';

import type { RateQuote } from './rates.js';

export class RateUnavailable extends Data.TaggedError('RateUnavailable')<{
  readonly attempts: number;
}> {}

export interface LoadRateOptions {
  retries: number;
  cachedRate?: number;
}

export function loadRate(
  fetchRate: () => Promise<number>,
  options: LoadRateOptions
): Effect.Effect<Result.Result<RateQuote, RateUnavailable>> {
  const live = Effect.tryPromise({
    try: () => fetchRate(),
    catch: (cause) => cause,
  }).pipe(
    Effect.retry({ times: options.retries }),
    Effect.map((rate): RateQuote => ({ rate, source: 'live' }))
  );

  const withFallback = live.pipe(
    Effect.catch(() => {
      const { cachedRate } = options;
      return cachedRate === undefined
        ? Effect.fail(new RateUnavailable({ attempts: options.retries + 1 }))
        : Effect.succeed<RateQuote>({ rate: cachedRate, source: 'cache' });
    })
  );

  return Effect.result(withFallback);
}
