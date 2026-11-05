import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

// Written the way the 1.x SDK worked: a raw-shape input schema and the flat `extra` handler
// argument with `_meta`, `signal`, and `sendNotification`.
export function createCounterServer(options: { stepDelayMs?: number } = {}): McpServer {
  const stepDelayMs = options.stepDelayMs ?? 100;
  const server = new McpServer({ name: 'task-runner', version: '0.1.0' });

  server.registerTool(
    'count_to',
    {
      description: 'Counts from 1 to n, reporting progress after every step.',
      inputSchema: { n: z.number().int().min(1) },
    },
    async ({ n }, extra) => {
      const progressToken = extra._meta?.progressToken;
      let reached = 0;
      for (let i = 1; i <= n; i += 1) {
        if (extra.signal.aborted) {
          break;
        }
        reached = i;
        if (progressToken !== undefined) {
          await extra.sendNotification({
            method: 'notifications/progress',
            params: { progressToken, progress: i, total: n },
          });
        }
        if (i < n) {
          await new Promise((resolve) => setTimeout(resolve, stepDelayMs));
        }
      }
      const text = reached === n ? `Counted to ${n}` : `Stopped at ${reached}`;
      return { content: [{ type: 'text', text }] };
    }
  );

  return server;
}
