import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import { type SyncInvoice, SyncError } from '../src/invoices.js';
import { syncAll } from '../src/sync.js';

// Pin the contract: an Effect that never fails and needs nothing.
const pinned: Effect.Effect<{ synced: number; failed: number }, never, never> = syncAll(
  [],
  (id) => Effect.succeed(id)
);

/** A fake accounting system: ids ending in "x" are rejected; every call is recorded. */
function accounting(): { syncInvoice: SyncInvoice; calls: string[]; maxInFlight: () => number } {
  const calls: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const syncInvoice: SyncInvoice = (id) =>
    Effect.gen(function* () {
      calls.push(id);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
      inFlight -= 1;
      if (id.endsWith('x')) {
        return yield* Effect.fail(new SyncError({ invoiceId: id, reason: 'rejected' }));
      }
      return `acc-${id}`;
    });
  return { syncInvoice, calls, maxInFlight: () => peak };
}

describe('syncAll', () => {
  it('is lazy: nothing is synced until the effect runs', async () => {
    const fake = accounting();
    const program = syncAll(['inv-1'], fake.syncInvoice);
    expect(fake.calls).toEqual([]);
    await Effect.runPromise(program);
    expect(fake.calls).toEqual(['inv-1']);
  });

  it('counts synced and failed invoices for the report', async () => {
    const fake = accounting();
    const ids = ['inv-1', 'inv-2', 'inv-3x', 'inv-4', 'inv-5', 'inv-6x', 'inv-7'];
    const summary = await Effect.runPromise(syncAll(ids, fake.syncInvoice));
    expect(summary).toEqual({ synced: 5, failed: 2 });
    expect([...fake.calls].sort()).toEqual([...ids].sort());
  });

  it('never fails, even when every invoice fails', async () => {
    const fake = accounting();
    const summary = await Effect.runPromise(syncAll(['ax', 'bx', 'cx'], fake.syncInvoice));
    expect(summary).toEqual({ synced: 0, failed: 3 });
  });

  it('runs at most 4 at a time', async () => {
    const fake = accounting();
    const ids = Array.from({ length: 12 }, (_, index) => `inv-${index}`);
    const summary = await Effect.runPromise(syncAll(ids, fake.syncInvoice));
    expect(summary).toEqual({ synced: 12, failed: 0 });
    expect(fake.maxInFlight()).toBeLessThanOrEqual(4);
  });

  it('handles an empty night', async () => {
    expect(await Effect.runPromise(pinned)).toEqual({ synced: 0, failed: 0 });
  });
});
