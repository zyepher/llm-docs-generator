import { describe, expect, it } from 'vitest';

import { cartHeader } from '../src/cart-header.js';

describe('cartHeader', () => {
  it('shows the title and the note in English', async () => {
    expect(await cartHeader('en')).toBe('Your cart (Prices include VAT)');
  });

  it('shows only the title in German, where the note is blank on purpose', async () => {
    expect(await cartHeader('de')).toBe('Warenkorb');
  });

  it('falls back to English for text a locale has not translated', async () => {
    expect(await cartHeader('fr')).toBe('Panier (Prices include VAT)');
  });

  it('keeps concurrent calls for different locales apart', async () => {
    expect(await Promise.all([cartHeader('de'), cartHeader('en'), cartHeader('fr')])).toEqual([
      'Warenkorb',
      'Your cart (Prices include VAT)',
      'Panier (Prices include VAT)',
    ]);
  });
});
