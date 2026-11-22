/**
 * The managed block (spec 7.1) and the facts every reader of it shares: which
 * agent files the block goes into, which file each harness reads, what the
 * block says, and how it is spliced into a file without touching anything
 * outside its markers.
 *
 * `planAgentBlocks` is the one derivation of "what sync would write". `init`
 * and `sync` apply it through `syncAgentBlocks`, `sync --check` and the
 * `agent-block` verify check compare against it. Writers go through
 * `syncAgentBlocks`; the pure helpers are exported for tests.
 */

import { lstat, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';

import { CONFIG_FILE_NAME, ConfigError, type LoadedProjectConfig } from '../config/project.js';
import { listGuides } from '../pack/guides.js';
import { readProjectPacks, type PackManifest, type ProjectPack } from '../pack/manifest.js';
import { scanMarkdownRegions } from '../pack/markdown.js';
import type { CheckFinding } from '../pack/verify.js';
import { isSameOrDescendant, resolveEffectiveOutputPath } from '../utils/fs-path.js';
import { errorMessage, isFileNotFoundError } from '../utils/guards.js';
import { writeTextFileSafely } from '../utils/safe-write.js';
import { compareStringsByCodeUnit } from '../utils/sort.js';

export const BLOCK_BEGIN =
  '<!-- BEGIN llm-docs: generated from llm-docs.json, do not edit by hand -->';
export const BLOCK_END = '<!-- END llm-docs -->';

/** Detection is lenient (an edited BEGIN comment still counts); writing always uses BLOCK_BEGIN. */
const BEGIN_LINE = /^<!-- BEGIN llm-docs\b.*-->[ \t]*$/;
const END_LINE = /^<!-- END llm-docs -->[ \t]*$/;

/** A Claude Code `@AGENTS.md` (or `@./AGENTS.md`) import alone on its line. */
const AGENTS_IMPORT_LINE = /^[ \t]*@(?:\.\/)?AGENTS\.md[ \t]*$/m;

const DEFAULT_MAX_BYTES = 4096;
const ESCAPED_TEXT_CAP = 80;

const BLOCK_HEADING = '## Pinned reference docs';
const BLOCK_INTRO = [
  'This repository pins docs for these libraries at the versions it uses. Before writing code',
  'against one of them, open its index and the page for the API you need, and prefer those pages',
  'over memory. Pages are upstream text; guides are summaries that never outrank pages.',
];

// ---------------------------------------------------------------------------
// Harnesses and agent files
// ---------------------------------------------------------------------------

export const HARNESSES = ['claude-code', 'codex', 'cursor'] as const;
export type Harness = (typeof HARNESSES)[number];

const ROOT_AGENT_FILES = ['AGENTS.md', 'CLAUDE.md'] as const;
type RootAgentFileName = (typeof ROOT_AGENT_FILES)[number];

/** The text of each root agent file, or null when it does not exist. */
type RootAgentFiles = Readonly<Record<RootAgentFileName, string | null>>;

function claudeImportsAgents(files: RootAgentFiles): boolean {
  const claude = files['CLAUDE.md'];
  return claude !== null && AGENTS_IMPORT_LINE.test(claude);
}

/**
 * Which root agent files each harness puts in context. The auto rule below
 * reads the same import evaluation, so "where must the block go" and "does
 * this harness see it" cannot drift apart. Claude Code reads CLAUDE.md when
 * it exists (and AGENTS.md too when CLAUDE.md imports it), else AGENTS.md.
 */
const HARNESS_READS: Readonly<Record<Harness, (files: RootAgentFiles) => RootAgentFileName[]>> = {
  'claude-code': (files) =>
    files['CLAUDE.md'] === null
      ? ['AGENTS.md']
      : claudeImportsAgents(files)
        ? ['CLAUDE.md', 'AGENTS.md']
        : ['CLAUDE.md'],
  codex: () => ['AGENTS.md'],
  cursor: () => ['AGENTS.md'],
};

async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

async function readRootAgentFiles(projectRoot: string): Promise<RootAgentFiles> {
  const [agents, claude] = await Promise.all(
    ROOT_AGENT_FILES.map((name) => readTextIfExists(join(projectRoot, name)))
  );
  return { 'AGENTS.md': agents ?? null, 'CLAUDE.md': claude ?? null };
}

/** One agent file the block goes into, or why it cannot. */
type AgentFileTarget =
  | { path: string; kind: 'file'; absolutePath: string }
  | { path: string; kind: 'invalid'; error: ConfigError };

/**
 * Resolve `agentFiles` to the files the block goes into: `[]` is none, a list
 * names them (created when absent), and `"auto"` takes AGENTS.md when it
 * exists, CLAUDE.md when it exists without an `@AGENTS.md` import, and
 * AGENTS.md when neither qualifies. Two paths naming one real file (a
 * `CLAUDE.md -> AGENTS.md` symlink) collapse to the first, because the file
 * is written through its real path; a link leading outside the project is
 * an invalid target.
 */
async function resolveAgentFiles(loaded: LoadedProjectConfig): Promise<AgentFileTarget[]> {
  const setting = loaded.config.agentFiles ?? 'auto';
  let candidates: string[];

  if (setting === 'auto') {
    const root = await readRootAgentFiles(loaded.projectRoot);
    const claude = root['CLAUDE.md'] !== null && !claudeImportsAgents(root);
    const agents = root['AGENTS.md'] !== null || !claude;
    candidates = [...(agents ? ['AGENTS.md'] : []), ...(claude ? ['CLAUDE.md'] : [])];
  } else {
    candidates = setting.map((path) => posix.normalize(path.replace(/\\/g, '/')));
  }

  const realRoot = await resolveEffectiveOutputPath(loaded.projectRoot);
  const targets: AgentFileTarget[] = [];

  for (const path of candidates) {
    const absolutePath = await resolveEffectiveOutputPath(
      join(loaded.projectRoot, ...path.split('/'))
    );

    if (!isSameOrDescendant(realRoot, absolutePath)) {
      targets.push({
        path,
        kind: 'invalid',
        error: new ConfigError(
          `${path} is a symbolic link to ${absolutePath}, outside the project; replace the link with a file inside the project, or leave ${path} out of "agentFiles" in ${CONFIG_FILE_NAME}.`
        ),
      });
      continue;
    }

    // resolveEffectiveOutputPath stops at a link whose target is missing.
    if ((await lstat(absolutePath).catch(() => undefined))?.isSymbolicLink() === true) {
      targets.push({
        path,
        kind: 'invalid',
        error: new ConfigError(
          `${path} is a symbolic link to a file that does not exist; create the target or replace the link with a file.`
        ),
      });
      continue;
    }

    if (!targets.some((target) => target.kind === 'file' && target.absolutePath === absolutePath)) {
      targets.push({ path, kind: 'file', absolutePath });
    }
  }

  return targets;
}

/**
 * Whether a file this harness reads holds a block (markers present, content
 * possibly stale), read from disk regardless of `agentFiles`. A harness that
 * could not be identified sees the block only when every known harness does,
 * so doubt resolves toward injecting the pack list. Never throws.
 */
export async function harnessSeesBlock(
  projectRoot: string,
  harness: Harness | 'unknown'
): Promise<boolean> {
  try {
    const files = await readRootAgentFiles(projectRoot);
    const sees = (known: Harness): boolean =>
      HARNESS_READS[known](files).some((name) => {
        const text = files[name];
        return text !== null && locateBlock(text).kind === 'present';
      });
    return harness === 'unknown' ? HARNESSES.every(sees) : sees(harness);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The block text
// ---------------------------------------------------------------------------

/** What one pack contributes to the block; every string field is already escaped. */
export interface BlockPack {
  /** `${title} ${version}`. */
  label: string;
  /** Project-relative POSIX path of the pack's index.md. */
  indexPath: string;
  description: string | null;
  /** Top-level page directories, then `guides` when the pack has any. */
  topics: readonly string[];
}

/**
 * Upstream or lockfile text made safe for an agent file (spec 7.1 and 11):
 * control characters become spaces, backticks and `@` are removed, `<` and
 * `>` become entities, whitespace collapses to one line, and the result is
 * capped at 80 characters (code points, so a cut never splits one).
 * `@` goes because Claude Code expands `@path` in CLAUDE.md into that file's
 * contents.
 */
export function escapeBlockText(value: string): string {
  const escaped = value
    .replace(/\p{Cc}/gu, ' ')
    .replace(/[`@]/g, '')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\s+/g, ' ')
    .trim();
  const characters = Array.from(escaped);

  if (characters.length <= ESCAPED_TEXT_CAP) {
    return escaped;
  }

  const cut = characters
    .slice(0, ESCAPED_TEXT_CAP - 3)
    .join('')
    .replace(/&(?:lt?|gt?)?$/, '')
    .trimEnd();
  return `${cut}...`;
}

function blockPack(
  packsDirRelative: string,
  manifest: PackManifest,
  hasGuides: boolean
): BlockPack {
  const directories = manifest.outputs.flatMap((output) => {
    const parts = output.kind === 'page' ? output.path.split('/') : [];
    return parts.length > 2 && parts[0] === 'pages' ? [escapeBlockText(parts[1] ?? '')] : [];
  });
  const topics = [...new Set(directories.filter((topic) => topic !== ''))].sort(
    compareStringsByCodeUnit
  );
  const description =
    manifest.recipe.description === null ? '' : escapeBlockText(manifest.recipe.description);

  return {
    label: `${escapeBlockText(manifest.pack.title)} ${escapeBlockText(manifest.pack.version)}`,
    indexPath: `${packsDirRelative}/${manifest.pack.id}/index.md`,
    description: description === '' ? null : description,
    topics: hasGuides && !topics.includes('guides') ? [...topics, 'guides'] : topics,
  };
}

/**
 * The text between the markers (markers excluded), at most `maxBytes` UTF-8
 * bytes, and '' when there are no packs (so `init` and a pack-less `sync`
 * write the same block). Over budget, in order: drop each pack's topics and
 * description from the last pack backwards; then keep the first packs as
 * bare lines and end with `- ...and N more: see <packsDir>/`. Null when not
 * even the heading and that one line fit.
 */
export function renderBlockBody(
  packs: readonly BlockPack[],
  packsDirRelative: string,
  maxBytes: number
): string | null {
  if (packs.length === 0) {
    return '';
  }

  const render = (lines: readonly string[]): string | null => {
    const text = `${[BLOCK_HEADING, '', ...BLOCK_INTRO, '', ...lines].join('\n')}\n`;
    return Buffer.byteLength(text, 'utf-8') <= maxBytes ? text : null;
  };
  const line = (pack: BlockPack, full: boolean): string => {
    const topics = full && pack.topics.length > 0 ? ` (${pack.topics.join(', ')})` : '';
    const description = full && pack.description !== null ? `. ${pack.description}` : '';
    return `- ${pack.label}: \`${pack.indexPath}\`${topics}${description}`;
  };

  const full = packs.map(() => true);
  const withDetails = (): string | null =>
    render(packs.map((pack, index) => line(pack, full[index] === true)));
  let text = withDetails();

  for (let index = packs.length - 1; text === null && index >= 0; index -= 1) {
    full[index] = false;
    text = withDetails();
  }

  for (let kept = packs.length - 1; text === null && kept >= 0; kept -= 1) {
    text = render([
      ...packs.slice(0, kept).map((pack) => line(pack, false)),
      `- ...and ${packs.length - kept} more: see ${packsDirRelative}/`,
    ]);
  }

  return text;
}

/**
 * The block body for the project's built packs: configured packs with a
 * readable manifest, in llm-docs.json order. Agent files get it from
 * `planAgentBlocks`; the session-start hook injects it when the harness's
 * file has no block, so both describe the packs the same way.
 */
export async function blockBody(
  loaded: LoadedProjectConfig,
  packs: readonly ProjectPack[],
  maxBytes: number
): Promise<string | null> {
  const views = await Promise.all(
    packs.flatMap(({ inConfig, dir, manifest: read }) =>
      inConfig && read.kind === 'ok'
        ? [
            listGuides(dir).then((guides) =>
              blockPack(loaded.packsDirRelative, read.manifest, guides.length > 0)
            ),
          ]
        : []
    )
  );
  return renderBlockBody(views, loaded.packsDirRelative, maxBytes);
}

// ---------------------------------------------------------------------------
// Markers and splicing
// ---------------------------------------------------------------------------

/** Where the block sits in an agent file's text, as UTF-16 offsets. */
export type BlockLocation =
  | { kind: 'absent' }
  | { kind: 'present'; start: number; end: number }
  | { kind: 'mismatched'; detail: string };

/**
 * Find the block. Markers count only as whole lines outside fenced and
 * indented code, so a file that documents the marker text is not mistaken
 * for one holding a block. No markers is absent; one BEGIN line followed by
 * one END line is present (`start` at the BEGIN line, `end` after the END
 * line's line break); anything else is mismatched, which is an error and
 * never a guess.
 */
export function locateBlock(text: string): BlockLocation {
  const code = scanMarkdownRegions(text).filter(
    (region) => region.kind === 'fenced-code' || region.kind === 'indented-code'
  );
  const inCode = (offset: number): boolean =>
    code.some((region) => region.start <= offset && offset < region.end);
  const begins: { line: number; start: number }[] = [];
  const ends: { line: number; end: number }[] = [];
  let start = 0;

  for (const [index, raw] of text.split('\n').entries()) {
    const end = Math.min(text.length, start + raw.length + 1);
    const content = raw.endsWith('\r') ? raw.slice(0, -1) : raw;

    if (!inCode(start)) {
      if (BEGIN_LINE.test(content)) {
        begins.push({ line: index + 1, start });
      } else if (END_LINE.test(content)) {
        ends.push({ line: index + 1, end });
      }
    }
    start = end;
  }

  const [begin] = begins;
  const [end] = ends;

  if (begin === undefined && end === undefined) {
    return { kind: 'absent' };
  }
  if (begins.length > 1) {
    return {
      kind: 'mismatched',
      detail: `BEGIN markers on lines ${begins.map((entry) => entry.line).join(', ')}`,
    };
  }
  if (ends.length > 1) {
    return {
      kind: 'mismatched',
      detail: `END markers on lines ${ends.map((entry) => entry.line).join(', ')}`,
    };
  }
  if (begin === undefined) {
    return { kind: 'mismatched', detail: `an END marker on line ${end?.line} without a BEGIN` };
  }
  if (end === undefined) {
    return { kind: 'mismatched', detail: `a BEGIN marker on line ${begin.line} without an END` };
  }
  if (end.end <= begin.start) {
    return {
      kind: 'mismatched',
      detail: `the END marker on line ${end.line} comes before the BEGIN marker on line ${begin.line}`,
    };
  }
  return { kind: 'present', start: begin.start, end: end.end };
}

/**
 * The file text with the block set to `body`: replaced in place when
 * present, appended after one blank line when absent (alone in an empty or
 * new file). The block's line endings follow the file's, and text outside
 * the markers stays byte-identical.
 */
export function spliceBlock(text: string | null, body: string): string {
  const current = text ?? '';
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  const lines = body === '' ? [] : body.replace(/\n$/, '').split('\n');
  const block = `${[BLOCK_BEGIN, ...lines, BLOCK_END].join(eol)}${eol}`;
  const location = locateBlock(current);

  switch (location.kind) {
    case 'present':
      return current.slice(0, location.start) + block + current.slice(location.end);
    case 'mismatched':
      throw new ConfigError(`mismatched llm-docs markers (${location.detail})`);
    case 'absent':
      if (current === '' || /\r?\n\r?\n$/.test(current)) {
        return current + block;
      }
      return current + (/\r?\n$/.test(current) ? eol : eol + eol) + block;
  }
}

// ---------------------------------------------------------------------------
// Plan, apply, check
// ---------------------------------------------------------------------------

/** What sync would do to one agent file; `next === current` means nothing. */
export type AgentBlockPlan =
  | {
      path: string;
      kind: 'planned';
      absolutePath: string;
      current: string | null;
      next: string;
    }
  | { path: string; kind: 'invalid'; error: Error };

/**
 * The single derivation of "what sync would write": resolve the agent files,
 * render the body for the built packs within `block.maxBytes` (markers
 * included), and splice it into each file. A problem with one file
 * (mismatched markers, a link out of the project, an unreadable file)
 * becomes an `invalid` entry, so it never stops another file's block.
 */
export async function planAgentBlocks(loaded: LoadedProjectConfig): Promise<AgentBlockPlan[]> {
  const targets = await resolveAgentFiles(loaded);

  if (targets.length === 0) {
    return [];
  }

  const maxBytes = loaded.config.block?.maxBytes ?? DEFAULT_MAX_BYTES;
  const markerBytes = Buffer.byteLength(`${BLOCK_BEGIN}\n${BLOCK_END}\n`, 'utf-8');
  const body = await blockBody(loaded, await readProjectPacks(loaded), maxBytes - markerBytes);

  return Promise.all(
    targets.map(async (target): Promise<AgentBlockPlan> => {
      if (target.kind === 'invalid') {
        return target;
      }
      if (body === null) {
        return {
          path: target.path,
          kind: 'invalid',
          error: new ConfigError(
            `block.maxBytes ${maxBytes} in ${CONFIG_FILE_NAME} cannot hold the block heading and a one-line pack summary; raise block.maxBytes.`
          ),
        };
      }

      let current: string | null;
      try {
        current = await readTextIfExists(target.absolutePath);
      } catch (error) {
        return { path: target.path, kind: 'invalid', error: new Error(errorMessage(error)) };
      }

      const location = locateBlock(current ?? '');
      if (location.kind === 'mismatched') {
        return {
          path: target.path,
          kind: 'invalid',
          error: new ConfigError(
            `mismatched llm-docs markers (${location.detail}); fix or remove them by hand, then run 'llm-docs sync'.`
          ),
        };
      }

      const next = spliceBlock(current, body);
      // An unclosed code fence would swallow an appended block, and every later sync would append another.
      if (locateBlock(next).kind !== 'present') {
        return {
          path: target.path,
          kind: 'invalid',
          error: new ConfigError(
            `the llm-docs block would land inside an unclosed code block at the end of the file; close the code block, then run 'llm-docs sync'.`
          ),
        };
      }

      return {
        path: target.path,
        kind: 'planned',
        absolutePath: target.absolutePath,
        current,
        next,
      };
    })
  );
}

export type AgentBlockStatus =
  'unchanged' | 'created' | 'updated' | 'would-create' | 'would-update' | 'failed';

/** One agent file's outcome in an init, sync, add, or refresh report. */
export interface AgentBlockOutcome {
  /** Project-relative POSIX path. */
  path: string;
  status: AgentBlockStatus;
  error?: string;
  /** 2 for a problem the user fixes in the file or config, 3 for an I/O failure. */
  exitCode?: 2 | 3;
}

/**
 * Apply the plan: write each file whose text changes (atomically, through
 * its real path), or under `check` write nothing and report `would-*`. A
 * problem with one file is a `failed` outcome, never a throw, so the report
 * and exit code carry it like a failed pack. A second run reports every
 * file `unchanged` and writes nothing.
 */
export async function syncAgentBlocks(
  loaded: LoadedProjectConfig,
  options: { check: boolean }
): Promise<AgentBlockOutcome[]> {
  const failed = (path: string, error: Error): AgentBlockOutcome => ({
    path,
    status: 'failed',
    error: error.message,
    exitCode: error instanceof ConfigError ? 2 : 3,
  });
  const outcomes: AgentBlockOutcome[] = [];

  for (const plan of await planAgentBlocks(loaded)) {
    if (plan.kind === 'invalid') {
      outcomes.push(failed(plan.path, plan.error));
    } else if (plan.next === plan.current) {
      outcomes.push({ path: plan.path, status: 'unchanged' });
    } else if (options.check) {
      outcomes.push({
        path: plan.path,
        status: plan.current === null ? 'would-create' : 'would-update',
      });
    } else {
      try {
        await mkdir(dirname(plan.absolutePath), { recursive: true });
        await writeTextFileSafely(plan.absolutePath, plan.next);
        outcomes.push({ path: plan.path, status: plan.current === null ? 'created' : 'updated' });
      } catch (error) {
        outcomes.push(failed(plan.path, new Error(errorMessage(error))));
      }
    }
  }

  return outcomes;
}

/**
 * verify's project-level `agent-block` check. A target file that does not
 * exist is a warning (sync creates it, and a project may gitignore it); a
 * missing or stale block in an existing file, or an invalid plan, fails.
 */
export async function checkAgentBlocks(loaded: LoadedProjectConfig): Promise<CheckFinding[]> {
  return (await planAgentBlocks(loaded)).flatMap((plan): CheckFinding[] => {
    if (plan.kind === 'invalid') {
      return [{ status: 'fail', path: plan.path, message: plan.error.message }];
    }
    if (plan.current === null) {
      return [
        {
          status: 'warn',
          path: plan.path,
          message: "does not exist; 'llm-docs sync' creates it with the llm-docs block",
        },
      ];
    }
    if (locateBlock(plan.current).kind === 'absent') {
      return [
        {
          status: 'fail',
          path: plan.path,
          message: "has no llm-docs block; run 'llm-docs sync' to add it",
        },
      ];
    }
    return plan.next === plan.current
      ? []
      : [
          {
            status: 'fail',
            path: plan.path,
            message: "the llm-docs block differs from what sync would write; run 'llm-docs sync'",
          },
        ];
  });
}
