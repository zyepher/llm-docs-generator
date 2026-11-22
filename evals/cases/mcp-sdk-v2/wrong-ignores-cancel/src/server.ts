import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';

// Wrong: written against the v2 API, but it never looks at the cancellation signal, so it keeps
// counting and notifying after the caller gave up. The timing-free cancellation check must reject it.
export function createCounterServer(options: { stepDelayMs?: number } = {}): McpServer {
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
      for (let i = 1; i <= n; i += 1) {
        if (progressToken !== undefined) {
          await ctx.mcpReq.notify({
            method: 'notifications/progress',
            params: { progressToken, progress: i, total: n },
          });
        }
        if (i < n) {
          await new Promise((resolve) => setTimeout(resolve, stepDelayMs));
        }
      }
      return { content: [{ type: 'text', text: `Counted to ${n}` }] };
    }
  );

  return server;
}
