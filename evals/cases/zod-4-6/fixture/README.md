# payouts-api

Request validation for the payouts service. Incoming JSON is validated with zod before it
reaches the ledger.

- `src/currencies.ts`: the currencies we can pay out in.

```sh
npm test          # vitest
npx tsc --noEmit  # type check
```
