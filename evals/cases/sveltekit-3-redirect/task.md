Add GitHub sign-in to this SvelteKit storefront: a `/login` route, in `src/routes/login/+page.server.ts`, that sends the visitor straight on to GitHub's authorization page, `https://github.com/login/oauth/authorize`, before any page renders. The URL carries two query parameters:

- `client_id`: our OAuth app's client id, `GITHUB_CLIENT_ID` from `src/lib/config.ts`.
- `redirect_uri`: this site's own origin followed by `/auth/callback` (for example `https://shop.example/auth/callback` when the site is served from `https://shop.example`, or `http://localhost:5173/auth/callback` in development).

The callback route itself comes later; you do not need to write it. Type the route with SvelteKit's own types.

Keep it fully typed: no `any` casts or ts-ignore comments. Do not change package.json or install packages. Run the type checker when you are done.
