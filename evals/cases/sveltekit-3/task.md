Add server hooks to this SvelteKit app in `src/hooks.server.ts`:

1. A `handle` hook that renders the request as usual and adds these headers to every response, keeping its status and body:
   - `X-Frame-Options: DENY`
   - `X-Content-Type-Options: nosniff`
   - `Referrer-Policy: strict-origin-when-cross-origin`
   - `Content-Security-Policy: default-src 'self'; img-src 'self' data:; frame-ancestors 'none'`
2. A `handleError` hook that gives every error an `errorId` (a random UUID) so support can find it in the logs. Errors we raise on purpose and errors SvelteKit itself produces (such as a 404 for an unknown route) keep their own status and message. Any other, unexpected error must not leak details: log it with `console.error`, including the `errorId`, and show the message `Unexpected error` with status 500.

Declare `errorId: string` on the app's error type in `src/app.d.ts` so pages can show it. Type both hooks with SvelteKit's own types.

Keep it fully typed: no `any` casts or ts-ignore comments. Do not change package.json or install packages. Run the type checker when you are done.
