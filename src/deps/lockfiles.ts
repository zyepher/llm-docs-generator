import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, posix, resolve, sep } from 'node:path';

import { load as yamlLoad, FAILSAFE_SCHEMA } from 'js-yaml';
import { parse as parseToml } from 'smol-toml';

import { errorMessage, isFileNotFoundError, isNonEmptyString, isRecord } from '../utils/guards.js';
import { compareStringsByCodeUnit } from '../utils/sort.js';
import { walkBoundedDirectoryTree } from '../utils/traversal.js';
import {
  parseBunLock,
  parseNpmPackageLock,
  parsePnpmLock,
  parseYarnLock,
} from './lockfiles-npm.js';

export const ECOSYSTEMS = ['npm', 'pypi', 'cargo', 'go', 'pub', 'swiftpm'] as const;
export type Ecosystem = (typeof ECOSYSTEMS)[number];

export interface ResolvedDependency {
  ecosystem: Ecosystem;
  /** Registry name; npm scoped names keep `@scope/name`, PyPI names are PEP 503 normalized. */
  name: string;
  version: string;
  /** Declared by the project manifest next to the lockfile (or a workspace member it lists). */
  direct: boolean;
  dev: boolean;
  /** Project-relative POSIX path. */
  lockfile: string;
  repositoryUrl?: string;
}

export interface DependencyScan {
  /** Sorted by ecosystem, name, version, lockfile. */
  dependencies: ResolvedDependency[];
  /** Project-relative POSIX paths of every lockfile found (including unsupported ones). */
  lockfiles: string[];
  warnings: string[];
}

export interface DependencyRef {
  ecosystem: Ecosystem;
  name: string;
}

export type DependencyVersionLookup =
  | { kind: 'found'; version: string; lockfiles: string[] }
  | { kind: 'conflict'; versions: { version: string; lockfile: string }[] }
  | { kind: 'missing'; searched: string[] };

export interface ScanDependenciesOptions {
  maxDepth?: number;
  /** Project-relative directories to leave out (the caller passes its packsDir). */
  skipDirectories?: string[];
}

/**
 * Why a lockfile entry was left out. Everything here is reported in one
 * aggregated warning: the entries are real dependencies, just not ones a
 * registry can date or a docs pack can bind to.
 */
export type SkipReason =
  | 'alias'
  | 'alternate-registry'
  | 'git'
  | 'path'
  | 'replaced'
  | 'revision-only'
  | 'url'
  | 'workspace';

export interface LockfileContext {
  projectRoot: string;
  /** Project-relative POSIX path of the lockfile. */
  lockfile: string;
  /** Absolute directory containing the lockfile. */
  directory: string;
  text: string;
}

export interface LockfileResult {
  dependencies: ResolvedDependency[];
  skipped: { name: string; reason: SkipReason }[];
  warnings: string[];
}

type LockfileParser = (context: LockfileContext) => Promise<LockfileResult>;

const DEFAULT_MAX_DEPTH = 6;
const MAX_WALK_ENTRIES = 200_000;
const MAX_SKIP_EXAMPLES = 20;

/**
 * Directories that hold other projects' lockfiles (virtualenvs, SwiftPM and
 * CocoaPods checkouts, Dart tool caches) on top of the shared traversal skip
 * list. Scanning them would report a dependency's own dependencies as the
 * project's.
 */
const EXTRA_SKIPPED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  '.build',
  '.dart_tool',
  '.gradle',
  '.hg',
  '.pnpm-store',
  '.svn',
  '.tox',
  '.venv',
  '.yarn',
  'Carthage',
  'Pods',
  '__pycache__',
  'bower_components',
  'venv',
]);

const LOCKFILE_PARSERS: Readonly<Record<string, LockfileParser>> = {
  'package-lock.json': parseNpmPackageLock,
  'npm-shrinkwrap.json': parseNpmPackageLock,
  'pnpm-lock.yaml': parsePnpmLock,
  'yarn.lock': parseYarnLock,
  'bun.lock': parseBunLock,
  'uv.lock': parseUvLock,
  'poetry.lock': parsePoetryLock,
  'pdm.lock': parsePdmLock,
  'Pipfile.lock': parsePipfileLock,
  'Cargo.lock': parseCargoLock,
  'go.mod': parseGoMod,
  'pubspec.lock': parsePubspecLock,
  'Package.resolved': parsePackageResolved,
};

const UNSUPPORTED_LOCKFILES: Readonly<Record<string, string>> = {
  'bun.lockb':
    'the binary bun.lockb format is not supported; run `bun install --save-text-lockfile` to produce bun.lock',
};

const REQUIREMENTS_FILE_PATTERN = /^requirements.*\.txt$/;

function lockfileParserFor(fileName: string): LockfileParser | undefined {
  if (Object.hasOwn(LOCKFILE_PARSERS, fileName)) {
    return LOCKFILE_PARSERS[fileName];
  }

  return REQUIREMENTS_FILE_PATTERN.test(fileName) ? parseRequirementsTxt : undefined;
}

/**
 * Find every supported lockfile under `projectRoot` (bounded walk, symlinks
 * never followed) and return the dependencies they resolve. Parsers only read
 * files; no project code runs. A lockfile that fails to parse becomes a
 * warning, never a thrown error, so one broken file cannot hide the rest.
 */
export async function scanDependencies(
  projectRoot: string,
  options: ScanDependenciesOptions = {}
): Promise<DependencyScan> {
  const root = resolve(projectRoot);
  const skipPrefixes = normalizeSkipDirectories(options.skipDirectories ?? []);
  const warnings: string[] = [];
  const found: { lockfile: string; parser: LockfileParser | undefined; unsupported?: string }[] =
    [];

  for await (const event of walkBoundedDirectoryTree({
    root,
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxEntries: MAX_WALK_ENTRIES,
    // The file budget never stops the walk; the entry budget is the real bound.
    maxFiles: MAX_WALK_ENTRIES,
    skipDirectoryNames: true,
    extraSkippedDirectoryNames: EXTRA_SKIPPED_DIRECTORY_NAMES,
    skippedDirectoryPaths: new Set(skipPrefixes),
  })) {
    if (event.kind === 'entries-exhausted') {
      warnings.push(
        `Dependency scan stopped early: the project has more than ${MAX_WALK_ENTRIES} entries; lockfiles beyond that were not read.`
      );
      continue;
    }

    if (event.kind === 'unreadable-directory') {
      warnings.push(
        `Dependency scan could not read ${toPosixPath(event.relativePath) || '.'}: ${errorMessage(event.error)}`
      );
      continue;
    }

    if (event.kind !== 'file') {
      continue;
    }

    const relativePath = toPosixPath(event.relativePath);
    const fileName = event.entry.name;
    const unsupported = UNSUPPORTED_LOCKFILES[fileName];

    if (Object.hasOwn(UNSUPPORTED_LOCKFILES, fileName) && unsupported !== undefined) {
      found.push({ lockfile: relativePath, parser: undefined, unsupported });
      continue;
    }

    const parser = lockfileParserFor(fileName);

    if (parser) {
      found.push({ lockfile: relativePath, parser });
    }
  }

  found.sort((a, b) => compareStringsByCodeUnit(a.lockfile, b.lockfile));

  const dependencies: ResolvedDependency[] = [];
  const skipped: { lockfile: string; name: string; reason: SkipReason }[] = [];

  for (const entry of found) {
    if (!entry.parser) {
      warnings.push(`${entry.lockfile}: unsupported lockfile, ${entry.unsupported ?? 'skipped'}.`);
      continue;
    }

    const absolutePath = join(root, ...entry.lockfile.split('/'));

    try {
      const result = await entry.parser({
        projectRoot: root,
        lockfile: entry.lockfile,
        directory: dirname(absolutePath),
        text: await readFile(absolutePath, 'utf-8'),
      });

      dependencies.push(...result.dependencies);
      warnings.push(...result.warnings.map((warning) => `${entry.lockfile}: ${warning}`));

      for (const skip of result.skipped) {
        skipped.push({ lockfile: entry.lockfile, ...skip });
      }
    } catch (error) {
      warnings.push(`${entry.lockfile}: could not be parsed: ${errorMessage(error)}`);
    }
  }

  const skippedWarning = formatSkippedWarning(skipped);

  if (skippedWarning) {
    warnings.push(skippedWarning);
  }

  return {
    dependencies: mergeDependencies(dependencies),
    lockfiles: found.map((entry) => entry.lockfile),
    warnings: [...new Set(warnings)].sort(compareStringsByCodeUnit),
  };
}

/**
 * The version a project resolves for one dependency. Direct entries win when
 * any exist, so a transitive copy at another version (common in npm trees)
 * does not turn a clear answer into a conflict.
 */
export function findDependencyVersion(
  scan: Pick<DependencyScan, 'dependencies' | 'lockfiles'>,
  ref: DependencyRef
): DependencyVersionLookup {
  const wanted = normalizeDependencyName(ref.ecosystem, ref.name);
  const matches = scan.dependencies.filter(
    (dependency) =>
      dependency.ecosystem === ref.ecosystem &&
      normalizeDependencyName(dependency.ecosystem, dependency.name) === wanted
  );
  const direct = matches.filter((dependency) => dependency.direct);
  const relevant = direct.length > 0 ? direct : matches;

  if (relevant.length === 0) {
    return {
      kind: 'missing',
      searched: scan.lockfiles.filter((lockfile) => lockfileEcosystem(lockfile) === ref.ecosystem),
    };
  }

  const versions = new Set(relevant.map((dependency) => dependency.version));

  if (versions.size === 1) {
    const [version] = [...versions];

    return {
      kind: 'found',
      version: version ?? '',
      lockfiles: uniqueSorted(relevant.map((dependency) => dependency.lockfile)),
    };
  }

  const pairs = new Map<string, { version: string; lockfile: string }>();

  for (const dependency of relevant) {
    pairs.set(`${dependency.version}\u0000${dependency.lockfile}`, {
      version: dependency.version,
      lockfile: dependency.lockfile,
    });
  }

  return {
    kind: 'conflict',
    versions: [...pairs.values()].sort(
      (a, b) =>
        compareStringsByCodeUnit(a.version, b.version) ||
        compareStringsByCodeUnit(a.lockfile, b.lockfile)
    ),
  };
}

/** The ecosystem a lockfile path belongs to, from its file name. */
export function lockfileEcosystem(lockfile: string): Ecosystem | undefined {
  const fileName = posix.basename(lockfile);

  switch (fileName) {
    case 'package-lock.json':
    case 'npm-shrinkwrap.json':
    case 'pnpm-lock.yaml':
    case 'yarn.lock':
    case 'bun.lock':
    case 'bun.lockb':
      return 'npm';
    case 'uv.lock':
    case 'poetry.lock':
    case 'pdm.lock':
    case 'Pipfile.lock':
      return 'pypi';
    case 'Cargo.lock':
      return 'cargo';
    case 'go.mod':
      return 'go';
    case 'pubspec.lock':
      return 'pub';
    case 'Package.resolved':
      return 'swiftpm';
    default:
      return REQUIREMENTS_FILE_PATTERN.test(fileName) ? 'pypi' : undefined;
  }
}

/** PEP 503 normalization: lowercase, runs of `-`, `_`, `.` collapsed to `-`. */
export function normalizePypiName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

export function normalizeDependencyName(ecosystem: Ecosystem, name: string): string {
  return ecosystem === 'pypi' ? normalizePypiName(name) : name;
}

// ============================================================================
// Shared helpers (also used by lockfiles-npm.ts)
// ============================================================================

const EXACT_SEMVER_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function isExactSemver(value: string): boolean {
  return EXACT_SEMVER_PATTERN.test(value);
}

export function createLockfileResult(): LockfileResult {
  return { dependencies: [], skipped: [], warnings: [] };
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf-8');
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return undefined;
    }

    throw error;
  }
}

export async function readJsonIfExists(path: string): Promise<unknown> {
  const text = await readTextIfExists(path);
  return text === undefined ? undefined : JSON.parse(text);
}

async function readTomlIfExists(path: string): Promise<Record<string, unknown> | undefined> {
  const text = await readTextIfExists(path);
  return text === undefined ? undefined : parseToml(text);
}

/**
 * YAML lockfiles are parsed with the failsafe schema so every scalar stays a
 * string: `version: 1.10` must not become the number 1.1.
 */
export function parseYamlStrings(text: string): unknown {
  return yamlLoad(text, { schema: FAILSAFE_SCHEMA });
}

/**
 * Expand workspace member patterns (`packages/*`, `crates/core`, `!excluded`)
 * relative to `baseDirectory`, returning POSIX paths relative to it. Only
 * single-segment `*` wildcards are supported; patterns that would leave the
 * base directory are ignored. Members are directories, never symlinks.
 */
export async function expandWorkspacePatterns(
  baseDirectory: string,
  patterns: readonly string[]
): Promise<{ members: string[]; warnings: string[] }> {
  const warnings: string[] = [];
  const included = new Set<string>();
  const excluded: RegExp[] = [];

  for (const rawPattern of patterns) {
    const negated = rawPattern.startsWith('!');
    const pattern = posix.normalize(
      (negated ? rawPattern.slice(1) : rawPattern).replace(/\\/g, '/').replace(/\/+$/, '')
    );

    if (pattern === '.' || pattern === '') {
      continue;
    }

    if (pattern.startsWith('/') || pattern === '..' || pattern.startsWith('../')) {
      warnings.push(`workspace pattern "${rawPattern}" points outside the project; ignored.`);
      continue;
    }

    if (pattern.split('/').includes('**')) {
      warnings.push(
        `workspace pattern "${rawPattern}" uses "**", which is not supported; ignored.`
      );
      continue;
    }

    if (negated) {
      excluded.push(segmentPatternToRegExp(pattern));
      continue;
    }

    for (const member of await expandPatternSegments(baseDirectory, pattern.split('/'), '')) {
      included.add(member);
    }
  }

  return {
    members: [...included]
      .filter((member) => !excluded.some((regExp) => regExp.test(member)))
      .sort(compareStringsByCodeUnit),
    warnings,
  };
}

async function expandPatternSegments(
  baseDirectory: string,
  segments: string[],
  prefix: string
): Promise<string[]> {
  const [segment, ...rest] = segments;

  if (segment === undefined) {
    return prefix === '' ? [] : [prefix];
  }

  let entries: Dirent[];

  try {
    entries = await readdir(join(baseDirectory, ...prefix.split('/').filter(Boolean)), {
      withFileTypes: true,
    });
  } catch {
    return [];
  }

  const matcher = segmentPatternToRegExp(segment);
  const results: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !matcher.test(entry.name)) {
      continue;
    }

    if (!segment.includes('*') && entry.name !== segment) {
      continue;
    }

    results.push(
      ...(await expandPatternSegments(
        baseDirectory,
        rest,
        prefix === '' ? entry.name : `${prefix}/${entry.name}`
      ))
    );
  }

  return results;
}

function segmentPatternToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*');

  return new RegExp(`^${escaped}$`);
}

function toPosixPath(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

function normalizeSkipDirectories(directories: readonly string[]): string[] {
  const prefixes: string[] = [];

  for (const directory of directories) {
    const normalized = posix
      .normalize(directory.replace(/\\/g, '/'))
      .replace(/^\.\//, '')
      .replace(/\/+$/, '');

    if (normalized === '' || normalized === '.' || normalized.startsWith('..')) {
      continue;
    }

    prefixes.push(normalized);
  }

  return prefixes;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareStringsByCodeUnit);
}

/**
 * Collapse duplicate (ecosystem, name, version, lockfile) entries: a version
 * installed at several tree positions is one dependency, direct when any copy
 * is direct, and dev only when every copy of the deciding kind (direct copies
 * when there are any) is dev.
 */
function mergeDependencies(dependencies: ResolvedDependency[]): ResolvedDependency[] {
  const merged = new Map<string, ResolvedDependency>();

  for (const dependency of dependencies) {
    const key = [
      dependency.ecosystem,
      dependency.name,
      dependency.version,
      dependency.lockfile,
    ].join('\u0000');
    const existing = merged.get(key);

    if (!existing) {
      merged.set(key, { ...dependency });
      continue;
    }

    if (existing.direct === dependency.direct) {
      existing.dev = existing.dev && dependency.dev;
    } else if (dependency.direct) {
      // A direct declaration decides dev-ness over a transitive copy.
      existing.direct = true;
      existing.dev = dependency.dev;
    }

    if (existing.repositoryUrl === undefined && dependency.repositoryUrl !== undefined) {
      existing.repositoryUrl = dependency.repositoryUrl;
    }
  }

  return [...merged.values()].sort(
    (a, b) =>
      compareStringsByCodeUnit(a.ecosystem, b.ecosystem) ||
      compareStringsByCodeUnit(a.name, b.name) ||
      compareStringsByCodeUnit(a.version, b.version) ||
      compareStringsByCodeUnit(a.lockfile, b.lockfile)
  );
}

function formatSkippedWarning(
  skipped: { lockfile: string; name: string; reason: SkipReason }[]
): string | undefined {
  if (skipped.length === 0) {
    return undefined;
  }

  const unique = new Map<string, { lockfile: string; name: string; reason: SkipReason }>();

  for (const entry of skipped) {
    unique.set(`${entry.lockfile}\u0000${entry.name}\u0000${entry.reason}`, entry);
  }

  const entries = [...unique.values()].sort(
    (a, b) =>
      compareStringsByCodeUnit(a.lockfile, b.lockfile) ||
      compareStringsByCodeUnit(a.name, b.name) ||
      compareStringsByCodeUnit(a.reason, b.reason)
  );
  const reasons = uniqueSorted(entries.map((entry) => entry.reason)).join(', ');
  const examples = entries
    .slice(0, MAX_SKIP_EXAMPLES)
    .map((entry) => `${entry.lockfile}: ${entry.name} (${entry.reason})`)
    .join('; ');
  const more =
    entries.length > MAX_SKIP_EXAMPLES ? `; and ${entries.length - MAX_SKIP_EXAMPLES} more` : '';
  const noun = entries.length === 1 ? 'dependency' : 'dependencies';

  return `Skipped ${entries.length} non-registry ${noun} (${reasons}): ${examples}${more}.`;
}

// ============================================================================
// Python
// ============================================================================

interface DeclaredNames {
  /** Normalized names declared as runtime (or optional) dependencies. */
  prod: Set<string>;
  /** Normalized names declared only in dev groups. */
  dev: Set<string>;
  /** Normalized names of the project itself and its workspace members. */
  local: Set<string>;
}

function emptyDeclared(): DeclaredNames {
  return { prod: new Set(), dev: new Set(), local: new Set() };
}

function declaredDirect(declared: DeclaredNames, name: string): { direct: boolean; dev: boolean } {
  const prod = declared.prod.has(name);
  const dev = declared.dev.has(name);
  return { direct: prod || dev, dev: dev && !prod };
}

/** The distribution name of a PEP 508 requirement string, normalized. */
export function parsePep508Name(requirement: string): string | undefined {
  const match = /^\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/.exec(requirement);
  return match?.[1] === undefined ? undefined : normalizePypiName(match[1]);
}

function addRequirementList(target: Set<string>, value: unknown): void {
  for (const item of arrayValue(value)) {
    const name = typeof item === 'string' ? parsePep508Name(item) : undefined;

    if (name) {
      target.add(name);
    }
  }
}

function addRequirementTable(target: Set<string>, value: unknown): void {
  for (const key of Object.keys(recordValue(value))) {
    const name = parsePep508Name(key);

    if (name && name !== 'python') {
      target.add(name);
    }
  }
}

function addPyprojectDeclarations(
  declared: DeclaredNames,
  pyproject: Record<string, unknown>
): void {
  const project = recordValue(pyproject.project);
  const tool = recordValue(pyproject.tool);
  const poetry = recordValue(tool.poetry);
  const projectName = stringValue(project.name) ?? stringValue(poetry.name);

  if (projectName) {
    declared.local.add(normalizePypiName(projectName));
  }

  addRequirementList(declared.prod, project.dependencies);

  for (const group of Object.values(recordValue(project['optional-dependencies']))) {
    addRequirementList(declared.prod, group);
  }

  for (const group of Object.values(recordValue(pyproject['dependency-groups']))) {
    addRequirementList(declared.dev, group);
  }

  addRequirementList(declared.dev, recordValue(tool.uv)['dev-dependencies']);
  addRequirementTable(declared.prod, poetry.dependencies);
  addRequirementTable(declared.dev, poetry['dev-dependencies']);

  for (const group of Object.values(recordValue(poetry.group))) {
    addRequirementTable(declared.dev, recordValue(group).dependencies);
  }

  for (const group of Object.values(recordValue(recordValue(tool.pdm)['dev-dependencies']))) {
    addRequirementList(declared.dev, group);
  }
}

/**
 * Names declared by `pyproject.toml` next to a Python lockfile, plus the
 * members of a uv workspace (`tool.uv.workspace.members`).
 */
async function readPyprojectDeclarations(
  directory: string,
  result: LockfileResult
): Promise<DeclaredNames | undefined> {
  const pyproject = await readTomlIfExists(join(directory, 'pyproject.toml'));

  if (!pyproject) {
    return undefined;
  }

  const declared = emptyDeclared();
  addPyprojectDeclarations(declared, pyproject);

  const workspace = recordValue(recordValue(recordValue(pyproject.tool).uv).workspace);
  const memberPatterns = arrayValue(workspace.members).filter(isNonEmptyString);
  const excludePatterns = arrayValue(workspace.exclude)
    .filter(isNonEmptyString)
    .map((pattern) => `!${pattern}`);

  if (memberPatterns.length > 0) {
    const expansion = await expandWorkspacePatterns(directory, [
      ...memberPatterns,
      ...excludePatterns,
    ]);
    result.warnings.push(...expansion.warnings);

    for (const member of expansion.members) {
      const memberPyproject = await readTomlIfExists(
        join(directory, ...member.split('/'), 'pyproject.toml')
      );

      if (memberPyproject) {
        addPyprojectDeclarations(declared, memberPyproject);
      }
    }
  }

  return declared;
}

function missingManifestWarning(manifest: string): string {
  return `no ${manifest} next to the lockfile, so no dependency is marked direct.`;
}

function pypiDependency(
  context: LockfileContext,
  name: string,
  version: string,
  flags: { direct: boolean; dev: boolean }
): ResolvedDependency {
  return {
    ecosystem: 'pypi',
    name: normalizePypiName(name),
    version,
    direct: flags.direct,
    dev: flags.dev,
    lockfile: context.lockfile,
  };
}

async function parseUvLock(context: LockfileContext): Promise<LockfileResult> {
  const result = createLockfileResult();
  const lock = parseToml(context.text);
  const declared = await readPyprojectDeclarations(context.directory, result);

  if (!declared) {
    result.warnings.push(missingManifestWarning('pyproject.toml'));
  }

  for (const entry of arrayValue(lock.package)) {
    const pkg = recordValue(entry);
    const name = stringValue(pkg.name);
    const version = stringValue(pkg.version);
    const source = recordValue(pkg.source);

    if (!name) {
      continue;
    }

    const normalized = normalizePypiName(name);

    if (isNonEmptyString(source.registry) && version) {
      result.dependencies.push(
        pypiDependency(
          context,
          name,
          version,
          declaredDirect(declared ?? emptyDeclared(), normalized)
        )
      );
      continue;
    }

    if (
      (isNonEmptyString(source.editable) || isNonEmptyString(source.virtual)) &&
      declared?.local.has(normalized)
    ) {
      continue;
    }

    result.skipped.push({ name: normalized, reason: pythonSkipReason(source) });
  }

  return result;
}

function pythonSkipReason(source: Record<string, unknown>): SkipReason {
  if (source.git !== undefined) {
    return 'git';
  }

  if (source.url !== undefined) {
    return 'url';
  }

  return 'path';
}

async function parsePoetryLock(context: LockfileContext): Promise<LockfileResult> {
  const result = createLockfileResult();
  const lock = parseToml(context.text);
  const declared = await readPyprojectDeclarations(context.directory, result);

  if (!declared) {
    result.warnings.push(missingManifestWarning('pyproject.toml'));
  }

  for (const entry of arrayValue(lock.package)) {
    const pkg = recordValue(entry);
    const name = stringValue(pkg.name);
    const version = stringValue(pkg.version);
    const sourceType = stringValue(recordValue(pkg.source).type);

    if (!name || !version) {
      continue;
    }

    const normalized = normalizePypiName(name);

    if (sourceType === 'git' || sourceType === 'directory' || sourceType === 'file') {
      result.skipped.push({ name: normalized, reason: sourceType === 'git' ? 'git' : 'path' });
      continue;
    }

    if (sourceType === 'url') {
      result.skipped.push({ name: normalized, reason: 'url' });
      continue;
    }

    const flags = declaredDirect(declared ?? emptyDeclared(), normalized);
    // Poetry before 1.5 recorded `category = "dev"` per package.
    const dev = flags.direct ? flags.dev : pkg.category === 'dev';
    result.dependencies.push(pypiDependency(context, name, version, { direct: flags.direct, dev }));
  }

  return result;
}

async function parsePdmLock(context: LockfileContext): Promise<LockfileResult> {
  const result = createLockfileResult();
  const lock = parseToml(context.text);
  const declared = await readPyprojectDeclarations(context.directory, result);

  if (!declared) {
    result.warnings.push(missingManifestWarning('pyproject.toml'));
  }

  for (const entry of arrayValue(lock.package)) {
    const pkg = recordValue(entry);
    const rawName = stringValue(pkg.name);
    const version = stringValue(pkg.version);
    const name = rawName === undefined ? undefined : parsePep508Name(rawName);

    if (!name) {
      continue;
    }

    if (pkg.git !== undefined || pkg.path !== undefined || pkg.url !== undefined || !version) {
      if (declared?.local.has(name)) {
        continue;
      }

      result.skipped.push({
        name,
        reason: pkg.git !== undefined ? 'git' : pkg.url !== undefined ? 'url' : 'path',
      });
      continue;
    }

    const flags = declaredDirect(declared ?? emptyDeclared(), name);
    const groups = arrayValue(pkg.groups).filter(isNonEmptyString);
    const dev = flags.direct ? flags.dev : groups.length > 0 && !groups.includes('default');
    result.dependencies.push(pypiDependency(context, name, version, { direct: flags.direct, dev }));
  }

  return result;
}

async function parsePipfileLock(context: LockfileContext): Promise<LockfileResult> {
  const result = createLockfileResult();
  const lock = recordValue(JSON.parse(context.text));
  const pipfile = await readTomlIfExists(join(context.directory, 'Pipfile'));
  const declared = emptyDeclared();

  if (pipfile) {
    addRequirementTable(declared.prod, pipfile.packages);
    addRequirementTable(declared.dev, pipfile['dev-packages']);
  } else {
    result.warnings.push(missingManifestWarning('Pipfile'));
  }

  for (const section of ['default', 'develop'] as const) {
    for (const [rawName, value] of Object.entries(recordValue(lock[section]))) {
      const entry = recordValue(value);
      const name = parsePep508Name(rawName);

      if (!name) {
        continue;
      }

      if (entry.git !== undefined) {
        result.skipped.push({ name, reason: 'git' });
        continue;
      }

      if (entry.path !== undefined || entry.file !== undefined) {
        result.skipped.push({ name, reason: entry.file !== undefined ? 'url' : 'path' });
        continue;
      }

      const version = stringValue(entry.version)?.replace(/^===?/, '');

      if (!version) {
        continue;
      }

      const flags = declaredDirect(declared, name);
      const dev = flags.direct ? flags.dev : section === 'develop';
      result.dependencies.push(
        pypiDependency(context, name, version, { direct: flags.direct, dev })
      );
    }
  }

  return result;
}

const REQUIREMENT_PIN_PATTERN =
  /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(?:\[[^\]]*\])?\s*===?\s*([^\s;,#*]+)$/;

/**
 * `requirements*.txt`: only exact `name==version` pins count. Options (`-r`,
 * `--hash`, `-e`), comments, environment markers after `;`, and backslash
 * continuations (pip-compile's hash lines) are stripped first.
 */
async function parseRequirementsTxt(context: LockfileContext): Promise<LockfileResult> {
  const result = createLockfileResult();
  const fileName = posix.basename(context.lockfile);
  const dev = /(?:^|[-_.])(?:dev|test|tests|lint|docs)(?:[-_.]|$)/.test(
    fileName.replace(/\.txt$/, '')
  );
  const logicalLines = context.text.replace(/\\\r?\n/g, ' ').split(/\r?\n/);

  for (const rawLine of logicalLines) {
    const withoutComment = rawLine.replace(/(?:^|\s)#.*$/, '');
    const requirement = withoutComment
      .split(';')[0]
      ?.replace(/\s--?[a-z][\w-]*(?:[= ]\S+)?/g, '')
      .trim();

    if (!requirement || requirement.startsWith('-')) {
      continue;
    }

    const match = REQUIREMENT_PIN_PATTERN.exec(requirement);

    if (match?.[1] === undefined || match[2] === undefined) {
      continue;
    }

    result.dependencies.push(pypiDependency(context, match[1], match[2], { direct: true, dev }));
  }

  return result;
}

// ============================================================================
// Cargo
// ============================================================================

const CRATES_IO_SOURCES = new Set([
  'registry+https://github.com/rust-lang/crates.io-index',
  'sparse+https://index.crates.io/',
]);

const CARGO_DEPENDENCY_TABLES = ['dependencies', 'dev-dependencies', 'build-dependencies'] as const;

interface CargoDeclarations {
  localNames: Set<string>;
  prod: Set<string>;
  dev: Set<string>;
}

function addCargoDependencyTable(target: Set<string>, table: unknown): void {
  for (const [key, value] of Object.entries(recordValue(table))) {
    const renamed = stringValue(recordValue(value).package);
    target.add(renamed ?? key);
  }
}

function addCargoManifest(
  declarations: CargoDeclarations,
  manifest: Record<string, unknown>
): void {
  const packageName = stringValue(recordValue(manifest.package).name);

  if (packageName) {
    declarations.localNames.add(packageName);
  }

  const tables = [manifest, ...Object.values(recordValue(manifest.target)).map(recordValue)];

  for (const table of tables) {
    for (const kind of CARGO_DEPENDENCY_TABLES) {
      addCargoDependencyTable(
        kind === 'dev-dependencies' ? declarations.dev : declarations.prod,
        table[kind]
      );
    }
  }
}

async function readCargoDeclarations(
  directory: string,
  result: LockfileResult
): Promise<CargoDeclarations | undefined> {
  const manifest = await readTomlIfExists(join(directory, 'Cargo.toml'));

  if (!manifest) {
    return undefined;
  }

  const declarations: CargoDeclarations = {
    localNames: new Set(),
    prod: new Set(),
    dev: new Set(),
  };
  addCargoManifest(declarations, manifest);

  const workspace = recordValue(manifest.workspace);
  const expansion = await expandWorkspacePatterns(directory, [
    ...arrayValue(workspace.members).filter(isNonEmptyString),
    ...arrayValue(workspace.exclude)
      .filter(isNonEmptyString)
      .map((pattern) => `!${pattern}`),
  ]);
  result.warnings.push(...expansion.warnings);

  for (const member of expansion.members) {
    const memberManifest = await readTomlIfExists(
      join(directory, ...member.split('/'), 'Cargo.toml')
    );

    if (memberManifest) {
      addCargoManifest(declarations, memberManifest);
    }
  }

  return declarations;
}

/**
 * `Cargo.lock` v1 to v4. Directness comes from the lockfile itself: each
 * workspace member's `dependencies` list names the exact crates (and, when a
 * name is ambiguous, the version) it uses. `Cargo.toml` supplies the member
 * names and which of them are dev-only.
 */
async function parseCargoLock(context: LockfileContext): Promise<LockfileResult> {
  const result = createLockfileResult();
  const lock = parseToml(context.text);
  const declarations = await readCargoDeclarations(context.directory, result);
  const packages = arrayValue(lock.package).map(recordValue);
  const versionsByName = new Map<string, Set<string>>();

  if (!declarations) {
    result.warnings.push(
      'no Cargo.toml next to the lockfile; local crates are treated as the workspace.'
    );
  }

  for (const pkg of packages) {
    const name = stringValue(pkg.name);
    const version = stringValue(pkg.version);

    if (name && version) {
      const versions = versionsByName.get(name) ?? new Set<string>();
      versions.add(version);
      versionsByName.set(name, versions);
    }
  }

  const isMember = (pkg: Record<string, unknown>): boolean => {
    const name = stringValue(pkg.name);
    return (
      pkg.source === undefined &&
      name !== undefined &&
      (declarations === undefined || declarations.localNames.has(name))
    );
  };

  const directKeys = new Set<string>();

  for (const member of packages.filter(isMember)) {
    for (const reference of arrayValue(member.dependencies).filter(isNonEmptyString)) {
      const [name, version] = reference.split(' ');

      if (!name) {
        continue;
      }

      const versions = version ? [version] : [...(versionsByName.get(name) ?? [])];

      for (const candidate of versions) {
        directKeys.add(`${name}@${candidate}`);
      }
    }
  }

  for (const pkg of packages) {
    const name = stringValue(pkg.name);
    const version = stringValue(pkg.version);
    const source = stringValue(pkg.source);

    if (!name || !version) {
      continue;
    }

    if (source === undefined) {
      if (!isMember(pkg)) {
        result.skipped.push({ name, reason: 'path' });
      }

      continue;
    }

    if (source.startsWith('git+')) {
      result.skipped.push({ name, reason: 'git' });
      continue;
    }

    if (!CRATES_IO_SOURCES.has(source)) {
      result.skipped.push({ name, reason: 'alternate-registry' });
      continue;
    }

    const direct = directKeys.has(`${name}@${version}`);
    const dev =
      direct &&
      declarations !== undefined &&
      declarations.dev.has(name) &&
      !declarations.prod.has(name);
    result.dependencies.push({
      ecosystem: 'cargo',
      name,
      version,
      direct,
      dev,
      lockfile: context.lockfile,
    });
  }

  return result;
}

// ============================================================================
// Go
// ============================================================================

function goRepositoryUrl(modulePath: string): string | undefined {
  const segments = modulePath.split('/');

  if (
    segments.length >= 3 &&
    (segments[0] === 'github.com' ||
      segments[0] === 'gitlab.com' ||
      segments[0] === 'bitbucket.org')
  ) {
    return `https://${segments.slice(0, 3).join('/')}`;
  }

  return undefined;
}

function unquoteGoToken(token: string): string {
  return token.replace(/^"(.*)"$/, '$1').replace(/^`(.*)`$/, '$1');
}

/**
 * `go.mod` require directives, block and single-line forms. A module named on
 * the left of a `replace` directive (any version, or the exact version given)
 * is skipped: the build uses the replacement, not the registry release.
 */
async function parseGoMod(context: LockfileContext): Promise<LockfileResult> {
  const result = createLockfileResult();
  const requires: { path: string; version: string; indirect: boolean }[] = [];
  const replaced: { path: string; version: string | undefined }[] = [];
  let block: string | undefined;

  for (const rawLine of context.text.split(/\r?\n/)) {
    const commentIndex = rawLine.indexOf('//');
    const comment = commentIndex >= 0 ? rawLine.slice(commentIndex + 2) : '';
    const line = (commentIndex >= 0 ? rawLine.slice(0, commentIndex) : rawLine).trim();

    if (line === '') {
      continue;
    }

    if (block !== undefined) {
      if (line === ')') {
        block = undefined;
        continue;
      }

      handleGoDirective(block, line, comment);
      continue;
    }

    const blockMatch = /^(\w+)\s*\($/.exec(line);

    if (blockMatch?.[1] !== undefined) {
      block = blockMatch[1];
      continue;
    }

    const directiveMatch = /^(\w+)\s+(.+)$/.exec(line);

    if (directiveMatch?.[1] !== undefined && directiveMatch[2] !== undefined) {
      handleGoDirective(directiveMatch[1], directiveMatch[2], comment);
    }
  }

  function handleGoDirective(directive: string, body: string, comment: string): void {
    if (directive === 'require') {
      const [path, version] = body.split(/\s+/).map(unquoteGoToken);

      if (path && version) {
        requires.push({ path, version, indirect: /(?:^|;)\s*indirect\b/.test(comment.trim()) });
      }
    } else if (directive === 'replace') {
      const [left] = body.split('=>');
      const [path, version] = (left ?? '').trim().split(/\s+/).map(unquoteGoToken);

      if (path) {
        replaced.push({ path, version });
      }
    }
  }

  for (const requirement of requires) {
    const isReplaced = replaced.some(
      (entry) =>
        entry.path === requirement.path &&
        (entry.version === undefined || entry.version === requirement.version)
    );

    if (isReplaced) {
      result.skipped.push({ name: requirement.path, reason: 'replaced' });
      continue;
    }

    const repositoryUrl = goRepositoryUrl(requirement.path);
    result.dependencies.push({
      ecosystem: 'go',
      name: requirement.path,
      version: requirement.version,
      direct: !requirement.indirect,
      dev: false,
      lockfile: context.lockfile,
      ...(repositoryUrl === undefined ? {} : { repositoryUrl }),
    });
  }

  return result;
}

// ============================================================================
// pub (Dart, Flutter)
// ============================================================================

const PUB_HOSTS = new Set(['https://pub.dev', 'https://pub.dartlang.org']);

async function parsePubspecLock(context: LockfileContext): Promise<LockfileResult> {
  const result = createLockfileResult();
  const lock = recordValue(parseYamlStrings(context.text));

  for (const [name, value] of Object.entries(recordValue(lock.packages))) {
    const entry = recordValue(value);
    const source = stringValue(entry.source);
    const version = stringValue(entry.version);
    const dependency = stringValue(entry.dependency) ?? '';

    if (source === 'sdk') {
      continue;
    }

    if (source === 'git' || source === 'path') {
      result.skipped.push({ name, reason: source });
      continue;
    }

    if (source !== 'hosted' || !version) {
      result.skipped.push({ name, reason: 'url' });
      continue;
    }

    const host = stringValue(recordValue(entry.description).url)?.replace(/\/+$/, '');

    if (host !== undefined && !PUB_HOSTS.has(host)) {
      result.skipped.push({ name, reason: 'alternate-registry' });
      continue;
    }

    result.dependencies.push({
      ecosystem: 'pub',
      name,
      version,
      direct: dependency.startsWith('direct'),
      dev: dependency === 'direct dev',
      lockfile: context.lockfile,
    });
  }

  return result;
}

// ============================================================================
// SwiftPM
// ============================================================================

/** SwiftPM's package identity: the last URL path component, lowercased, without `.git`. */
export function swiftPackageIdentity(location: string): string {
  const trimmed = location.replace(/\/+$/, '').replace(/\.git$/i, '');
  const lastSegment = trimmed.split(/[/:]/).at(-1) ?? trimmed;
  return lastSegment.toLowerCase();
}

/**
 * Identities declared by `Package.swift` through `.package(url: "...")` or
 * `.package(id: "...")`, or undefined when the manifest is missing or declares
 * packages in a form a regex cannot read (computed URLs, variables).
 */
async function readSwiftDeclaredIdentities(directory: string): Promise<Set<string> | undefined> {
  const manifest = await readTextIfExists(join(directory, 'Package.swift'));

  if (manifest === undefined) {
    return undefined;
  }

  const withoutComments = manifest.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const declarations = withoutComments.match(/\.package\s*\(/g)?.length ?? 0;
  const identities = new Set<string>();
  let parsed = 0;

  for (const match of withoutComments.matchAll(
    /\.package\s*\(\s*(?:name\s*:\s*"[^"]*"\s*,\s*)?(url|id|path)\s*:\s*"([^"]+)"/g
  )) {
    parsed++;
    const kind = match[1];
    const value = match[2];

    if (value === undefined || kind === 'path') {
      continue;
    }

    identities.add(kind === 'id' ? value.toLowerCase() : swiftPackageIdentity(value));
  }

  return parsed === declarations ? identities : undefined;
}

async function parsePackageResolved(context: LockfileContext): Promise<LockfileResult> {
  const result = createLockfileResult();
  const resolved = recordValue(JSON.parse(context.text));
  const formatVersion = resolved.version;
  const pins =
    formatVersion === 1 ? arrayValue(recordValue(resolved.object).pins) : arrayValue(resolved.pins);

  if (formatVersion !== 1 && formatVersion !== 2 && formatVersion !== 3) {
    result.warnings.push(
      `Package.resolved format version ${String(formatVersion)} is not known; read as version 2.`
    );
  }

  const declared = await readSwiftDeclaredIdentities(context.directory);

  if (!declared) {
    result.warnings.push(
      'no parsable Package.swift next to Package.resolved; every pin is treated as a direct dependency.'
    );
  }

  for (const value of pins) {
    const pin = recordValue(value);
    const location = stringValue(pin.repositoryURL) ?? stringValue(pin.location);
    const kind = stringValue(pin.kind);
    const identity =
      stringValue(pin.identity)?.toLowerCase() ??
      (location === undefined ? undefined : swiftPackageIdentity(location));
    const version = stringValue(recordValue(pin.state).version);

    if (!identity) {
      continue;
    }

    if (kind === 'localSourceControl' || kind === 'fileSystem') {
      result.skipped.push({ name: identity, reason: 'path' });
      continue;
    }

    if (!version) {
      result.skipped.push({ name: identity, reason: 'revision-only' });
      continue;
    }

    const repositoryUrl = kind === 'registry' ? undefined : location;
    result.dependencies.push({
      ecosystem: 'swiftpm',
      name: identity,
      version,
      direct: declared === undefined || declared.has(identity),
      dev: false,
      lockfile: context.lockfile,
      ...(repositoryUrl === undefined ? {} : { repositoryUrl }),
    });
  }

  return result;
}
