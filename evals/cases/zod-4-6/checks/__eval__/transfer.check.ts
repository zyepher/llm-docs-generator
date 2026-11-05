import { describe, expect, expectTypeOf, it } from 'vitest';
import * as z from 'zod';

import { ibanSchema, isTransfer, type Transfer, transferSchema } from '../src/transfer.js';

// Type-level pins, enforced by the typecheck check: the IBAN schema is zod's built-in format.
const pinned: z.ZodIBAN = ibanSchema;
expectTypeOf(isTransfer).guards.toEqualTypeOf<Transfer>();
expectTypeOf<Transfer>().toEqualTypeOf<{
  iban: string;
  amountCents: number;
  currency: 'EUR' | 'GBP' | 'CHF';
  reference: string;
}>();

const valid = {
  iban: 'DE89370400440532013000',
  amountCents: 125_00,
  currency: 'EUR',
  reference: 'Invoice 2026-114',
};

describe('ibanSchema', () => {
  it('is the built-in IBAN format', () => {
    expect(pinned).toBeInstanceOf(z.ZodIBAN);
  });

  it('accepts valid IBANs in electronic format', () => {
    for (const iban of ['DE89370400440532013000', 'GB82WEST12345698765432', 'NO9386011117947']) {
      expect(ibanSchema.safeParse(iban).success).toBe(true);
    }
  });

  it('rejects bad checksums, spaces, and lowercase', () => {
    for (const iban of [
      'DE89370400440532013001',
      'GB82WEST12345698765433',
      'DE89 3704 0044 0532 0130 00',
      'de89370400440532013000',
      'DE89',
      '',
    ]) {
      expect(ibanSchema.safeParse(iban).success).toBe(false);
    }
  });
});

describe('transferSchema and isTransfer', () => {
  it('accepts a valid transfer', () => {
    expect(isTransfer(valid)).toBe(true);
    expect(transferSchema.parse(valid)).toEqual(valid);
  });

  it('rejects invalid transfers', () => {
    expect(isTransfer({ ...valid, iban: 'DE89370400440532013001' })).toBe(false);
    expect(isTransfer({ ...valid, amountCents: 0 })).toBe(false);
    expect(isTransfer({ ...valid, amountCents: 10.5 })).toBe(false);
    expect(isTransfer({ ...valid, currency: 'USD' })).toBe(false);
    expect(isTransfer({ ...valid, reference: '' })).toBe(false);
    expect(isTransfer({ ...valid, reference: 'x'.repeat(141) })).toBe(false);
    expect(isTransfer(null)).toBe(false);
    expect(isTransfer('DE89370400440532013000')).toBe(false);
  });
});
