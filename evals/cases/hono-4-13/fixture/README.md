# catalog-api

The product catalog HTTP API, built with Hono. It runs on any Fetch-compatible runtime; tests
call the app directly with `app.request()`.

- `src/catalog.ts`: the catalog items (an in-memory list for now).

```sh
npm test          # vitest
npx tsc --noEmit  # type check
```
