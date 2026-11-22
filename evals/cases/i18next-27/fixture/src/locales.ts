/**
 * Translations for the shop, one i18next resource per locale (namespace `translation`).
 *
 * German has no VAT note on purpose: prices there are always shown with VAT, so the note is left
 * blank. French has not been translated beyond the title yet.
 */
export const resources = {
  en: {
    translation: {
      cart: { title: 'Your cart', note: 'Prices include VAT' },
    },
  },
  de: {
    translation: {
      cart: { title: 'Warenkorb', note: '' },
    },
  },
  fr: {
    translation: {
      cart: { title: 'Panier' },
    },
  },
};

export type Locale = keyof typeof resources;
