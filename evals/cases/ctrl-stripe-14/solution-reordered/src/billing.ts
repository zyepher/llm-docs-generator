import type Stripe from 'stripe';

// Correct, and rejected by the first version of the checks: the payment methods in another order.
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
    payment_method_types: ['link', 'card'],
  });
}

export function cancelAtPeriodEnd(
  stripe: Stripe,
  subscriptionId: string
): Promise<Stripe.Subscription> {
  return stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
}
