Add `src/fetch-rate.ts` to this project, written with Effect, exporting:

1. `RateUnavailable`: an error class with `_tag` equal to `'RateUnavailable'` and a readonly `attempts: number` field.
2. `loadRate(fetchRate: () => Promise<number>, options: { retries: number; cachedRate?: number })`, which returns an Effect that never fails. It succeeds with effect's `Result` type: a success holding a `RateQuote` (from `src/rates.ts`), or a failure holding a `RateUnavailable`.

Behaviour:

- Nothing runs until the returned Effect is run.
- `fetchRate` is called once; each time it rejects it is retried immediately, up to `options.retries` more times.
- If a call resolves, the result is a success with `{ rate, source: 'live' }`.
- If every attempt rejects and `options.cachedRate` is set, the result is a success with `{ rate: options.cachedRate, source: 'cache' }`.
- If every attempt rejects and there is no cached rate, the result is a failure holding a `RateUnavailable` whose `attempts` is the total number of calls made.

Keep it fully typed: no `any` casts or ts-ignore comments. Do not change package.json or install packages. Run the type checker when you are done.
