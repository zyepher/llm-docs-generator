import i18next from 'i18next';

import { type Locale, resources } from './locales.js';

// Written from i18next 26 knowledge, where an empty string was a valid translation by default.
export async function cartHeader(locale: Locale): Promise<string> {
  const i18n = i18next.createInstance();
  await i18n.init({ lng: locale, fallbackLng: 'en', resources });
  const title = i18n.t('cart.title');
  const note = i18n.t('cart.note');
  return note ? `${title} (${note})` : title;
}
