Add a `src/run-tool.ts` module for the chat UI, built with the MCP TypeScript SDK packages already installed. It must export:

`runTool(client: Client, name: string, args: Record<string, unknown>): Promise<string>` (`Client` from `@modelcontextprotocol/client`, already connected to a server), which calls the server's tool `name` with `args` and returns what the chat should show:

- when the tool runs normally, the text of its result (its text content joined with newlines);
- when the call does not give a normal result, `Tool failed: <the server's message>`. That covers a tool that reports an error, arguments the server rejects, and a name the server has no tool for (the assistant sometimes asks for tools that do not exist).

The chat must never crash because of a tool call, so `runTool` resolves with one of those strings in all of these cases instead of rejecting.

Keep it fully typed: no `any` casts or ts-ignore comments. Do not change package.json or install packages. Run the type checker when you are done.
