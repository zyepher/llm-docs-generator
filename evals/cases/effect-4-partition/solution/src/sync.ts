import { Effect } from 'effect';

import type { SyncInvoice } from './invoices.js';

export const syncAll = (
  invoiceIds: ReadonlyArray<string>,
  syncInvoice: SyncInvoice
): Effect.Effect<{ synced: number; failed: number }> =>
  Effect.gen(function* () {
    // Effect 4 returns [passes, fails]; Effect 3 returned [failures, successes].
    const [synced, failed] = yield* Effect.partition(invoiceIds, syncInvoice, { concurrency: 4 });
    return { synced: synced.length, failed: failed.length };
  });
