Add a `src/transfer.ts` module that validates outgoing bank transfers with zod. It should export:

1. `ibanSchema`: validates an IBAN. Use zod's own built-in IBAN validation rather than a hand-written pattern or checksum. We only accept the electronic format (uppercase, no spaces); anything else is rejected.
2. `transferSchema`: an object schema with `iban` (validated by `ibanSchema`), `amountCents` (a positive integer), `currency` (one of the currencies in `src/currencies.ts`), and `reference` (a string of 1 to 140 characters).
3. `Transfer`: the TypeScript type inferred from `transferSchema`.
4. `isTransfer(value: unknown): value is Transfer`: a type guard that returns true only when `value` is a valid transfer.

Keep it fully typed: no `any` casts or ts-ignore comments. Do not change package.json or install packages. Run the type checker when you are done.
