import { Hono } from 'hono';
import type { Context } from 'hono';

import { ITEMS } from './catalog.js';

// What a model writes from Hono 4.12 knowledge: QUERY through app.on, and a hand-rolled 405 per
// path because 4.12 has no built-in for it.
export const app = new Hono();

const notAllowed = (allow: string[]) => (c: Context) =>
  c.json({ error: 'method_not_allowed', allow }, 405, { Allow: allow.join(', ') });

app.get('/items', (c) => c.json({ items: ITEMS }));

app.get('/items/:id', (c) => {
  const item = ITEMS.find((candidate) => String(candidate.id) === c.req.param('id'));
  return item ? c.json(item) : c.json({ error: 'not_found' }, 404);
});

app.on('QUERY', '/search', async (c) => {
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

app.all('/items', notAllowed(['GET']));
app.all('/items/:id', notAllowed(['GET']));
app.all('/search', notAllowed(['QUERY']));
