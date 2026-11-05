import type Stripe from 'stripe';

// Written from memory of stripe-node before v23: payment_method_types on the session, and
// pausing through pause_collection on a subscription update.
export function createCheckout(
  stripe: Stripe,
  priceId: string,
  quantity: number,
  successUrl: string
): Promise<Stripe.Checkout.Session> {
  return stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{ price: priceId, quantity }],
    success_url: successUrl,
    payment_method_types: ['card', 'paypay'],
  });
}

export function pauseSub(stripe: Stripe, subscriptionId: string): Promise<Stripe.Subscription> {
  return stripe.subscriptions.update(subscriptionId, {
    pause_collection: { behavior: 'keep_as_draft' },
  });
}
