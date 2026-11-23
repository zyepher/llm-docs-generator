import { constants, existsSync } from 'node:fs';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import picomatch from 'picomatch';

import { errorMessage, isRecord } from '../../src/utils/guards.js';
import { sha256File, sha256Hex } from '../../src/utils/hash.js';
import { readJsonFile } from '../../src/utils/json.js';
import {
  AGENT_TEST_GLOBS,
  type Arm,
  CACHE_DIR,
  type CheckSpec,
  type EvalCase,
  isPluginArm,
  listFiles,
} from './cases.js';
import { checkHookNote } from './hook-note.js';
import { runProcess } from './proc.js';
import type { TranscriptSummary } from './transcript.js';

const TEMPLATE_STAMP = '.eval-template.json';

/** Hash of the fixture manifest and lockfile: the template is reused while this is unchanged. */
async function lockKey(evalCase: EvalCase): Promise<string> {
  const fixture = join(evalCase.dir, 'fixture');
  const pkg = await sha256File(join(fixture, 'package.json'));
  const lock = await sha256File(join(fixture, 'package-lock.json'));
  return sha256Hex(`${pkg}\n${lock}`);
}

/**
 * Installs the fixture's locked dependencies once into `.cache/templates/<id>` and returns that
 * directory. Workspaces copy `node_modules` from here, so agents never wait on npm and every arm
 * starts from the same installed tree.
 */
export async function ensureTemplate(
  evalCase: EvalCase,
  log: (line: string) => void
): Promise<string> {
  const templateDir = join(CACHE_DIR, 'templates', evalCase.id);
  const key = await lockKey(evalCase);
  const stampPath = join(templateDir, TEMPLATE_STAMP);
  if (existsSync(stampPath)) {
    const stamp = await readJsonFile(stampPath);
    if (isRecord(stamp) && stamp.lockKey === key && existsSync(join(templateDir, 'node_modules'))) {
      return templateDir;
    }
  }

  log(`installing ${evalCase.id} template (npm ci)`);
  const staging = `${templateDir}.staging-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  const fixture = join(evalCase.dir, 'fixture');
  await cp(join(fixture, 'package.json'), join(staging, 'package.json'));
  await cp(join(fixture, 'package-lock.json'), join(staging, 'package-lock.json'));
  const result = await runProcess(
    'npm',
    ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'],
    { cwd: staging, timeoutMs: 10 * 60_000 }
  );
  if (result.exitCode !== 0) {
    await rm(staging, { recursive: true, force: true });
    throw new Error(
      `npm ci failed for ${evalCase.id} (exit ${String(result.exitCode)}${result.timedOut ? ', timed out' : ''}):\n${result.stderr}`
    );
  }
  await writeFile(join(staging, TEMPLATE_STAMP), `${JSON.stringify({ lockKey: key }, null, 2)}\n`);
  await rm(templateDir, { recursive: true, force: true });
  await rename(staging, templateDir);
  return templateDir;
}

/** Recursive copy that keeps relative symlinks (node_modules/.bin) and clones files where the FS can. */
export async function copyTree(from: string, to: string): Promise<void> {
  await cp(from, to, {
    recursive: true,
    verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE,
  });
}

/**
 * A fresh workspace: the fixture files, then the template's node_modules. Overlays (solution,
 * naive, pack files) are applied by the caller.
 */
export async function createWorkspace(
  evalCase: EvalCase,
  templateDir: string,
  dir: string
): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await copyTree(join(evalCase.dir, 'fixture'), dir);
  await copyTree(join(templateDir, 'node_modules'), join(dir, 'node_modules'));
}

/** Copies every file of `overlayDir` over `dir`, except the names in `skip`. */
export async function overlay(
  overlayDir: string,
  dir: string,
  skip: readonly string[] = []
): Promise<void> {
  for (const rel of await listFiles(overlayDir)) {
    if (skip.includes(rel)) {
      continue;
    }
    const target = join(dir, rel);
    await mkdir(join(target, '..'), { recursive: true });
    await cp(join(overlayDir, rel), target);
  }
}

export interface CheckResult {
  name: string;
  passed: boolean;
  durationMs: number;
  /** Short reason or the tail of the command output. */
  detail: string;
}

/** Patterns over code with comments and string, template, and regex literals blanked out. */
const CODE_SUPPRESSIONS: Array<[RegExp, string]> = [
  [/\bas\s+any\b/, '`as any`'],
  [/:\s*any\b/, '`: any`'],
  [/\bas\s+unknown\s+as\b/, '`as unknown as`'],
];
/** A directive only works inside a comment, so only comments are searched for it. */
const COMMENT_SUPPRESSION = /@ts-(ignore|expect-error|nocheck)/;

/** The slice of the TypeScript compiler API the suppression scan uses. */
interface TsNode {
  kind: number;
  pos: number;
  end: number;
  getStart(sourceFile: TsNode): number;
  getChildren(sourceFile: TsNode): TsNode[];
}
interface TypeScriptApi {
  createSourceFile(
    fileName: string,
    text: string,
    languageVersion: number,
    setParentNodes: boolean,
    scriptKind: number
  ): TsNode;
  ScriptTarget: Record<string, unknown>;
  ScriptKind: Record<string, unknown>;
  SyntaxKind: Record<string, unknown>;
}

function isTypeScriptApi(value: unknown): value is TypeScriptApi {
  return (
    isRecord(value) &&
    typeof value.createSourceFile === 'function' &&
    isRecord(value.ScriptTarget) &&
    isRecord(value.ScriptKind) &&
    isRecord(value.SyntaxKind)
  );
}

function enumValue(table: Record<string, unknown>, name: string): number {
  const value = table[name];
  if (typeof value !== 'number') {
    throw new Error(`the installed typescript has no ${name}`);
  }
  return value;
}

/**
 * Loads the TypeScript compiler the project pins (every fixture installs one), so the scan
 * tokenizes exactly as that compiler does.
 */
function loadTypeScript(projectDir: string): TypeScriptApi {
  const ts: unknown = createRequire(join(projectDir, 'package.json'))('typescript');
  if (!isTypeScriptApi(ts)) {
    throw new Error(`typescript in ${projectDir}/node_modules does not expose the compiler API`);
  }
  return ts;
}

const blank = (char: string | undefined): string => (char === '\n' || char === '\r' ? char : ' ');

/**
 * Splits TypeScript source into code and comments, each as long as the input with everything else
 * blanked (newlines kept, so line numbers survive). Walking the parsed tokens rather than a raw
 * scan is what tells a regex literal from a division, and a template's text from its expressions.
 * Comments live in the trivia between one token and the next.
 */
function splitCodeAndComments(
  ts: TypeScriptApi,
  fileName: string,
  text: string
): { code: string[]; comments: string[] } {
  const kinds = ts.SyntaxKind;
  const literalKinds = new Set(
    [
      'StringLiteral',
      'NoSubstitutionTemplateLiteral',
      'TemplateHead',
      'TemplateMiddle',
      'TemplateTail',
      'RegularExpressionLiteral',
      'JsxText',
    ].map((name) => enumValue(kinds, name))
  );
  const firstJsDoc = enumValue(kinds, 'FirstJSDocNode');
  const lastJsDoc = enumValue(kinds, 'LastJSDocNode');
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    enumValue(ts.ScriptTarget, 'Latest'),
    true,
    enumValue(ts.ScriptKind, fileName.endsWith('.tsx') ? 'TSX' : 'TS')
  );
  const code = text.split('');
  const comments = code.map(blank);
  const visit = (node: TsNode): void => {
    // A JSDoc block is also the leading trivia of the token after it, which covers it.
    if (node.kind >= firstJsDoc && node.kind <= lastJsDoc) {
      return;
    }
    const children = node.getChildren(sourceFile);
    if (children.length > 0) {
      children.forEach(visit);
      return;
    }
    const start = node.getStart(sourceFile);
    for (let index = node.pos; index < start; index += 1) {
      comments[index] = text[index] ?? ' ';
      code[index] = blank(text[index]);
    }
    if (literalKinds.has(node.kind)) {
      for (let index = start; index < node.end; index += 1) {
        code[index] = blank(text[index]);
      }
    }
  };
  visit(sourceFile);
  return { code, comments };
}

/**
 * The TypeScript a Svelte component holds, as [offset, text] segments: its `<script>` blocks and
 * the `{...}` expressions in its markup. Markup prose, styles, and HTML comments are not code.
 */
function svelteSegments(text: string): Array<[number, string]> {
  const segments: Array<[number, string]> = [];
  const expressions = (from: number, to: number): void => {
    let depth = 0;
    let open = 0;
    for (let index = from; index < to; index += 1) {
      if (text[index] === '{') {
        open = depth === 0 ? index + 1 : open;
        depth += 1;
      } else if (text[index] === '}' && depth > 0) {
        depth -= 1;
        if (depth === 0) {
          segments.push([open, text.slice(open, index)]);
        }
      }
    }
  };
  let markupFrom = 0;
  for (const match of text.matchAll(/<(script|style)\b[^>]*>([\s\S]*?)<\/\1>|<!--[\s\S]*?-->/g)) {
    expressions(markupFrom, match.index);
    const body = match[2];
    if (match[1] === 'script' && body !== undefined) {
      segments.push([match.index + match[0].indexOf('>') + 1, body]);
    }
    markupFrom = match.index + match[0].length;
  }
  expressions(markupFrom, text.length);
  return segments;
}

/**
 * Type suppressions in the TypeScript and Svelte files under `srcDir`, as `src/<file>:<line> uses
 * <what>`, with the TypeScript compiler `projectDir` installs. Only code counts: the same words in
 * a comment or a string are prose. The agent's own test files are not graded (AGENT_TEST_GLOBS).
 */
export async function findTypeSuppressions(srcDir: string, projectDir: string): Promise<string[]> {
  if (!existsSync(srcDir)) {
    return [];
  }
  const ts = loadTypeScript(projectDir);
  const isAgentTest = picomatch(AGENT_TEST_GLOBS);
  const hits: string[] = [];
  for (const rel of await listFiles(srcDir)) {
    if (!/\.(ts|mts|cts|tsx|svelte)$/.test(rel) || isAgentTest(`src/${rel}`)) {
      continue;
    }
    const text = await readFile(join(srcDir, rel), 'utf8');
    let split: { code: string[]; comments: string[] };
    if (rel.endsWith('.svelte')) {
      split = { code: text.split('').map(blank), comments: text.split('').map(blank) };
      for (const [offset, segment] of svelteSegments(text)) {
        const part = splitCodeAndComments(ts, `${rel}.ts`, segment);
        part.code.forEach((char, index) => {
          split.code[offset + index] = char;
        });
        part.comments.forEach((char, index) => {
          split.comments[offset + index] = char;
        });
      }
    } else {
      split = splitCodeAndComments(ts, rel, text);
    }
    const commentLines = split.comments.join('').split('\n');
    for (const [index, line] of split.code.join('').split('\n').entries()) {
      for (const [pattern, label] of CODE_SUPPRESSIONS) {
        if (pattern.test(line)) {
          hits.push(`src/${rel}:${index + 1} uses ${label}`);
        }
      }
      if (COMMENT_SUPPRESSION.test(commentLines[index] ?? '')) {
        hits.push(`src/${rel}:${index + 1} uses a @ts- directive`);
      }
    }
  }
  return hits;
}

async function runBuiltin(
  evalCase: EvalCase,
  check: Extract<CheckSpec, { kind: 'builtin' }>,
  dir: string
): Promise<CheckResult> {
  const started = Date.now();
  const done = (passed: boolean, detail: string): CheckResult => ({
    name: check.name,
    passed,
    durationMs: Date.now() - started,
    detail,
  });

  if (check.builtin === 'deps-unchanged') {
    const changed: string[] = [];
    for (const file of ['package.json', 'package-lock.json']) {
      const fixturePath = join(evalCase.dir, 'fixture', file);
      const workspacePath = join(dir, file);
      if (!existsSync(workspacePath)) {
        changed.push(`${file} (deleted)`);
        continue;
      }
      if ((await sha256File(fixturePath)) !== (await sha256File(workspacePath))) {
        changed.push(file);
      }
    }
    return changed.length === 0
      ? done(true, 'package.json and package-lock.json are byte-identical to the fixture')
      : done(false, `changed: ${changed.join(', ')}`);
  }

  const hits = await findTypeSuppressions(join(dir, 'src'), dir);
  return hits.length === 0
    ? done(true, 'no type suppressions in src/')
    : done(false, hits.join('\n'));
}

/**
 * Runs one command check. The program is resolved inside the workspace's node_modules/.bin so a
 * globally installed tool can never stand in for the pinned one.
 */
async function runCommand(
  check: Extract<CheckSpec, { kind: 'command' }>,
  dir: string
): Promise<CheckResult> {
  const [program, ...args] = check.command;
  const binDir = join(dir, 'node_modules', '.bin');
  const programPath = join(binDir, program);
  if (!existsSync(programPath)) {
    return {
      name: check.name,
      passed: false,
      durationMs: 0,
      detail: `${program} is not installed in the workspace`,
    };
  }
  const result = await runProcess(programPath, args, {
    cwd: dir,
    timeoutMs: check.timeoutSeconds * 1000,
    keepBytes: 16 * 1024,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      CI: '1',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    },
  });
  const passed = result.exitCode === 0 && !result.timedOut;
  const output = `${result.stdout}\n${result.stderr}`.trim();
  const reason = result.timedOut
    ? `timed out after ${check.timeoutSeconds}s`
    : (result.spawnError ?? `exit ${String(result.exitCode)}`);
  return {
    name: check.name,
    passed,
    durationMs: result.durationMs,
    detail: passed ? reason : `${reason}\n${output.slice(-4000)}`,
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Arm assertions                                                                             */
/* ------------------------------------------------------------------------------------------ */

/** What the agent was given, read from the workspace just before the session starts. */
export interface WorkspaceFacts {
  agentDocsDir: boolean;
  llmDocsJson: boolean;
  agentsMd: boolean;
  /** `agent-docs/<pack id>` exists, whatever it holds. */
  packDir: boolean;
  packIndex: boolean;
  packManifest: boolean;
  managedBlock: boolean;
}

export async function inspectWorkspace(dir: string, packId: string): Promise<WorkspaceFacts> {
  const agentsPath = join(dir, 'AGENTS.md');
  const agentsText = existsSync(agentsPath) ? await readFile(agentsPath, 'utf8') : '';
  return {
    agentDocsDir: existsSync(join(dir, 'agent-docs')),
    llmDocsJson: existsSync(join(dir, 'llm-docs.json')),
    agentsMd: existsSync(agentsPath),
    packDir: existsSync(join(dir, 'agent-docs', packId)),
    packIndex: existsSync(join(dir, 'agent-docs', packId, 'index.md')),
    packManifest: existsSync(join(dir, 'agent-docs', packId, 'manifest.json')),
    managedBlock:
      agentsText.includes('<!-- BEGIN llm-docs') && agentsText.includes('<!-- END llm-docs -->'),
  };
}

export interface ArmAssertion {
  name: string;
  passed: boolean;
  /** The evidence: what was found, or what is missing. */
  detail: string;
}

export interface ArmExpectation {
  model: string;
  packId: string;
  /** `name` from the plugin's `.claude-plugin/plugin.json`; null in an arm without the plugin. */
  pluginName: string | null;
  /** The note prepare-packs stored for the case and arm; null in an arm without the plugin. */
  hookNote: string | null;
  /** Whether the case marks read-first pages, so its changes arm holds a pack of them. */
  hasReadFirst: boolean;
}

/**
 * Proves a session ran the arm it claims, from the workspace the agent was given and what the
 * session reported about itself. A run that fails any assertion measured a different arm and is
 * never graded.
 */
export function assertArm(
  arm: Arm,
  facts: WorkspaceFacts,
  transcript: Pick<TranscriptSummary, 'session' | 'sessionStartHooks'>,
  expected: ArmExpectation
): ArmAssertion[] {
  const out: ArmAssertion[] = [];
  const check = (name: string, passed: boolean, pass: string, fail: string): void => {
    out.push({ name, passed, detail: passed ? pass : fail });
  };
  const session = transcript.session;
  const pack = `agent-docs/${expected.packId}`;

  if (arm === 'baseline') {
    check(
      'no agent-docs/',
      !facts.agentDocsDir,
      'agent-docs/ absent',
      'agent-docs/ is present in a baseline workspace'
    );
    check(
      'no llm-docs.json',
      !facts.llmDocsJson,
      'llm-docs.json absent',
      'llm-docs.json is present in a baseline workspace'
    );
    check(
      'no AGENTS.md',
      !facts.agentsMd,
      'AGENTS.md absent',
      'AGENTS.md is present in a baseline workspace'
    );
  } else if (arm === 'note' || arm === 'changes') {
    check(
      'llm-docs.json',
      facts.llmDocsJson,
      'llm-docs.json present',
      `llm-docs.json is missing from a ${arm} workspace`
    );
    if (arm === 'changes' && expected.hasReadFirst) {
      check(
        'pack index',
        facts.packIndex,
        `${pack}/index.md present`,
        `${pack}/index.md is missing`
      );
    } else {
      check(
        'no pack',
        !facts.packDir,
        `${pack}/ absent`,
        arm === 'note'
          ? `${pack}/ is present in a note workspace`
          : `${pack}/ is present in a changes workspace, but the case marks no read-first pages`
      );
    }
  } else {
    check('pack index', facts.packIndex, `${pack}/index.md present`, `${pack}/index.md is missing`);
    check(
      'pack manifest',
      facts.packManifest,
      `${pack}/manifest.json present`,
      `${pack}/manifest.json is missing`
    );
    check(
      'managed block',
      facts.managedBlock,
      'AGENTS.md has the llm-docs managed block',
      facts.agentsMd ? 'AGENTS.md has no llm-docs managed block markers' : 'AGENTS.md is missing'
    );
  }

  const model = session?.model ?? null;
  check(
    'model',
    model === expected.model,
    `session model ${expected.model}`,
    session === null
      ? 'session reported no system/init event'
      : `session model is ${String(model)}, not ${expected.model}`
  );
  const mcp = session?.mcpServers ?? [];
  check(
    'no MCP servers',
    session !== null && mcp.length === 0,
    'no MCP servers',
    `MCP servers: ${mcp.join(', ') || 'unknown (no init event)'}`
  );

  const plugins = (session?.plugins ?? []).map((plugin) => plugin.name);
  // Hook events do not name their plugin. The baseline and pack arms assert that no SessionStart
  // hook runs at all, so in an arm that loads the plugin every SessionStart hook is the plugin's.
  const hooks = transcript.sessionStartHooks;
  if (isPluginArm(arm)) {
    const name = expected.pluginName ?? '';
    check(
      'plugin loaded',
      plugins.length === 1 && plugins[0] === name,
      `plugin ${name} loaded`,
      plugins.includes(name)
        ? `other plugins loaded besides ${name}: ${plugins.filter((p) => p !== name).join(', ')}`
        : `plugin ${name} did not load${session !== null && session.pluginErrors.length > 0 ? ` (${session.pluginErrors.join('; ')})` : ''}`
    );
    const finished = hooks.filter((hook) => hook.outcome === 'success');
    check(
      'plugin hook ran',
      hooks.length > 0 && finished.length === hooks.length,
      `${finished.length} SessionStart hook(s) ran`,
      hooks.length === 0
        ? 'plugin hook did not run'
        : `plugin hook did not finish: ${hooks.map((hook) => hook.outcome ?? 'no response').join(', ')}`
    );
    const note = checkHookNote(expected.hookNote ?? '', hooks);
    check(
      'plugin hook note',
      note.verdict === 'match',
      note.expected === ''
        ? 'plugin hook gave no note, as expected'
        : `plugin hook gave the expected ${note.expected.length}-character note`,
      note.verdict === 'empty'
        ? `plugin hook gave the agent nothing, not the expected ${note.expected.length}-character note`
        : note.expected === ''
          ? `plugin hook gave a ${note.actual.length}-character note where none was expected`
          : `plugin hook gave a ${note.actual.length}-character note that differs from the expected ${note.expected.length}-character one`
    );
  } else {
    check(
      'no plugins',
      session !== null && plugins.length === 0,
      'no plugins beyond the built-in ones',
      `plugins loaded: ${plugins.join(', ') || 'unknown (no init event)'}`
    );
    check(
      'no SessionStart hook',
      hooks.length === 0,
      'no SessionStart hook ran',
      `${hooks.length} SessionStart hook(s) ran`
    );
  }
  return out;
}

/** Copies the hidden graders into the workspace and runs every check in order. */
export async function gradeWorkspace(evalCase: EvalCase, dir: string): Promise<CheckResult[]> {
  await overlay(join(evalCase.dir, 'checks'), dir, ['checks.json']);
  const results: CheckResult[] = [];
  for (const check of evalCase.checks) {
    try {
      results.push(
        check.kind === 'builtin'
          ? await runBuiltin(evalCase, check, dir)
          : await runCommand(check, dir)
      );
    } catch (error) {
      results.push({
        name: check.name,
        passed: false,
        durationMs: 0,
        detail: `check crashed: ${errorMessage(error)}`,
      });
    }
  }
  return results;
}
