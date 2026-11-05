/**
 * `verify` (spec 5.1): named checks with pass, fail, warn, info, or skipped
 * results, per pack and per project. Read-only and offline.
 *
 * Implemented here: config-schema, manifest-schema, outputs, unlisted-files,
 * links, recipe, lockfile, conversion. The remaining checks register in
 * PACK_CHECKS and PROJECT_CHECKS: `license` (Phase 2c), `citations`
 * (Phase 5), `agent-block` (Phase 4).
 */

import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import { join, posix, sep } from 'node:path';

import {
  ConfigError,
  LockfileResolutionUnavailableError,
  loadProjectConfig,
  resolvePackRecipe,
  type DependencyVersionResolver,
  type LoadedProjectConfig,
} from '../config/project.js';
import { isStaleAgentConversion } from '../sources/convert.js';
import { errorMessage, isFileNotFoundError } from '../utils/guards.js';
import { sha256File } from '../utils/hash.js';
import { compareStringsByCodeUnit } from '../utils/sort.js';
import { walkBoundedDirectoryTree } from '../utils/traversal.js';
import {
  MANIFEST_FILE_NAME,
  ManifestError,
  readPackManifest,
  type PackManifest,
} from './manifest.js';
import { findLinkTargets, headingAnchors } from './markdown.js';

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
  resolveDependencyVersion?: DependencyVersionResolver | undefined;
}

/** Files a pack directory holds, by exact (case-preserving) pack-relative POSIX path. */
interface PackListing {
  files: Set<string>;
  symlinks: string[];
}

interface PackCheckContext {
  packId: string;
  packDir: string;
  manifest: PackManifest;
  listing: PackListing;
  loaded: LoadedProjectConfig | null;
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

async function listPack(packDir: string, guidesRoot: string | undefined): Promise<PackListing> {
  const listing: PackListing = { files: new Set(), symlinks: [] };

  const walk = async (root: string, prefix: string, skipGuides: boolean): Promise<void> => {
    for await (const event of walkBoundedDirectoryTree({
      root,
      maxDepth: 64,
      maxEntries: 200_000,
      maxFiles: 200_000,
      skipDirectoryNames: false,
      skippedDirectoryPaths: skipGuides ? new Set(['guides']) : new Set(),
    })) {
      if (event.kind === 'file') {
        listing.files.add(posix.join(prefix, toPosix(event.relativePath)));
      } else if (event.kind === 'symlink') {
        listing.symlinks.push(posix.join(prefix, toPosix(event.relativePath)));
      } else if (event.kind === 'unreadable-directory') {
        if (!isFileNotFoundError(event.error) || event.relativePath !== '') {
          throw new Error(`Cannot read ${event.absolutePath}: ${errorMessage(event.error)}`);
        }
      } else if (event.kind === 'entries-exhausted') {
        throw new Error(`${root} holds more than 200000 entries.`);
      }
    }
  };

  await walk(packDir, '', guidesRoot !== undefined);

  if (guidesRoot !== undefined) {
    await walk(join(guidesRoot, 'guides'), 'guides', false);
  }

  return listing;
}

// ---------------------------------------------------------------------------
// Pack checks
// ---------------------------------------------------------------------------

async function checkOutputs(context: PackCheckContext): Promise<CheckOutcome> {
  const findings: CheckFinding[] = [];

  for (const output of context.manifest.outputs) {
    const absolutePath = join(context.packDir, ...output.path.split('/'));
    let isFile = false;

    try {
      isFile = (await lstat(absolutePath)).isFile();
    } catch (error) {
      if (!isFileNotFoundError(error)) {
        throw error;
      }
    }

    if (!isFile) {
      findings.push({ status: 'fail', path: output.path, message: 'listed output is missing' });
      continue;
    }

    if ((await sha256File(absolutePath)) !== output.sha256) {
      findings.push({
        status: 'fail',
        path: output.path,
        message: 'content differs from the manifest (hash mismatch)',
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
      findings.push({ status: 'fail', path, message: 'file is not listed in the manifest' });
    }
  }

  for (const path of context.listing.symlinks) {
    findings.push({ status: 'fail', path, message: 'symbolic link inside the pack' });
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
      anchors = headingAnchors(await readFile(join(context.packDir, ...path.split('/')), 'utf-8'));
      anchorsByPath.set(path, anchors);
    }
    return anchors;
  };

  for (const output of context.manifest.outputs) {
    if (!LINKED_OUTPUT_KINDS.has(output.kind) || !context.listing.files.has(output.path)) {
      continue;
    }

    const text = await readFile(join(context.packDir, ...output.path.split('/')), 'utf-8');

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
        message: `orphan pack: llm-docs.json has no pack "${context.packId}" (remove it with 'llm-docs sync --prune')`,
      },
    ];
  }

  try {
    const resolved = await resolvePackRecipe(loaded.config, context.packId, {
      resolveDependencyVersion: context.options.resolveDependencyVersion,
    });

    return resolved.recipeHash === context.manifest.recipeHash
      ? []
      : [
          {
            status: 'fail',
            message: `the recipe in llm-docs.json changed since the last sync; run 'llm-docs sync ${context.packId}'`,
          },
        ];
  } catch (error) {
    if (error instanceof LockfileResolutionUnavailableError) {
      return {
        skipped: 'the version comes from lockfiles, and lockfile resolution is not available',
      };
    }
    if (error instanceof ConfigError) {
      return [{ status: 'fail', message: error.message }];
    }
    throw error;
  }
}

async function checkLockfile(context: PackCheckContext): Promise<CheckOutcome> {
  const dependency = context.manifest.dependency;

  if (dependency === null) {
    return [];
  }

  const resolver = context.options.resolveDependencyVersion;

  if (resolver === undefined) {
    return { skipped: 'lockfile resolution is not available' };
  }

  const label = `${dependency.ecosystem}:${dependency.name}`;
  const version = context.manifest.pack.version;
  const lookup = await resolver(dependency);

  switch (lookup.kind) {
    case 'found':
      return lookup.version === version
        ? []
        : [
            {
              status: 'fail',
              message: `stale-pack: lockfiles resolve ${label} ${lookup.version} (${lookup.lockfiles.join(', ')}), the pack is ${version}; run 'llm-docs sync ${context.packId}'`,
            },
          ];
    case 'missing':
      return [
        {
          status: 'fail',
          message: `no lockfile resolves ${label} (searched: ${lookup.searched.join(', ') || 'none found'})`,
        },
      ];
    case 'conflict': {
      const versions = lookup.versions.map((entry) => `${entry.version} in ${entry.lockfile}`);
      const matches = lookup.versions.some((entry) => entry.version === version);
      return [
        {
          status: matches ? 'warn' : 'fail',
          message: `${matches ? '' : 'stale-pack: '}lockfiles resolve ${label} to different versions (${versions.join(', ')}); the pack is ${version}`,
        },
      ];
    }
  }
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
    const originPath = join(projectRoot, ...origin.path.split('/'));
    let current: string;

    try {
      const originalPath = (await stat(originPath)).isDirectory()
        ? join(originPath, ...entry.path.split('/'))
        : originPath;
      current = await sha256File(originalPath);
    } catch (error) {
      if (!isFileNotFoundError(error)) {
        throw error;
      }
      findings.push(finding('warn', `${label}, converted by an agent, no longer exists`));
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

/**
 * Per-pack checks after `manifest-schema`, in report order. Later phases add
 * theirs here: `citations` (Phase 5), `license` (Phase 2c, warn for unknown
 * and proprietary, fail under --strict).
 */
const PACK_CHECKS: readonly PackCheck[] = [
  { name: 'outputs', run: checkOutputs },
  { name: 'unlisted-files', run: checkUnlistedFiles },
  { name: 'links', run: checkLinks },
  { name: 'recipe', run: checkRecipe },
  { name: 'lockfile', run: checkLockfile },
  { name: 'conversion', run: checkConversion },
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
    options: {},
  };
  const wanted = new Set<string>(options.checks ?? [...FILE_CHECKS]);
  const results: CheckResult[] = [];

  for (const check of PACK_CHECKS) {
    if (wanted.has(check.name)) {
      results.push(result(check.name, packId, await check.run(context)));
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

async function packDirectoriesOnDisk(packsDir: string): Promise<string[]> {
  try {
    const entries = await readdir(packsDir, { withFileTypes: true });
    const ids: string[] = [];

    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        try {
          await lstat(join(packsDir, entry.name, MANIFEST_FILE_NAME));
          ids.push(entry.name);
        } catch {
          // Not a pack: no manifest.
        }
      }
    }

    return ids.sort(compareStringsByCodeUnit);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return [];
    }
    throw error;
  }
}

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

  // Phase 4 registers `agent-block` here: each managed block matches what sync would write.

  const onDisk = await packDirectoriesOnDisk(loaded.packsDir);
  const configured = Object.keys(loaded.config.packs);
  const known = new Set([...configured, ...onDisk]);

  for (const id of ids ?? []) {
    if (!known.has(id)) {
      throw new ConfigError(`No pack "${id}" in llm-docs.json or ${loaded.packsDirRelative}/.`);
    }
  }

  const selected =
    ids === undefined || ids.length === 0
      ? [...configured, ...onDisk.filter((id) => !configured.includes(id))]
      : [...new Set(ids)];

  for (const packId of selected) {
    const packDir = join(loaded.packsDir, packId);
    let manifest: PackManifest;

    try {
      manifest = await readPackManifest(packDir);
      if (manifest.pack.id !== packId) {
        throw new ManifestError(
          `${MANIFEST_FILE_NAME} belongs to pack "${manifest.pack.id}", not "${packId}"`,
          'invalid'
        );
      }
    } catch (error) {
      if (!(error instanceof ManifestError)) {
        throw error;
      }
      const message =
        error.reason === 'missing'
          ? `${error.message}; run 'llm-docs sync ${packId}'`
          : error.message;
      results.push(
        result('manifest-schema', packId, [{ status: 'fail', path: MANIFEST_FILE_NAME, message }])
      );
      for (const check of PACK_CHECKS) {
        results.push(result(check.name, packId, { skipped: 'the manifest could not be read' }));
      }
      continue;
    }

    results.push(result('manifest-schema', packId, []));
    const context: PackCheckContext = {
      packId,
      packDir,
      manifest,
      listing: await listPack(packDir, undefined),
      loaded,
      options,
    };

    for (const check of PACK_CHECKS) {
      results.push(result(check.name, packId, await check.run(context)));
    }
  }

  return { ok: !results.some((entry) => entry.status === 'fail'), strict, results };
}
