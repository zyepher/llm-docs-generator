import Stripe from 'stripe';

export function createStripeClient(secretKey: string): Stripe {
  if (!secretKey.startsWith('sk_')) {
    throw new Error('Expected a Stripe secret key (sk_...)');
  }
  return new Stripe(secretKey);
}
