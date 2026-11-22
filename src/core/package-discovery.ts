/**
 * `discover --package` (spec 10): read-only evidence about where a package's
 * docs live. Registry metadata, the git tags that match the version, and, at
 * the first exact tag, the directories holding Markdown and the files that
 * describe change. The planner reads the evidence and writes the recipe;
 * nothing here chooses a source or a page to read first.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';

import { ConfigError } from '../config/project.js';
import { ECOSYSTEMS, type Ecosystem } from '../deps/lockfiles.js';
import {
  fetchPackageMetadata,
  type PackageMetadataLookup,
  type RegistryEndpoints,
} from '../deps/registries.js';
import {
  assertRepositoryAllowed,
  createGitRunner,
  fetchCommit,
  GitError,
  parseTree,
  type GitRunner,
  type TreeEntry,
} from '../sources/git.js';
import { createHttpClient, redactUrl } from '../sources/http.js';
import { errorMessage } from '../utils/guards.js';
import { compareStringsByCodeUnit } from '../utils/sort.js';
import { isSkippedTraversalDirectory } from '../utils/traversal.js';

const DOC_DIRECTORY_LIMIT = 10;
const CHANGE_DOCUMENT_LIMIT = 20;
/** Matched tags whose commits are fetched to read their dates; exact forms come first. */
const DATED_TAG_LIMIT = 10;
/** A release is tagged and published within days; a wider gap suggests another release's tag. */
const TAG_PUBLISH_GAP_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/;
const NAME_PATTERN = /^@?[A-Za-z0-9][A-Za-z0-9._~/-]*$/;

export interface PackageSpec {
  ecosystem: Ecosystem;
  /** The registry name; for swiftpm, the repository URL. */
  name: string;
  version: string | undefined;
}

export type TagForm = 'v-prefixed' | 'bare' | 'name-at' | 'name-dash-v' | 'directory' | 'suffix';

export interface TagMatch {
  tag: string;
  /** How the tag names the version; every form but `suffix` is exact. */
  form: TagForm;
  commit: string;
}

export interface DatedTagMatch extends TagMatch {
  /**
   * The commit's committer date (ISO 8601), not its author or tag date; null
   * when it was not read, which a warning explains.
   */
  committerDate: string | null;
}

export interface MarkdownDirectory {
  path: string;
  /** `.md` and `.mdx` files anywhere under the directory. */
  markdownFiles: number;
}

export interface ChangeDocument {
  path: string;
  /** The name pattern its file name or a directory matched, such as `changelog` or `migration`. */
  pattern: ChangeDocumentPattern;
}

export type ChangeDocumentEvidence =
  | {
      status: 'listed';
      tag: string;
      commit: string;
      documents: ChangeDocument[];
      /** Matches past the first CHANGE_DOCUMENT_LIMIT, which are not listed. */
      more: number;
    }
  | { status: 'skipped'; reason: string };

export type RegistryEvidence = PackageMetadataLookup | { status: 'not-applicable'; reason: string };

export type RepositoryEvidence =
  | { status: 'ok'; url: string; directory: string | null }
  | { status: 'missing'; reason: string }
  | { status: 'refused'; declared: string; reason: string };

export type TagEvidence =
  | { status: 'matched'; tagCount: number; matches: DatedTagMatch[] }
  | { status: 'no-match'; tagCount: number }
  | { status: 'unreachable'; error: string }
  | { status: 'skipped'; reason: string };

export type DocDirectoryEvidence =
  | {
      status: 'listed';
      tag: string;
      commit: string;
      markdownFiles: number;
      directories: MarkdownDirectory[];
    }
  | { status: 'failed'; tag: string; error: string }
  | { status: 'skipped'; reason: string };

export interface PackageDiscovery {
  package: {
    ecosystem: Ecosystem;
    name: string;
    requestedVersion: string | null;
    /** The version every piece of evidence below is about. */
    version: string | null;
    versionSource: 'requested' | 'registry-latest' | 'latest-tag' | null;
  };
  registry: RegistryEvidence;
  repository: RepositoryEvidence;
  tags: TagEvidence;
  docDirectories: DocDirectoryEvidence;
  changeDocuments: ChangeDocumentEvidence;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** Parse `<ecosystem>:<name>[@<version>]`; swiftpm names are https:// or file:// URLs. */
export function parsePackageSpec(value: string): PackageSpec {
  const separator = value.indexOf(':');
  const ecosystem = ECOSYSTEMS.find((entry) => entry === value.slice(0, separator));
  const rest = value.slice(separator + 1);

  if (separator <= 0 || ecosystem === undefined || rest === '') {
    throw new ConfigError(
      `--package must be <ecosystem>:<name>[@<version>] with an ecosystem of ${ECOSYSTEMS.join(', ')}; got "${value}".`
    );
  }

  const at = rest.lastIndexOf('@');
  // A scoped npm name starts with '@'; a URL's '@' before its path is userinfo, not a version.
  const hasVersion = ecosystem === 'swiftpm' ? at > rest.lastIndexOf('/') : at > 0;
  const name = hasVersion ? rest.slice(0, at) : rest;
  const version = hasVersion ? rest.slice(at + 1) : undefined;

  if (version !== undefined && !VERSION_PATTERN.test(version)) {
    throw new ConfigError(
      `--package version "${version}" is not a version (letters, digits, ".", "+", "_", "-"); write it as it appears in the registry.`
    );
  }

  if (ecosystem === 'swiftpm') {
    let url: URL;
    try {
      url = new URL(name);
    } catch {
      throw new ConfigError(
        `--package swiftpm:<repository url> needs an https:// or file:// URL; got "${redactUrl(name)}".`
      );
    }
    if ((url.protocol !== 'https:' && url.protocol !== 'file:') || url.username !== '') {
      throw new ConfigError(
        `--package swiftpm:<repository url> needs an https:// or file:// URL without credentials; got "${redactUrl(name)}".`
      );
    }
    return { ecosystem, name, version };
  }

  if (!NAME_PATTERN.test(name) || name.split('/').some((segment) => /^\.{0,2}$/.test(segment))) {
    throw new ConfigError(
      `--package name "${name}" is not a valid ${ecosystem} package name; write it as the ${ecosystem} registry spells it.`
    );
  }

  return { ecosystem, name, version };
}

// ---------------------------------------------------------------------------
// Repository URLs from registry metadata (untrusted)
// ---------------------------------------------------------------------------

/** Hosts whose repositories are always `/<owner>/<repo>`; deeper paths are views inside one. */
const OWNER_REPO_HOSTS = new Set(['github.com', 'bitbucket.org', 'codeberg.org']);

/**
 * A declared repository as an https:// clone URL (plus a directory when the
 * URL points inside the repository), or why it is refused. Handles
 * `git+https://`, `git+ssh://`, `ssh://`, `git://`, `http://`, scp-style
 * `git@host:owner/repo`, trailing `.git`, and forge `tree/<ref>/<dir>` links.
 */
export function normalizeRepositoryUrl(
  declared: string
): { url: string; directory: string | null } | { refused: string } {
  let value = declared.trim().replace(/^git\+/i, '');
  const scp = /^(?:[\w.-]+@)?([\w-]+(?:\.[\w-]+)+):(?!\/\/)(.+)$/.exec(value);

  if (scp !== null) {
    value = `https://${scp[1] ?? ''}/${(scp[2] ?? '').replace(/^\/+/, '')}`;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { refused: `"${redactUrl(declared)}" is not a URL.` };
  }

  if (!['https:', 'http:', 'git:', 'ssh:'].includes(url.protocol)) {
    return {
      refused: `"${redactUrl(declared)}" uses ${url.protocol}; only repositories reachable over https:// are inspected.`,
    };
  }

  const segments = url.pathname.split('/').filter((segment) => segment !== '');
  const host = url.hostname.toLowerCase();
  let directory: string | null = null;
  let path = segments;

  if (OWNER_REPO_HOSTS.has(host)) {
    if (segments.length < 2) {
      return { refused: `"${redactUrl(declared)}" does not name a repository on ${host}.` };
    }
    path = segments.slice(0, 2);
    if ((segments[2] === 'tree' || segments[2] === 'blob') && segments.length > 4) {
      directory = segments.slice(4).join('/');
    }
  } else if (host === 'gitlab.com' && segments.includes('-')) {
    path = segments.slice(0, segments.indexOf('-'));
  }

  const repoPath = path.join('/').replace(/\.git$/i, '');
  if (repoPath === '') {
    return { refused: `"${redactUrl(declared)}" does not name a repository.` };
  }

  return { url: `https://${url.host}/${repoPath}`, directory };
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

/** Every tag with the commit it names (annotated tags peeled), from `git ls-remote --tags`. */
function parseRemoteTags(output: string): Map<string, string> {
  const tags = new Map<string, string>();

  for (const line of output.split('\n')) {
    const match = /^([0-9a-f]{40,64})\trefs\/tags\/(.+?)(\^\{\})?$/.exec(line.trim());
    const sha = match?.[1];
    const name = match?.[2];

    if (sha !== undefined && name !== undefined && (match?.[3] !== undefined || !tags.has(name))) {
      tags.set(name, sha);
    }
  }

  return tags;
}

/**
 * The tags that name `version`: exact forms first in a fixed order (`v1.2.3`,
 * `1.2.3`, `<name>@1.2.3`, `<name>-v1.2.3`, `<directory>/v1.2.3`), then every
 * other tag ending in the version at a separator (monorepo forms such as
 * `@scope/pkg@1.2.3` or `release-1.2.3`), sorted.
 */
export function matchVersionTags(
  tags: ReadonlyMap<string, string>,
  version: string,
  name: string,
  directory: string | null
): TagMatch[] {
  const bare = version.replace(/^v(?=\d)/, '');
  const exact: [string, TagForm][] = [
    [`v${bare}`, 'v-prefixed'],
    [bare, 'bare'],
    [`${name}@${bare}`, 'name-at'],
    [`${name}-v${bare}`, 'name-dash-v'],
    ...(directory === null ? [] : [[`${directory}/v${bare}`, 'directory'] as [string, TagForm]]),
  ];
  const matches: TagMatch[] = [];
  const seen = new Set<string>();

  for (const [tag, form] of exact) {
    const commit = tags.get(tag);
    if (commit !== undefined && !seen.has(tag)) {
      seen.add(tag);
      matches.push({ tag, form, commit });
    }
  }

  const isSeparator = (character: string | undefined) =>
    character !== undefined && '@/-_'.includes(character);
  const suffixes = [...tags]
    .filter(([tag]) => {
      if (seen.has(tag) || !tag.endsWith(bare) || tag.length === bare.length) {
        return false;
      }
      const prefix = tag.slice(0, -bare.length);
      const last = prefix.at(-1);
      return (
        isSeparator(last) || (last === 'v' && (prefix.length === 1 || isSeparator(prefix.at(-2))))
      );
    })
    .sort(([a], [b]) => compareStringsByCodeUnit(a, b));

  for (const [tag, commit] of suffixes) {
    matches.push({ tag, form: 'suffix', commit });
  }

  return matches;
}

/** SwiftPM versions are semver tags; with no version asked for, the highest release tag stands in. */
export function latestSemverTag(tags: ReadonlyMap<string, string>): string | null {
  let best: { tag: string; parts: number[] } | null = null;

  for (const tag of tags.keys()) {
    const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag);
    if (match === null) {
      continue;
    }
    const parts = match.slice(1).map(Number);
    const current = best?.parts ?? [];
    const differs = parts.findIndex((part, index) => part !== current[index]);
    // On a tie (`1.2.3` and `v1.2.3`) the first-seen tag stays.
    if (best === null || (differs !== -1 && (parts[differs] ?? 0) > (current[differs] ?? 0))) {
      best = { tag, parts };
    }
  }

  return best?.tag ?? null;
}

// ---------------------------------------------------------------------------
// Markdown directories
// ---------------------------------------------------------------------------

/**
 * Directories ranked by how many `.md` and `.mdx` files they hold at any
 * depth. Hidden paths (`.github`, `.changeset`) are skipped, and a directory
 * whose count equals one child's is dropped in favor of that child.
 */
export function rankMarkdownDirectories(entries: readonly TreeEntry[]): {
  markdownFiles: number;
  directories: MarkdownDirectory[];
} {
  const counts = new Map<string, number>();
  let markdownFiles = 0;

  for (const entry of entries) {
    const segments = entry.path.split('/');
    if (
      entry.type !== 'blob' ||
      entry.mode === '120000' ||
      !/\.mdx?$/i.test(entry.path) ||
      segments.some((segment) => segment.startsWith('.'))
    ) {
      continue;
    }
    markdownFiles += 1;
    for (let depth = 1; depth < segments.length; depth += 1) {
      const directory = segments.slice(0, depth).join('/');
      counts.set(directory, (counts.get(directory) ?? 0) + 1);
    }
  }

  const redundant = new Set<string>();
  for (const [directory, count] of counts) {
    const parent = posix.dirname(directory);
    if (parent !== '.' && counts.get(parent) === count) {
      redundant.add(parent);
    }
  }

  const directories = [...counts]
    .filter(([path]) => !redundant.has(path))
    .map(([path, count]) => ({ path, markdownFiles: count }))
    .sort((a, b) => b.markdownFiles - a.markdownFiles || compareStringsByCodeUnit(a.path, b.path))
    .slice(0, DOC_DIRECTORY_LIMIT);

  return { markdownFiles, directories };
}

// ---------------------------------------------------------------------------
// Change documents
// ---------------------------------------------------------------------------

/**
 * Names of files that describe change, as word sequences: a file name or a
 * directory matches when its words (split at punctuation and camelCase,
 * lowercased) contain the sequence. Each reports its pattern name.
 */
const CHANGE_DOCUMENT_PATTERNS = [
  { pattern: 'changelog', words: ['changelog'] },
  { pattern: 'changes', words: ['changes'] },
  { pattern: 'history', words: ['history'] },
  { pattern: 'releases', words: ['releases'] },
  { pattern: 'release-notes', words: ['release', 'notes'] },
  { pattern: 'migration', words: ['migration'] },
  { pattern: 'migrating', words: ['migrating'] },
  { pattern: 'migrate', words: ['migrate'] },
  { pattern: 'upgrade', words: ['upgrade'] },
  { pattern: 'upgrading', words: ['upgrading'] },
  { pattern: 'breaking', words: ['breaking'] },
  { pattern: 'whats-new', words: ['whats', 'new'] },
  { pattern: 'whats-new', words: ['what', 's', 'new'] },
] as const;

export type ChangeDocumentPattern = (typeof CHANGE_DOCUMENT_PATTERNS)[number]['pattern'];

const CHANGE_DOCUMENT_EXTENSION = /\.(?:md|mdx|rst|txt)$/i;

function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '');
}

function containsWords(words: readonly string[], sequence: readonly string[]): boolean {
  return words.some((_, start) => sequence.every((word, offset) => words[start + offset] === word));
}

/** The pattern a file's name, else its nearest matching directory, matches; undefined for none. */
export function changeDocumentPattern(path: string): ChangeDocumentPattern | undefined {
  const segments = path.split('/');
  const name = segments.at(-1) ?? '';

  if (!CHANGE_DOCUMENT_EXTENSION.test(name)) {
    return undefined;
  }

  const names = [name.replace(CHANGE_DOCUMENT_EXTENSION, ''), ...segments.slice(0, -1).reverse()];
  for (const candidate of names) {
    const words = nameWords(candidate);
    const match = CHANGE_DOCUMENT_PATTERNS.find((entry) => containsWords(words, entry.words));
    if (match !== undefined) {
      return match.pattern;
    }
  }

  return undefined;
}

/**
 * Files whose name or directory says they describe change (changelogs,
 * release notes, migration and upgrade guides), shallowest first, then by
 * path; at most CHANGE_DOCUMENT_LIMIT, with a count of the rest. Hidden
 * paths, vendored and build directories, and symlinks are skipped. Evidence
 * only: which one an agent should read first is the planner's call.
 */
export function findChangeDocuments(entries: readonly TreeEntry[]): {
  documents: ChangeDocument[];
  more: number;
} {
  const documents: ChangeDocument[] = [];

  for (const entry of entries) {
    const segments = entry.path.split('/');
    if (
      entry.type !== 'blob' ||
      entry.mode === '120000' ||
      segments.some((segment) => segment.startsWith('.')) ||
      segments.slice(0, -1).some(isSkippedTraversalDirectory)
    ) {
      continue;
    }
    const pattern = changeDocumentPattern(entry.path);
    if (pattern !== undefined) {
      documents.push({ path: entry.path, pattern });
    }
  }

  documents.sort(
    (a, b) =>
      a.path.split('/').length - b.path.split('/').length ||
      compareStringsByCodeUnit(a.path, b.path)
  );

  return {
    documents: documents.slice(0, CHANGE_DOCUMENT_LIMIT),
    more: Math.max(0, documents.length - CHANGE_DOCUMENT_LIMIT),
  };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface DiscoverPackageOptions {
  /** Registry endpoint overrides (tests point them at a local server). */
  endpoints?: Partial<RegistryEndpoints>;
}

const skipped = (reason: string): { status: 'skipped'; reason: string } => ({
  status: 'skipped',
  reason,
});

/**
 * Gather the evidence. A package, version, repository, or tag that cannot be
 * found is recorded in the result; only an unreachable registry throws.
 */
export async function discoverPackage(
  spec: PackageSpec,
  options: DiscoverPackageOptions = {}
): Promise<PackageDiscovery> {
  const warnings: string[] = [];
  const result: PackageDiscovery = {
    package: {
      ecosystem: spec.ecosystem,
      name: spec.name,
      requestedVersion: spec.version ?? null,
      version: spec.version ?? null,
      versionSource: spec.version === undefined ? null : 'requested',
    },
    registry: {
      status: 'not-applicable',
      reason: 'A SwiftPM package is identified by its repository URL; there is no registry.',
    },
    // Every path that leaves the repository missing replaces this with its own reason.
    repository: { status: 'missing', reason: 'No repository was looked up.' },
    tags: skipped('There is no repository to read tags from.'),
    docDirectories: skipped('No tag was matched.'),
    // Listed only from the same tree as docDirectories; its reason says why there is none.
    changeDocuments: skipped('No tree was listed at a matched tag; see docDirectories.'),
    warnings,
  };
  let declared: { url: string; directory: string | null };

  if (spec.ecosystem === 'swiftpm') {
    declared = { url: spec.name, directory: null };
  } else {
    const client = createHttpClient();
    const fetched = await fetchPackageMetadata(
      { ecosystem: spec.ecosystem, name: spec.name, version: spec.version },
      options.endpoints === undefined ? { client } : { client, endpoints: options.endpoints }
    ).finally(() => client.close());
    const lookup = fetched.lookup;
    warnings.push(...fetched.warnings);
    result.registry = lookup;

    if (lookup.status === 'package-not-found') {
      result.repository = {
        status: 'missing',
        reason: `${lookup.source} has no package ${spec.ecosystem}:${spec.name}; check the name against the registry's spelling.`,
      };
      return result;
    }
    if (lookup.status === 'version-not-found') {
      result.repository = {
        status: 'missing',
        reason: `${lookup.source} has no version ${spec.version ?? ''} of ${spec.name}${lookup.latestVersion === null ? '' : `; the latest is ${lookup.latestVersion}`}.`,
      };
      return result;
    }

    result.package.version = lookup.metadata.version;
    result.package.versionSource = spec.version === undefined ? 'registry-latest' : 'requested';
    if (lookup.metadata.repository === null) {
      result.repository = {
        status: 'missing',
        reason: `${lookup.source} names no repository for ${spec.name} ${lookup.metadata.version}, so no tags were read; this tool cannot tell where its source lives.`,
      };
      return result;
    }
    declared = lookup.metadata.repository;
  }

  const normalized =
    spec.ecosystem === 'swiftpm'
      ? { url: spec.name, directory: null }
      : normalizeRepositoryUrl(declared.url);

  if ('refused' in normalized) {
    result.repository = { status: 'refused', declared: declared.url, reason: normalized.refused };
    return result;
  }

  const repoUrl = new URL(normalized.url);
  try {
    await assertRepositoryAllowed(repoUrl);
  } catch (error) {
    if (error instanceof ConfigError) {
      result.repository = {
        status: 'refused',
        declared: declared.url,
        reason: errorMessage(error),
      };
      return result;
    }
    result.repository = { status: 'ok', url: normalized.url, directory: null };
    result.tags = { status: 'unreachable', error: errorMessage(error) };
    result.docDirectories = skipped(`${normalized.url} could not be reached; see tags.error.`);
    return result;
  }

  const directory = declared.directory ?? normalized.directory;
  result.repository = { status: 'ok', url: normalized.url, directory };
  const tagName =
    spec.ecosystem === 'swiftpm'
      ? posix.basename(repoUrl.pathname).replace(/\.git$/i, '')
      : spec.name;
  const workDir = await mkdtemp(join(tmpdir(), 'llm-docs-discover-'));

  try {
    const git = await createGitRunner(workDir, repoUrl);
    let tags: Map<string, string>;

    try {
      tags = parseRemoteTags(await git(['ls-remote', '--tags', normalized.url]));
    } catch (error) {
      if (!(error instanceof GitError)) {
        throw error;
      }
      result.tags = { status: 'unreachable', error: errorMessage(error) };
      result.docDirectories = skipped(`${normalized.url} could not be reached; see tags.error.`);
      return result;
    }

    let version = result.package.version;
    if (version === null) {
      version = latestSemverTag(tags)?.replace(/^v/, '') ?? null;
      result.package.version = version;
      result.package.versionSource = version === null ? null : 'latest-tag';
    }

    const matches = version === null ? [] : matchVersionTags(tags, version, tagName, directory);
    const [first] = matches;
    if (version === null || first === undefined) {
      result.tags = { status: 'no-match', tagCount: tags.size };
      result.docDirectories = skipped(
        version === null
          ? 'No version was given and no tag looks like a release (1.2.3 or v1.2.3); pass --package swiftpm:<url>@<version>.'
          : `None of the ${tags.size} tags names ${version}, so this tool cannot tell which commit was released as ${version}.`
      );
      return result;
    }

    const checkout = join(workDir, 'repository');
    const fetched = await fetchTagCommits(git, checkout, normalized.url, [
      first,
      ...matches.slice(1, DATED_TAG_LIMIT),
    ]);
    const committerDates =
      fetched.status === 'fetched' ? fetched.committerDates : new Map<string, string>();
    result.tags = {
      status: 'matched',
      tagCount: tags.size,
      matches: matches.map((match) => ({
        ...match,
        committerDate: committerDates.get(match.commit) ?? null,
      })),
    };
    if (fetched.status === 'failed') {
      warnings.push(
        `No committer date was read because the commits of the tags matching ${version} could not be fetched (${fetched.error}); run discover again once the repository is reachable.`
      );
    } else {
      const undated = result.tags.matches.filter((match) => match.committerDate === null);
      if (undated.length > 0) {
        warnings.push(
          `${undated.length} of the ${matches.length} tags matching ${version} have committerDate null because their commits were not fetched (only the first ${DATED_TAG_LIMIT} tags' commits are), so they were not compared with the publish date.`
        );
      }
    }

    // matchVersionTags puts exact forms first, so the listed tag is the first fetched.
    const listed = first.form === 'suffix' ? undefined : first;
    if (listed === undefined) {
      result.docDirectories = skipped(
        `Only tags that end in ${version} matched (${matches.map((match) => match.tag).join(', ')}); none has an exact form, so none was listed. Pass the one you mean to 'llm-docs add --git ${normalized.url} --ref <tag>'.`
      );
    } else {
      if (matches.length > 1) {
        warnings.push(
          `${matches.length} tags match ${version}; the directory listing uses ${listed.tag}, the first exact form.`
        );
      }
      const listing =
        fetched.status === 'failed' ? fetched : await listTree(git, checkout, fetched.commit);
      if (listing.status === 'failed') {
        result.docDirectories = { status: 'failed', tag: listed.tag, error: listing.error };
      } else {
        const { commit, tree } = listing;
        const tag = listed.tag;
        result.docDirectories = { status: 'listed', tag, commit, ...rankMarkdownDirectories(tree) };
        result.changeDocuments = { status: 'listed', tag, commit, ...findChangeDocuments(tree) };
      }
    }

    warnings.push(...tagDateWarnings(result));
    return result;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Fetch the tags' commits in one shallow, blobless fetch and read each
 * commit's committer date, keyed by commit. Returns the first tag's commit.
 */
async function fetchTagCommits(
  git: GitRunner,
  checkout: string,
  repo: string,
  tags: readonly [TagMatch, ...TagMatch[]]
): Promise<
  | { status: 'fetched'; commit: string; committerDates: Map<string, string> }
  | { status: 'failed'; error: string }
> {
  const [first, ...rest] = tags;
  try {
    const commit = await fetchCommit(git, checkout, repo, [
      `refs/tags/${first.tag}`,
      ...rest.map((match) => `refs/tags/${match.tag}`),
    ]);
    // --ignore-missing: a tag moved since ls-remote leaves its old commit unfetched and undated.
    const log = await git(
      [
        'log',
        '--no-walk',
        '--ignore-missing',
        '--format=%H %cI',
        ...new Set(tags.map((match) => match.commit)),
      ],
      { cwd: checkout }
    );
    const committerDates = new Map<string, string>();
    for (const line of log.split('\n')) {
      const [sha, date] = line.trim().split(' ');
      if (sha !== undefined && date !== undefined) {
        committerDates.set(sha, date);
      }
    }
    return { status: 'fetched', commit, committerDates };
  } catch (error) {
    if (!(error instanceof GitError)) {
      throw error;
    }
    return { status: 'failed', error: errorMessage(error) };
  }
}

async function listTree(
  git: GitRunner,
  checkout: string,
  commit: string
): Promise<
  { status: 'listed'; commit: string; tree: TreeEntry[] } | { status: 'failed'; error: string }
> {
  try {
    const tree = parseTree(
      await git(['ls-tree', '-r', '-z', '--full-tree', commit], { cwd: checkout })
    );
    return { status: 'listed', commit, tree };
  } catch (error) {
    if (!(error instanceof GitError)) {
      throw error;
    }
    return { status: 'failed', error: errorMessage(error) };
  }
}

/**
 * One warning per tag whose commit is more than TAG_PUBLISH_GAP_DAYS from the
 * registry's publish date for the version: such a tag may be another
 * package's release from the same repository, for example under the
 * package's former name. Nothing is compared when either date is unknown.
 */
export function tagDateWarnings(discovery: PackageDiscovery): string[] {
  const { package: pkg, registry, repository, tags, docDirectories } = discovery;
  if (
    registry.status !== 'found' ||
    registry.metadata.publishedAt === null ||
    repository.status !== 'ok' ||
    tags.status !== 'matched'
  ) {
    return [];
  }

  const publishedAt = registry.metadata.publishedAt;
  const warnings: string[] = [];

  for (const { tag, committerDate } of tags.matches) {
    if (committerDate === null) {
      continue;
    }
    const days = Math.abs(Date.parse(committerDate) - Date.parse(publishedAt)) / DAY_MS;
    if (Number.isNaN(days) || days <= TAG_PUBLISH_GAP_DAYS) {
      continue;
    }
    const listedHere = docDirectories.status === 'listed' && docDirectories.tag === tag;
    warnings.push(
      `Tag ${tag} was committed on ${committerDate.slice(0, 10)} but ${registry.source} published ${pkg.name} ${registry.metadata.version} on ${publishedAt.slice(0, 10)}, ${Math.round(days)} days apart, so the tag${listedHere ? ' (and the docDirectories and changeDocuments listed at it)' : ''} may belong to another package from this repository, such as one under a former name. Check the package manifest at ${tag} before pinning it with 'llm-docs add --git ${repository.url} --ref ${tag}'.`
    );
  }

  return warnings;
}

/** The stderr summary: one line per piece of evidence. */
export function describePackageDiscovery(result: PackageDiscovery): string[] {
  const { package: pkg, registry, repository, tags, docDirectories, changeDocuments } = result;
  const lines = [
    `${pkg.ecosystem}:${pkg.name}@${pkg.version ?? '(no version)'}${pkg.versionSource === null ? '' : ` (${pkg.versionSource})`}`,
  ];

  switch (registry.status) {
    case 'found': {
      const { metadata } = registry;
      lines.push(
        `  registry ${registry.source}: published ${metadata.publishedAt ?? 'unknown'}, license ${metadata.license ?? 'unknown'}, latest ${metadata.latestVersion ?? 'unknown'}`
      );
      break;
    }
    case 'package-not-found':
      lines.push(`  registry ${registry.source}: no such package`);
      break;
    case 'version-not-found':
      lines.push(
        `  registry ${registry.source}: no such version (latest ${registry.latestVersion ?? 'unknown'})`
      );
      break;
    case 'not-applicable':
      break;
  }

  switch (repository.status) {
    case 'ok':
      lines.push(
        `  repository ${repository.url}${repository.directory === null ? '' : ` (directory ${repository.directory})`}`
      );
      break;
    case 'missing':
      lines.push(`  repository: none. ${repository.reason}`);
      break;
    case 'refused':
      lines.push(`  repository refused: ${repository.reason}`);
      break;
  }

  switch (tags.status) {
    case 'matched':
      lines.push(
        `  tags: ${tags.matches
          .map(
            (match) =>
              `${match.tag} (${match.form}, ${match.committerDate === null ? 'committer date not read' : `committed ${match.committerDate}`})`
          )
          .join(', ')}`
      );
      break;
    case 'no-match':
      lines.push(`  tags: none of ${tags.tagCount} match`);
      break;
    case 'unreachable':
      lines.push(`  tags: repository unreachable: ${tags.error}`);
      break;
    case 'skipped':
      break;
  }

  switch (docDirectories.status) {
    case 'listed':
      lines.push(
        `  Markdown at ${docDirectories.tag}: ${docDirectories.markdownFiles} files; ${
          docDirectories.directories.length === 0
            ? 'none inside a directory'
            : docDirectories.directories
                .slice(0, 5)
                .map((directory) => `${directory.path} (${directory.markdownFiles})`)
                .join(', ')
        }`
      );
      break;
    case 'failed':
      lines.push(`  Markdown at ${docDirectories.tag}: listing failed: ${docDirectories.error}`);
      break;
    case 'skipped':
      if (tags.status === 'matched' || tags.status === 'no-match') {
        lines.push(`  Markdown directories: ${docDirectories.reason}`);
      }
      break;
  }

  if (changeDocuments.status === 'listed') {
    const { documents, more } = changeDocuments;
    const shown = documents
      .slice(0, 5)
      .map((document) => `${document.path} (${document.pattern})`)
      .join(', ');
    const rest = documents.length + more - Math.min(documents.length, 5);
    lines.push(
      `  change documents at ${changeDocuments.tag}: ${
        documents.length === 0 ? 'none' : `${shown}${rest > 0 ? `, and ${rest} more` : ''}`
      }`
    );
  }

  for (const warning of result.warnings) {
    lines.push(`  warning: ${warning}`);
  }

  return lines;
}
