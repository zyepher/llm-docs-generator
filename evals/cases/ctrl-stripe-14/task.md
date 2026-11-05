Add a `src/billing.ts` module to this project with two exported functions, using the stripe library that is already installed:

1. `createCheckout(stripe: Stripe, priceId: string, quantity: number, successUrl: string): Promise<Stripe.Checkout.Session>` creates a Stripe Checkout Session for a one-time payment of `quantity` units of the price `priceId`, redirecting to `successUrl` afterwards. The session must only offer two payment methods: cards and Link.
2. `cancelAtPeriodEnd(stripe: Stripe, subscriptionId: string): Promise<Stripe.Subscription>` schedules the subscription to cancel at the end of the current billing period instead of cancelling it right away.

Use the `stripe` client passed in; do not create a new one inside these functions. Keep it fully typed: no `any` casts or ts-ignore comments. Do not change package.json or install packages. Run the type checker when you are done.
