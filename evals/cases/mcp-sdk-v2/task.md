Add a `src/server.ts` module to this MCP server project, built with the MCP TypeScript SDK packages already installed (`@modelcontextprotocol/server`, and `@modelcontextprotocol/client` for testing).

It must export `createCounterServer(options?: { stepDelayMs?: number }): McpServer` (`McpServer` from `@modelcontextprotocol/server`), returning a server (not yet connected to any transport) that has one tool:

- Name `count_to`, taking one argument `n` (a positive integer, validated with zod).
- It counts from 1 to `n`. After reaching each number it sends the client a standard MCP progress notification for this request (progress is the current number, total is `n`), then waits `stepDelayMs` milliseconds (default 100) before the next step.
- If the client cancels the request, the tool must stop counting promptly and send no further progress notifications.
- When it finishes it returns a single text content block `Counted to <n>`, for example `Counted to 3`.

Clients that call the tool with a progress callback should see one callback per step. Please also add a small test that connects a client to the server in memory and calls the tool.

Keep it fully typed: no `any` casts or ts-ignore comments. Do not change package.json or install packages. Run the type checker when you are done.
