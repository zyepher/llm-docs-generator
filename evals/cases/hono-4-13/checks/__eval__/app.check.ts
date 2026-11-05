import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { app } from '../src/app.js';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return /\.ts$/.test(entry.name) ? [path] : [];
  });
}

function methodSet(list: string): string[] {
  return list
    .split(',')
    .map((method) => method.trim().toUpperCase())
    .filter((method) => method.length > 0)
    .sort();
}

async function expect405(path: string, method: string, allowed: string[]): Promise<void> {
  const res = await app.request(path, { method });
  expect(res.status, `${method} ${path}`).toBe(405);
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

  it("uses Hono's built-in 405 handling", () => {
    const src = sourceFiles('src')
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    expect(src).toMatch(/from\s+['"]hono\/method-not-allowed['"]/);
  });
});
