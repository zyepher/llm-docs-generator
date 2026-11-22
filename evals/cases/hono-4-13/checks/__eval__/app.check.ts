import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { app } from '../src/app.js';

// The task asks for Hono's own 405 handling. Rather than look for its import in the source, which
// an unused or type-only import satisfies, wrap the real middleware and record each request it
// turned from the router's 404 into a 405.
const producedByMiddleware = vi.hoisted(() => new Set<Request>());

vi.mock('hono/method-not-allowed', async (importOriginal) => {
  const original = await importOriginal<typeof import('hono/method-not-allowed')>();
  const methodNotAllowed: typeof original.methodNotAllowed = (options) => {
    const middleware: MiddlewareHandler = original.methodNotAllowed(options);
    return async (c, next) => {
      let statusFromRoutes: number | undefined;
      await middleware(c, async () => {
        await next();
        statusFromRoutes = c.res.status;
      });
      if (statusFromRoutes === 404 && c.res.status === 405) {
        producedByMiddleware.add(c.req.raw);
      }
    };
  };
  return { ...original, methodNotAllowed };
});

function methodSet(list: string): string[] {
  return list
    .split(',')
    .map((method) => method.trim().toUpperCase())
    .filter((method) => method.length > 0)
    .sort();
}

async function expect405(path: string, method: string, allowed: string[]): Promise<void> {
  const request = new Request(`http://localhost${path}`, { method });
  const res = await app.request(request);
  expect(res.status, `${method} ${path}`).toBe(405);
  expect(
    producedByMiddleware.has(request),
    `${method} ${path}: the 405 comes from Hono's method-not-allowed middleware`
  ).toBe(true);
  expect(res.headers.get('content-type') ?? '').toMatch(/application\/json/);
  expect(methodSet(res.headers.get('allow') ?? ''), `Allow for ${method} ${path}`).toEqual(
    [...allowed].sort()
  );
  const body: unknown = await res.json();
  expect(body).toMatchObject({ error: 'method_not_allowed' });
  const allow = typeof body === 'object' && body !== null && 'allow' in body ? body.allow : null;
  expect(Array.isArray(allow) ? methodSet(allow.join(',')) : allow).toEqual([...allowed].sort());
}

describe('catalog API', () => {
  it('exports a Hono app', () => {
    expect(app).toBeInstanceOf(Hono);
  });

  it('lists and fetches items', async () => {
    const list = await app.request('/items');
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { items: unknown[] };
    expect(listBody.items).toHaveLength(4);

    const one = await app.request('/items/3');
    expect(one.status).toBe(200);
    expect(await one.json()).toMatchObject({ id: 3, name: 'Ceramic Dripper' });

    const missing = await app.request('/items/99');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not_found' });

    const head = await app.request('/items', { method: 'HEAD' });
    expect(head.status).toBe(200);
  });

  it('answers QUERY /search from the request body', async () => {
    const res = await app.request('/search', {
      method: 'QUERY',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q: 'CUP' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<{ id: number }> };
    expect(body.results.map((item) => item.id).sort()).toEqual([1, 4]);

    const bad = await app.request('/search', {
      method: 'QUERY',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'cup' }),
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'invalid_query' });
  });

  it('returns a JSON 405 with the methods the router knows for the path', async () => {
    await expect405('/items', 'DELETE', ['GET', 'HEAD']);
    await expect405('/items/2', 'PUT', ['GET', 'HEAD']);
    await expect405('/search', 'GET', ['QUERY']);
    await expect405('/search', 'POST', ['QUERY']);
  });

  it('keeps the normal 404 for unknown paths', async () => {
    const res = await app.request('/nope', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});
