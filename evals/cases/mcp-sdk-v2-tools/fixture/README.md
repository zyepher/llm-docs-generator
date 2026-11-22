# chat-tools

The part of the chat backend that calls tools on MCP servers on behalf of the assistant and shows
the result in the conversation. Built on the official MCP TypeScript SDK
(`@modelcontextprotocol/client`, with `@modelcontextprotocol/server` for tests).

- `src/config.ts`: how the backend identifies itself to servers.

```sh
npm test          # vitest
npx tsc --noEmit  # type check
```
