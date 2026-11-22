import type { Handle, HandleServerError } from '@sveltejs/kit/hooks';

// Wrong: the log carries the error but not its errorId, so support cannot find it. The relaxed
// logging check must still reject it.
export const handle: Handle = async ({ event, resolve }) => {
  const response = await resolve(event);
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'"
  );
  return response;
};

export const handleError: HandleServerError = ({ kind, error, event }) => {
  const errorId = crypto.randomUUID();
  if (kind !== 'unknown') {
    return { ...error, errorId };
  }
  console.error({ path: event.url.pathname, error });
  return { status: 500, message: 'Unexpected error', errorId };
};
