import type { Client } from '@modelcontextprotocol/client';

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
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = textOf(result.content);
    return result.isError ? `Tool failed: ${text}` : text;
  } catch (error) {
    // In SDK v2 an unknown or disabled tool rejects with a protocol error instead of resolving
    // with isError.
    return `Tool failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}
