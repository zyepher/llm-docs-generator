import { Data, type Effect } from 'effect';

/** Pushing one invoice to the accounting system failed. */
export class SyncError extends Data.TaggedError('SyncError')<{
  readonly invoiceId: string;
  readonly reason: string;
}> {}

/**
 * Pushes one invoice to the accounting system and succeeds with the id the accounting system gave
 * it. The production implementation lives in the API layer; jobs receive it as a parameter.
 */
export type SyncInvoice = (invoiceId: string) => Effect.Effect<string, SyncError>;
