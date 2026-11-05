import { Data, Effect, type Either, Schedule } from 'effect';

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
): Effect.Effect<Either.Either<RateQuote, RateUnavailable>> {
  const live = Effect.tryPromise({
    try: () => fetchRate(),
    catch: (cause) => cause,
  }).pipe(
    Effect.retry(Schedule.recurs(options.retries)),
    Effect.map((rate): RateQuote => ({ rate, source: 'live' }))
  );

  const withFallback = live.pipe(
    Effect.catchAll(() => {
      const { cachedRate } = options;
      return cachedRate === undefined
        ? Effect.fail(new RateUnavailable({ attempts: options.retries + 1 }))
        : Effect.succeed<RateQuote>({ rate: cachedRate, source: 'cache' });
    })
  );

  return Effect.either(withFallback);
}
