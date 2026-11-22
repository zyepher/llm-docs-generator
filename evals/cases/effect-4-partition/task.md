Add `src/sync.ts` to this project, written with Effect, exporting `syncAll(invoiceIds: ReadonlyArray<string>, syncInvoice: SyncInvoice)` (`SyncInvoice` is in `src/invoices.ts`) for the nightly invoice job.

It returns an Effect that:

- runs `syncInvoice` once for every invoice id, with at most 4 running at a time;
- never fails, even when some invoices fail to sync: one bad invoice must not stop the others;
- succeeds with `{ synced: number; failed: number }`, how many invoices synced and how many failed, for the nightly report.

Nothing runs until the returned Effect is run.

Keep it fully typed: no `any` casts or ts-ignore comments. Do not change package.json or install packages. Run the type checker when you are done.
