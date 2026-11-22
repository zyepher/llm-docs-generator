import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import * as z from 'zod';

import { runTool } from '../src/run-tool.js';

const open: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of open.splice(0)) {
    await close();
  }
});

async function connect(): Promise<Client> {
  const server = new McpServer({ name: 'tools', version: '1.0.0' });
  server.registerTool(
    'echo',
    { description: 'Echoes the text back.', inputSchema: z.object({ text: z.string() }) },
    async ({ text }) => ({
      content: [
        { type: 'text', text },
        { type: 'text', text: `(${text.length} chars)` },
      ],
    })
  );
  server.registerTool(
    'quota',
    { description: 'Always reports that the quota is used up.', inputSchema: z.object({}) },
    async () => ({ isError: true, content: [{ type: 'text', text: 'quota exceeded for today' }] })
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'grader', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  open.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

describe('runTool', () => {
  it('returns the text of a normal result', async () => {
    const client = await connect();
    expect(await runTool(client, 'echo', { text: 'hi' })).toBe('hi\n(2 chars)');
  });

  it('reports an error the tool returns', async () => {
    const client = await connect();
    const shown = await runTool(client, 'quota', {});
    expect(shown.startsWith('Tool failed: ')).toBe(true);
    expect(shown).toContain('quota exceeded for today');
  });

  it('reports arguments the server rejects', async () => {
    const client = await connect();
    await expect(runTool(client, 'echo', { text: 42 })).resolves.toMatch(/^Tool failed: /);
  });

  it('reports a tool the server does not have, without rejecting', async () => {
    const client = await connect();
    const outcome = await runTool(client, 'missing_tool', {}).then(
      (shown) => ({ resolved: true, shown }),
      (error: unknown) => ({ resolved: false, shown: String(error) })
    );
    expect(outcome.resolved, `runTool rejected: ${outcome.shown}`).toBe(true);
    expect(outcome.shown.startsWith('Tool failed: ')).toBe(true);
    expect(outcome.shown).toContain('missing_tool');
  });
});
