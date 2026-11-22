import { Effect } from 'effect';

import type { SyncInvoice } from './invoices.js';

// Written from Effect 3 knowledge, where Effect.partition returns [failures, successes].
export const syncAll = (invoiceIds: ReadonlyArray<string>, syncInvoice: SyncInvoice) =>
  Effect.gen(function* () {
    const [failed, synced] = yield* Effect.partition(invoiceIds, syncInvoice, { concurrency: 4 });
    return { synced: synced.length, failed: failed.length };
  });
