import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { isNonEmptyString, isRecord } from '../../src/utils/guards.js';
import { readJsonFile } from '../../src/utils/json.js';
import { type CaseKind, PACK_CACHE_DIR } from './cases.js';
import type { SessionStartHook } from './transcript.js';

/**
 * The note the plugin's session-start hook must give the agent in a case's workspace. prepare-packs
 * computes it by running the bundled hook in that workspace layout, and the plugin arm proves the
 * session got exactly this text: a hook that missed its deadline prints nothing, and one that
 * resolved another model prints another cutoff, and either would grade a plugin run without the
 * plugin's treatment.
 */
export interface ExpectedHookNote {
  /** The evaluated model, given to the hook as `ANTHROPIC_MODEL`. */
  model: string;
  /** sha256 of the plugin's `bin/llm-docs.mjs`, the hook that produced the note. */
  pluginBundle: string;
  note: string;
}

/** Beside the prepared pack, so preparing the pack again removes a note computed for the old one. */
export function hookNotePath(caseId: string): string {
  return join(PACK_CACHE_DIR, caseId, 'expected-hook-note.json');
}

export async function readExpectedHookNote(caseId: string): Promise<ExpectedHookNote | null> {
  const path = hookNotePath(caseId);
  const raw = existsSync(path) ? await readJsonFile(path) : null;
  return isRecord(raw) &&
    isNonEmptyString(raw.model) &&
    isNonEmptyString(raw.pluginBundle) &&
    isNonEmptyString(raw.note)
    ? { model: raw.model, pluginBundle: raw.pluginBundle, note: raw.note }
    : null;
}

/** How many times prepare-packs runs the hook to get two consecutive equal, non-empty outputs. */
export const HOOK_NOTE_ATTEMPTS = 5;

/**
 * Runs the hook until two consecutive runs print the same non-empty note, at most
 * HOOK_NOTE_ATTEMPTS times. A loaded machine can make a run miss the hook's deadline (it then
 * prints nothing), so one run is not proof of what the hook says.
 */
export async function settleHookNote(
  runHook: () => Promise<string>
): Promise<{ note: string } | { outputs: string[] }> {
  const outputs: string[] = [];
  for (let attempt = 0; attempt < HOOK_NOTE_ATTEMPTS; attempt += 1) {
    const output = await runHook();
    if (output !== '' && output === outputs.at(-1)) {
      return { note: output };
    }
    outputs.push(output);
  }
  return { outputs };
}

/* ------------------------------------------------------------------------------------------ */
/* What the note must say                                                                     */
/* ------------------------------------------------------------------------------------------ */

export interface NoteExpectation {
  kind: CaseKind;
  packId: string;
  /** The case's library (`case.json` `library.name`). */
  library: string;
  /** The dependency the pack is bound to. */
  boundDependency: string | null;
  /** The fixture's direct dependencies, each with whether its repository is a pack source's. */
  dependencies: ReadonlyArray<{ name: string; sharesPackRepository: boolean }>;
}

type NoteSection = 'pinned' | 'unpinned' | 'other';

/** The note's list rows, each with the section its heading opened (`formatStatusBrief`). */
function noteRows(note: string): Array<{ section: NoteSection; line: string }> {
  const rows: Array<{ section: NoteSection; line: string }> = [];
  let section: NoteSection = 'other';
  for (const line of note.split('\n')) {
    if (line.startsWith('- ')) {
      rows.push({ section, line });
    } else if (line.startsWith('Pinned docs for libraries released')) {
      section = 'pinned';
    } else if (
      line.startsWith('Direct dependencies released') ||
      line.startsWith('Recently released dependencies')
    ) {
      section = 'unpinned';
    } else if (line.trim() !== '') {
      section = 'other';
    }
  }
  return rows;
}

/**
 * What the expected note says wrong about the case's own pack, as failures (a mis-bound pack
 * recipe) and warnings. A post-cutoff case's note must list its pack as pinned docs for a library
 * released after the cutoff. No note may list the case's library, or the pack's bound dependency,
 * among the dependencies with no pinned docs. A dependency that comes from one of the pack's source
 * repositories but is not the one the pack binds is listed there because a pack binds a single
 * dependency today; that is a warning, not a failure, until a pack can cover several.
 */
export function expectedNoteProblems(
  note: string,
  expectation: NoteExpectation
): { failures: string[]; warnings: string[] } {
  const failures: string[] = [];
  const warnings: string[] = [];
  const rows = noteRows(note);
  const index = `\`agent-docs/${expectation.packId}/index.md\``;

  if (expectation.kind === 'post-cutoff') {
    const packRows = rows.filter((row) => row.line.includes(index));
    const pinned = packRows.some(
      (row) => row.section === 'pinned' && row.line.includes(', after cutoff)')
    );
    if (!pinned) {
      failures.push(
        `the note does not list ${index} as pinned docs for a library released after the cutoff: ${packRows.map((row) => `"${row.line}"`).join(', ') || 'no line names it'}`
      );
    }
  }

  for (const dependency of expectation.dependencies) {
    // The hook escapes names for an agent file: `@` and backticks are dropped.
    const shown = dependency.name.replace(/[`@]/g, '');
    const row = rows.find(
      (candidate) => candidate.section === 'unpinned' && candidate.line.startsWith(`- ${shown} `)
    );
    if (row === undefined) {
      continue;
    }
    if (dependency.sharesPackRepository && dependency.name !== expectation.boundDependency) {
      warnings.push(
        `${dependency.name} comes from the pack's repository but the pack binds ${String(expectation.boundDependency)}, so the note lists it with no pinned docs: "${row.line}"`
      );
    } else if (
      dependency.name === expectation.library ||
      dependency.name === expectation.boundDependency
    ) {
      failures.push(`the note says the case's own library has no pinned docs: "${row.line}"`);
    }
  }
  return { failures, warnings };
}

/* ------------------------------------------------------------------------------------------ */
/* What the session got                                                                       */
/* ------------------------------------------------------------------------------------------ */

export interface HookNoteCheck {
  verdict: 'match' | 'empty' | 'different';
  expected: string;
  /** What the session's SessionStart hooks gave the agent, joined. */
  actual: string;
}

export function checkHookNote(expected: string, hooks: readonly SessionStartHook[]): HookNoteCheck {
  const actual = hooks
    .filter((hook) => hook.outcome === 'success' && hook.output !== '')
    .map((hook) => hook.output)
    .join('\n\n');
  const verdict = actual === '' ? 'empty' : actual === expected ? 'match' : 'different';
  return { verdict, expected, actual };
}
