# storefront

A small SvelteKit storefront. Product data lives in `src/catalog.ts` and the home page lists it.

- `src/app.d.ts`: app-wide types (`App.Error`, `App.Locals`, ...)
- `src/routes/`: pages

```sh
npm run dev       # dev server
npm test          # vitest
npx tsc --noEmit  # type check
```
