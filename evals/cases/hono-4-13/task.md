Create `src/app.ts` exporting `app`, a Hono app that serves the catalog in `src/catalog.ts`:

1. `GET /items` returns `{ "items": [...] }` with every item.
2. `GET /items/:id` returns the item as JSON, or status 404 with `{ "error": "not_found" }` when there is no item with that id.
3. `/search` accepts the HTTP QUERY method (a safe request like GET, but the query travels in the request body). The body is JSON `{ "q": string }`; respond with `{ "results": [...] }` holding the items whose name contains `q`, ignoring case. A body that is not JSON or has no string `q` gets status 400 with `{ "error": "invalid_query" }`.
4. When a request uses a method that a known path does not support (for example `DELETE /items`), respond with status 405, an `Allow` header listing every method that path supports, and a JSON body `{ "error": "method_not_allowed", "allow": [...] }` with the same methods. Paths the app does not know still get the normal 404.

Use what Hono itself provides for the 405 handling rather than writing your own route matching for it.

Keep it fully typed: no `any` casts or ts-ignore comments. Do not change package.json or install packages. Run the type checker when you are done.
