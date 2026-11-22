Add a `src/cart-header.ts` module that builds the cart page's header text with i18next (already installed), using the translations in `src/locales.ts`. It must export `cartHeader(locale: Locale): Promise<string>` (`Locale` is in `src/locales.ts`).

The header is the translated cart title, followed by the translated note in parentheses when the locale has one: `Your cart (Prices include VAT)` in English. English is the fallback language: text a locale has not translated yet is shown in English. German leaves the note blank on purpose (prices there always include VAT), so the German header is just `Warenkorb`, with no English note.

Calls for different locales may run at the same time, so they must not interfere with each other.

Keep it fully typed: no `any` casts or ts-ignore comments. Do not change package.json or install packages. Run the type checker when you are done.
