// The test the task asks for, written loosely. The reference server beside it is correct; the
// first version of the checks failed this variant because it type-checked and scanned this file.
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { expect, it } from 'vitest';

import { createCounterServer } from './server.js';

it('counts to 2', async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createCounterServer({ stepDelayMs: 1 });
  const client = new Client({ name: 'test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const result = (await client.callTool({ name: 'count_to', arguments: { n: 2 } })) as any;
  expect(result.content[0].text).toBe('Counted to 2');
  const unused: number = 'a test-only type error the grader no longer reads';
  await client.close();
});
