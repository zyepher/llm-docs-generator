import type { RequestEvent } from '@sveltejs/kit';
import type { Handle, HandleServerError } from '@sveltejs/kit/hooks';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import { handle, handleError } from '../src/hooks.server.js';

// Pin the SvelteKit 3 API: the hooks must be assignable to the hook types from
// @sveltejs/kit/hooks, and App.Error must carry the errorId.
const typedHandle: Handle = handle;
const typedHandleError: HandleServerError = handleError;
expectTypeOf<App.Error['errorId']>().toEqualTypeOf<string>();

const CSP = "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'";

function fakeEvent(path: string): { event: RequestEvent; setHeadersCalls: Record<string, string> } {
  const setHeadersCalls: Record<string, string> = {};
  const url = new URL(`https://shop.example${path}`);
  const fields = {
    url,
    request: new Request(url),
    locals: {},
    isDataRequest: false,
    isSubRequest: false,
    isRemoteRequest: false,
    getClientAddress: () => '127.0.0.1',
    setHeaders: (headers: Record<string, string>) => {
      Object.assign(setHeadersCalls, headers);
    },
  } satisfies Partial<RequestEvent>;
  return { event: fields as RequestEvent, setHeadersCalls };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`handleError returned ${String(value)}, expected an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handle', () => {
  it('adds the security headers and keeps status and body', async () => {
    const { event, setHeadersCalls } = fakeEvent('/');
    const resolve = vi.fn(
      async (_event: RequestEvent) =>
        new Response('<h1>Storefront</h1>', {
          status: 201,
          headers: { 'content-type': 'text/html' },
        })
    );
    const response = await typedHandle({ event, resolve });

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0]?.[0]).toBe(event);
    expect(response.status).toBe(201);
    expect(await response.text()).toBe('<h1>Storefront</h1>');

    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(setHeadersCalls)) {
      headers.set(name, value);
    }
    expect(headers.get('x-frame-options')).toBe('DENY');
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(headers.get('content-security-policy')).toBe(CSP);
    expect(headers.get('content-type')).toBe('text/html');
  });
});

describe('handleError', () => {
  it('keeps the status and message of framework errors such as 404s', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { event } = fakeEvent('/no-such-page');
    const result = asRecord(
      await typedHandleError({
        kind: 'framework',
        error: { status: 404, message: 'Not Found' },
        event,
      })
    );
    expect(result.message ?? 'Not Found').toBe('Not Found');
    expect(result.status ?? 404).toBe(404);
    expect(result.errorId).toEqual(expect.any(String));
  });

  it('keeps the status and message of errors raised on purpose', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { event } = fakeEvent('/admin');
    const result = asRecord(
      await typedHandleError({
        kind: 'app',
        error: { status: 403, message: 'Forbidden', errorId: 'from-app' },
        event,
      })
    );
    expect(result.message ?? 'Forbidden').toBe('Forbidden');
    expect(result.status ?? 403).toBe(403);
    expect(result.errorId).toEqual(expect.any(String));
  });

  it('hides unexpected errors behind a generic message and logs them with the errorId', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { event } = fakeEvent('/checkout');
    const result = asRecord(
      await typedHandleError({ kind: 'unknown', error: new Error('db password is hunter2'), event })
    );
    expect(result.message).toBe('Unexpected error');
    expect(result.status ?? 500).toBe(500);
    expect(typeof result.errorId).toBe('string');
    expect(JSON.stringify(result)).not.toContain('hunter2');

    expect(consoleError).toHaveBeenCalled();
    const logged = consoleError.mock.calls
      .flat()
      .map((arg) => (arg instanceof Error ? `${arg.message}` : String(arg)))
      .join(' ');
    expect(logged).toContain(String(result.errorId));
  });

  it('gives every error its own errorId', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { event } = fakeEvent('/');
    const first = asRecord(
      await typedHandleError({ kind: 'unknown', error: new Error('a'), event })
    );
    const second = asRecord(
      await typedHandleError({ kind: 'unknown', error: new Error('b'), event })
    );
    expect(first.errorId).not.toBe(second.errorId);
  });
});
