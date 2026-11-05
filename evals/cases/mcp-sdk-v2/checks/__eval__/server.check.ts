import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';

import { createCounterServer } from '../src/server.js';

type Connected = {
  client: Client;
  /** Progress values the server put on the wire, whatever the client did with them. */
  sentProgress: number[];
  close: () => Promise<void>;
};

const open: Connected[] = [];

afterEach(async () => {
  for (const connection of open.splice(0)) {
    await connection.close();
  }
});

async function connect(stepDelayMs: number): Promise<Connected> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const sentProgress: number[] = [];
  const send = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (message: JSONRPCMessage, options) => {
    if ('method' in message && message.method === 'notifications/progress') {
      const progress = message.params?.progress;
      if (typeof progress === 'number') {
        sentProgress.push(progress);
      }
    }
    return send(message, options);
  };

  const server = createCounterServer({ stepDelayMs });
  const client = new Client({ name: 'grader', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const connection: Connected = {
    client,
    sentProgress,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
  open.push(connection);
  return connection;
}

function textOf(result: { content?: unknown }): string {
  const content = Array.isArray(result.content) ? result.content : [];
  return content
    .map((block: unknown) =>
      typeof block === 'object' &&
      block !== null &&
      'text' in block &&
      typeof block.text === 'string'
        ? block.text
        : ''
    )
    .join('');
}

describe('count_to', () => {
  it('is listed with an n argument', async () => {
    const { client } = await connect(5);
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === 'count_to');
    expect(tool).toBeDefined();
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toContain('n');
  });

  it('reports progress for every step and returns the count', async () => {
    const { client } = await connect(5);
    const seen: number[] = [];
    const result = await client.callTool(
      { name: 'count_to', arguments: { n: 3 } },
      { onprogress: (progress) => seen.push(progress.progress) }
    );
    expect(seen).toEqual([1, 2, 3]);
    expect(textOf(result)).toBe('Counted to 3');
  });

  it('stops counting when the caller cancels', async () => {
    const { client, sentProgress } = await connect(20);
    const controller = new AbortController();
    const call = client.callTool(
      { name: 'count_to', arguments: { n: 1000 } },
      {
        signal: controller.signal,
        onprogress: () => controller.abort('caller gave up'),
      }
    );
    await expect(call).rejects.toThrow();
    // Uncancelled, the tool would put about 20 more notifications on the wire in this window.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const afterCancel = sentProgress.length;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(afterCancel).toBeLessThanOrEqual(3);
    expect(sentProgress.length).toBe(afterCancel);
  });

  it('uses the MCP SDK packages', () => {
    const source = readFileSync('src/server.ts', 'utf8');
    expect(source).toMatch(/from\s+['"]@modelcontextprotocol\/server['"]/);
  });
});
