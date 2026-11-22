# invoice-sync

Background jobs that push invoices to the accounting system. Business logic is written with
Effect.

- `src/invoices.ts`: the `SyncInvoice` operation the jobs are given, and its `SyncError`.

```sh
npm test          # vitest
npx tsc --noEmit  # type check
```
