import * as z from 'zod';

import { PAYOUT_CURRENCIES } from './currencies.js';

export const ibanSchema = z.iban();

export const transferSchema = z.object({
  iban: ibanSchema,
  amountCents: z.number().int().positive(),
  currency: z.enum(PAYOUT_CURRENCIES),
  reference: z.string().min(1).max(140),
});

export type Transfer = z.infer<typeof transferSchema>;

export function isTransfer(value: unknown): value is Transfer {
  return transferSchema.validate(value);
}
