import type Stripe from 'stripe';

// Wrong: offers a third payment method. The order-insensitive check must still reject it.
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
    payment_method_types: ['card', 'link', 'paypal'],
  });
}

export function cancelAtPeriodEnd(
  stripe: Stripe,
  subscriptionId: string
): Promise<Stripe.Subscription> {
  return stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
}
