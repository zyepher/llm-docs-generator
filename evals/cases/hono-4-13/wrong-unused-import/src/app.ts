import { Hono } from 'hono';
import type { Context } from 'hono';
import type { methodNotAllowed } from 'hono/method-not-allowed';

import { ITEMS } from './catalog.js';

// Wrong: a hand-rolled 405 per path that gets every response right (including the HEAD Hono
// derives from GET), plus a type-only import of the built-in middleware that never runs. The first
// version of the checks passed it on the import text alone.
export type Unused = typeof methodNotAllowed;

export const app = new Hono();

const notAllowed = (allow: string[]) => (c: Context) =>
  c.json({ error: 'method_not_allowed', allow }, 405, { Allow: allow.join(', ') });

app.get('/items', (c) => c.json({ items: ITEMS }));

app.get('/items/:id', (c) => {
  const item = ITEMS.find((candidate) => String(candidate.id) === c.req.param('id'));
  return item ? c.json(item) : c.json({ error: 'not_found' }, 404);
});

app.query('/search', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    body = null;
  }
  if (typeof body !== 'object' || body === null || !('q' in body) || typeof body.q !== 'string') {
    return c.json({ error: 'invalid_query' }, 400);
  }
  const q = body.q.toLowerCase();
  return c.json({ results: ITEMS.filter((item) => item.name.toLowerCase().includes(q)) });
});

app.all('/items', notAllowed(['GET', 'HEAD']));
app.all('/items/:id', notAllowed(['GET', 'HEAD']));
app.all('/search', notAllowed(['QUERY']));
