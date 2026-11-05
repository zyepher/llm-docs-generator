import { join } from 'node:path';

import { parse as parseJsonc, type ParseError } from 'jsonc-parser';

import { isNonEmptyString, isRecord } from '../utils/guards.js';
import {
  arrayValue,
  createLockfileResult,
  expandWorkspacePatterns,
  isExactSemver,
  parseYamlStrings,
  readJsonIfExists,
  recordValue,
  stringValue,
  type LockfileContext,
  type LockfileResult,
  type ResolvedDependency,
  type SkipReason,
} from './lockfiles.js';

/**
 * npm-family lockfiles: package-lock.json / npm-shrinkwrap.json, pnpm-lock.yaml,
 * yarn.lock (classic and berry), and bun.lock. Every format resolves to the
 * same shape: one registry (name, version) per installed package, direct when
 * the root package.json or a workspace member declares it.
 */

const NPM_DECLARATION_FIELDS = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'devDependencies',
] as const;

interface NpmDeclarations {
  /** name -> declared ranges and whether every declaration is a devDependency. */
  byName: Map<string, { ranges: Set<string>; dev: boolean }>;
}

function emptyNpmDeclarations(): NpmDeclarations {
  return { byName: new Map() };
}

function addNpmDeclarations(declarations: NpmDeclarations, manifest: unknown): void {
  const record = recordValue(manifest);

  for (const field of NPM_DECLARATION_FIELDS) {
    for (const [name, range] of Object.entries(recordValue(record[field]))) {
      const existing = declarations.byName.get(name);
      const dev = field === 'devDependencies';
      const ranges = existing?.ranges ?? new Set<string>();

      if (typeof range === 'string') {
        ranges.add(range);
      }

      declarations.byName.set(name, { ranges, dev: existing ? existing.dev && dev : dev });
    }
  }
}

function npmDependency(
  context: LockfileContext,
  name: string,
  version: string,
  flags: { direct: boolean; dev: boolean }
): ResolvedDependency {
  return {
    ecosystem: 'npm',
    name,
    version,
    direct: flags.direct,
    dev: flags.dev,
    lockfile: context.lockfile,
  };
}

/** Classify a non-registry version or specifier (`file:`, `git+ssh:`, `github:`, a URL). */
function npmSpecifierSkipReason(specifier: string): SkipReason {
  if (/^(?:file|link|portal):/.test(specifier)) {
    return 'path';
  }

  if (specifier.startsWith('workspace:')) {
    return 'workspace';
  }

  if (/^https?:/.test(specifier) && !/codeload\.github\.com|\.git(?:#|$)/.test(specifier)) {
    return 'url';
  }

  return 'git';
}

/** A tarball URL from a registry has the `/<name>/-/<file>.tgz` layout. */
function isRegistryTarball(resolved: string | undefined): boolean {
  return resolved === undefined || resolved.includes('/-/');
}

/** Split `name@version`, keeping the leading `@` of a scoped name. */
function splitNameAtVersion(value: string): { name: string; version: string } | undefined {
  const at = value.indexOf('@', value.startsWith('@') ? 1 : 0);

  if (at <= 0) {
    return undefined;
  }

  return { name: value.slice(0, at), version: value.slice(at + 1) };
}

// ============================================================================
// package-lock.json and npm-shrinkwrap.json
// ============================================================================

export async function parseNpmPackageLock(context: LockfileContext): Promise<LockfileResult> {
  const lock = recordValue(JSON.parse(context.text));

  if (isRecord(lock.packages)) {
    return parseNpmPackagesTree(context, lock.packages);
  }

  return parseNpmLegacyTree(context, recordValue(lock.dependencies));
}

/**
 * lockfileVersion 2 and 3: the flat `packages` map keyed by install path. The
 * root (`""`) and workspace members (keys without a `node_modules/` segment)
 * carry their own declarations, so directness needs no package.json read.
 */
function parseNpmPackagesTree(
  context: LockfileContext,
  packages: Record<string, unknown>
): LockfileResult {
  const result = createLockfileResult();
  const importers = new Map<string, NpmDeclarations>();

  for (const [path, value] of Object.entries(packages)) {
    if (!path.split('/').includes('node_modules')) {
      const declarations = emptyNpmDeclarations();
      addNpmDeclarations(declarations, value);
      importers.set(path, declarations);
    }
  }

  for (const [path, value] of Object.entries(packages)) {
    const marker = path.lastIndexOf('node_modules/');

    if (marker < 0) {
      continue;
    }

    const entry = recordValue(value);
    const installedName = path.slice(marker + 'node_modules/'.length);
    const parent = path.slice(0, marker).replace(/\/$/, '');
    const version = stringValue(entry.version);
    const resolved = stringValue(entry.resolved);
    const declaredName = stringValue(entry.name);

    if (entry.link === true) {
      result.skipped.push({
        name: installedName,
        reason: resolved !== undefined && importers.has(resolved) ? 'workspace' : 'path',
      });
      continue;
    }

    if (declaredName !== undefined && declaredName !== installedName) {
      result.skipped.push({ name: installedName, reason: 'alias' });
      continue;
    }

    if (version === undefined || !isExactSemver(version)) {
      result.skipped.push({
        name: installedName,
        reason: npmSpecifierSkipReason(version ?? resolved ?? ''),
      });
      continue;
    }

    if (!isRegistryTarball(resolved)) {
      result.skipped.push({ name: installedName, reason: npmSpecifierSkipReason(resolved ?? '') });
      continue;
    }

    const parentImporter = importers.get(parent);
    const direct =
      (parentImporter?.byName.has(installedName) ?? false) ||
      // A member's dependency is hoisted to the root node_modules.
      (parent === '' &&
        [...importers.values()].some((declarations) => declarations.byName.has(installedName)));

    result.dependencies.push(
      npmDependency(context, installedName, version, { direct, dev: entry.dev === true })
    );
  }

  return result;
}

/** lockfileVersion 1: the nested `dependencies` tree, with package.json for directness. */
async function parseNpmLegacyTree(
  context: LockfileContext,
  dependencies: Record<string, unknown>
): Promise<LockfileResult> {
  const result = createLockfileResult();
  const manifest = await readJsonIfExists(join(context.directory, 'package.json'));
  const declarations = emptyNpmDeclarations();

  if (manifest === undefined) {
    result.warnings.push(
      'no package.json next to the lockfile, so no dependency is marked direct.'
    );
  } else {
    addNpmDeclarations(declarations, manifest);
  }

  const visit = (tree: Record<string, unknown>, topLevel: boolean): void => {
    for (const [name, value] of Object.entries(tree)) {
      const entry = recordValue(value);
      const version = stringValue(entry.version) ?? '';
      const resolved = stringValue(entry.resolved);

      if (version.startsWith('npm:')) {
        result.skipped.push({ name, reason: 'alias' });
      } else if (!isExactSemver(version)) {
        result.skipped.push({ name, reason: npmSpecifierSkipReason(version) });
      } else if (!isRegistryTarball(resolved)) {
        result.skipped.push({ name, reason: npmSpecifierSkipReason(resolved ?? '') });
      } else {
        result.dependencies.push(
          npmDependency(context, name, version, {
            direct: topLevel && declarations.byName.has(name),
            dev: entry.dev === true,
          })
        );
      }

      visit(recordValue(entry.dependencies), false);
    }
  };

  visit(dependencies, true);
  return result;
}

// ============================================================================
// pnpm-lock.yaml
// ============================================================================

function stripPeerSuffix(version: string): string {
  const parenthesis = version.indexOf('(');
  return parenthesis >= 0 ? version.slice(0, parenthesis) : version;
}

/**
 * pnpm lockfile v6 (`6.0`, `6.1`), v7 (pnpm 9 prereleases), and v9. Direct
 * dependencies come from `importers` (or the top-level maps of a v6
 * single-package lockfile); every package comes from `packages`, whose keys
 * are `/name@version(peers)` in v6 and `name@version` in v9.
 */
export async function parsePnpmLock(context: LockfileContext): Promise<LockfileResult> {
  const result = createLockfileResult();
  const lock = recordValue(parseYamlStrings(context.text));
  const lockfileVersion = Number.parseFloat(stringValue(lock.lockfileVersion) ?? '');

  if (!Number.isFinite(lockfileVersion) || lockfileVersion < 6) {
    result.warnings.push(
      `pnpm lockfileVersion ${String(lock.lockfileVersion)} is not supported (6.0 or later is); skipped.`
    );
    return result;
  }

  const importers = isRecord(lock.importers) ? Object.values(lock.importers) : [lock];
  const direct = new Map<string, { dev: boolean }>();

  for (const importer of importers.map(recordValue)) {
    for (const field of NPM_DECLARATION_FIELDS) {
      for (const [name, value] of Object.entries(recordValue(importer[field]))) {
        // v6 single-package lockfiles without `specifier` blocks use `name: version`.
        const raw = isRecord(value) ? stringValue(value.version) : stringValue(value);

        if (raw === undefined) {
          continue;
        }

        const version = stripPeerSuffix(raw);

        if (!isExactSemver(version)) {
          const aliased = splitNameAtVersion(version.replace(/^\//, ''));

          if (aliased !== undefined && isExactSemver(aliased.version)) {
            result.skipped.push({ name, reason: aliased.name === name ? 'url' : 'alias' });
          } else {
            result.skipped.push({ name, reason: npmSpecifierSkipReason(version) });
          }

          continue;
        }

        const key = `${name}@${version}`;
        const dev = field === 'devDependencies';
        const existing = direct.get(key);
        direct.set(key, { dev: existing ? existing.dev && dev : dev });
        result.dependencies.push(npmDependency(context, name, version, { direct: true, dev }));
      }
    }
  }

  for (const [key, value] of Object.entries(recordValue(lock.packages))) {
    const entry = recordValue(value);
    const parsed = splitNameAtVersion(stripPeerSuffix(key.replace(/^\//, '')));
    const resolution = recordValue(entry.resolution);
    const fallbackName = stringValue(entry.name) ?? key;

    if (parsed === undefined) {
      result.skipped.push({ name: fallbackName, reason: npmSpecifierSkipReason(key) });
      continue;
    }

    if (resolution.type === 'git' || resolution.type === 'directory') {
      result.skipped.push({
        name: parsed.name,
        reason: resolution.type === 'git' ? 'git' : 'path',
      });
      continue;
    }

    if (!isExactSemver(parsed.version)) {
      result.skipped.push({ name: parsed.name, reason: npmSpecifierSkipReason(parsed.version) });
      continue;
    }

    const tarball = stringValue(resolution.tarball);

    if (tarball !== undefined && !isRegistryTarball(tarball)) {
      result.skipped.push({ name: parsed.name, reason: npmSpecifierSkipReason(tarball) });
      continue;
    }

    const directEntry = direct.get(`${parsed.name}@${parsed.version}`);
    result.dependencies.push(
      npmDependency(context, parsed.name, parsed.version, {
        direct: directEntry !== undefined,
        dev: directEntry?.dev ?? entry.dev === 'true',
      })
    );
  }

  return result;
}

// ============================================================================
// yarn.lock (classic v1 and berry)
// ============================================================================

export async function parseYarnLock(context: LockfileContext): Promise<LockfileResult> {
  return /^__metadata:/m.test(context.text) ? parseYarnBerry(context) : parseYarnClassic(context);
}

interface YarnClassicEntry {
  descriptors: string[];
  fields: Map<string, string>;
}

function unquoteYarnToken(token: string): string {
  if (token.length >= 2 && token.startsWith('"') && token.endsWith('"')) {
    return token.slice(1, -1).replace(/\\(.)/g, '$1');
  }

  return token;
}

function splitYarnDescriptors(header: string): string[] {
  const descriptors: string[] = [];
  let current = '';
  let quoted = false;

  for (const character of header) {
    if (character === '"') {
      quoted = !quoted;
    }

    if (character === ',' && !quoted) {
      descriptors.push(unquoteYarnToken(current.trim()));
      current = '';
      continue;
    }

    current += character;
  }

  if (current.trim() !== '') {
    descriptors.push(unquoteYarnToken(current.trim()));
  }

  return descriptors;
}

/**
 * The yarn v1 lockfile format: unindented `descriptor, descriptor:` headers,
 * two-space `key value` fields, and deeper-indented nested maps (dependency
 * lists) that this reader does not need and skips.
 */
function parseYarnClassicEntries(text: string): YarnClassicEntry[] {
  const entries: YarnClassicEntry[] = [];
  let current: YarnClassicEntry | undefined;

  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      continue;
    }

    if (!line.startsWith(' ')) {
      if (line.endsWith(':')) {
        current = { descriptors: splitYarnDescriptors(line.slice(0, -1)), fields: new Map() };
        entries.push(current);
      } else {
        current = undefined;
      }

      continue;
    }

    if (!current || line.startsWith('    ')) {
      continue;
    }

    const match = /^ {2}("(?:[^"\\]|\\.)*"|\S+)\s+(.+)$/.exec(line);

    if (match?.[1] !== undefined && match[2] !== undefined) {
      current.fields.set(unquoteYarnToken(match[1]), unquoteYarnToken(match[2].trim()));
    }
  }

  return entries;
}

/** Root package.json plus every workspace member's (yarn and npm `workspaces` field). */
async function readNpmWorkspaceDeclarations(
  context: LockfileContext,
  result: LockfileResult
): Promise<NpmDeclarations | undefined> {
  const manifest = await readJsonIfExists(join(context.directory, 'package.json'));

  if (manifest === undefined) {
    result.warnings.push(
      'no package.json next to the lockfile, so no dependency is marked direct.'
    );
    return undefined;
  }

  const declarations = emptyNpmDeclarations();
  addNpmDeclarations(declarations, manifest);

  const workspaces = recordValue(manifest).workspaces;
  const patterns = (
    Array.isArray(workspaces) ? workspaces : arrayValue(recordValue(workspaces).packages)
  ).filter(isNonEmptyString);
  const expansion = await expandWorkspacePatterns(context.directory, patterns);
  result.warnings.push(...expansion.warnings);

  for (const member of expansion.members) {
    const memberManifest = await readJsonIfExists(
      join(context.directory, ...member.split('/'), 'package.json')
    );

    if (memberManifest !== undefined) {
      addNpmDeclarations(declarations, memberManifest);
    }
  }

  return declarations;
}

async function parseYarnClassic(context: LockfileContext): Promise<LockfileResult> {
  const result = createLockfileResult();
  const declarations =
    (await readNpmWorkspaceDeclarations(context, result)) ?? emptyNpmDeclarations();
  const declaredDescriptors = new Set<string>();

  for (const [name, declaration] of declarations.byName) {
    for (const range of declaration.ranges) {
      declaredDescriptors.add(`${name}@${range}`);
    }
  }

  const candidates: { name: string; version: string; directByDescriptor: boolean }[] = [];

  for (const entry of parseYarnClassicEntries(context.text)) {
    const first = entry.descriptors[0];
    const parsed = first === undefined ? undefined : splitNameAtVersion(first);

    if (!parsed) {
      continue;
    }

    const version = entry.fields.get('version') ?? '';
    const resolved = entry.fields.get('resolved');
    const range = parsed.version;

    if (range.startsWith('npm:')) {
      const target = splitNameAtVersion(range.slice('npm:'.length));

      if (target !== undefined && target.name !== parsed.name) {
        result.skipped.push({ name: parsed.name, reason: 'alias' });
        continue;
      }
    }

    if (/^(?:file|link|portal|workspace|git\+|git:|github:|ssh:|https?:)/.test(range)) {
      result.skipped.push({ name: parsed.name, reason: npmSpecifierSkipReason(range) });
      continue;
    }

    if (!isExactSemver(version) || !isRegistryTarball(resolved)) {
      result.skipped.push({
        name: parsed.name,
        reason: npmSpecifierSkipReason(resolved ?? range),
      });
      continue;
    }

    candidates.push({
      name: parsed.name,
      version,
      directByDescriptor: entry.descriptors.some((descriptor) =>
        declaredDescriptors.has(descriptor)
      ),
    });
  }

  pushWithDeclaredFallback(context, result, declarations, candidates);
  return result;
}

/**
 * Mark entries direct by exact descriptor match; when a declared name matched
 * no descriptor (a range written differently from how the lockfile records
 * it), every entry of that name counts as direct rather than none.
 */
function pushWithDeclaredFallback(
  context: LockfileContext,
  result: LockfileResult,
  declarations: NpmDeclarations,
  candidates: { name: string; version: string; directByDescriptor: boolean }[]
): void {
  const matchedNames = new Set(
    candidates
      .filter((candidate) => candidate.directByDescriptor)
      .map((candidate) => candidate.name)
  );

  for (const candidate of candidates) {
    const declaration = declarations.byName.get(candidate.name);
    const direct =
      candidate.directByDescriptor ||
      (declaration !== undefined && !matchedNames.has(candidate.name));

    result.dependencies.push(
      npmDependency(context, candidate.name, candidate.version, {
        direct,
        dev: direct && (declaration?.dev ?? false),
      })
    );
  }
}

/** Decode berry's `patch:name@npm%3A1.2.3#...` wrapper to the patched `name@npm:1.2.3`. */
function unwrapBerryPatch(reference: string): string {
  if (!reference.startsWith('patch:')) {
    return reference;
  }

  const inner = reference.slice('patch:'.length).split('#')[0] ?? '';

  try {
    return decodeURIComponent(inner);
  } catch {
    return inner;
  }
}

/**
 * Yarn 2+ (berry) lockfiles are YAML. Workspace entries
 * (`name@workspace:path`) list their declared dependencies by descriptor, so
 * directness is an exact descriptor match; each workspace's package.json
 * supplies which of those are dev-only.
 */
async function parseYarnBerry(context: LockfileContext): Promise<LockfileResult> {
  const result = createLockfileResult();
  const lock = recordValue(parseYamlStrings(context.text));
  const declarations = emptyNpmDeclarations();
  const declaredDescriptors = new Set<string>();

  for (const [key, value] of Object.entries(lock)) {
    const entry = recordValue(value);
    const resolution = splitNameAtVersion(stringValue(entry.resolution) ?? '');

    if (key === '__metadata' || !resolution?.version.startsWith('workspace:')) {
      continue;
    }

    for (const field of ['dependencies', 'peerDependencies'] as const) {
      for (const [name, range] of Object.entries(recordValue(entry[field]))) {
        if (typeof range === 'string') {
          declaredDescriptors.add(`${name}@${range}`);
        }
      }
    }

    const workspacePath = resolution.version.slice('workspace:'.length);
    const manifest = await readJsonIfExists(
      join(
        context.directory,
        ...workspacePath.split('/').filter((part) => part !== '.'),
        'package.json'
      )
    ).catch(() => undefined);
    addNpmDeclarations(declarations, manifest);
  }

  const candidates: { name: string; version: string; directByDescriptor: boolean }[] = [];

  for (const [key, value] of Object.entries(lock)) {
    if (key === '__metadata') {
      continue;
    }

    const entry = recordValue(value);
    const descriptors = key.split(',').map((descriptor) => descriptor.trim());
    const declaredName = splitNameAtVersion(descriptors[0] ?? '')?.name;
    const resolution = splitNameAtVersion(stringValue(entry.resolution) ?? '');

    if (!declaredName || !resolution) {
      continue;
    }

    if (resolution.version.startsWith('workspace:')) {
      if (resolution.version !== 'workspace:.') {
        result.skipped.push({ name: resolution.name, reason: 'workspace' });
      }

      continue;
    }

    const unwrapped = resolution.version.startsWith('patch:')
      ? splitNameAtVersion(unwrapBerryPatch(resolution.version))
      : undefined;
    const reference = unwrapped?.version ?? resolution.version;
    const name = unwrapped?.name ?? resolution.name;

    if (name !== declaredName) {
      result.skipped.push({ name: declaredName, reason: 'alias' });
      continue;
    }

    if (!reference.startsWith('npm:') || !isExactSemver(reference.slice('npm:'.length))) {
      result.skipped.push({ name, reason: npmSpecifierSkipReason(reference) });
      continue;
    }

    candidates.push({
      name,
      version: reference.slice('npm:'.length),
      directByDescriptor: descriptors.some((descriptor) => declaredDescriptors.has(descriptor)),
    });
  }

  pushWithDeclaredFallback(context, result, declarations, candidates);
  return result;
}

// ============================================================================
// bun.lock
// ============================================================================

/** The final package name of a bun install path (`parent/@scope/child` -> `@scope/child`). */
function bunInstalledName(path: string): string {
  const segments = path.split('/');
  const last = segments.at(-1) ?? path;
  const beforeLast = segments.at(-2);
  return beforeLast?.startsWith('@') ? `${beforeLast}/${last}` : last;
}

/**
 * Bun's text lockfile (JSONC with trailing commas). `workspaces` holds every
 * member's declarations keyed by its path; `packages` maps an install path
 * (`name`, or `parent/name` when not hoisted) to `["name@version", ...]`.
 */
export async function parseBunLock(context: LockfileContext): Promise<LockfileResult> {
  const result = createLockfileResult();
  const errors: ParseError[] = [];
  const parsed: unknown = parseJsonc(context.text, errors, { allowTrailingComma: true });

  if (errors.length > 0) {
    throw new Error(`invalid JSONC at offset ${errors[0]?.offset ?? 0}`);
  }

  const lock = recordValue(parsed);
  const workspaceNames = new Set<string>();
  const declarations = emptyNpmDeclarations();

  for (const workspace of Object.values(recordValue(lock.workspaces))) {
    const name = stringValue(recordValue(workspace).name);

    if (name) {
      workspaceNames.add(name);
    }

    addNpmDeclarations(declarations, workspace);
  }

  for (const [installPath, value] of Object.entries(recordValue(lock.packages))) {
    const installedName = bunInstalledName(installPath);
    const spec = stringValue(arrayValue(value)[0]);
    const parsedSpec = spec === undefined ? undefined : splitNameAtVersion(spec);

    if (!parsedSpec) {
      continue;
    }

    if (parsedSpec.version.startsWith('workspace:')) {
      result.skipped.push({ name: installedName, reason: 'workspace' });
      continue;
    }

    if (parsedSpec.name !== installedName) {
      result.skipped.push({ name: installedName, reason: 'alias' });
      continue;
    }

    if (!isExactSemver(parsedSpec.version)) {
      result.skipped.push({
        name: installedName,
        reason: npmSpecifierSkipReason(parsedSpec.version),
      });
      continue;
    }

    const parentPath = installPath.slice(
      0,
      Math.max(0, installPath.length - installedName.length - 1)
    );
    const declaration = declarations.byName.get(installedName);
    const direct =
      declaration !== undefined && (parentPath === '' || workspaceNames.has(parentPath));

    result.dependencies.push(
      npmDependency(context, installedName, parsedSpec.version, {
        direct,
        dev: direct && declaration.dev,
      })
    );
  }

  return result;
}
