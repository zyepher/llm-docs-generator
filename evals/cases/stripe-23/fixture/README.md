# shop-billing

Server-side billing helpers for the shop: one-off checkouts and subscription management on
Stripe, using the official `stripe` Node library. Every helper takes the Stripe client as its
first argument so callers (and tests) decide how it is configured.

- `src/stripe.ts`: builds the Stripe client from the secret key.

```sh
npm test          # vitest
npx tsc --noEmit  # type check
```
