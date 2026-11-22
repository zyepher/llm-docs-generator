import type Stripe from 'stripe';

// Correct, and rejected by the first version of the checks: the payment methods in another order,
// and a pause that relies on invoicing_behavior defaulting to pending_invoice_item.
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
    allowed_payment_method_types: ['paypay', 'card'],
  });
}

export function pauseSub(stripe: Stripe, subscriptionId: string): Promise<Stripe.Subscription> {
  return stripe.subscriptions.pause(subscriptionId);
}
