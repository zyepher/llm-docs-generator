/**
 * `verify` (spec 5.1): named checks with pass, fail, warn, info, or skipped
 * results, per pack and per project. Read-only and offline.
 *
 * Implemented here: config-schema, agent-block (from src/agent/block.ts),
 * manifest-schema, outputs, unlisted-files, links, recipe, lockfile,
 * citations (from src/pack/guides.ts), conversion, license.
 */

import { lstat, stat } from 'node:fs/promises';
import { join, posix, resolve, sep } from 'node:path';

import { checkAgentBlocks } from '../agent/block.js';
import {
  ConfigError,
  loadProjectConfig,
  resolvePackRecipe,
  type DependencyVersionResolver,
  type LoadedProjectConfig,
} from '../config/project.js';
import { majorVersionsDiffer, projectDependencies } from '../deps/lockfiles.js';
import { isStaleAgentConversion } from '../sources/convert.js';
import { isSameOrDescendant } from '../utils/fs-path.js';
import { errorMessage, isFileNotFoundError } from '../utils/guards.js';
import { sha256File } from '../utils/hash.js';
import { compareStringsByCodeUnit } from '../utils/sort.js';
import { walkBoundedDirectoryTree } from '../utils/traversal.js';
import { checkCitations } from './guides.js';
import { MANIFEST_FILE_NAME, readProjectPacks, type PackManifest } from './manifest.js';
import { findLinkTargets, headingAnchors } from './markdown.js';
import { readRegularFile } from '../utils/safe-write.js';

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'info' | 'skipped';

export const PACK_CHECK_NAMES = [
  'manifest-schema',
  'outputs',
  'unlisted-files',
  'links',
  'recipe',
  'lockfile',
  'citations',
  'conversion',
  'license',
] as const;
export const PROJECT_CHECK_NAMES = ['config-schema', 'agent-block'] as const;
export type CheckName = (typeof PACK_CHECK_NAMES)[number] | (typeof PROJECT_CHECK_NAMES)[number];

export interface CheckFinding {
  status: 'fail' | 'warn' | 'info';
  message: string;
  /** Pack-relative (pack checks) or project-relative (project checks) path. */
  path?: string;
}

export interface CheckResult {
  check: CheckName;
  /** null for project-level checks. */
  packId: string | null;
  status: CheckStatus;
  findings: CheckFinding[];
  /** Why the check did not run (status `skipped`). */
  reason?: string;
}

export interface VerifyReport {
  ok: boolean;
  strict: boolean;
  results: CheckResult[];
}

export interface VerifyOptions {
  strict?: boolean;
  /** Overrides the project's lockfile scan (tests pin a lockfile answer with it). */
  resolveDependencyVersion?: DependencyVersionResolver | undefined;
}

/** Files a pack directory holds, by exact (case-preserving) pack-relative POSIX path. */
interface PackListing {
  files: Set<string>;
  symlinks: string[];
  /** Directories the walk could not examine (unreadable, too deep, past the entry budget). */
  unexamined: { path: string; why: string }[];
}

interface PackCheckContext {
  packId: string;
  packDir: string;
  manifest: PackManifest;
  listing: PackListing;
  loaded: LoadedProjectConfig | null;
  resolveDependencyVersion: DependencyVersionResolver;
  options: VerifyOptions;
}

type CheckOutcome = CheckFinding[] | { skipped: string };

interface PackCheck {
  name: (typeof PACK_CHECK_NAMES)[number];
  run(context: PackCheckContext): Promise<CheckOutcome>;
}

const OS_JUNK_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
const LINKED_OUTPUT_KINDS = new Set(['page', 'index', 'combined']);

function statusOf(findings: readonly CheckFinding[]): CheckStatus {
  if (findings.some((finding) => finding.status === 'fail')) {
    return 'fail';
  }
  if (findings.some((finding) => finding.status === 'warn')) {
    return 'warn';
  }
  return findings.some((finding) => finding.status === 'info') ? 'info' : 'pass';
}

function result(check: CheckName, packId: string | null, outcome: CheckOutcome): CheckResult {
  if (!Array.isArray(outcome)) {
    return { check, packId, status: 'skipped', findings: [], reason: outcome.skipped };
  }
  return { check, packId, status: statusOf(outcome), findings: outcome };
}

const toPosix = (path: string): string => path.split(sep).join('/');

const PACK_WALK_MAX_DEPTH = 64;
const PACK_WALK_MAX_ENTRIES = 200_000;

/**
 * List a pack. A walk bound that stops it short is recorded, never ignored:
 * a part of the pack nothing examined must not pass as clean.
 */
async function listPack(packDir: string, guidesRoot: string | undefined): Promise<PackListing> {
  const listing: PackListing = { files: new Set(), symlinks: [], unexamined: [] };

  const walk = async (root: string, prefix: string, skipGuides: boolean): Promise<void> => {
    const at = (relativePath: string): string => posix.join(prefix, toPosix(relativePath));

    for await (const event of walkBoundedDirectoryTree({
      root,
      maxDepth: PACK_WALK_MAX_DEPTH,
      maxEntries: PACK_WALK_MAX_ENTRIES,
      maxFiles: PACK_WALK_MAX_ENTRIES,
      skipDirectoryNames: false,
      skippedDirectoryPaths: skipGuides ? new Set(['guides']) : new Set(),
    })) {
      if (event.kind === 'file') {
        listing.files.add(at(event.relativePath));
      } else if (event.kind === 'symlink') {
        listing.symlinks.push(at(event.relativePath));
      } else if (event.kind === 'unreadable-directory') {
        if (!isFileNotFoundError(event.error) || event.relativePath !== '') {
          listing.unexamined.push({
            path: `${at(event.relativePath)}/`,
            why: `directory cannot be read (${errorMessage(event.error)})`,
          });
        }
      } else if (event.kind === 'depth-pruned') {
        listing.unexamined.push({
          path: `${at(event.relativePath)}/`,
          why: `directory is more than ${PACK_WALK_MAX_DEPTH} levels deep`,
        });
      } else if (event.kind === 'entries-exhausted') {
        listing.unexamined.push({
          path: `${at(event.relativePath)}/`,
          why: `the pack holds more than ${PACK_WALK_MAX_ENTRIES} entries and the walk stopped in this directory`,
        });
      }
    }
  };

  await walk(packDir, '', guidesRoot !== undefined);

  if (guidesRoot !== undefined) {
    await walk(join(guidesRoot, 'guides'), 'guides', false);
  }

  return listing;
}

/** A pack file verify may open, or why it may not. */
type PackFile =
  { kind: 'file'; absolutePath: string } | { kind: 'missing' } | { kind: 'unusable'; why: string };

function isNotDirectoryError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOTDIR';
}

/**
 * The one place verify turns a pack-relative path into a file it opens. The
 * path must resolve inside the pack directory, and each component from the
 * pack directory down must be a real directory and, last, a regular file: a
 * symbolic link anywhere on the way is never followed.
 */
async function packFile(packDir: string, path: string): Promise<PackFile> {
  const segments = path.split('/');
  const absolutePath = resolve(packDir, ...segments);

  if (!isSameOrDescendant(packDir, absolutePath) || absolutePath === resolve(packDir)) {
    return { kind: 'unusable', why: 'outside the pack directory' };
  }

  try {
    for (let index = 1; index <= segments.length; index++) {
      const stats = await lstat(join(packDir, ...segments.slice(0, index)));
      if (stats.isSymbolicLink()) {
        return {
          kind: 'unusable',
          why: 'reached through a symbolic link, which verify never follows',
        };
      }
      if (index < segments.length ? !stats.isDirectory() : !stats.isFile()) {
        return { kind: 'missing' };
      }
    }
  } catch (error) {
    if (isFileNotFoundError(error) || isNotDirectoryError(error)) {
      return { kind: 'missing' };
    }
    return { kind: 'unusable', why: `unreadable (${errorMessage(error)})` };
  }

  return { kind: 'file', absolutePath };
}

/** The text of a pack page, or the fail finding that says why its links went unchecked. */
async function readPackText(
  context: PackCheckContext,
  path: string
): Promise<{ text: string } | { finding: CheckFinding }> {
  const file = await packFile(context.packDir, path);
  const fail = (why: string): { finding: CheckFinding } => ({
    finding: {
      status: 'fail',
      path,
      message: `${why}, so its links were not checked; run 'llm-docs sync ${context.packId}' to rebuild the pack`,
    },
  });

  if (file.kind !== 'file') {
    return fail(file.kind === 'missing' ? 'file is missing' : `file is ${file.why}`);
  }
  try {
    return {
      text: (await readRegularFile(file.absolutePath, { followLinks: false })).toString('utf-8'),
    };
  } catch (error) {
    return fail(`file is unreadable (${errorMessage(error)})`);
  }
}

// ---------------------------------------------------------------------------
// Pack checks
// ---------------------------------------------------------------------------

async function checkOutputs(context: PackCheckContext): Promise<CheckOutcome> {
  const findings: CheckFinding[] = [];

  for (const output of context.manifest.outputs) {
    const file = await packFile(context.packDir, output.path);
    const fail = (problem: string): void => {
      findings.push({
        status: 'fail',
        path: output.path,
        message: `listed output is ${problem}; run 'llm-docs sync ${context.packId}' to rebuild the pack`,
      });
    };

    if (file.kind !== 'file') {
      fail(file.kind === 'missing' ? 'missing' : file.why);
      continue;
    }

    let actual: string;
    try {
      actual = await sha256File(file.absolutePath);
    } catch (error) {
      fail(`unreadable (${errorMessage(error)})`);
      continue;
    }

    if (actual !== output.sha256) {
      findings.push({
        status: 'fail',
        path: output.path,
        message: `content differs from the manifest (hash mismatch); pack files are tool-written, so run 'llm-docs sync ${context.packId}' to restore it`,
      });
    }
  }

  return findings;
}

async function checkUnlistedFiles(context: PackCheckContext): Promise<CheckOutcome> {
  const listed = new Set(context.manifest.outputs.map((output) => output.path));
  const findings: CheckFinding[] = [];
  let guides = 0;

  for (const path of [...context.listing.files].sort(compareStringsByCodeUnit)) {
    if (listed.has(path) || path === MANIFEST_FILE_NAME) {
      continue;
    }

    if (path.startsWith('guides/')) {
      guides += 1;
    } else if (OS_JUNK_FILES.has(posix.basename(path))) {
      findings.push({ status: 'info', path, message: 'operating system file, ignored' });
    } else {
      findings.push({
        status: 'fail',
        path,
        message: `file is not listed in the manifest; move it into guides/ if it is yours, or run 'llm-docs sync ${context.packId}' to remove it`,
      });
    }
  }

  for (const path of context.listing.symlinks) {
    findings.push({
      status: 'fail',
      path,
      message: `symbolic link inside the pack; delete it, or run 'llm-docs sync ${context.packId}' to rebuild the pack`,
    });
  }

  for (const { path, why } of context.listing.unexamined) {
    findings.push({
      status: 'fail',
      path,
      message: `${why}, so verify could not examine what it holds; remove it, or run 'llm-docs sync ${context.packId}' to rebuild the pack`,
    });
  }

  if (guides > 0) {
    findings.push({
      status: 'info',
      path: 'guides/',
      message: `${guides} agent-owned guide file${guides === 1 ? '' : 's'}, not covered by outputs`,
    });
  }

  return findings;
}

const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/**
 * Check every relative link in pages, the index, and combined files. Targets
 * with a scheme, protocol-relative URLs, and links in code are ignored;
 * fragments are checked against heading anchors only under `--strict`.
 */
async function checkLinks(context: PackCheckContext): Promise<CheckOutcome> {
  const findings: CheckFinding[] = [];
  const anchorsByPath = new Map<string, Set<string>>();
  const anchorsOf = async (path: string): Promise<Set<string>> => {
    let anchors = anchorsByPath.get(path);
    if (anchors === undefined) {
      const read = await readPackText(context, path);
      if ('finding' in read) {
        findings.push(read.finding);
      }
      anchors = 'text' in read ? headingAnchors(read.text) : new Set<string>();
      anchorsByPath.set(path, anchors);
    }
    return anchors;
  };

  for (const output of context.manifest.outputs) {
    if (!LINKED_OUTPUT_KINDS.has(output.kind) || !context.listing.files.has(output.path)) {
      continue;
    }

    const read = await readPackText(context, output.path);
    if ('finding' in read) {
      findings.push(read.finding);
      continue;
    }
    const text = read.text;

    for (const link of findLinkTargets(text)) {
      const target = link.target.trim();

      if (target === '' || URL_SCHEME.test(target) || target.startsWith('//')) {
        continue;
      }

      const hash = target.indexOf('#');
      const pathPart = (hash === -1 ? target : target.slice(0, hash)).replace(/\?.*$/, '');
      const fragment = hash === -1 ? '' : decodePath(target.slice(hash + 1));
      const fail = (message: string): void => {
        findings.push({ status: 'fail', path: output.path, message: `${message}: ${target}` });
      };

      if (pathPart === '') {
        if (context.options.strict === true && fragment !== '') {
          if (!(await anchorsOf(output.path)).has(fragment)) {
            fail('fragment matches no heading on this page');
          }
        }
        continue;
      }

      const decoded = decodePath(pathPart);

      if (decoded.startsWith('/')) {
        fail('site-absolute link does not resolve inside the pack');
        continue;
      }

      const resolved = posix.normalize(posix.join(posix.dirname(output.path), decoded));

      if (resolved === '..' || resolved.startsWith('../')) {
        fail('link points outside the pack');
        continue;
      }

      if (!context.listing.files.has(resolved)) {
        fail('link target is not a file in the pack');
        continue;
      }

      if (
        context.options.strict === true &&
        fragment !== '' &&
        resolved.endsWith('.md') &&
        !resolved.startsWith('guides/') &&
        !(await anchorsOf(resolved)).has(fragment)
      ) {
        fail('fragment matches no heading in the target page');
      }
    }
  }

  return findings;
}

async function checkRecipe(context: PackCheckContext): Promise<CheckOutcome> {
  const loaded = context.loaded;

  if (loaded === null || !Object.hasOwn(loaded.config.packs, context.packId)) {
    return [
      {
        status: 'warn',
        message: `orphan pack: llm-docs.json has no pack "${context.packId}"; delete it with 'llm-docs sync --prune', or add packs.${context.packId} back to llm-docs.json`,
      },
    ];
  }

  // Resolved at the version the manifest records, so a lockfile that moved (the lockfile
  // check's finding) never reads as an edited recipe: one cause, one finding.
  try {
    const resolved = await resolvePackRecipe(loaded.config, context.packId, {
      resolveDependencyVersion: () => ({
        kind: 'found',
        version: context.manifest.pack.version,
        lockfiles: [],
      }),
    });

    return resolved.recipeHash === context.manifest.recipeHash
      ? []
      : [
          {
            status: 'fail',
            message: `packs.${context.packId} in llm-docs.json changed since the last sync; run 'llm-docs sync ${context.packId}'`,
          },
        ];
  } catch (error) {
    if (error instanceof ConfigError) {
      return [{ status: 'fail', message: error.message }];
    }
    throw error;
  }
}

async function checkLockfile(context: PackCheckContext): Promise<CheckOutcome> {
  return [...(await boundDependencyFindings(context)), ...(await coveredFindings(context))];
}

/** The bound dependency must resolve to the pack's version (spec 2.4). */
async function boundDependencyFindings(context: PackCheckContext): Promise<CheckFinding[]> {
  const dependency = context.manifest.dependency;

  if (dependency === null) {
    return [];
  }

  const label = `${dependency.ecosystem}:${dependency.name}`;
  const version = context.manifest.pack.version;
  const lookup = await context.resolveDependencyVersion(dependency);
  const sync = `run 'llm-docs sync ${context.packId}'`;
  // An explicit version wins at sync (spec 2.4), so syncing alone cannot fix the mismatch.
  const pinned =
    context.loaded !== null &&
    Object.hasOwn(context.loaded.config.packs, context.packId) &&
    context.loaded.config.packs[context.packId]?.version !== undefined;

  switch (lookup.kind) {
    case 'found':
      return lookup.version === version
        ? []
        : [
            {
              status: 'fail',
              message: `stale-pack: lockfiles resolve ${label} ${lookup.version} (${lookup.lockfiles.join(', ')}), the pack is ${version}; ${
                pinned
                  ? `set packs.${context.packId}.version in llm-docs.json to ${lookup.version} (or remove it to follow the lockfile), then ${sync}`
                  : sync
              }`,
            },
          ];
    case 'missing':
      return [
        {
          status: 'fail',
          message: `no lockfile resolves ${label} (searched: ${lookup.searched.join(', ') || 'none found'}); install the dependency, or remove packs.${context.packId}.dependency from llm-docs.json`,
        },
      ];
    case 'conflict': {
      const versions = lookup.versions.map((entry) => `${entry.version} in ${entry.lockfile}`);
      const matches = lookup.versions.some((entry) => entry.version === version);
      return [
        {
          status: matches ? 'warn' : 'fail',
          message: `${matches ? '' : 'stale-pack: '}lockfiles resolve ${label} to different versions (${versions.join(', ')}); the pack is ${version}${matches ? '' : `, so set packs.${context.packId}.version in llm-docs.json to the one these docs describe, then run 'llm-docs sync ${context.packId}'`}`,
        },
      ];
    }
    case 'unread':
      return [
        {
          status: 'fail',
          message: `${label} could not be checked against the lockfiles, because ${lookup.lockfiles.map((entry) => `${entry.lockfile} ${entry.reason}`).join('; ')}; shrink or split that lockfile, or remove packs.${context.packId}.dependency from llm-docs.json`,
        },
      ];
  }
}

/**
 * A covered package binds no version, so the only thing worth saying is a
 * different major version, and only as a warning: the packages of one
 * family do not always share versions.
 */
async function coveredFindings(context: PackCheckContext): Promise<CheckFinding[]> {
  const findings: CheckFinding[] = [];
  const version = context.manifest.pack.version;

  for (const covered of context.manifest.recipe.covers ?? []) {
    const lookup = await context.resolveDependencyVersion(covered);
    if (lookup.kind === 'unread') {
      findings.push({
        status: 'warn',
        message: `covers ${covered.ecosystem}:${covered.name}, which could not be checked against the lockfiles, because ${lookup.lockfiles.map((entry) => `${entry.lockfile} ${entry.reason}`).join('; ')}`,
      });
      continue;
    }
    const resolved =
      lookup.kind === 'found'
        ? [lookup.version]
        : lookup.kind === 'conflict'
          ? [...new Set(lookup.versions.map((entry) => entry.version))]
          : [];

    for (const other of resolved.filter((entry) => majorVersionsDiffer(entry, version))) {
      findings.push({
        status: 'warn',
        message: `covers ${covered.ecosystem}:${covered.name}, which the lockfiles resolve to ${other}, another major version than the pack's ${version}: the pack may not describe that package's version; add a pack for it, or remove it from packs.${context.packId}.covers in llm-docs.json`,
      });
    }
  }

  return findings;
}

/** Spec 4.10: an unknown or proprietary license warns, and fails under --strict. */
async function checkLicense(context: PackCheckContext): Promise<CheckOutcome> {
  const { status, declared } = context.manifest.license;

  if (status !== 'unknown' && status !== 'proprietary') {
    return [];
  }

  const message =
    status === 'proprietary'
      ? 'license is proprietary: check the terms before committing or sharing this pack'
      : declared === null
        ? `license unknown: no license file was detected; set packs.${context.packId}.license in llm-docs.json (an SPDX id, or "proprietary") once you know the terms`
        : `license unknown: "${declared}" is not a recognized SPDX id; set packs.${context.packId}.license to one, such as MIT or Apache-2.0`;

  return [{ status: context.options.strict === true ? 'fail' : 'warn', message }];
}

/**
 * Agent conversions (spec 4.6): fail when the original changed after the
 * agent's `.md` was written, either as recorded at the last sync or, for
 * local sources, as the original now reads on disk.
 */
async function checkConversion(context: PackCheckContext): Promise<CheckOutcome> {
  const findings: CheckFinding[] = [];
  const projectRoot = context.loaded?.projectRoot;

  for (const entry of context.manifest.sources) {
    if (entry.converter?.tool !== 'agent') {
      continue;
    }

    const key = `${entry.source}:${entry.path}`;
    const page = context.manifest.outputs.find((output) => output.sources?.includes(key));
    const origin = context.manifest.origins[entry.source];
    const label = origin?.type === 'local' ? posix.join(origin.path, entry.path) : entry.path;
    const fix = `have an agent convert it again into ${entry.path}.md, then run 'llm-docs sync ${context.packId}'`;
    const finding = (status: 'fail' | 'warn', message: string): CheckFinding => ({
      status,
      message,
      ...(page === undefined ? {} : { path: page.path }),
    });

    if (isStaleAgentConversion(entry)) {
      findings.push(
        finding(
          'fail',
          `stale agent conversion: ${label} changed after ${entry.path}.md was written; ${fix}`
        )
      );
      continue;
    }

    if (origin?.type !== 'local' || projectRoot === undefined) {
      continue;
    }

    // A local origin is either the original itself or a directory holding it.
    const originPath = resolve(projectRoot, ...origin.path.split('/'));
    let current: string;

    try {
      const originalPath = (await stat(originPath)).isDirectory()
        ? resolve(originPath, ...entry.path.split('/'))
        : originPath;
      if (!isSameOrDescendant(projectRoot, originalPath)) {
        findings.push(
          finding(
            'fail',
            `${label} resolves outside the project; run 'llm-docs sync ${context.packId}' to rebuild the pack`
          )
        );
        continue;
      }
      current = await sha256File(originalPath);
    } catch (error) {
      if (!isFileNotFoundError(error)) {
        findings.push(
          finding(
            'fail',
            `${label}, converted by an agent, is unreadable (${errorMessage(error)}); make it readable, then run 'llm-docs verify' again`
          )
        );
        continue;
      }
      findings.push(
        finding(
          'warn',
          `${label}, converted by an agent, no longer exists; exclude it from the source or restore it, then run 'llm-docs sync ${context.packId}'`
        )
      );
      continue;
    }

    if (current !== entry.sha256) {
      findings.push(
        finding('fail', `stale agent conversion: ${label} changed since the last sync; ${fix}`)
      );
    }
  }

  return findings;
}

/** Per-pack checks after `manifest-schema`, in report order. */
const PACK_CHECKS: readonly PackCheck[] = [
  { name: 'outputs', run: checkOutputs },
  { name: 'unlisted-files', run: checkUnlistedFiles },
  { name: 'links', run: checkLinks },
  { name: 'recipe', run: checkRecipe },
  { name: 'lockfile', run: checkLockfile },
  {
    name: 'citations',
    // A linked guides/ fails unlisted-files; reading the guides through it would follow the link.
    run: async (context) =>
      context.listing.symlinks.includes('guides')
        ? { skipped: 'guides/ is a symbolic link, which verify never follows' }
        : checkCitations(context.packId, context.packDir),
  },
  { name: 'conversion', run: checkConversion },
  { name: 'license', run: checkLicense },
];

/** The pack-file checks a build runs on its staging directory and a sync runs to decide skipping. */
const FILE_CHECKS: ReadonlySet<string> = new Set(['outputs', 'unlisted-files', 'links']);

/**
 * Run the file-integrity checks (outputs, unlisted-files, links) on one pack
 * directory against `manifest`. `guidesRoot` is a pack directory whose
 * `guides/` stand in for this one's (a staging pack before the swap moves
 * the guides in).
 */
export async function verifyPackFiles(
  packId: string,
  packDir: string,
  manifest: PackManifest,
  options: {
    guidesRoot?: string;
    checks?: readonly ('outputs' | 'unlisted-files' | 'links')[];
  } = {}
): Promise<CheckResult[]> {
  const context: PackCheckContext = {
    packId,
    packDir,
    manifest,
    listing: await listPack(packDir, options.guidesRoot),
    loaded: null,
    resolveDependencyVersion: () => {
      throw new Error('The pack-file checks never resolve lockfiles.');
    },
    options: {},
  };
  const wanted = new Set<string>(options.checks ?? [...FILE_CHECKS]);
  const results: CheckResult[] = [];

  for (const check of PACK_CHECKS) {
    if (wanted.has(check.name)) {
      results.push(result(check.name, packId, await runCheck(check, context)));
    }
  }

  return results;
}

/**
 * Run one check. A check that cannot finish (an I/O error the check did not
 * turn into a finding itself) fails with the reason instead of ending the
 * whole run, so every other check and pack is still reported.
 */
async function runCheck(check: PackCheck, context: PackCheckContext): Promise<CheckOutcome> {
  try {
    return await check.run(context);
  } catch (error) {
    return [
      {
        status: 'fail',
        message: `the check could not finish: ${errorMessage(error)}; fix the cause, then run 'llm-docs verify ${context.packId}' again`,
      },
    ];
  }
}

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

/**
 * Verify the project's packs (all configured packs plus orphan pack
 * directories, or just `ids`). An invalid config fails `config-schema` and
 * stops there; an unknown id is a ConfigError.
 */
export async function verifyPacks(
  projectRoot: string,
  ids: readonly string[] | undefined,
  options: VerifyOptions = {}
): Promise<VerifyReport> {
  const strict = options.strict === true;
  const results: CheckResult[] = [];
  let loaded: LoadedProjectConfig;

  try {
    loaded = await loadProjectConfig(projectRoot);
    results.push(result('config-schema', null, []));
  } catch (error) {
    if (!(error instanceof ConfigError)) {
      throw error;
    }
    results.push(
      result('config-schema', null, [
        { status: 'fail', path: 'llm-docs.json', message: error.message },
      ])
    );
    return { ok: false, strict, results };
  }

  results.push(result('agent-block', null, await checkAgentBlocks(loaded)));

  const resolveDependencyVersion =
    options.resolveDependencyVersion ??
    projectDependencies(loaded.projectRoot, { skipDirectories: [loaded.packsDirRelative] })
      .resolveVersion;
  const packs = await readProjectPacks(loaded);

  for (const id of ids ?? []) {
    if (!packs.some((pack) => pack.id === id)) {
      throw new ConfigError(
        `No pack "${id}" in llm-docs.json or ${loaded.packsDirRelative}/; 'llm-docs status' lists the packs.`
      );
    }
  }

  const selected =
    ids === undefined || ids.length === 0
      ? packs
      : [...new Set(ids)].flatMap((id) => packs.filter((pack) => pack.id === id));

  for (const { id: packId, dir: packDir, inConfig, manifest: read } of selected) {
    if (read.kind === 'invalid' && read.reason === 'link') {
      results.push(result('manifest-schema', packId, { skipped: read.message }));
      for (const check of PACK_CHECKS) {
        results.push(
          result(
            check.name,
            packId,
            check.name === 'unlisted-files'
              ? [
                  {
                    status: 'fail',
                    path: '.',
                    message: `the pack directory is a symbolic link, which verify never follows; delete the link, then run 'llm-docs sync ${packId}' to build the pack in place`,
                  },
                ]
              : { skipped: read.message }
          )
        );
      }
      continue;
    }

    if (read.kind !== 'ok') {
      const sync = `run 'llm-docs sync ${packId}' to rebuild the pack`;
      const message =
        read.kind === 'missing'
          ? `${MANIFEST_FILE_NAME} is missing; ${sync}`
          : read.reason === 'other-version'
            ? read.message
            : !inConfig
              ? `${read.message}; llm-docs.json has no pack "${packId}", so delete ${loaded.packsDirRelative}/${packId}/ or add it back to llm-docs.json`
              : read.reason === 'wrong-id'
                ? `${read.message}; move ${loaded.packsDirRelative}/${packId}/ away, then ${sync}`
                : `${read.message}; ${sync}`;
      results.push(
        result('manifest-schema', packId, [{ status: 'fail', path: MANIFEST_FILE_NAME, message }])
      );
      for (const check of PACK_CHECKS) {
        results.push(result(check.name, packId, { skipped: 'the manifest could not be read' }));
      }
      continue;
    }

    const manifest = read.manifest;
    results.push(result('manifest-schema', packId, []));
    const context: PackCheckContext = {
      packId,
      packDir,
      manifest,
      listing: await listPack(packDir, undefined),
      loaded,
      resolveDependencyVersion,
      options,
    };

    for (const check of PACK_CHECKS) {
      results.push(result(check.name, packId, await runCheck(check, context)));
    }
  }

  return { ok: !results.some((entry) => entry.status === 'fail'), strict, results };
}
