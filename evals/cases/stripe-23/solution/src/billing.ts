import type Stripe from 'stripe';

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
    allowed_payment_method_types: ['card', 'paypay'],
  });
}

export function pauseSub(stripe: Stripe, subscriptionId: string): Promise<Stripe.Subscription> {
  return stripe.subscriptions.pause(subscriptionId, {
    invoicing_behavior: 'pending_invoice_item',
  });
}
