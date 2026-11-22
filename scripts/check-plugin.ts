/**
 * `npm run check:plugin`: fails when the committed plugin is out of date or
 * its prose names a command, flag, or check the CLI does not have.
 *
 * 1. The bundle and the stamped manifests equal what `npm run build:plugin`
 *    writes, byte for byte.
 * 2. Each skill folder name equals its frontmatter `name`, and each agent file
 *    name its agent's `name`; frontmatter uses only harness-neutral fields.
 * 3. Every `llm-docs <command>` and `--flag` inside a code span or code block
 *    of the skills, the agent, and the plugin README exists in
 *    `capabilities --json` of the freshly built bundle, the `llm-docs` skill
 *    names every command, and its `Check` table lists exactly the checks
 *    `verify` runs.
 * 4. `claude plugin validate --strict` passes for the plugin and the
 *    marketplace, when the `claude` CLI is on PATH (CI does not have it).
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { load } from 'js-yaml';

import { errorMessage, isRecord } from '../src/utils/guards.js';
import { REPO_ROOT, renderPlugin } from './build-plugin.js';

const run = promisify(execFile);

/**
 * Flags the skills teach from parallel work that this build does not have
 * yet, by command. Remove an entry as soon as `capabilities --json` lists it.
 */
const PENDING_FLAGS: Readonly<Record<string, readonly string[]>> = {
  add: ['--read-first'],
};

/** Frontmatter keys every target harness accepts (Claude Code, Cursor, Codex). */
const SKILL_KEYS = new Set(['name', 'description', 'license', 'metadata']);
const AGENT_KEYS = new Set(['name', 'description']);
/** The Agent Skills standard's cap; Claude Code's listing allows more. */
const DESCRIPTION_MAX_CHARS = 1024;
const PROGRAM_FLAGS = ['--help', '--version'];

export interface Capabilities {
  commands: ReadonlyArray<{ name: string; flags: readonly string[] }>;
  checks: readonly string[];
}

/** The parts of `capabilities --json` the lint reads. */
export function parseCapabilities(raw: unknown): Capabilities {
  if (!isRecord(raw) || !Array.isArray(raw.commands) || !isRecord(raw.checks)) {
    throw new Error('capabilities --json has an unexpected shape.');
  }

  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];

  return {
    commands: raw.commands.filter(isRecord).map((command) => ({
      name: String(command.name),
      flags: (Array.isArray(command.options) ? command.options : [])
        .filter(isRecord)
        .flatMap((option) => String(option.flags).split(/[\s,]+/))
        .filter((token) => token.startsWith('--')),
    })),
    checks: [...strings(raw.checks.pack), ...strings(raw.checks.project)],
  };
}

interface Snippet {
  text: string;
  line: number;
}

/** Inline code spans outside fences, and every line inside a fenced block. */
function codeSnippets(markdown: string): Snippet[] {
  const snippets: Snippet[] = [];
  let fence: string | null = null;

  markdown.split(/\r?\n/).forEach((text, index) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(text)?.[1];

    if (marker !== undefined && (fence === null || marker.startsWith(fence))) {
      fence = fence === null ? marker : null;
      return;
    }
    if (fence !== null) {
      snippets.push({ text, line: index + 1 });
      return;
    }
    for (const match of text.matchAll(/(`+)([^`]+?)\1(?!`)/g)) {
      snippets.push({ text: match[2] ?? '', line: index + 1 });
    }
  });
  return snippets;
}

function frontmatter(markdown: string): Record<string, unknown> | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(markdown);
  const parsed: unknown = match?.[1] === undefined ? null : load(match[1]);
  return isRecord(parsed) ? parsed : null;
}

function checkFrontmatter(
  where: string,
  markdown: string,
  expectedName: string,
  allowedKeys: ReadonlySet<string>
): string[] {
  const fields = frontmatter(markdown);

  if (fields === null) {
    return [`${where}: no YAML frontmatter.`];
  }

  const problems: string[] = [];

  if (fields.name !== expectedName) {
    problems.push(
      `${where}: frontmatter name "${String(fields.name)}" must equal "${expectedName}".`
    );
  }
  if (typeof fields.description !== 'string' || fields.description.trim() === '') {
    problems.push(`${where}: frontmatter needs a description.`);
  } else if (fields.description.length > DESCRIPTION_MAX_CHARS) {
    problems.push(
      `${where}: the description has ${fields.description.length} characters; the cap is ${DESCRIPTION_MAX_CHARS}.`
    );
  }
  for (const key of Object.keys(fields)) {
    if (!allowedKeys.has(key)) {
      problems.push(
        `${where}: frontmatter field "${key}" is not accepted by every harness; use only ${[...allowedKeys].join(', ')}.`
      );
    }
  }
  return problems;
}

/** Problems with the commands and flags one snippet names; records the commands it saw. */
function checkSnippet(
  where: string,
  snippet: Snippet,
  capabilities: Capabilities,
  seen: Set<string>
): string[] {
  const words = snippet.text.trim().split(/\s+/);
  const at = `${where}:${snippet.line}`;
  const flagOf = (word: string): string | undefined =>
    /^(--[a-z][a-z0-9-]*)/.exec(word)?.[1] ?? undefined;
  const known = (flag: string, command: string | null): boolean => {
    const commands =
      command === null
        ? capabilities.commands
        : capabilities.commands.filter((entry) => entry.name === command);
    return (
      PROGRAM_FLAGS.includes(flag) ||
      commands.some((entry) => entry.flags.includes(flag)) ||
      Object.entries(PENDING_FLAGS).some(
        ([name, flags]) => (command === null || command === name) && flags.includes(flag)
      )
    );
  };
  const starts = words.flatMap((word, index) => (word === 'llm-docs' ? [index] : []));

  if (starts.length === 0) {
    // A bare flag (`--dry-run`) belongs to some command; other code (git, npm) is not ours.
    const flag = words[0] === undefined ? undefined : flagOf(words[0]);
    return flag === undefined || known(flag, null)
      ? []
      : [`${at}: \`${flag}\` is not an option of any llm-docs command.`];
  }

  const problems: string[] = [];

  starts.forEach((start, position) => {
    const segment = words.slice(start + 1, starts[position + 1] ?? words.length);
    const first = segment[0];

    if (first === undefined || first.startsWith('-') || /^[<[]/.test(first)) {
      for (const word of segment) {
        const flag = flagOf(word);
        if (flag !== undefined && !PROGRAM_FLAGS.includes(flag)) {
          problems.push(`${at}: \`llm-docs ${flag}\` is not a program option.`);
        }
      }
      return;
    }

    const name = [`${first} ${segment[1] ?? ''}`, first].find((candidate) =>
      capabilities.commands.some((entry) => entry.name === candidate)
    );

    if (name === undefined) {
      problems.push(`${at}: \`llm-docs ${first}\` is not an llm-docs command.`);
      return;
    }
    seen.add(name);
    for (const word of segment) {
      const flag = flagOf(word);
      if (flag !== undefined && !known(flag, name)) {
        problems.push(`${at}: \`${flag}\` is not an option of \`llm-docs ${name}\`.`);
      }
    }
  });
  return problems;
}

/** First-column code spans of every Markdown table whose header starts with `Check`. */
function checkTableNames(markdown: string): string[] | null {
  let inTable = false;
  let names: string[] | null = null;

  for (const line of markdown.split(/\r?\n/)) {
    if (/^\|\s*Check\s*\|/.test(line)) {
      inTable = true;
      names ??= [];
      continue;
    }
    if (!line.startsWith('|')) {
      inTable = false;
      continue;
    }
    const name = /^\|\s*`([^`]+)`\s*\|/.exec(line)?.[1];
    if (inTable && name !== undefined) {
      names?.push(name);
    }
  }
  return names;
}

/** Every problem with the plugin's skills, agents, and README; empty when they are true to the CLI. */
export async function lintPlugin(pluginDir: string, capabilities: Capabilities): Promise<string[]> {
  const problems: string[] = [];
  const seenByReference = new Set<string>();
  const documents: Array<{ where: string; markdown: string }> = [];

  const skillEntries = await readdir(join(pluginDir, 'skills'), { withFileTypes: true });

  for (const entry of skillEntries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) {
      continue;
    }
    const where = `skills/${entry.name}/SKILL.md`;
    const markdown = await readFile(join(pluginDir, where), 'utf-8').catch(() => null);
    if (markdown === null) {
      problems.push(`skills/${entry.name}: no SKILL.md.`);
      continue;
    }
    problems.push(...checkFrontmatter(where, markdown, entry.name, SKILL_KEYS));
    documents.push({ where, markdown });
  }

  for (const entry of (await readdir(join(pluginDir, 'agents'))).sort()) {
    if (entry.endsWith('.md')) {
      const where = `agents/${entry}`;
      const markdown = await readFile(join(pluginDir, where), 'utf-8');
      problems.push(...checkFrontmatter(where, markdown, basename(entry, '.md'), AGENT_KEYS));
      documents.push({ where, markdown });
    }
  }

  documents.push({
    where: 'README.md',
    markdown: await readFile(join(pluginDir, 'README.md'), 'utf-8'),
  });

  for (const { where, markdown } of documents) {
    const seen = where === 'skills/llm-docs/SKILL.md' ? seenByReference : new Set<string>();
    for (const snippet of codeSnippets(markdown)) {
      problems.push(...checkSnippet(where, snippet, capabilities, seen));
    }
  }

  const reference = documents.find((document) => document.where === 'skills/llm-docs/SKILL.md');

  if (reference === undefined) {
    problems.push('skills/llm-docs/SKILL.md is missing: it is the command reference.');
  } else {
    for (const command of capabilities.commands) {
      if (!seenByReference.has(command.name)) {
        problems.push(`skills/llm-docs/SKILL.md never names \`llm-docs ${command.name}\` in code.`);
      }
    }
    const table = checkTableNames(reference.markdown);
    const listed = new Set(table ?? []);
    if (table === null) {
      problems.push('skills/llm-docs/SKILL.md has no table whose first column is "Check".');
    }
    for (const check of capabilities.checks) {
      if (!listed.has(check)) {
        problems.push(`skills/llm-docs/SKILL.md: the Check table does not list \`${check}\`.`);
      }
    }
    for (const name of listed) {
      if (!capabilities.checks.includes(name)) {
        problems.push(`skills/llm-docs/SKILL.md: \`${name}\` is not a verify check.`);
      }
    }
  }

  return problems;
}

/** Problems from `claude plugin validate --strict`, or null when the claude CLI is not installed. */
async function claudeValidate(): Promise<string[] | null> {
  const problems: string[] = [];

  for (const target of ['plugin', '.']) {
    try {
      await run('claude', ['plugin', 'validate', target, '--strict'], { cwd: REPO_ROOT });
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') {
        return null;
      }
      const output = isRecord(error) ? `${String(error.stdout)}${String(error.stderr)}` : '';
      problems.push(
        `claude plugin validate ${target} --strict failed: ${output.trim() || errorMessage(error)}`
      );
    }
  }
  return problems;
}

async function main(): Promise<void> {
  const problems: string[] = [];
  const rendered = await renderPlugin();
  const scratch = await mkdtemp(join(tmpdir(), 'llm-docs-check-plugin-'));

  try {
    for (const [path, bytes] of rendered) {
      const committed = await readFile(join(REPO_ROOT, path)).catch(() => null);
      if (committed === null || !committed.equals(bytes)) {
        problems.push(
          `${path} differs from what the build writes; run 'npm run build:plugin' and commit the result.`
        );
      }
    }

    const bundle = join(scratch, 'llm-docs.mjs');
    const bundleBytes = rendered.get('plugin/bin/llm-docs.mjs');
    if (bundleBytes === undefined) {
      throw new Error('renderPlugin returned no bundle.');
    }
    await writeFile(bundle, bundleBytes);
    const { stdout } = await run(process.execPath, [bundle, 'capabilities', '--json']);
    const lint = await lintPlugin(join(REPO_ROOT, 'plugin'), parseCapabilities(JSON.parse(stdout)));
    problems.push(...lint);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  const validation = await claudeValidate();
  problems.push(...(validation ?? []));

  for (const problem of problems) {
    process.stderr.write(`check:plugin: ${problem}\n`);
  }
  process.stderr.write(
    `${validation === null ? 'check:plugin: the claude CLI is not installed; skipped claude plugin validate.\n' : ''}` +
      (problems.length === 0
        ? 'check:plugin: the plugin is up to date and its skills match the CLI.\n'
        : `check:plugin: ${problems.length} problem${problems.length === 1 ? '' : 's'}.\n`)
  );
  process.exitCode = problems.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
