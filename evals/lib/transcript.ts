import { isRecord } from '../../src/utils/guards.js';

/**
 * What the runner extracts from a `claude -p --output-format stream-json --verbose` transcript.
 * Parsing is defensive: unknown line shapes are ignored, never fatal, because the stream format
 * is not a stable contract.
 */
export interface TranscriptSummary {
  /** From the final `result` line; null when the run never produced one (timeout, crash). */
  result: {
    subtype: string;
    isError: boolean;
    totalCostUsd: number | null;
    numTurns: number | null;
    durationMs: number | null;
    permissionDenials: string[];
    finalText: string;
  } | null;
  /** From the `system/init` line: proves which tools, MCP servers, and plugins the arm had. */
  session: {
    model: string | null;
    claudeCodeVersion: string | null;
    tools: string[];
    mcpServers: string[];
    plugins: string[];
    skills: string[];
  } | null;
  toolCalls: Record<string, number>;
  docsConsulted: boolean;
  /** Distinct agent-docs paths touched by Read, Grep, Glob, or a Bash command. */
  docsPaths: string[];
  webSearches: number;
  webFetches: number;
  webTargets: string[];
  /** Text the SessionStart hooks produced, when hook events were in the stream. */
  sessionStartHookOutput: string[];
  parseErrors: number;
}

const DOCS_MARKER = 'agent-docs';
const WEB_FETCH_AGENT = 'web-fetch';
const OUTPUT_KEYS = new Set(['stdout', 'output', 'additionalContext', 'additional_context']);

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function numberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function namesOf(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      if (typeof item === 'string') {
        return item;
      }
      if (isRecord(item)) {
        return stringField(item, 'name') ?? '';
      }
      return '';
    })
    .filter((name) => name.length > 0);
}

function collectHookText(value: unknown, out: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectHookText(item, out);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, inner] of Object.entries(value)) {
    if (OUTPUT_KEYS.has(key) && typeof inner === 'string' && inner.trim().length > 0) {
      out.push(inner);
    } else if (typeof inner === 'object') {
      collectHookText(inner, out);
    }
  }
}

function docsPathsIn(input: Record<string, unknown>): string[] {
  const found: string[] = [];
  for (const key of ['file_path', 'path', 'pattern', 'glob', 'command']) {
    const value = stringField(input, key);
    if (value === null || !value.includes(DOCS_MARKER)) {
      continue;
    }
    for (const match of value.matchAll(/agent-docs\/[^\s"'`)]*/g)) {
      found.push(match[0]);
    }
    if (!/agent-docs\//.test(value)) {
      found.push(DOCS_MARKER);
    }
  }
  return found;
}

export function summarizeTranscript(jsonl: string): TranscriptSummary {
  const summary: TranscriptSummary = {
    result: null,
    session: null,
    toolCalls: {},
    docsConsulted: false,
    docsPaths: [],
    webSearches: 0,
    webFetches: 0,
    webTargets: [],
    sessionStartHookOutput: [],
    parseErrors: 0,
  };
  const docsPaths = new Set<string>();
  const webFetchAgents = new Set<string>();

  for (const line of jsonl.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      summary.parseErrors += 1;
      continue;
    }
    if (!isRecord(event)) {
      continue;
    }
    const type = stringField(event, 'type');
    const subtype = stringField(event, 'subtype');

    if (type === 'system' && subtype === 'init') {
      summary.session = {
        model: stringField(event, 'model'),
        claudeCodeVersion: stringField(event, 'claude_code_version'),
        tools: namesOf(event.tools).sort(),
        mcpServers: namesOf(event.mcp_servers).sort(),
        plugins: namesOf(event.plugins).sort(),
        skills: namesOf(event.skills).sort(),
      };
      continue;
    }

    if (
      type === 'system' &&
      subtype !== null &&
      subtype.startsWith('hook') &&
      line.includes('SessionStart')
    ) {
      const texts: string[] = [];
      collectHookText(event, texts);
      summary.sessionStartHookOutput.push(...texts);
      continue;
    }

    if (type === 'assistant' && isRecord(event.message) && Array.isArray(event.message.content)) {
      const parent = stringField(event, 'parent_tool_use_id');
      for (const block of event.message.content) {
        if (!isRecord(block) || block.type !== 'tool_use') {
          continue;
        }
        const name = stringField(block, 'name') ?? 'unknown';
        summary.toolCalls[name] = (summary.toolCalls[name] ?? 0) + 1;
        const input = isRecord(block.input) ? block.input : {};
        if (['Read', 'Grep', 'Glob', 'Bash'].includes(name)) {
          for (const path of docsPathsIn(input)) {
            docsPaths.add(path);
          }
        }
        if (name === 'WebSearch') {
          summary.webSearches += 1;
          summary.webTargets.push(`search: ${stringField(input, 'query') ?? ''}`.slice(0, 200));
        } else if (name === 'WebFetch' && (parent === null || !webFetchAgents.has(parent))) {
          summary.webFetches += 1;
          summary.webTargets.push(`fetch: ${stringField(input, 'url') ?? ''}`.slice(0, 200));
        } else if (
          (name === 'Task' || name === 'Agent') &&
          stringField(input, 'subagent_type') === WEB_FETCH_AGENT
        ) {
          // Claude Code 2.1 has no top-level WebFetch tool; pages are read through the web-fetch
          // subagent. Its own nested WebFetch calls are not counted again.
          webFetchAgents.add(stringField(block, 'id') ?? '');
          summary.webFetches += 1;
          summary.webTargets.push(
            `fetch (agent): ${stringField(input, 'prompt') ?? ''}`.slice(0, 200)
          );
        }
      }
      continue;
    }

    if (type === 'result') {
      const denials = Array.isArray(event.permission_denials) ? event.permission_denials : [];
      summary.result = {
        subtype: subtype ?? 'unknown',
        isError: event.is_error === true,
        totalCostUsd: numberField(event, 'total_cost_usd'),
        numTurns: numberField(event, 'num_turns'),
        durationMs: numberField(event, 'duration_ms'),
        permissionDenials: denials.map((denial) => {
          if (!isRecord(denial)) {
            return 'unknown';
          }
          const tool = stringField(denial, 'tool_name') ?? 'unknown';
          const input = isRecord(denial.tool_input) ? denial.tool_input : {};
          const detail =
            stringField(input, 'command') ??
            stringField(input, 'file_path') ??
            stringField(input, 'url');
          return detail === null ? tool : `${tool}: ${detail.slice(0, 160)}`;
        }),
        finalText: (stringField(event, 'result') ?? '').slice(0, 2000),
      };
    }
  }

  summary.docsPaths = [...docsPaths].sort();
  summary.docsConsulted = summary.docsPaths.length > 0;
  return summary;
}
