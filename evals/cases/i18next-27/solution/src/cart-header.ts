import i18next from 'i18next';

import { type Locale, resources } from './locales.js';

export async function cartHeader(locale: Locale): Promise<string> {
  const i18n = i18next.createInstance();
  await i18n.init({
    lng: locale,
    fallbackLng: 'en',
    resources,
    // Since i18next 27 an empty translation falls back like a missing one unless this is set.
    returnEmptyString: true,
  });
  const title = i18n.t('cart.title');
  const note = i18n.t('cart.note');
  return note ? `${title} (${note})` : title;
}
