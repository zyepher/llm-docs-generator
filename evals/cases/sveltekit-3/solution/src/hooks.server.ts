import type { Handle, HandleServerError } from '@sveltejs/kit/hooks';

const SECURITY_HEADERS: Record<string, string> = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
};

export const handle: Handle = async ({ event, resolve }) => {
  const response = await resolve(event);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
};

export const handleError: HandleServerError = ({ kind, error, event }) => {
  const errorId = crypto.randomUUID();
  if (kind === 'app' || kind === 'framework' || kind === 'validation') {
    return { ...error, errorId };
  }
  console.error(`[${errorId}] unexpected error on ${event.url.pathname}`, error);
  return { status: 500, message: 'Unexpected error', errorId };
};
