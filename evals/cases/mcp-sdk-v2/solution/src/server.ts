import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';

export interface CounterServerOptions {
  /** Pause between two counting steps, in milliseconds. */
  stepDelayMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createCounterServer(options: CounterServerOptions = {}): McpServer {
  const stepDelayMs = options.stepDelayMs ?? 100;
  const server = new McpServer({ name: 'task-runner', version: '0.1.0' });

  server.registerTool(
    'count_to',
    {
      description: 'Counts from 1 to n, reporting progress after every step.',
      inputSchema: z.object({ n: z.number().int().min(1) }),
    },
    async ({ n }, ctx) => {
      const progressToken = ctx.mcpReq._meta?.progressToken;
      let reached = 0;
      for (let i = 1; i <= n; i += 1) {
        if (ctx.mcpReq.signal.aborted) {
          break;
        }
        reached = i;
        if (progressToken !== undefined) {
          await ctx.mcpReq.notify({
            method: 'notifications/progress',
            params: { progressToken, progress: i, total: n },
          });
        }
        if (i < n) {
          await sleep(stepDelayMs);
        }
      }
      const text = reached === n ? `Counted to ${n}` : `Stopped at ${reached}`;
      return { content: [{ type: 'text', text }] };
    }
  );

  return server;
}
