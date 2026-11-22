# shop-front

Server-rendered storefront. User-facing text is translated with i18next; the translations live
in `src/locales.ts` while the translation service integration is being built.

- `src/locales.ts`: the translations per locale.

```sh
npm test          # vitest
npx tsc --noEmit  # type check
```
