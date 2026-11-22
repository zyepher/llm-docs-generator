import type { Client } from '@modelcontextprotocol/client';

// Written from 1.x knowledge: every failed call, including an unknown tool, came back as a
// result with isError set.
function textOf(content: unknown): string {
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((block: unknown) =>
      typeof block === 'object' && block !== null && 'text' in block && typeof block.text === 'string'
        ? block.text
        : ''
    )
    .filter((text) => text.length > 0)
    .join('\n');
}

export async function runTool(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  const text = textOf(result.content);
  return result.isError ? `Tool failed: ${text}` : text;
}
