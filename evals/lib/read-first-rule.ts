import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type ChangeDocument,
  type ChangeDocumentPattern,
  discoverPackage,
  findChangeDocuments,
  parsePackageSpec,
} from '../../src/core/package-discovery.js';
import { createGitRunner, fetchCommit, parseTree } from '../../src/sources/git.js';
import { isNonEmptyString, isRecord } from '../../src/utils/guards.js';
import { readJsonFile, writeJsonFileSafely } from '../../src/utils/json.js';
import { compareStringsByCodeUnit } from '../../src/utils/sort.js';
import { CACHE_DIR, type EvalCase, PACK_CACHE_DIR, PREPARED_STAMP } from './cases.js';

/**
 * The read-first rule: every case's `readFirst` is computed from evidence, never chosen by hand,
 * so no entry can be aimed at a task's answer. The change documents discover lists (or, for a
 * recipe whose source is not the library's repository, the ones in that source by the same name
 * patterns) are taken into the pack, ordered by kind, and the first three become whole-page
 * read-first targets. evals/README.md states the rule in full.
 */

const READ_FIRST_LIMIT = 3;

/** Lower groups come first: migration and upgrade guides, then breaking, what's new, release notes, changelogs. */
const PATTERN_GROUP: Record<ChangeDocumentPattern, number> = {
  migration: 0,
  migrating: 0,
  migrate: 0,
  upgrade: 0,
  upgrading: 0,
  breaking: 1,
  'whats-new': 2,
  'release-notes': 3,
  releases: 3,
  changelog: 4,
  changes: 4,
  history: 4,
};

function isChangeDocumentPattern(value: unknown): value is ChangeDocumentPattern {
  return typeof value === 'string' && Object.hasOwn(PATTERN_GROUP, value);
}

/**
 * The forms in which a path names a major version: `v<N>` (also inside a segment such as
 * `docs-v3`), `<N>.x`, `-<N>`, and a range `v<A>-to-v<B>` or `<A>-to-<B>`, each number with no
 * digit after it. The range form adds `<A>`; the other forms already find `v<A>` and `-<B>`.
 */
const MAJOR_FORMS = [
  /(?<![a-z0-9])v(\d+)(?![0-9])/gi,
  /(?<![0-9.])(\d+)\.x(?![a-z0-9])/gi,
  /-(\d+)(?![0-9])/g,
  /(?<![a-z0-9])v?(\d+)-to-v?\d+(?![0-9])/gi,
];

/** A date is not a version: `-07` in `support-2026-07-28.md` names no major. */
const DATE = /\d{4}-\d{2}-\d{2}/g;

/** Every major version a path names, without leading zeros, in order of first appearance. */
export function namedMajors(path: string): string[] {
  const text = path.replace(DATE, ' ');
  const majors = MAJOR_FORMS.flatMap((form) =>
    [...text.matchAll(form)].flatMap((match) =>
      match[1] === undefined ? [] : [String(Number(match[1]))]
    )
  );
  return [...new Set(majors)];
}

export function namesMajor(path: string, major: string): boolean {
  return namedMajors(path).includes(major);
}

/**
 * A guide for another major version is not the page that says what changed on the way to the
 * pinned one, so a path that names majors must name the pinned one. A path naming none stays.
 */
function isForPinnedMajor(path: string, major: string | undefined): boolean {
  const named = namedMajors(path);
  return named.length === 0 || major === undefined || named.includes(major);
}

function depth(path: string): number {
  return path.split('/').length;
}

function orderChangeDocuments(
  documents: readonly ChangeDocument[],
  major: string | undefined
): ChangeDocument[] {
  const namesPinnedMajor = (path: string): number =>
    major !== undefined && namesMajor(path, major) ? 0 : 1;
  return [...documents].sort(
    (a, b) =>
      PATTERN_GROUP[a.pattern] - PATTERN_GROUP[b.pattern] ||
      namesPinnedMajor(a.path) - namesPinnedMajor(b.path) ||
      depth(a.path) - depth(b.path) ||
      compareStringsByCodeUnit(a.path, b.path)
  );
}

function isTaken(path: string, takenPaths: readonly string[]): boolean {
  return takenPaths.some(
    (taken) => taken === '.' || path === taken || path.startsWith(`${taken}/`)
  );
}

interface Candidate extends ChangeDocument {
  /** The pack output the document became, such as `pages/CHANGELOG.md`. */
  page: string;
}

export interface RuleOutput {
  /** Change documents outside every taken path, to add to the recipe as single-file paths. */
  additions: string[];
  /** Change documents that are pages in the built pack, in rule order. */
  candidates: Candidate[];
  /** Whole-page targets, never with a `#fragment`. */
  readFirst: string[];
}

/**
 * The rule itself, pure. `pageOf` maps a repository path to the output the built pack made of
 * it; a document that is taken but not a page (an include glob left it out) is not a candidate.
 */
export function applyReadFirstRule(input: {
  documents: readonly ChangeDocument[];
  takenPaths: readonly string[];
  pageOf: ReadonlyMap<string, string>;
  major: string | undefined;
}): RuleOutput {
  const additions = input.documents
    .map((document) => document.path)
    .filter((path) => !isTaken(path, input.takenPaths))
    .sort(compareStringsByCodeUnit);
  const candidates = orderChangeDocuments(input.documents, input.major).flatMap((document) => {
    const page = input.pageOf.get(document.path);
    return page === undefined || !isForPinnedMajor(document.path, input.major)
      ? []
      : [{ ...document, page }];
  });
  return {
    additions,
    candidates,
    readFirst: candidates.slice(0, READ_FIRST_LIMIT).map((candidate) => candidate.page),
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Evidence                                                                                   */
/* ------------------------------------------------------------------------------------------ */

interface ChangeEvidence {
  /** `discover` for the library's tagged repository; `source listing` for a recipe source elsewhere. */
  via: 'discover' | 'source listing';
  repo: string;
  /** The matched tag, or the recipe's pinned ref. */
  ref: string;
  commit: string;
  documents: ChangeDocument[];
  /** Matches past discover's listing limit, which the rule never sees. */
  more: number;
}

interface GitSource {
  index: number;
  repo: string;
  ref: string;
  paths: string[];
}

function sameRepository(a: string, b: string): boolean {
  const normalize = (url: string): string => url.toLowerCase().replace(/(\.git)?\/?$/, '');
  return normalize(a) === normalize(b);
}

function gitSources(evalCase: EvalCase): GitSource[] {
  const sources = Array.isArray(evalCase.pack.pack.sources) ? evalCase.pack.pack.sources : [];
  return sources.flatMap((source, index) =>
    isRecord(source) &&
    source.type === 'git' &&
    isNonEmptyString(source.repo) &&
    isNonEmptyString(source.ref) &&
    Array.isArray(source.paths) &&
    source.paths.every(isNonEmptyString)
      ? [{ index, repo: source.repo, ref: source.ref, paths: source.paths }]
      : []
  );
}

function parseDocuments(raw: unknown): ChangeDocument[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const documents: ChangeDocument[] = [];
  for (const entry of raw) {
    if (
      !isRecord(entry) ||
      !isNonEmptyString(entry.path) ||
      !isChangeDocumentPattern(entry.pattern)
    ) {
      return undefined;
    }
    documents.push({ path: entry.path, pattern: entry.pattern });
  }
  return documents;
}

/** Discover's JSON (as `llm-docs discover --package` prints it) down to what the rule reads. */
function evidenceFromDiscover(raw: unknown): ChangeEvidence | string {
  if (!isRecord(raw) || !isRecord(raw.repository) || !isRecord(raw.changeDocuments)) {
    return 'discover output has no repository or changeDocuments';
  }
  const { repository, changeDocuments } = raw;
  if (repository.status !== 'ok' || !isNonEmptyString(repository.url)) {
    return `discover found no repository (${String(repository.status)})`;
  }
  if (changeDocuments.status !== 'listed') {
    return `discover listed no change documents: ${String(changeDocuments.reason)}`;
  }
  const documents = parseDocuments(changeDocuments.documents);
  if (
    documents === undefined ||
    !isNonEmptyString(changeDocuments.tag) ||
    !isNonEmptyString(changeDocuments.commit) ||
    typeof changeDocuments.more !== 'number'
  ) {
    return 'discover changeDocuments is malformed';
  }
  return {
    via: 'discover',
    repo: repository.url,
    ref: changeDocuments.tag,
    commit: changeDocuments.commit,
    documents,
    more: changeDocuments.more,
  };
}

function parseSourceListing(raw: unknown): ChangeEvidence | undefined {
  if (
    !isRecord(raw) ||
    raw.via !== 'source listing' ||
    !isNonEmptyString(raw.repo) ||
    !isNonEmptyString(raw.ref) ||
    !isNonEmptyString(raw.commit) ||
    typeof raw.more !== 'number'
  ) {
    return undefined;
  }
  const documents = parseDocuments(raw.documents);
  return documents === undefined
    ? undefined
    : {
        via: 'source listing',
        repo: raw.repo,
        ref: raw.ref,
        commit: raw.commit,
        documents,
        more: raw.more,
      };
}

/** The change documents in a recipe source that is not the library's repository, by discover's patterns. */
async function listSourceChangeDocuments(repo: string, ref: string): Promise<ChangeEvidence> {
  const workDir = await mkdtemp(join(tmpdir(), 'llm-docs-evals-read-first-'));
  try {
    const git = await createGitRunner(workDir, new URL(repo));
    const checkout = join(workDir, 'repository');
    const commit = await fetchCommit(git, checkout, repo, [ref]);
    const tree = parseTree(
      await git(['ls-tree', '-r', '-z', '--full-tree', commit], { cwd: checkout })
    );
    return { via: 'source listing', repo, ref, commit, ...findChangeDocuments(tree) };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export const READ_FIRST_CACHE_DIR = join(CACHE_DIR, 'read-first');

/** Every case's fixture is an npm project (lintCase requires package.json and package-lock.json). */
function packageSpec(evalCase: EvalCase): string {
  return `npm:${evalCase.library.name}@${evalCase.library.version}`;
}

/**
 * The evidence for one case, from `.cache/read-first/<case>.json` when it was fetched for the same
 * package (and the same source repo and ref, for a source listing), otherwise fetched and cached.
 * `refresh` refetches regardless.
 */
async function loadEvidence(
  evalCase: EvalCase,
  refresh: boolean
): Promise<{ evidence: ChangeEvidence; sources: GitSource[] } | string> {
  const cachePath = join(READ_FIRST_CACHE_DIR, `${evalCase.id}.json`);
  const spec = packageSpec(evalCase);
  const cached = !refresh && existsSync(cachePath) ? await readJsonFile(cachePath) : undefined;
  const usable = isRecord(cached) && cached.package === spec ? cached : undefined;

  let fetched = usable?.discover === undefined;
  const discover: unknown = fetched
    ? JSON.parse(JSON.stringify(await discoverPackage(parsePackageSpec(spec))))
    : usable?.discover;
  const fromDiscover = evidenceFromDiscover(discover);
  if (typeof fromDiscover === 'string') {
    return `${spec}: ${fromDiscover}`;
  }

  const all = gitSources(evalCase);
  const onLibraryRepo = all.filter((source) => sameRepository(source.repo, fromDiscover.repo));
  let evidence = fromDiscover;
  let sources = onLibraryRepo;
  let sourceListing: ChangeEvidence | null = null;

  if (onLibraryRepo.length === 0) {
    const [first] = all;
    if (first === undefined) {
      return `no git source in the recipe, and discover's evidence is about ${fromDiscover.repo}`;
    }
    if (first.ref.includes('{')) {
      return `source ${first.repo} has a templated ref (${first.ref}); the rule lists a pinned ref only`;
    }
    const cachedListing = parseSourceListing(usable?.sourceListing);
    if (
      cachedListing !== undefined &&
      sameRepository(cachedListing.repo, first.repo) &&
      cachedListing.ref === first.ref
    ) {
      sourceListing = cachedListing;
    } else {
      sourceListing = await listSourceChangeDocuments(first.repo, first.ref);
      fetched = true;
    }
    evidence = sourceListing;
    sources = all.filter((source) => sameRepository(source.repo, first.repo));
  }

  if (fetched) {
    await mkdir(READ_FIRST_CACHE_DIR, { recursive: true });
    await writeJsonFileSafely(cachePath, { package: spec, discover, sourceListing });
  }
  return { evidence, sources };
}

/* ------------------------------------------------------------------------------------------ */
/* The built pack                                                                             */
/* ------------------------------------------------------------------------------------------ */

function withoutReadFirst(pack: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...pack };
  delete rest.readFirst;
  return rest;
}

/**
 * Repository path to pack output, for files the prepared pack took from `commit`. The pack must
 * have been prepared from the recipe as it stands, `readFirst` aside (it never changes the pages).
 */
async function preparedPages(
  evalCase: EvalCase,
  commit: string
): Promise<Map<string, string> | string> {
  const dir = join(PACK_CACHE_DIR, evalCase.id);
  const stamp = existsSync(join(dir, PREPARED_STAMP))
    ? await readJsonFile(join(dir, PREPARED_STAMP))
    : undefined;
  const stamped: unknown =
    isRecord(stamp) && typeof stamp.pack === 'string' ? JSON.parse(stamp.pack) : undefined;
  if (
    !isRecord(stamped) ||
    !isRecord(stamped.pack) ||
    JSON.stringify(withoutReadFirst(stamped.pack)) !==
      JSON.stringify(withoutReadFirst(evalCase.pack.pack))
  ) {
    return 'the prepared pack is missing or was built from other sources; run prepare-packs';
  }

  const manifest = await readJsonFile(join(dir, 'agent-docs', evalCase.pack.id, 'manifest.json'));
  if (
    !isRecord(manifest) ||
    !Array.isArray(manifest.origins) ||
    !Array.isArray(manifest.sources) ||
    !Array.isArray(manifest.outputs)
  ) {
    return 'the prepared manifest has no origins, sources, or outputs';
  }

  const outputBySource = new Map<string, string>();
  for (const output of manifest.outputs) {
    if (isRecord(output) && isNonEmptyString(output.path) && Array.isArray(output.sources)) {
      for (const source of output.sources) {
        if (typeof source === 'string') {
          outputBySource.set(source, output.path);
        }
      }
    }
  }

  const marker = `/blob/${commit}/`;
  const pages = new Map<string, string>();
  for (const file of manifest.sources) {
    if (!isRecord(file) || typeof file.source !== 'number' || !isNonEmptyString(file.path)) {
      continue;
    }
    const origin: unknown = manifest.origins[file.source];
    if (!isRecord(origin) || origin.type !== 'git' || origin.commit !== commit) {
      continue;
    }
    const url = typeof file.url === 'string' ? file.url : '';
    const at = url.indexOf(marker);
    if (at === -1) {
      return `${file.path} has no repository URL in the manifest, so its repository path is unknown`;
    }
    const repoPath = url
      .slice(at + marker.length)
      .split('/')
      .map(decodeURIComponent)
      .join('/');
    const output = outputBySource.get(`${file.source}:${file.path}`);
    if (output !== undefined) {
      pages.set(repoPath, output);
    }
  }
  return pages;
}

/* ------------------------------------------------------------------------------------------ */
/* Per case                                                                                   */
/* ------------------------------------------------------------------------------------------ */

export type CaseRule =
  | { status: 'cannot-apply'; reason: string }
  | {
      status: 'applied';
      evidence: ChangeEvidence;
      /** The recipe source additions go to: the first git source on the evidence repository. */
      target: GitSource;
      /** Why the built pack's pages are unknown (no pack prepared from this recipe), or null. */
      pagesProblem: string | null;
      output: RuleOutput;
    };

export async function evaluateCase(evalCase: EvalCase, refresh: boolean): Promise<CaseRule> {
  const loaded = await loadEvidence(evalCase, refresh);
  if (typeof loaded === 'string') {
    return { status: 'cannot-apply', reason: loaded };
  }
  const { evidence, sources } = loaded;
  const [target] = sources;
  if (target === undefined) {
    return { status: 'cannot-apply', reason: `no recipe source takes ${evidence.repo}` };
  }
  const takenPaths = sources.flatMap((source) => source.paths);
  if (takenPaths.some((path) => path.includes('{'))) {
    return {
      status: 'cannot-apply',
      reason: 'a taken path has a placeholder; the rule needs literal paths',
    };
  }
  const pages = await preparedPages(evalCase, evidence.commit);
  const major = /^v?(\d+)/.exec(evalCase.library.version)?.[1];
  return {
    status: 'applied',
    evidence,
    target,
    pagesProblem: typeof pages === 'string' ? pages : null,
    output: applyReadFirstRule({
      documents: evidence.documents,
      takenPaths,
      pageOf: typeof pages === 'string' ? new Map() : pages,
      major,
    }),
  };
}

function currentReadFirst(evalCase: EvalCase): unknown {
  return evalCase.pack.pack.readFirst;
}

/** Why the committed pack.json differs from the rule's output, or nothing when it matches. */
export function ruleProblems(evalCase: EvalCase, rule: CaseRule): string[] {
  if (rule.status === 'cannot-apply') {
    return [`the read-first rule cannot be applied: ${rule.reason}`];
  }
  const fix = 'run `npm run eval -- read-first-rule --write`';
  if (rule.output.additions.length > 0) {
    return [
      `pack.json does not take change document(s) ${rule.output.additions.join(', ')}; ${fix}, then prepare-packs, then the rule again`,
    ];
  }
  if (rule.pagesProblem !== null) {
    return [`the read-first rule needs the built pack's pages: ${rule.pagesProblem}`];
  }
  const expected = rule.output.readFirst;
  const actual = currentReadFirst(evalCase);
  const matches =
    expected.length === 0
      ? actual === undefined
      : Array.isArray(actual) &&
        actual.length === expected.length &&
        actual.every((target, index) => target === expected[index]);
  return matches
    ? []
    : [
        `pack.json readFirst is ${JSON.stringify(actual ?? null)}, the read-first rule gives ${JSON.stringify(expected.length === 0 ? null : expected)}; ${fix}`,
      ];
}

/**
 * Writes the rule's output into the case's pack.json and says what it wrote. Additions go in
 * alone and drop `readFirst`, because taking a new path can move every page (the source's common
 * root changes), so the targets are known only once the pack is prepared again.
 */
export async function writeRule(
  evalCase: EvalCase,
  rule: CaseRule
): Promise<'paths' | 'readFirst' | 'nothing'> {
  if (rule.status === 'cannot-apply' || ruleProblems(evalCase, rule).length === 0) {
    return 'nothing';
  }
  const { additions, readFirst } = rule.output;
  const rest = withoutReadFirst(evalCase.pack.pack);
  let pack: Record<string, unknown>;
  if (additions.length > 0) {
    const sources = Array.isArray(rest.sources) ? rest.sources : [];
    pack = {
      ...rest,
      sources: sources.map((source, index) =>
        index === rule.target.index && isRecord(source)
          ? { ...source, paths: [...rule.target.paths, ...additions] }
          : source
      ),
    };
  } else if (rule.pagesProblem !== null) {
    return 'nothing';
  } else {
    pack = readFirst.length > 0 ? { ...rest, readFirst } : rest;
  }
  await writeJsonFileSafely(join(evalCase.dir, 'pack.json'), { id: evalCase.pack.id, pack });
  return additions.length > 0 ? 'paths' : 'readFirst';
}
