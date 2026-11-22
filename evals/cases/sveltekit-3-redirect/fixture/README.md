# storefront

A small SvelteKit storefront. Product data lives in `src/catalog.ts` and the home page lists it.

- `src/app.d.ts`: app-wide types (`App.Error`, `App.Locals`, ...)
- `src/lib/config.ts`: settings shared by the server code
- `src/routes/`: pages

Route types (`./$types`) are generated into `.svelte-kit/` whenever Vite starts, so run `npm test`
(or the dev server) once after adding a route, then type check.

```sh
npm run dev       # dev server
npm test          # vitest
npx tsc --noEmit  # type check
```
