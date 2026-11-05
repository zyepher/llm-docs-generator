# task-runner-mcp

An MCP server that exposes long-running maintenance jobs as tools, so an assistant can start
them, watch their progress, and cancel them. Built on the official MCP TypeScript SDK
(`@modelcontextprotocol/server`, with `@modelcontextprotocol/client` for tests).

- `src/config.ts`: server name, version, and timing defaults.

```sh
npm test          # vitest
npx tsc --noEmit  # type check
```
