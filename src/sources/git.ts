/**
 * Git acquisition (spec 2.3 and 4.1): resolve a ref to a commit, fetch only
 * that commit (shallow, blobless), check out only the taken paths plus the
 * license files at the repository root and at each taken path's root, and
 * report the files with their pinned upstream URLs.
 *
 * Git runs hardened: `execFile` (never a shell), no terminal prompts, no
 * system or user config, no hooks, no symlinks, no submodules, and a
 * protocol allowlist (https, plus file for file:// repositories).
 */

import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';

import { ConfigError, type ResolvedSourceOfType } from '../config/project.js';
import { detectLicense, isLicenseFileName, type LicenseFile } from '../pack/license.js';
import { isSameOrDescendant } from '../utils/fs-path.js';
import { errorMessage } from '../utils/guards.js';
import { sha256File } from '../utils/hash.js';
import { compareStringsByCodeUnit } from '../utils/sort.js';
import {
  createSourceMatcher,
  type AcquireContext,
  type AcquiredFile,
  type SourceAcquisition,
} from './acquire.js';
import { ALLOW_PRIVATE_NETWORK_ENV, redactUrl, resolveAllowedAddress } from './http.js';

const GIT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const LICENSE_MAX_BYTES = 1024 * 1024;

/** A git command that failed at runtime (network, missing binary): exit 3. */
export class GitError extends Error {
  override name = 'GitError';
}

export type RefKind = 'tag' | 'branch' | 'commit';

type GitRunner = (args: readonly string[], options?: { cwd?: string }) => Promise<string>;

/** Environment variables kept from the parent: TLS trust settings a corporate network needs. */
const KEPT_GIT_ENV = new Set(['GIT_SSL_CAINFO', 'GIT_SSL_CAPATH']);

/**
 * A git runner with the spec 4.1 isolation. Every `GIT_*` variable from the
 * parent is dropped (GIT_DIR, GIT_CONFIG_PARAMETERS, GIT_ALLOW_PROTOCOL, and
 * friends would otherwise steer git), and config flags pin the policy.
 */
async function createGitRunner(workDir: string, repo: URL): Promise<GitRunner> {
  const emptyConfig = join(workDir, 'git-empty-config');
  const emptyHooks = join(workDir, 'git-empty-hooks');
  await writeFile(emptyConfig, '');
  await mkdir(emptyHooks, { recursive: true });

  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^GIT_/i.test(key) || KEPT_GIT_ENV.has(key)) {
      env[key] = value;
    }
  }
  delete env.SSH_ASKPASS;
  Object.assign(env, {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_LITERAL_PATHSPECS: '1',
    GCM_INTERACTIVE: 'never',
  });

  const config = [
    // Forward slashes: Git for Windows reads them, and no value escaping applies.
    `core.hooksPath=${emptyHooks.replace(/\\/g, '/')}`,
    'core.symlinks=false',
    'core.fsmonitor=false',
    'protocol.allow=never',
    'protocol.https.allow=always',
    ...(repo.protocol === 'file:' ? ['protocol.file.allow=always'] : []),
    'submodule.recurse=false',
    'fetch.recurseSubmodules=false',
    'advice.detachedHead=false',
  ].flatMap((entry) => ['-c', entry]);

  return (args, options = {}) =>
    new Promise((resolveRun, reject) => {
      execFile(
        'git',
        [...config, ...args],
        {
          cwd: options.cwd ?? workDir,
          env,
          timeout: GIT_COMMAND_TIMEOUT_MS,
          maxBuffer: GIT_MAX_BUFFER,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error === null) {
            resolveRun(stdout);
            return;
          }
          if ('code' in error && error.code === 'ENOENT') {
            reject(
              new GitError(
                'git is not installed or not on PATH; install it (https://git-scm.com/downloads) to use git sources.'
              )
            );
            return;
          }
          const detail = stderr.trim().split('\n').slice(-3).join(' ').trim();
          const reason = error.killed
            ? `timed out after ${GIT_COMMAND_TIMEOUT_MS / 60_000} minutes`
            : detail || errorMessage(error);
          reject(new GitError(`git ${args[0] ?? ''} failed for ${redactUrl(repo)}: ${reason}`));
        }
      );
    });
}

// ---------------------------------------------------------------------------
// Input checks
// ---------------------------------------------------------------------------

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

/** A ref name git accepts and that cannot be mistaken for an option. */
function assertRefName(ref: string): void {
  if (
    !/^[A-Za-z0-9_][A-Za-z0-9._/+-]*$/.test(ref) ||
    ref.includes('..') ||
    ref.includes('//') ||
    ref.endsWith('/') ||
    ref.endsWith('.') ||
    ref.endsWith('.lock')
  ) {
    throw new ConfigError(`git ref "${ref}" is not a valid tag, branch, or 40-hex commit name.`);
  }
}

/** Normalize the taken paths: repository-relative POSIX, no `..`; "." is the whole repository. */
function normalizeTakenPaths(paths: readonly string[]): string[] {
  const normalized = paths.map((path) => {
    const value = posix
      .normalize(path.replace(/\\/g, '/'))
      .replace(/^\.\/+/, '')
      .replace(/\/+$/, '');

    if (
      value.startsWith('/') ||
      value === '..' ||
      value.startsWith('../') ||
      /^[A-Za-z]:/.test(value)
    ) {
      throw new ConfigError(`git path "${path}" must be a relative path inside the repository.`);
    }
    return value === '' ? '.' : value;
  });

  return normalized.includes('.') ? ['.'] : [...new Set(normalized)].sort(compareStringsByCodeUnit);
}

/** `https://github.com/<owner>/<repo>` for a github.com remote, else undefined. */
function githubBase(repo: URL): string | undefined {
  if (repo.protocol !== 'https:' || repo.hostname.toLowerCase() !== 'github.com') {
    return undefined;
  }
  const match = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(repo.pathname);
  return match === null ? undefined : `https://github.com/${match[1]}/${match[2]}`;
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

// ---------------------------------------------------------------------------
// Ref resolution
// ---------------------------------------------------------------------------

export interface ResolvedRef {
  kind: RefKind;
  /** The commit the ref names (tags are peeled), when ls-remote reports one. */
  commit: string;
  /** What to fetch. */
  refspec: string;
}

/** Resolve `ref` with `git ls-remote`: tag (peeled when annotated), then branch, then a commit id. */
async function resolveRef(git: GitRunner, repo: string, ref: string): Promise<ResolvedRef> {
  const tag = `refs/tags/${ref}`;
  const branch = `refs/heads/${ref}`;
  const output = await git(['ls-remote', repo, tag, `${tag}^{}`, branch]);
  const refs = new Map<string, string>();

  for (const line of output.split('\n')) {
    const [sha, name] = line.trim().split(/\s+/);
    if (sha !== undefined && name !== undefined && COMMIT_PATTERN.test(sha)) {
      refs.set(name, sha);
    }
  }

  const tagSha = refs.get(`${tag}^{}`) ?? refs.get(tag);
  if (tagSha !== undefined) {
    return { kind: 'tag', commit: tagSha, refspec: tag };
  }

  const branchSha = refs.get(branch);
  if (branchSha !== undefined) {
    return { kind: 'branch', commit: branchSha, refspec: branch };
  }

  if (COMMIT_PATTERN.test(ref)) {
    return { kind: 'commit', commit: ref, refspec: ref };
  }

  throw new ConfigError(
    `git ref "${ref}" is not a tag or branch of ${redactUrl(repo)}, and not a 40-hex commit id.`
  );
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

/** gitignore-style escaping for a literal path in a sparse-checkout pattern. */
function sparseLiteral(path: string): string {
  return path.replace(/[\\*?[\]!#]/g, (character) => `\\${character}`).replace(/ $/, '\\ ');
}

const LICENSE_GLOBS = ['[Ll][Ii][Cc][Ee][Nn][CcSs][Ee]*', '[Cc][Oo][Pp][Yy][Ii][Nn][Gg]*'];

function sparsePatterns(paths: readonly string[]): string {
  const patterns = [...LICENSE_GLOBS.map((glob) => `/${glob}`)];

  for (const path of paths) {
    patterns.push(`/${sparseLiteral(path)}`);
    patterns.push(...LICENSE_GLOBS.map((glob) => `/${sparseLiteral(path)}/${glob}`));
  }

  return `${patterns.join('\n')}\n`;
}

interface TreeEntry {
  mode: string;
  type: string;
  path: string;
}

function parseTree(output: string): TreeEntry[] {
  return output
    .split('\0')
    .filter((record) => record !== '')
    .map((record) => {
      const tab = record.indexOf('\t');
      const [mode = '', type = ''] = record.slice(0, tab).split(' ');
      return { mode, type, path: record.slice(tab + 1) };
    });
}

/** The deepest directory containing every taken path: origin-relative paths start there. */
function commonRoot(paths: readonly string[], entries: readonly TreeEntry[]): string {
  if (paths.includes('.')) {
    return '';
  }

  const files = new Set(entries.map((entry) => entry.path));
  const directories = paths.map((path) => (files.has(path) ? posix.dirname(path) : path));
  const segments = directories.map((directory) => (directory === '.' ? [] : directory.split('/')));
  const first = segments[0] ?? [];
  let length = first.length;

  for (const other of segments.slice(1)) {
    let shared = 0;
    while (shared < Math.min(length, other.length) && other[shared] === first[shared]) {
      shared += 1;
    }
    length = shared;
  }

  return first.slice(0, length).join('/');
}

function within(path: string, directory: string): boolean {
  return (
    directory === '' || directory === '.' || path === directory || path.startsWith(`${directory}/`)
  );
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function sample(paths: readonly string[]): string {
  return `${paths.slice(0, 5).join(', ')}${paths.length > 5 ? ', ...' : ''}`;
}

export async function acquireGit(
  source: ResolvedSourceOfType<'git'>,
  context: AcquireContext
): Promise<SourceAcquisition> {
  const repoUrl = new URL(source.repo);
  const warnings: string[] = [];

  if (repoUrl.protocol === 'https:') {
    // git resolves the host itself; vet it first so a recipe cannot reach a private network.
    await resolveAllowedAddress(repoUrl, process.env[ALLOW_PRIVATE_NETWORK_ENV] === '1');
  } else if (repoUrl.protocol === 'file:') {
    warnings.push(
      `git source ${source.repo} is a file:// repository: a non-portable origin that only this machine can refresh.`
    );
  } else {
    throw new ConfigError(
      `git repo "${redactUrl(source.repo)}" must be an https:// or file:// URL.`
    );
  }

  assertRefName(source.ref);
  const paths = normalizeTakenPaths(source.paths);
  const git = await createGitRunner(context.workDir, repoUrl);
  const checkout = join(context.workDir, 'checkout');
  const resolved = await resolveRef(git, source.repo, source.ref);

  await mkdir(checkout);
  await git(['init', '--quiet', '--template=', checkout]);
  await git(['remote', 'add', 'origin', source.repo], { cwd: checkout });
  await git(
    [
      'fetch',
      '--quiet',
      '--depth',
      '1',
      '--filter=blob:none',
      '--no-tags',
      '--no-recurse-submodules',
      'origin',
      resolved.refspec,
    ],
    { cwd: checkout }
  );
  const commit = (
    await git(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], { cwd: checkout })
  ).trim();

  if (!COMMIT_PATTERN.test(commit)) {
    throw new GitError(
      `git fetch of ${redactUrl(source.repo)} at ${source.ref} returned no commit.`
    );
  }

  const sparse = !paths.includes('.');
  if (sparse) {
    // `init --template=` creates no info/ directory.
    await mkdir(join(checkout, '.git', 'info'), { recursive: true });
    await writeFile(join(checkout, '.git', 'info', 'sparse-checkout'), sparsePatterns(paths));
  }
  await git(
    [
      '-c',
      `core.sparseCheckout=${sparse}`,
      '-c',
      'core.sparseCheckoutCone=false',
      'checkout',
      '--quiet',
      '--detach',
      commit,
    ],
    { cwd: checkout }
  );

  const tree = parseTree(
    await git(['ls-tree', '-r', '-z', '--full-tree', commit, ...(sparse ? ['--', ...paths] : [])], {
      cwd: checkout,
    })
  ).filter((entry) => paths.some((path) => within(entry.path, path)));

  const missing = paths.filter(
    (path) => path !== '.' && !tree.some((entry) => within(entry.path, path))
  );
  if (missing.length > 0) {
    throw new ConfigError(
      `git ${redactUrl(source.repo)} at ${source.ref} (${commit.slice(0, 12)}) has no ${missing.map((path) => `"${path}"`).join(', ')}; fix "paths".`
    );
  }

  const root = commonRoot(paths, tree);
  const checkoutReal = await realpath(checkout);
  const classify = createSourceMatcher(source);
  const github = githubBase(repoUrl);
  const files: AcquiredFile[] = [];
  const ignoredSymlinks: string[] = [];
  const submodules: string[] = [];

  for (const entry of tree) {
    const path = root === '' ? entry.path : entry.path.slice(root.length + 1);

    if (entry.type === 'commit') {
      submodules.push(entry.path);
      continue;
    }

    const fileClass = classify(path);

    if (entry.mode === '120000') {
      if (fileClass === 'excluded') {
        continue;
      }
      if (fileClass !== 'ignored') {
        throw new ConfigError(
          `${entry.path} in ${redactUrl(source.repo)} is a symbolic link; symlinks are never followed, so exclude it.`
        );
      }
      ignoredSymlinks.push(entry.path);
      continue;
    }

    if (fileClass === 'excluded' || fileClass === 'ignored') {
      continue;
    }

    const absolutePath = join(checkout, ...entry.path.split('/'));
    const stats = await lstat(absolutePath);

    if (!stats.isFile() || !isSameOrDescendant(checkoutReal, await realpath(absolutePath))) {
      throw new GitError(`${entry.path} did not check out as a regular file inside the checkout.`);
    }

    const url =
      github === undefined ? undefined : `${github}/blob/${commit}/${encodePath(entry.path)}`;
    const sourceLabel = url ?? `${source.repo}@${commit}:${entry.path}`;

    if (stats.size > context.maxFileBytes) {
      throw new ConfigError(
        `${sourceLabel} is ${stats.size} bytes, over the ${context.maxFileBytes} byte per-file limit; exclude it or raise "limits.maxFileBytes".`
      );
    }

    files.push({
      path,
      absolutePath,
      sha256: await sha256File(absolutePath),
      bytes: stats.size,
      ...(url === undefined ? {} : { url }),
      sourceLabel,
    });
  }

  if (submodules.length > 0) {
    warnings.push(
      `Skipped ${plural(submodules.length, 'submodule')} in ${redactUrl(source.repo)} (submodules are never fetched): ${sample(submodules)}.`
    );
  }
  if (ignoredSymlinks.length > 0) {
    warnings.push(
      `Ignored ${plural(ignoredSymlinks.length, 'symbolic link')} in ${redactUrl(source.repo)} (symlinks are never followed): ${sample(ignoredSymlinks)}.`
    );
  }
  if (resolved.kind === 'branch') {
    warnings.push(
      `git ref "${source.ref}" is a branch, so the pin floats: this build records commit ${commit.slice(0, 12)}, and the next acquisition records wherever the branch points then. Pin a tag or commit for a stable pack.`
    );
  }

  const license = detectLicense(await readLicenseFiles(git, checkout, commit, paths));
  warnings.push(...license.warnings);

  return {
    origin: { type: 'git', repo: source.repo, ref: source.ref, commit, refKind: resolved.kind },
    files,
    warnings,
    license: license.detected,
  };
}

/** License files at the repository root and at each taken directory's root. */
async function readLicenseFiles(
  git: GitRunner,
  checkout: string,
  commit: string,
  paths: readonly string[]
): Promise<LicenseFile[]> {
  const directories = ['', ...paths.filter((path) => path !== '.')];
  const found: LicenseFile[] = [];

  for (const directory of directories) {
    const entries = parseTree(
      await git(['ls-tree', '-z', commit, ...(directory === '' ? [] : ['--', `${directory}/`])], {
        cwd: checkout,
      })
    );

    for (const entry of entries) {
      const name = posix.basename(entry.path);

      if (entry.type !== 'blob' || entry.mode === '120000' || !isLicenseFileName(name)) {
        continue;
      }

      const absolutePath = join(checkout, ...entry.path.split('/'));
      const stats = await lstat(absolutePath).catch(() => undefined);

      if (stats?.isFile() !== true || stats.size > LICENSE_MAX_BYTES) {
        continue;
      }

      found.push({ path: entry.path, text: await readFile(absolutePath, 'utf-8') });
    }
  }

  return found;
}
