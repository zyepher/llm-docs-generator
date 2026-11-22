import { isRecord } from '../../src/utils/guards.js';

/** One SessionStart hook as the stream reported it (`--include-hook-events`). */
export interface SessionStartHook {
  hookId: string;
  /** `null` while only `hook_started` was seen: the hook began but never reported back. */
  outcome: string | null;
  exitCode: number | null;
  /** The text the hook gave the agent: `additionalContext` from its JSON envelope, else its raw output. */
  output: string;
}

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
    /** HTTP status of the API error that ended the turn; null when none did or no response came. */
    apiErrorStatus: number | null;
    terminalReason: string | null;
    startupFailureReason: string | null;
    totalCostUsd: number | null;
    numTurns: number | null;
    durationMs: number | null;
    permissionDenials: string[];
    finalText: string;
  } | null;
  /** From the `system/init` line: proves which model, MCP servers, and plugins the arm had. */
  session: {
    model: string | null;
    claudeCodeVersion: string | null;
    tools: string[];
    mcpServers: string[];
    /** Plugins other than Claude Code's own built-in ones, which load in every session. */
    plugins: Array<{ name: string; path: string }>;
    pluginErrors: string[];
    skills: string[];
  } | null;
  /** The last main-thread API error message (`is_api_error_message`), if the session saw one. */
  apiError: { code: string | null; status: number | null; text: string } | null;
  /** Set when a `rate_limit_event` reported the subscription quota as exhausted. */
  quotaRejected: { resetsAt: number | null } | null;
  /** Set when the stream's last event was `system/api_retry`: the session was still retrying. */
  retryingAtEnd: { error: string; status: number | null } | null;
  toolCalls: Record<string, number>;
  docsConsulted: boolean;
  /** Distinct agent-docs paths touched by Read, Grep, Glob, or a Bash command. */
  docsPaths: string[];
  webSearches: number;
  webFetches: number;
  webTargets: string[];
  sessionStartHooks: SessionStartHook[];
  parseErrors: number;
}

const DOCS_MARKER = 'agent-docs';
const WEB_FETCH_AGENT = 'web-fetch';

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

/** Built-in plugins report `path: "builtin"` (observed on Claude Code 2.1.330). */
function addedPlugins(value: unknown): Array<{ name: string; path: string }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(isRecord)
    .map((plugin) => ({
      name: stringField(plugin, 'name') ?? '',
      path: stringField(plugin, 'path') ?? '',
    }))
    .filter((plugin) => plugin.path !== 'builtin')
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A SessionStart hook prints a JSON envelope; the agent sees its `additionalContext`. prepare-packs
 * reads the expected note from the hook's stdout with this too, so both sides parse alike.
 */
export function hookText(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && isRecord(parsed.hookSpecificOutput)) {
      return stringField(parsed.hookSpecificOutput, 'additionalContext') ?? '';
    }
  } catch {
    // Plain-text output reaches the agent as it is.
  }
  return raw.trim();
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

function assistantText(message: unknown): string {
  if (!isRecord(message) || !Array.isArray(message.content)) {
    return '';
  }
  return message.content
    .filter(isRecord)
    .map((block) => stringField(block, 'text') ?? '')
    .join('\n')
    .trim();
}

export function summarizeTranscript(jsonl: string): TranscriptSummary {
  const summary: TranscriptSummary = {
    result: null,
    session: null,
    apiError: null,
    quotaRejected: null,
    retryingAtEnd: null,
    toolCalls: {},
    docsConsulted: false,
    docsPaths: [],
    webSearches: 0,
    webFetches: 0,
    webTargets: [],
    sessionStartHooks: [],
    parseErrors: 0,
  };
  const docsPaths = new Set<string>();
  const webFetchAgents = new Set<string>();
  const hooks = new Map<string, SessionStartHook>();

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
    summary.retryingAtEnd = null;

    if (type === 'system' && subtype === 'init') {
      summary.session = {
        model: stringField(event, 'model'),
        claudeCodeVersion: stringField(event, 'claude_code_version'),
        tools: namesOf(event.tools).sort(),
        mcpServers: namesOf(event.mcp_servers).sort(),
        plugins: addedPlugins(event.plugins),
        pluginErrors: (Array.isArray(event.plugin_errors) ? event.plugin_errors : [])
          .filter(isRecord)
          .map(
            (error) =>
              `${stringField(error, 'plugin') ?? '?'}: ${stringField(error, 'message') ?? ''}`
          ),
        skills: namesOf(event.skills).sort(),
      };
      continue;
    }

    if (type === 'system' && subtype === 'api_retry') {
      summary.retryingAtEnd = {
        error: stringField(event, 'error') ?? 'unknown',
        status: numberField(event, 'error_status'),
      };
      continue;
    }

    if (
      type === 'system' &&
      (subtype === 'hook_started' || subtype === 'hook_response') &&
      stringField(event, 'hook_event') === 'SessionStart'
    ) {
      const hookId = stringField(event, 'hook_id') ?? `hook-${hooks.size}`;
      const hook = hooks.get(hookId) ?? { hookId, outcome: null, exitCode: null, output: '' };
      if (subtype === 'hook_response') {
        hook.outcome = stringField(event, 'outcome') ?? 'unknown';
        hook.exitCode = numberField(event, 'exit_code');
        hook.output = hookText(stringField(event, 'output') ?? stringField(event, 'stdout') ?? '');
      }
      hooks.set(hookId, hook);
      continue;
    }

    if (type === 'rate_limit_event' && isRecord(event.rate_limit_info)) {
      const info = event.rate_limit_info;
      if (stringField(info, 'status') === 'rejected') {
        summary.quotaRejected = { resetsAt: numberField(info, 'resetsAt') };
      }
      continue;
    }

    if (type === 'assistant' && isRecord(event.message) && Array.isArray(event.message.content)) {
      const parent = stringField(event, 'parent_tool_use_id');
      if (
        parent === null &&
        (event.is_api_error_message === true || stringField(event, 'error') !== null)
      ) {
        summary.apiError = {
          code: stringField(event, 'error'),
          status: numberField(event, 'api_error_status'),
          text: assistantText(event.message).slice(0, 2000),
        };
      }
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
        apiErrorStatus: numberField(event, 'api_error_status'),
        terminalReason: stringField(event, 'terminal_reason'),
        startupFailureReason: stringField(event, 'startup_failure_reason'),
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
  summary.sessionStartHooks = [...hooks.values()];
  return summary;
}

/* ------------------------------------------------------------------------------------------ */
/* Session outcome                                                                            */
/* ------------------------------------------------------------------------------------------ */

export type CouldNotRunReason =
  | 'usage-limit'
  | 'rate-limit'
  | 'overloaded'
  | 'auth'
  | 'billing'
  | 'network'
  | 'model-unavailable'
  | 'startup-failure'
  | 'no-result'
  | 'api-error';

/**
 * How a session ended. Every kind except `could-not-run` is the agent's own result and is graded:
 * hitting the turn cap, the budget cap, or the wall timeout is part of what an arm achieved, and
 * so is `ended-early` (Claude Code stopped the turn for a reason of the session's own making, such
 * as a context overflow or a hook, which excluding would hide). `could-not-run` means the service
 * or the account, not the agent, ended the session; it is never graded.
 */
export type SessionOutcome =
  | { kind: 'completed' }
  | { kind: 'turn-cap' }
  | { kind: 'budget-cap' }
  | { kind: 'timeout' }
  | { kind: 'ended-early'; terminalReason: string }
  | { kind: 'could-not-run'; reason: CouldNotRunReason; detail: string; resetsAt: string | null };

/** Out of quota or locked out: every later session would end the same way, so the run stops. */
export const ACCOUNT_STOP_REASONS: ReadonlySet<CouldNotRunReason> = new Set([
  'usage-limit',
  'auth',
  'billing',
]);

/** Short-lived service conditions worth retrying in place. */
export const TRANSIENT_REASONS: ReadonlySet<CouldNotRunReason> = new Set([
  'rate-limit',
  'overloaded',
]);

/** `SDKAssistantMessageError` codes (Agent SDK `sdk.d.ts` 0.3.330, also `system/api_retry.error`). */
const ERROR_CODE_REASONS: Record<string, CouldNotRunReason> = {
  authentication_failed: 'auth',
  oauth_org_not_allowed: 'auth',
  account_on_hold: 'auth',
  verification_required: 'auth',
  cloud_credential_error: 'auth',
  billing_error: 'billing',
  overloaded: 'overloaded',
  model_not_found: 'model-unavailable',
};

function reasonForStatus(status: number): CouldNotRunReason {
  if (status === 401 || status === 403) {
    return 'auth';
  }
  if (status === 402) {
    return 'billing';
  }
  if (status === 404) {
    return 'model-unavailable';
  }
  if (status === 429) {
    return 'rate-limit';
  }
  if (status === 529) {
    return 'overloaded';
  }
  return 'api-error';
}

/**
 * Message text that tells cases apart where the structured fields cannot (a 429 is both a plan
 * quota and a short throttle) or are missing. Every pattern is the wording Claude Code documents
 * at https://code.claude.com/docs/en/errors.md (read 2026-11-22 for Claude Code 2.1.330), under the
 * heading named in the comment. Usage-limit patterns come first so a quota 429 is never retried.
 */
const TEXT_PATTERNS: ReadonlyArray<[RegExp, CouldNotRunReason]> = [
  // "You've hit your session limit" (session, weekly, Opus, Sonnet; Fable by the same template).
  [/You've hit your (session|weekly|Opus|Sonnet|Fable) limit/i, 'usage-limit'],
  // "You've hit your monthly spend limit" (spend, individual, org, team, channel, usage limit).
  [/You've hit your .*(spend|usage) limit|You've hit your team's shared budget/i, 'usage-limit'],
  // "Spend limit reached" (a Claude apps gateway cap) and "Usage credits ran out".
  [/spend limit reached|Usage credits ran out|exceeds your group's budget/i, 'usage-limit'],
  // "Credit balance is too low".
  [/Credit balance (is )?too low/i, 'billing'],
  // "Not logged in", "OAuth token revoked or expired", "Login expired", "Invalid API key".
  [
    /Not logged in|Please run \/login|Failed to authenticate|Invalid API key|OAuth token|Login expired|does not have access to Claude/i,
    'auth',
  ],
  // "Server is temporarily limiting requests" and "Request rejected (429)".
  [/temporarily limiting requests|Request rejected \(429\)/i, 'rate-limit'],
  // "API Error: Repeated 529 Overloaded errors" and the "experiencing high load" variant.
  [/529 Overloaded|experiencing high load/i, 'overloaded'],
  // "There's an issue with the selected model", "Model not found".
  [
    /issue with the selected model|not a recognized model id|Model .{1,80} not found/i,
    'model-unavailable',
  ],
  // "Unable to connect to API", "No response from API", "Request timed out", and the
  // "Network and connection errors" family.
  [
    /Unable to connect to API|No response from API|Request timed out|Connection (dropped|refused|lost)|ECONNRESET|ENOTFOUND|Socket is closed|Stream idle timeout/i,
    'network',
  ],
];

function reasonFromText(text: string): CouldNotRunReason | null {
  for (const [pattern, reason] of TEXT_PATTERNS) {
    if (pattern.test(text)) {
      return reason;
    }
  }
  return null;
}

/** A structured code or status decides, except that only the text separates a quota 429 from a throttle. */
function classifyApiError(
  code: string | null,
  status: number | null,
  text: string,
  quotaRejected: boolean
): CouldNotRunReason {
  const fromText = reasonFromText(text);
  if (quotaRejected || fromText === 'usage-limit') {
    return 'usage-limit';
  }
  const fromCode = code === null ? undefined : ERROR_CODE_REASONS[code];
  if (fromCode !== undefined) {
    return fromCode;
  }
  if (code === 'rate_limit') {
    return 'rate-limit';
  }
  if (status !== null) {
    return reasonForStatus(status);
  }
  if (fromText !== null) {
    return fromText;
  }
  // An API error that got no HTTP response at all is a connection failure.
  return code === null || code === 'server_error' || code === 'unknown' ? 'network' : 'api-error';
}

function resetsAtOf(summary: TranscriptSummary, text: string): string | null {
  const epochSeconds = summary.quotaRejected?.resetsAt ?? null;
  if (epochSeconds !== null) {
    return new Date(epochSeconds * 1000).toISOString();
  }
  // The documented messages end with "· resets 3:45pm" or "· resets Mon 12:00am".
  const match = /\bresets ([^·\n.]+)/i.exec(text);
  return match?.[1] === undefined ? null : `${match[1].trim()} (as reported)`;
}

export interface ProcessEnd {
  timedOut: boolean;
  exitCode: number | null;
  stderr: string;
}

/**
 * The single place a session's outcome is decided, from the transcript and how the process
 * ended. Structured fields (`subtype`, `terminal_reason`, `is_error`, `api_error_status`, the
 * assistant message's `error` code, `rate_limit_event`) decide first; message text only where
 * they cannot.
 */
export function classifyOutcome(summary: TranscriptSummary, end: ProcessEnd): SessionOutcome {
  const couldNotRun = (reason: CouldNotRunReason, detail: string): SessionOutcome => ({
    kind: 'could-not-run',
    reason,
    detail: detail.slice(0, 500),
    resetsAt: reason === 'usage-limit' ? resetsAtOf(summary, detail) : null,
  });
  const result = summary.result;

  if (result === null) {
    const retrying = summary.retryingAtEnd;
    if (retrying !== null) {
      // Killed or crashed while Claude Code was still retrying the API: the service ended it.
      const reason = classifyApiError(
        retrying.error,
        retrying.status,
        '',
        summary.quotaRejected !== null
      );
      return couldNotRun(
        reason,
        `still retrying the API (${retrying.error}, status ${String(retrying.status)}) when the session ended`
      );
    }
    if (end.timedOut) {
      return { kind: 'timeout' };
    }
    const stderr = end.stderr.trim().split('\n').at(-1) ?? '';
    return couldNotRun(
      reasonFromText(end.stderr) ?? 'no-result',
      `no result event (exit ${String(end.exitCode)})${stderr.length > 0 ? `: ${stderr}` : ''}`
    );
  }

  if (result.startupFailureReason !== null) {
    return couldNotRun('startup-failure', `${result.startupFailureReason}: ${result.finalText}`);
  }
  if (result.subtype === 'error_max_turns' || result.terminalReason === 'max_turns') {
    return { kind: 'turn-cap' };
  }
  if (result.subtype === 'error_max_budget_usd' || result.terminalReason === 'budget_exhausted') {
    return { kind: 'budget-cap' };
  }
  if (!result.isError) {
    return { kind: 'completed' };
  }

  const apiError = summary.apiError;
  const text = [result.finalText, apiError?.text ?? ''].join('\n');
  const endedOnApiError =
    result.terminalReason === 'api_error' || result.apiErrorStatus !== null || apiError !== null;
  if (endedOnApiError) {
    const reason = classifyApiError(
      apiError?.code ?? null,
      result.apiErrorStatus ?? apiError?.status ?? null,
      text,
      summary.quotaRejected !== null
    );
    return couldNotRun(reason, result.finalText || apiError?.text || 'API error');
  }
  const fromText = reasonFromText(text);
  if (fromText !== null) {
    return couldNotRun(fromText, result.finalText);
  }
  return { kind: 'ended-early', terminalReason: result.terminalReason ?? result.subtype };
}

export function describeOutcome(outcome: SessionOutcome | null): string {
  if (outcome === null) {
    return 'not started';
  }
  switch (outcome.kind) {
    case 'could-not-run':
      return `could not run (${outcome.reason})`;
    case 'ended-early':
      return `ended early (${outcome.terminalReason})`;
    default:
      return outcome.kind;
  }
}
