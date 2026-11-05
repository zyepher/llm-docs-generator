import { Hono } from 'hono';
import { methodNotAllowed } from 'hono/method-not-allowed';

import { ITEMS } from './catalog.js';

export const app = new Hono();

app.use(
  methodNotAllowed({
    app,
    onMethodNotAllowed: (c, methods) =>
      c.json({ error: 'method_not_allowed', allow: methods }, 405, { Allow: methods.join(', ') }),
  })
);

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
