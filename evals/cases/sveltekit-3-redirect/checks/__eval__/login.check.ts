import { isRedirect, type RequestEvent } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';

import { GITHUB_CLIENT_ID } from '../src/lib/config.js';
import { load } from '../src/routes/login/+page.server.js';

type LoadEvent = Parameters<typeof load>[0];

function fakeEvent(origin: string): LoadEvent {
  const url = new URL('/login', origin);
  // Only what a sign-in redirect can need; anything else the load touches is undefined.
  const fields = {
    url,
    request: new Request(url),
    locals: {},
    isDataRequest: false,
    isSubRequest: false,
    getClientAddress: () => '127.0.0.1',
    setHeaders: () => {},
  } satisfies Partial<RequestEvent>;
  return Object.assign({} as LoadEvent, fields);
}

async function thrownBy(origin: string): Promise<unknown> {
  try {
    await load(fakeEvent(origin));
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('/login', () => {
  for (const origin of ['https://shop.example', 'http://localhost:5173']) {
    it(`sends a visitor on ${origin} to GitHub's authorization page`, async () => {
      const thrown = await thrownBy(origin);
      expect(
        isRedirect(thrown),
        `load must end in a redirect, got ${thrown instanceof Error ? thrown.message.split('\n')[0] : String(thrown)}`
      ).toBe(true);
      if (!isRedirect(thrown)) {
        return;
      }
      expect([302, 303, 307]).toContain(thrown.status);
      const location = new URL(thrown.location);
      expect(location.origin).toBe('https://github.com');
      expect(location.pathname).toBe('/login/oauth/authorize');
      expect(location.searchParams.get('client_id')).toBe(GITHUB_CLIENT_ID);
      expect(location.searchParams.get('redirect_uri')).toBe(`${origin}/auth/callback`);
    });
  }
});
