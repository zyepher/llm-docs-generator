import Stripe from 'stripe';
import { beforeEach, describe, expect, it } from 'vitest';

import { cancelAtPeriodEnd, createCheckout } from '../src/billing.js';

interface CapturedRequest {
  method: string;
  path: string;
  form: URLSearchParams;
}

let requests: CapturedRequest[] = [];

const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  );
  const body = typeof init?.body === 'string' ? init.body : '';
  const method = (init?.method ?? 'GET').toUpperCase();
  requests.push({ method, path: url.pathname, form: new URLSearchParams(body) });

  const payload = url.pathname.startsWith('/v1/checkout/sessions')
    ? {
        id: 'cs_test_123',
        object: 'checkout.session',
        url: 'https://checkout.stripe.com/c/pay/cs_test_123',
      }
    : { id: 'sub_123', object: 'subscription', status: 'active', cancel_at_period_end: true };
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json', 'request-id': 'req_test' },
  });
};

function client(): Stripe {
  return new Stripe('sk_test_123', {
    apiVersion: '2023-10-16',
    httpClient: Stripe.createFetchHttpClient(fakeFetch),
    maxNetworkRetries: 0,
  });
}

beforeEach(() => {
  requests = [];
});

describe('createCheckout', () => {
  it('creates a payment-mode session restricted to card and Link', async () => {
    const session = await createCheckout(client(), 'price_123', 2, 'https://shop.test/thanks');
    expect(session.id).toBe('cs_test_123');
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.method).toBe('POST');
    expect(request?.path).toBe('/v1/checkout/sessions');
    const form = request?.form ?? new URLSearchParams();
    expect(form.get('mode')).toBe('payment');
    expect(form.get('line_items[0][price]')).toBe('price_123');
    expect(form.get('line_items[0][quantity]')).toBe('2');
    expect(form.get('success_url')).toBe('https://shop.test/thanks');
    expect(form.get('payment_method_types[0]')).toBe('card');
    expect(form.get('payment_method_types[1]')).toBe('link');
  });
});

describe('cancelAtPeriodEnd', () => {
  it('schedules cancellation at the end of the period instead of cancelling now', async () => {
    const subscription = await cancelAtPeriodEnd(client(), 'sub_123');
    expect(subscription.id).toBe('sub_123');
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.method).toBe('POST');
    expect(request?.path).toBe('/v1/subscriptions/sub_123');
    expect(request?.form.get('cancel_at_period_end')).toBe('true');
  });
});
