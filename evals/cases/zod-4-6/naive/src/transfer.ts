import { z } from 'zod';

import { PAYOUT_CURRENCIES } from './currencies.js';

function hasValidChecksum(iban: string): boolean {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const digits = /[A-Z]/.test(char) ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of digits) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return remainder === 1;
}

export const ibanSchema = z
  .string()
  .regex(/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/)
  .refine(hasValidChecksum, { message: 'Invalid IBAN checksum' });

export const transferSchema = z.object({
  iban: ibanSchema,
  amountCents: z.number().int().positive(),
  currency: z.enum(PAYOUT_CURRENCIES),
  reference: z.string().min(1).max(140),
});

export type Transfer = z.infer<typeof transferSchema>;

export function isTransfer(value: unknown): value is Transfer {
  return transferSchema.safeParse(value).success;
}
