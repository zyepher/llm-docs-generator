import { stat } from 'node:fs/promises';
import { join, posix } from 'node:path';

import { parse } from 'smol-toml';

import { errorMessage, isFileNotFoundError } from '../utils/guards.js';
import { readRegularFile, RefusedFileError } from '../utils/safe-write.js';
import { compareStringsByCodeUnit } from '../utils/sort.js';
import {
  parseYamlStrings,
  recordValue,
  stringValue,
  type ResolvedDependency,
  type UnreadLockfile,
} from './lockfiles.js';

/**
 * The project's own language and toolchain versions, read from its version
 * files (`.python-version`, `go.mod`, `.nvmrc`, ...) as the `toolchain`
 * ecosystem. lockfiles.ts imports this module and this module imports
 * lockfiles.ts, so neither reads a `const` of the other at module load.
 */

export const TOOLCHAINS = ['go', 'python', 'rust', 'swift', 'dart', 'flutter', 'node'] as const;
export type Toolchain = (typeof TOOLCHAINS)[number];

interface ToolchainDeclaration {
  toolchain: Toolchain;
  version: string;
  kind: 'pin' | 'minimum';
}

const MAX_TOOLCHAIN_FILES = 200;

/**
 * A toolchain is tracked at its feature release: `major.minor`, or `major`
 * alone when that is all the text states. Channel names, ranges, and
 * pre-releases state nothing.
 */
export function toolchainVersion(text: string): string | undefined {
  const match = /^v?(\d{1,4})(?:\.(\d{1,4})(?:\.\d{1,4})?)?$/.exec(text.trim());

  if (match?.[1] === undefined) {
    return undefined;
  }

  return match[2] === undefined ? match[1] : `${match[1]}.${match[2]}`;
}

/**
 * The lowest version a constraint allows, ignoring its upper bounds and
 * exclusions. A number that continues a version (the `0` of `>=3.5.0-0`, the
 * `1` of `>=3.13.0rc1`) is part of that version's pre-release tag, not a
 * version of its own.
 */
export function minimumOf(constraint: string): string | undefined {
  let lowest: { major: number; minor: number; version: string } | undefined;

  for (const match of constraint.matchAll(
    /(?<![\w.+-])(<=|>=|!=|==|~=|<|>|=|\^|~)?\s*v?(\d{1,4}(?:\.\d{1,4}){0,2})/g
  )) {
    const operator = match[1];
    const version = match[2] === undefined ? undefined : toolchainVersion(match[2]);

    if (operator === '<' || operator === '<=' || operator === '!=' || version === undefined) {
      continue;
    }

    const [major = 0, minor = 0] = version.split('.').map(Number);

    if (
      lowest === undefined ||
      major < lowest.major ||
      (major === lowest.major && minor < lowest.minor)
    ) {
      lowest = { major, minor, version };
    }
  }

  return lowest?.version;
}

/** The feature release (`X.Y.0`) a toolchain version belongs to; a missing minor is 0. */
export function toolchainFeatureRelease(
  version: string
): { major: number; minor: number } | undefined {
  const match = /^v?(\d{1,4})(?:\.(\d{1,4}))?(?:\.\d{1,4})?$/.exec(version);

  if (match?.[1] === undefined) {
    return undefined;
  }

  return { major: Number(match[1]), minor: Number(match[2] ?? '0') };
}

// ============================================================================
// File parsers
// ============================================================================

function declaration(
  toolchain: Toolchain,
  version: string | undefined,
  kind: ToolchainDeclaration['kind']
): ToolchainDeclaration[] {
  return version === undefined ? [] : [{ toolchain, version, kind }];
}

/** The first line that is not blank and, when `skipComments`, does not start with `#`. */
function firstLine(text: string, skipComments: boolean): string | undefined {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '' && !(skipComments && line.startsWith('#')));
}

function pinFromFirstLine(toolchain: Toolchain, skipComments: boolean) {
  return (text: string): ToolchainDeclaration[] => {
    const line = firstLine(text, skipComments);
    return declaration(toolchain, line === undefined ? undefined : toolchainVersion(line), 'pin');
  };
}

function parseGoFile(text: string): ToolchainDeclaration[] {
  let toolchain: string | undefined;
  let go: string | undefined;

  for (const rawLine of text.split(/\r?\n/)) {
    const commentIndex = rawLine.indexOf('//');
    const line = (commentIndex >= 0 ? rawLine.slice(0, commentIndex) : rawLine).trim();
    const toolchainMatch = /^toolchain\s+(\S+)$/.exec(line);
    const goMatch = /^go\s+(\S+)$/.exec(line);

    if (toolchainMatch?.[1] !== undefined && toolchain === undefined) {
      toolchain = toolchainMatch[1];
    } else if (goMatch?.[1] !== undefined && go === undefined) {
      go = goMatch[1];
    }
  }

  // `toolchain default` and `toolchain local` name no version; the `go` line still does.
  const pinned =
    toolchain?.startsWith('go') === true ? toolchainVersion(toolchain.slice(2)) : undefined;

  if (pinned !== undefined) {
    return declaration('go', pinned, 'pin');
  }

  return declaration('go', go === undefined ? undefined : toolchainVersion(go), 'minimum');
}

function parsePipfile(text: string): ToolchainDeclaration[] {
  const requires = recordValue(parse(text).requires);
  const version = stringValue(requires.python_full_version) ?? stringValue(requires.python_version);
  return declaration(
    'python',
    version === undefined ? undefined : toolchainVersion(version),
    'pin'
  );
}

function parsePyproject(text: string): ToolchainDeclaration[] {
  const pyproject = parse(text);
  const constraint =
    stringValue(recordValue(pyproject.project)['requires-python']) ??
    stringValue(recordValue(recordValue(recordValue(pyproject.tool).poetry).dependencies).python);
  return declaration(
    'python',
    constraint === undefined ? undefined : minimumOf(constraint),
    'minimum'
  );
}

function parseRustToolchainToml(text: string): ToolchainDeclaration[] {
  const channel = stringValue(recordValue(parse(text).toolchain).channel);
  return declaration('rust', channel === undefined ? undefined : toolchainVersion(channel), 'pin');
}

function parseRustToolchain(text: string): ToolchainDeclaration[] {
  if (text.split(/\r?\n/).some((line) => line.trim() === '[toolchain]')) {
    return parseRustToolchainToml(text);
  }

  const line = firstLine(text, false);
  return declaration('rust', line === undefined ? undefined : toolchainVersion(line), 'pin');
}

function parseCargoToml(text: string): ToolchainDeclaration[] {
  const manifest = parse(text);
  const version =
    stringValue(recordValue(manifest.package)['rust-version']) ??
    stringValue(recordValue(recordValue(manifest.workspace).package)['rust-version']);
  return declaration(
    'rust',
    version === undefined ? undefined : toolchainVersion(version),
    'minimum'
  );
}

function parsePackageSwift(text: string): ToolchainDeclaration[] {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (line !== '' && !line.startsWith('//')) {
      break;
    }

    const match = /^\/\/\s*swift-tools-version\s*:\s*(\d+\.\d+(?:\.\d+)?)/i.exec(line);

    if (match?.[1] !== undefined) {
      return declaration('swift', toolchainVersion(match[1]), 'minimum');
    }
  }

  return [];
}

/** Dart and Flutter SDK constraints, from pubspec.yaml or pubspec.lock. */
function pubSdkMinimums(dartValue: unknown, flutterValue: unknown): ToolchainDeclaration[] {
  const dart = stringValue(dartValue);
  const flutter = stringValue(flutterValue);
  return [
    ...declaration('dart', dart === undefined ? undefined : minimumOf(dart), 'minimum'),
    ...declaration('flutter', flutter === undefined ? undefined : minimumOf(flutter), 'minimum'),
  ];
}

function parsePubspecYaml(text: string): ToolchainDeclaration[] {
  const environment = recordValue(recordValue(parseYamlStrings(text)).environment);
  return pubSdkMinimums(environment.sdk, environment.flutter);
}

function parsePubspecLock(text: string): ToolchainDeclaration[] {
  const sdks = recordValue(recordValue(parseYamlStrings(text)).sdks);
  return pubSdkMinimums(sdks.dart, sdks.flutter);
}

function parseFvmrc(text: string): ToolchainDeclaration[] {
  const flutter = stringValue(recordValue(JSON.parse(text)).flutter);
  return declaration(
    'flutter',
    flutter === undefined ? undefined : toolchainVersion(flutter),
    'pin'
  );
}

function parsePackageJson(text: string): ToolchainDeclaration[] {
  const manifest = recordValue(JSON.parse(text));
  const volta = stringValue(recordValue(manifest.volta).node);

  if (volta !== undefined) {
    return declaration('node', toolchainVersion(volta), 'pin');
  }

  const engines = stringValue(recordValue(manifest.engines).node);
  return declaration('node', engines === undefined ? undefined : minimumOf(engines), 'minimum');
}

const TOOL_VERSIONS_NAMES: Readonly<Record<string, Toolchain>> = {
  golang: 'go',
  go: 'go',
  python: 'python',
  rust: 'rust',
  swift: 'swift',
  dart: 'dart',
  flutter: 'flutter',
  nodejs: 'node',
  node: 'node',
};

/** asdf's `.tool-versions`: one `<tool> <version>` per line; the first line for a tool wins. */
function parseToolVersions(text: string): ToolchainDeclaration[] {
  const seen = new Set<Toolchain>();
  const declarations: ToolchainDeclaration[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const [tool, rawVersion] = rawLine.replace(/#.*$/, '').trim().split(/\s+/);
    const toolchain =
      tool !== undefined && Object.hasOwn(TOOL_VERSIONS_NAMES, tool)
        ? TOOL_VERSIONS_NAMES[tool]
        : undefined;

    if (toolchain === undefined || rawVersion === undefined || seen.has(toolchain)) {
      continue;
    }

    seen.add(toolchain);
    const version = toolchain === 'flutter' ? rawVersion.replace(/-stable$/, '') : rawVersion;
    declarations.push(...declaration(toolchain, toolchainVersion(version), 'pin'));
  }

  return declarations;
}

const TOOLCHAIN_FILE_PARSERS: Readonly<Record<string, (text: string) => ToolchainDeclaration[]>> = {
  'go.mod': parseGoFile,
  'go.work': parseGoFile,
  '.python-version': pinFromFirstLine('python', true),
  Pipfile: parsePipfile,
  'pyproject.toml': parsePyproject,
  'rust-toolchain.toml': parseRustToolchainToml,
  'rust-toolchain': parseRustToolchain,
  'Cargo.toml': parseCargoToml,
  '.swift-version': pinFromFirstLine('swift', false),
  'Package.swift': parsePackageSwift,
  'pubspec.yaml': parsePubspecYaml,
  'pubspec.lock': parsePubspecLock,
  '.fvmrc': parseFvmrc,
  '.nvmrc': pinFromFirstLine('node', true),
  '.node-version': pinFromFirstLine('node', true),
  'package.json': parsePackageJson,
  '.tool-versions': parseToolVersions,
};

/** Within one directory, the file of a toolchain that comes first here wins among the same kind. */
const TOOLCHAIN_FILE_ORDER: Readonly<Record<Toolchain, readonly string[]>> = {
  go: ['go.work', 'go.mod', '.tool-versions'],
  python: ['.python-version', '.tool-versions', 'Pipfile', 'pyproject.toml'],
  rust: ['rust-toolchain', 'rust-toolchain.toml', '.tool-versions', 'Cargo.toml'],
  swift: ['.swift-version', '.tool-versions', 'Package.swift'],
  dart: ['.tool-versions', 'pubspec.yaml', 'pubspec.lock'],
  flutter: ['.fvmrc', '.tool-versions', 'pubspec.yaml', 'pubspec.lock'],
  node: ['.nvmrc', '.node-version', 'package.json', '.tool-versions'],
};

export function isToolchainFile(fileName: string): boolean {
  return Object.hasOwn(TOOLCHAIN_FILE_PARSERS, fileName);
}

export function toolchainFileNames(toolchain: Toolchain): readonly string[] {
  return TOOLCHAIN_FILE_ORDER[toolchain];
}

// ============================================================================
// Selection and reading
// ============================================================================

/**
 * One version per toolchain and directory (a pin before a minimum, then the
 * file order), and across the project a pin drops every minimum of its
 * toolchain. Two different versions left over are a conflict, as two
 * lockfiles are.
 */
export function selectToolchainVersions(
  declared: readonly (ToolchainDeclaration & { file: string })[]
): ResolvedDependency[] {
  const rank = (entry: ToolchainDeclaration & { file: string }): [number, number] => [
    entry.kind === 'pin' ? 0 : 1,
    toolchainFileNames(entry.toolchain).indexOf(posix.basename(entry.file)),
  ];
  const kept = new Map<string, ToolchainDeclaration & { file: string }>();

  for (const entry of declared) {
    const key = `${entry.toolchain}\u0000${posix.dirname(entry.file)}`;
    const existing = kept.get(key);

    if (existing === undefined) {
      kept.set(key, entry);
      continue;
    }

    const [kind, order] = rank(entry);
    const [existingKind, existingOrder] = rank(existing);

    if (kind < existingKind || (kind === existingKind && order < existingOrder)) {
      kept.set(key, entry);
    }
  }

  const pinned = new Set(
    [...kept.values()].filter((entry) => entry.kind === 'pin').map((entry) => entry.toolchain)
  );

  return [...kept.values()]
    .filter((entry) => entry.kind === 'pin' || !pinned.has(entry.toolchain))
    .map((entry): ResolvedDependency => ({
      ecosystem: 'toolchain',
      name: entry.toolchain,
      version: entry.version,
      direct: true,
      dev: false,
      lockfile: entry.file,
    }))
    .sort(
      (a, b) =>
        compareStringsByCodeUnit(a.name, b.name) ||
        compareStringsByCodeUnit(a.version, b.version) ||
        compareStringsByCodeUnit(a.lockfile, b.lockfile)
    );
}

/**
 * Read the version files a scan found (project-relative POSIX paths), with
 * the lockfile rules: never through a symbolic link, never over `maxBytes`,
 * and nothing in them runs. Shallow files are read first, at most
 * MAX_TOOLCHAIN_FILES of them.
 */
export async function readToolchainVersions(
  projectRoot: string,
  files: readonly string[],
  options: { maxBytes: number; signal?: AbortSignal }
): Promise<{ dependencies: ResolvedDependency[]; unread: UnreadLockfile[]; warnings: string[] }> {
  const unread: UnreadLockfile[] = [];
  const warnings: string[] = [];
  const declared: (ToolchainDeclaration & { file: string })[] = [];
  const ordered = [...files].sort(
    (a, b) => a.split('/').length - b.split('/').length || compareStringsByCodeUnit(a, b)
  );

  if (ordered.length > MAX_TOOLCHAIN_FILES) {
    warnings.push(
      `Toolchain version scan read the first ${MAX_TOOLCHAIN_FILES} of ${ordered.length} files that can state a version; the rest were not read.`
    );
  }

  for (const file of ordered.slice(0, MAX_TOOLCHAIN_FILES)) {
    if (options.signal?.aborted === true) {
      unread.push({
        lockfile: file,
        ecosystems: ['toolchain'],
        reason: 'was not read before the time limit',
      });
      continue;
    }

    const fileName = posix.basename(file);
    const parser = isToolchainFile(fileName) ? TOOLCHAIN_FILE_PARSERS[fileName] : undefined;

    if (parser === undefined) {
      continue;
    }

    const absolutePath = join(projectRoot, ...file.split('/'));

    try {
      const bytes = (await stat(absolutePath)).size;

      if (bytes > options.maxBytes) {
        const reason = `is ${bytes} bytes, over the ${options.maxBytes}-byte limit for a version file`;
        unread.push({ lockfile: file, ecosystems: ['toolchain'], reason });
        warnings.push(`${file}: skipped, it ${reason}.`);
        continue;
      }

      const text = (await readRegularFile(absolutePath, { followLinks: false })).toString('utf-8');

      for (const entry of parser(text)) {
        declared.push({ ...entry, file });
      }
    } catch (error) {
      if (error instanceof RefusedFileError) {
        const reason = `could not be read: ${errorMessage(error)}`;
        unread.push({ lockfile: file, ecosystems: ['toolchain'], reason });
        warnings.push(`${file}: ${reason}.`);
      } else if (!isFileNotFoundError(error)) {
        warnings.push(`${file}: could not be read for a toolchain version: ${errorMessage(error)}`);
      }
    }
  }

  return { dependencies: selectToolchainVersions(declared), unread, warnings };
}
