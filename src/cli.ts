#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { Command, CommanderError, Help, Option } from 'commander';

import packageJson from '../package.json';
import { syncAgentBlocks, type AgentBlockOutcome, type AgentBlockStatus } from './agent/block.js';
import { detectHarness, nodeHookIo, runSessionStartHook, sessionBrief } from './agent/hook.js';
import {
  CONFIG_FILE_NAME,
  CONVERTER_TOOLS,
  ConfigError,
  PACK_LIMITS,
  SOURCE_TYPES,
  TRANSFORM_NAMES,
  findProjectRoot,
  formatSchemaIssues,
  initProjectConfig,
  loadOrEmptyConfig,
  loadProjectConfig,
  loadProjectConfigIfPresent,
  packConfigSchema,
  projectRootForCreate,
  resolvePackRecipe,
  saveProjectConfig,
  sourceConfigSchema,
  PACK_ID_PATTERN,
  READ_FIRST_MAX,
  COVERS_MAX,
  type PackConfig,
} from './config/project.js';
import { migrateV2Pack } from './config/migrate.js';
import {
  describePackageDiscovery,
  discoverPackage,
  parsePackageSpec,
} from './core/package-discovery.js';
import { inspectWebsite } from './core/website-discovery.js';
import { ECOSYSTEMS, projectDependencies, type Ecosystem } from './deps/lockfiles.js';
import { defaultCacheDir } from './deps/registries.js';
import { formatStatusHuman, gatherProjectStatus } from './deps/status.js';
import {
  ensurePacksDir,
  previewPack,
  syncPacks,
  type OrphanStatus,
  type PackSyncResult,
  type PackSyncStatus,
  type StaleReason,
  type SyncReport,
} from './pack/build.js';
import { stampGuides, type PageChange, type SectionChange } from './pack/guides.js';
import {
  PACK_CHECK_NAMES,
  PROJECT_CHECK_NAMES,
  verifyPacks,
  type CheckStatus,
  type VerifyReport,
} from './pack/verify.js';
import { supportedSourceTypes } from './sources/acquire.js';
import { CONVERTER_INSTALL_HINTS } from './sources/convert.js';
import { errorMessage, isFileNotFoundError, isRecord } from './utils/guards.js';
import { writeTextFileSafely } from './utils/safe-write.js';

const CLI_NAME = 'llm-docs';
// Not package.json's description: the bundle inlines each package.json value
// the CLI reads, so reading it would tie the committed bundle to npm metadata.
const CLI_DESCRIPTION =
  'Version-pinned, verified reference docs for AI coding agents, kept in your repository and locked to your dependencies.';
const EXIT_CHECK_FAILED = 1;
const EXIT_USAGE = 2;
const EXIT_RUNTIME = 3;

interface CommandExample {
  /** The arguments after `llm-docs`, exactly as a shell would pass them. */
  argv: readonly string[];
  note: string;
}

interface CommandEntry {
  name: string;
  summary: string;
  status: 'implemented';
  /** Shown under `Examples:` in the command's help; a test parses each one. */
  examples: readonly CommandExample[];
}

// The single source for `capabilities` and for each command's help text. A
// command registered below must have an entry here so the two cannot drift.
const COMMANDS = [
  {
    name: 'init',
    summary:
      'Create llm-docs.json, the packs directory, and empty managed blocks in the agent files. Run it once per repository before the first add; rerunning it never overwrites config.',
    status: 'implemented',
    examples: [
      { argv: ['init'], note: 'Set up the repository you are in' },
      {
        argv: ['init', '--packs-dir', 'docs/agent-docs'],
        note: 'Keep the packs somewhere other than agent-docs/',
      },
    ],
  },
  {
    name: 'add',
    summary:
      "Write a pack recipe into llm-docs.json, then build that pack. Use it to pin a library's docs at an exact version; preview with --dry-run first.",
    status: 'implemented',
    examples: [
      {
        argv: ['add', 'mylib', '--local', 'docs/mylib', '--version', '2.1.0', '--dry-run'],
        note: 'Preview a pack built from a folder in the project, writing nothing',
      },
      {
        argv: [
          'add',
          'vite',
          '--git',
          'https://github.com/vitejs/vite',
          '--ref',
          'v{version}',
          '--path',
          'docs',
          '--dependency',
          'npm:vite',
        ],
        note: "Pin Vite's docs at the version the lockfile resolves, and follow it on every sync",
      },
      {
        argv: ['add', 'mylib', '--local', 'docs/mylib', '--version', '2.1.0', '--json'],
        note: 'Add and build the pack, printing the recipe and the sync report as JSON',
      },
    ],
  },
  {
    name: 'sync',
    summary:
      'Build or rebuild packs so they match their recipes and the lockfiles, then update the managed blocks. Run it after editing llm-docs.json or a lockfile; in CI, run it with --check.',
    status: 'implemented',
    examples: [
      { argv: ['sync'], note: 'Rebuild every stale pack and update the managed blocks' },
      { argv: ['sync', 'vite'], note: 'Bring one pack up to date' },
      {
        argv: ['sync', '--check'],
        note: 'CI gate: write nothing, exit 1 when a pack or managed block is out of date',
      },
      {
        argv: ['sync', '--check', '--json'],
        note: 'The same, with a reason code per stale pack on stdout',
      },
    ],
  },
  {
    name: 'refresh',
    summary:
      'Re-acquire packs at their recorded recipes and report, page by page, what changed upstream. Run it when the docs of a pinned version may have been edited upstream.',
    status: 'implemented',
    examples: [
      {
        argv: ['refresh', '--check'],
        note: 'Report upstream changes without writing; exit 1 when something changed',
      },
      { argv: ['refresh', 'vite'], note: 'Re-acquire one pack and rebuild it if upstream changed' },
      { argv: ['refresh', '--check', '--json'], note: 'The per-page report as JSON' },
    ],
  },
  {
    name: 'verify',
    summary:
      'Check packs against their manifests, recipes, lockfiles, and links, and check the managed blocks. Read-only and offline; run it in CI, where a failed check exits 1.',
    status: 'implemented',
    examples: [
      { argv: ['verify'], note: 'Run every check on every pack' },
      {
        argv: ['verify', 'vite', '--strict'],
        note: 'Also check link anchors and fail on an unknown or proprietary license',
      },
      { argv: ['verify', '--strict', '--json'], note: 'CI: every check result as JSON on stdout' },
    ],
  },
  {
    name: 'status',
    summary:
      "Show each pack's lockfile drift and the direct dependencies released after or near the model's training data cutoff. Use it to decide which libraries need a pack.",
    status: 'implemented',
    examples: [
      {
        argv: ['status', '--model', 'claude-opus-5-5'],
        note: "Compare release dates against that model's training data cutoff",
      },
      {
        argv: ['status', '--cutoff', '2026-06', '--offline', '--json'],
        note: 'Use a cutoff month and cached release dates only, as JSON',
      },
      {
        argv: ['status', '--brief'],
        note: 'Print what the session-start hook would tell an agent',
      },
    ],
  },
  {
    name: 'guides stamp',
    summary:
      'Record the hash of every section each guide cites, so verify, refresh, and sync report the guides to re-review when that text changes. Run it after writing or re-reviewing a guide.',
    status: 'implemented',
    examples: [
      { argv: ['guides', 'stamp', 'vite'], note: 'Stamp every guide of the vite pack' },
      {
        argv: ['guides', 'stamp', 'vite', 'guides/routing.md', '--json'],
        note: 'Stamp one guide and print what was recorded as JSON',
      },
    ],
  },
  {
    name: 'migrate',
    summary:
      'Write a recipe into llm-docs.json for a v2 pack, from its manifest; the v2 pack is left as is. Run it once per v2 pack, then sync the new pack.',
    status: 'implemented',
    examples: [
      {
        argv: ['migrate', 'old-docs/vite', '--version', '7.1.0'],
        note: 'Carry a v2 pack over under its directory name',
      },
      {
        argv: ['migrate', 'old-docs/vite', '--id', 'vite7', '--version', '7.1.0', '--json'],
        note: 'Pick the pack id, and print the recipe and the next command as JSON',
      },
    ],
  },
  {
    name: 'discover',
    summary:
      'Print read-only evidence for writing a recipe, as JSON on stdout: a docs website (--url: llms.txt, sitemap, Markdown probe, version segments) or a package (--package: registry metadata, matching git tags, Markdown directories, change documents). Run it before add to choose a source.',
    status: 'implemented',
    examples: [
      { argv: ['discover', '--package', 'npm:vite'], note: 'Evidence for the latest Vite release' },
      {
        argv: ['discover', '--package', 'npm:vite@7.1.0'],
        note: 'Evidence for one version, with its git tags and docs directories',
      },
      { argv: ['discover', '--url', 'https://vite.dev'], note: "The site's llms.txt and sitemap" },
    ],
  },
  {
    name: 'capabilities',
    summary:
      'Describe what this build supports: commands, options, examples, checks, outcome and reason codes, exit codes, sources, converters, ecosystems, transforms, and limits. Agents read it with --json.',
    status: 'implemented',
    examples: [
      { argv: ['capabilities', '--json'], note: 'Everything above as one JSON document' },
      { argv: ['capabilities'], note: 'One line per command' },
    ],
  },
  {
    name: 'hook session-start',
    summary: 'Used by the plugin',
    status: 'implemented',
    examples: [],
  },
] as const satisfies readonly CommandEntry[];

type CommandName = (typeof COMMANDS)[number]['name'];

const REMOVED_COMMANDS: ReadonlyArray<{ name: string; hint: string }> = [
  {
    name: 'generate',
    hint: "Use 'llm-docs add' instead; 'llm-docs add --help' lists its source flags.",
  },
  {
    name: 'validate',
    hint: "The Supabase SDK catalog was removed; add the SDK docs as a pack with 'llm-docs add'.",
  },
  {
    name: 'list-sdks',
    hint: "The Supabase SDK catalog was removed; add the SDK docs as a pack with 'llm-docs add'.",
  },
  { name: 'source-truth', hint: 'Source-truth mode was removed; read the code directly.' },
  { name: 'verify-docs', hint: 'Source-truth mode was removed; read the code directly.' },
  {
    name: 'plugins',
    hint: 'Parser plugins were removed; convert documents with a source\'s "convert" in llm-docs.json, such as {"tool": "command", "command": [...]}.',
  },
  {
    name: 'agent',
    hint: "Install the llm-docs plugin instead ('claude plugin install llm-docs@llm-docs' in Claude Code); it runs 'llm-docs hook session-start' for you.",
  },
];

const EXIT_CODES = {
  0: 'success',
  [EXIT_CHECK_FAILED]: 'a check failed (verify, sync --check, refresh --check)',
  [EXIT_USAGE]: `usage or config error (a flag, an argument, or ${CONFIG_FILE_NAME})`,
  [EXIT_RUNTIME]: 'runtime failure (network, git, a converter, a held lock)',
};

const JSON_HELP =
  'With --json, a command that runs prints exactly one JSON document on stdout, even when it reports a failed pack or check; a command that cannot run prints nothing on stdout and its error on stderr. Human text always goes to stderr.';

const START_HERE_HELP = `Start here:
  llm-docs init                                 set up the repository
  llm-docs discover --package <eco>:<name>      evidence for choosing a docs source
  llm-docs add <id> --git <repo> --ref <ref>    pin a library's docs (see 'llm-docs add --help')
  llm-docs capabilities --json                  everything this build supports, for programs`;

class UsageError extends Error {}

function commandEntry(name: CommandName): CommandEntry {
  const entry = COMMANDS.find((command) => command.name === name);
  if (entry === undefined) {
    throw new Error(`Command ${name} has no COMMANDS entry`);
  }
  return entry;
}

/** An argument as a POSIX shell (and cmd.exe, for plain Windows paths) reads it back. */
function shellQuote(value: string): string {
  const plain = process.platform === 'win32' ? /^[\w@%+=:,./\\-]+$/ : /^[\w@%+=:,./-]+$/;
  if (plain.test(value)) {
    return value;
  }
  return /["$`!\\]/.test(value) ? `'${value.replaceAll("'", `'\\''`)}'` : `"${value}"`;
}

/** The command's summary as its description, and its examples after the options in --help. */
function describeCommand(command: Command, name: CommandName): Command {
  const { summary, examples } = commandEntry(name);
  command.description(summary);
  if (examples.length > 0) {
    const lines = examples.flatMap((example) => [
      `  # ${example.note}`,
      `  llm-docs ${example.argv.map(shellQuote).join(' ')}`,
    ]);
    command.addHelpText('after', `\nExamples:\n${lines.join('\n')}`);
  }
  return command;
}

/**
 * Hints in messages name commands as `llm-docs <command> ...`. When the user
 * passed --project, each hint for a command that takes it gets it too, so a
 * hint copied into another directory acts on the same project. Set by the
 * preAction hook before any action prints.
 */
let projectHint: { pattern: RegExp; flag: string } | undefined;

function withProjectHint(text: string): string {
  return projectHint === undefined
    ? text
    : text.replace(projectHint.pattern, `$& ${projectHint.flag}`);
}

function writeJson(value: unknown): void {
  const json = JSON.stringify(
    value,
    (_key, entry: unknown) => (typeof entry === 'string' ? withProjectHint(entry) : entry),
    2
  );
  process.stdout.write(`${json}\n`);
}

/** Human output always goes to stderr, so stdout carries only `--json` output. */
function say(line: string): void {
  process.stderr.write(`${withProjectHint(line)}\n`);
}

interface ProjectOptions {
  project?: string;
  json?: boolean;
}

/**
 * `--project` and `--json`. `discovery` says how the project is found without
 * --project, for the help text.
 */
function withProjectOptions(
  command: Command,
  discovery: 'nearest config' | 'create' | 'nearest config or cwd'
): Command {
  const defaults = {
    'nearest config': `the nearest directory, from the current one up, holding ${CONFIG_FILE_NAME}`,
    create: 'the git top-level directory, else the current directory',
    'nearest config or cwd': `the nearest directory, from the current one up, holding ${CONFIG_FILE_NAME}, else the current directory`,
  }[discovery];
  return command
    .option('--project <dir>', `Project root (default: ${defaults})`)
    .option(
      '--json',
      'Print one JSON document on stdout; human text stays on stderr (default: human text only)'
    );
}

/** The project for commands that read config: --project, else the nearest ancestor with config. */
async function existingProjectRoot(options: ProjectOptions): Promise<string> {
  if (options.project !== undefined) {
    return resolve(options.project);
  }

  const root = await findProjectRoot(process.cwd());

  if (root === undefined) {
    throw new ConfigError(
      `No ${CONFIG_FILE_NAME} in ${process.cwd()} or any parent directory; run 'llm-docs init' or pass --project <dir>.`
    );
  }

  return root;
}

async function creatingProjectRoot(options: ProjectOptions): Promise<string> {
  return options.project !== undefined
    ? resolve(options.project)
    : projectRootForCreate(process.cwd());
}

// ---------------------------------------------------------------------------
// add: source flags
// ---------------------------------------------------------------------------

interface AddOptions extends ProjectOptions {
  local?: string;
  git?: string;
  ref?: string;
  path?: string[];
  url?: string[];
  urlsFile?: string;
  llmsTxt?: string;
  include?: string[];
  stripPrefix?: string;
  site?: string;
  dependency?: string;
  covers?: string[];
  version?: string;
  mount?: string;
  title?: string;
  recipe?: string;
  convert?: string;
  convertInclude?: string[];
  readFirst?: string[];
  replace?: boolean;
  dryRun?: boolean;
}

/** Converters `add --convert` takes; a `command` converter needs its argv, so it goes in --recipe. */
const ADD_CONVERT_TOOLS = CONVERTER_TOOLS.filter((tool) => tool !== 'command');

/** The source's `convert` from `--convert` and `--convert-include`, or undefined. */
function readConvertFlags(options: AddOptions): Record<string, unknown> | undefined {
  if (options.convert === undefined) {
    if (options.convertInclude !== undefined) {
      throw new UsageError('--convert-include needs --convert <tool>.');
    }
    return undefined;
  }

  const tool = ADD_CONVERT_TOOLS.find((entry) => entry === options.convert);

  if (tool === undefined) {
    throw new UsageError(
      options.convert === 'command'
        ? '--convert command needs an argv: pass --recipe \'{"convert":{"tool":"command","command":[...],"include":[...]}}\' instead.'
        : `--convert must be one of ${ADD_CONVERT_TOOLS.join(', ')}; got "${options.convert}".`
    );
  }

  return options.convertInclude === undefined
    ? { tool }
    : { tool, include: options.convertInclude };
}

/** One URL per line; blank lines and `#` comments are ignored. */
function readUrlsFile(path: string): string[] {
  let text: string;

  try {
    text = readFileSync(resolve(path), 'utf-8');
  } catch (error) {
    throw new UsageError(
      `Cannot read --urls-file ${path} (${errorMessage(error)}); pass a readable text file with one https:// URL per line.`
    );
  }

  const urls = text
    .split(/\r?\n/)
    .map((line) => line.replace(/(?:^|\s)#.*$/, '').trim())
    .filter((line) => line !== '');

  if (urls.length === 0) {
    throw new UsageError(
      `--urls-file ${path} lists no URLs; put one https:// URL per line (# starts a comment).`
    );
  }

  return urls;
}

/**
 * Source flags of `add`, each building one source object. `--convert` is
 * read by readConvertFlags.
 */
const ADD_SOURCE_FLAGS: ReadonlyArray<{
  flags: string;
  description: string;
  repeatable?: true;
  read(options: AddOptions): Record<string, unknown> | undefined;
}> = [
  {
    flags: '--local <path>',
    description:
      'Take the docs from a directory or file inside the project (a project-relative path)',
    read: (options) =>
      options.local === undefined ? undefined : { type: 'local', path: options.local },
  },
  {
    flags: '--git <repo>',
    description:
      'Take the docs from a git repository (an https:// URL) at --ref, limited to --path',
    read: (options) => {
      if (options.git === undefined) {
        return undefined;
      }
      if (options.ref === undefined) {
        throw new UsageError('--git needs --ref <tag, branch, or commit>.');
      }
      return {
        type: 'git',
        repo: options.git,
        ref: options.ref,
        ...(options.path === undefined ? {} : { paths: options.path }),
      };
    },
  },
  {
    flags: '--url <url>',
    description: 'Fetch exactly this https:// page (repeatable)',
    repeatable: true,
    read: (options) =>
      options.url === undefined ? undefined : { type: 'urls', urls: options.url },
  },
  {
    flags: '--urls-file <file>',
    description:
      'Fetch the pages a text file lists, one https:// URL per line (# starts a comment)',
    read: (options) =>
      options.urlsFile === undefined
        ? undefined
        : { type: 'urls', urls: readUrlsFile(options.urlsFile) },
  },
  {
    flags: '--llms-txt <url>',
    description: 'Fetch the pages an llms.txt index lists that pass --include (an https:// URL)',
    read: (options) => {
      if (options.llmsTxt === undefined) {
        return undefined;
      }
      return {
        type: 'llms-txt',
        url: options.llmsTxt,
        ...(options.stripPrefix === undefined ? {} : { stripPrefix: options.stripPrefix }),
      };
    },
  },
];

/** Flags that refine a source flag, with the source type each one needs (undefined: any). */
const ADD_SOURCE_MODIFIERS: ReadonlyArray<{
  flags: string;
  description: string;
  key: 'ref' | 'path' | 'include' | 'stripPrefix';
  repeatable?: true;
  needs?: string;
}> = [
  {
    flags: '--ref <ref>',
    description: 'Tag, branch, or 40-hex commit for --git; may use {version} (required with --git)',
    key: 'ref',
    needs: 'git',
  },
  {
    flags: '--path <path>',
    description: 'Repository path to take for --git (repeatable; default the whole repository)',
    key: 'path',
    repeatable: true,
    needs: 'git',
  },
  {
    flags: '--include <glob>',
    description:
      'Glob a page must match: URL paths for --llms-txt (required there), file paths otherwise (repeatable; default: every page for --url and --urls-file; Markdown, MDX, reStructuredText, and HTML files for --local and --git)',
    key: 'include',
    repeatable: true,
  },
  {
    flags: '--strip-prefix <prefix>',
    description: 'URL path prefix removed from --llms-txt page paths (default: none)',
    key: 'stripPrefix',
    needs: 'llms-txt',
  },
];

function collect(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

function parseDependency(
  value: string,
  flag: '--dependency' | '--covers'
): { ecosystem: Ecosystem; name: string } {
  const separator = value.indexOf(':');
  const ecosystem = ECOSYSTEMS.find((entry) => entry === value.slice(0, separator));
  const name = value.slice(separator + 1);

  if (separator <= 0 || name === '' || ecosystem === undefined) {
    throw new UsageError(
      `${flag} must be <ecosystem>:<name> with an ecosystem of ${ECOSYSTEMS.join(', ')}; got "${value}".`
    );
  }

  return { ecosystem, name };
}

function parseRecipeJson(value: string): Record<string, unknown> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new UsageError(`--recipe is not valid JSON: ${errorMessage(error)}`);
  }

  if (!isRecord(parsed)) {
    throw new UsageError('--recipe must be a JSON object describing one source.');
  }

  return parsed;
}

function buildPackRecipe(options: AddOptions): PackConfig {
  const fromFlags = ADD_SOURCE_FLAGS.map((flag) => flag.read(options)).filter(
    (source): source is Record<string, unknown> => source !== undefined
  );

  if (fromFlags.length > 1) {
    throw new UsageError(
      'Pass one source flag per add; for a pack with several sources, add it with one, then append the others to packs.<id>.sources in llm-docs.json and run sync.'
    );
  }

  const extra = options.recipe === undefined ? {} : parseRecipeJson(options.recipe);
  const source: Record<string, unknown> = { ...(fromFlags[0] ?? {}) };
  const convert = readConvertFlags(options);

  if (convert !== undefined) {
    source.convert = convert;
  }

  for (const [key, value] of Object.entries(extra)) {
    if (Object.hasOwn(source, key) && source[key] !== value) {
      throw new UsageError(
        `--recipe sets "${key}", which a source flag already sets; set it in one place only.`
      );
    }
    source[key] = value;
  }

  if (Object.keys(source).length === 0) {
    throw new UsageError(
      `Name a source: ${ADD_SOURCE_FLAGS.map((flag) => flag.flags.split(' ')[0]).join(', ')}, or --recipe <json>.`
    );
  }

  if (options.mount !== undefined) {
    if (Object.hasOwn(source, 'mount')) {
      throw new UsageError('--mount and --recipe both set "mount"; set it in one place only.');
    }
    source.mount = options.mount;
  }

  for (const modifier of ADD_SOURCE_MODIFIERS) {
    if (
      options[modifier.key] !== undefined &&
      modifier.needs !== undefined &&
      source.type !== modifier.needs
    ) {
      throw new UsageError(
        `${modifier.flags.split(' ')[0]} only applies to --${modifier.needs}; drop it, or take the docs from --${modifier.needs}.`
      );
    }
  }

  if (options.include !== undefined) {
    if (Object.hasOwn(source, 'include')) {
      throw new UsageError('--include and --recipe both set "include"; set it in one place only.');
    }
    source.include = options.include;
  }

  if (source.type === 'llms-txt' && source.include === undefined) {
    throw new UsageError('--llms-txt needs at least one --include <glob> over page URL paths.');
  }

  const checkedSource = sourceConfigSchema.safeParse(source);

  if (!checkedSource.success) {
    throw new UsageError(formatSchemaIssues('source', checkedSource.error));
  }

  const pack: Record<string, unknown> = {};

  if (options.title !== undefined) {
    pack.title = options.title;
  }
  if (options.dependency !== undefined) {
    pack.dependency = parseDependency(options.dependency, '--dependency');
  }
  if (options.covers !== undefined) {
    pack.covers = options.covers.map((value) => parseDependency(value, '--covers'));
  }
  if (options.version !== undefined) {
    pack.version = options.version;
  }
  if (pack.version === undefined && pack.dependency === undefined) {
    throw new UsageError('Pass --version <v> or --dependency <ecosystem>:<name>.');
  }
  if (options.site !== undefined) {
    pack.site = { baseUrl: options.site };
  }
  // Keep the source exactly as the user wrote it (not the parsed copy) so the config stays minimal.
  pack.sources = [source];
  if (options.readFirst !== undefined) {
    pack.readFirst = options.readFirst;
  }

  const checkedPack = packConfigSchema.safeParse(pack);

  if (!checkedPack.success) {
    throw new UsageError(formatSchemaIssues('pack', checkedPack.error));
  }

  return checkedPack.data;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** The worst failure among `entries` (runtime over usage), else 1 when a check found changes. */
function worstExitCode(
  entries: readonly { status: string; exitCode?: 2 | 3 }[],
  checkChanged: boolean
): number {
  const failures = entries.filter((entry) => entry.status === 'failed');

  if (failures.length > 0) {
    return failures.some((entry) => entry.exitCode === EXIT_RUNTIME) ? EXIT_RUNTIME : EXIT_USAGE;
  }

  return checkChanged ? EXIT_CHECK_FAILED : 0;
}

/** A failed managed block counts like a failed pack. */
function syncExitCode(report: SyncReport): number {
  return worstExitCode([...report.packs, ...report.agentBlocks], report.check && report.changed);
}

const BLOCK_STATUS_TEXT: Readonly<Record<AgentBlockStatus, string>> = {
  unchanged: 'llm-docs block up to date',
  created: 'created with the llm-docs block',
  updated: 'llm-docs block updated',
  'would-create': 'would be created with the llm-docs block',
  'would-update': 'llm-docs block would change',
  failed: 'failed',
};

function printAgentBlocks(blocks: readonly AgentBlockOutcome[]): void {
  for (const block of blocks) {
    const error = block.error === undefined ? '' : `: ${block.error}`;
    say(`${block.path}: ${BLOCK_STATUS_TEXT[block.status]}${error}`);
  }
}

const CITATION_CHANGE_LABEL: Readonly<Record<SectionChange | PageChange, string>> = {
  'section-changed': 'section changed',
  unresolved: 'no longer resolves',
  'page-changed': 'page changed upstream',
  'page-removed': 'page removed upstream',
};

function printGuideReview(pack: PackSyncResult): void {
  const review = pack.guideReview;

  if (review === undefined) {
    return;
  }

  say(
    review.basis === 'sections'
      ? '  guides to re-review (cited sections changed):'
      : '  guides to re-review (cited pages changed upstream; sections are compared once rebuilt):'
  );
  for (const guide of review.guides) {
    for (const citation of guide.citations) {
      say(`    ${guide.guide} -> ${citation.target} (${CITATION_CHANGE_LABEL[citation.change]})`);
    }
  }
  if (review.basis === 'sections') {
    const guides = review.guides.map((guide) => guide.guide).join(' ');
    say(`  after re-reviewing them, run 'llm-docs guides stamp ${pack.id} ${guides}'`);
  }
}

function printSyncReport(report: SyncReport): void {
  for (const pack of report.packs) {
    switch (pack.status) {
      case 'unchanged':
        say(`${pack.id}: up to date`);
        break;
      case 'built':
        say(`${pack.id}: built (${pack.detail ?? 'rebuilt'})`);
        break;
      case 'would-build':
        say(`${pack.id}: would rebuild (${pack.detail ?? 'out of date'})`);
        break;
      case 'failed':
        say(`${pack.id}: failed: ${pack.error ?? 'unknown error'}`);
        break;
    }
    for (const warning of pack.warnings) {
      say(`  warning: ${warning}`);
    }
    printGuideReview(pack);
  }

  for (const orphan of report.orphans) {
    const detail = {
      orphan: `not in ${CONFIG_FILE_NAME}; 'llm-docs sync --prune' deletes it`,
      pruned: 'deleted (not in config)',
      'would-prune': 'would be deleted (not in config)',
      kept: `kept: ${orphan.reason ?? ''}`,
    }[orphan.status];
    say(`${orphan.id}: orphan pack directory, ${detail}`);
  }

  printAgentBlocks(report.agentBlocks);

  if (report.packs.length === 0) {
    say(
      `No packs in ${CONFIG_FILE_NAME}; add one with 'llm-docs add <id> --local <path> --version <v>'.`
    );
  }
  if (report.check) {
    const prune = report.orphans.some((orphan) => orphan.status === 'would-prune');
    say(
      report.changed
        ? `sync --check: packs or managed blocks are out of date; run 'llm-docs sync${prune ? ' --prune' : ''}'.`
        : 'sync --check: everything is up to date.'
    );
  }
}

function printRefreshReport(report: SyncReport): void {
  for (const pack of report.packs) {
    const refresh = pack.refresh;

    if (pack.status === 'failed' || refresh === undefined) {
      say(`${pack.id}: failed: ${pack.error ?? 'unknown error'}`);
      continue;
    }

    const { counts } = refresh;
    const summary = `${counts.changed} changed, ${counts.added} added, ${counts.removed} removed, ${counts.unchanged} unchanged`;
    const reason = pack.detail ?? 'upstream changed';
    const outcome = {
      unchanged: 'no upstream changes',
      built: `${reason}; rebuilt`,
      'would-build': `${reason}; would rebuild`,
    }[pack.status];
    say(`${pack.id}: ${outcome} (${summary})`);

    for (const ref of refresh.refs) {
      say(
        `  git ref ${ref.ref} of ${ref.repo} now resolves to ${ref.commit.slice(0, 12)} (was ${ref.previousCommit.slice(0, 12)})`
      );
    }
    for (const file of refresh.files) {
      if (file.status !== 'unchanged') {
        say(`  ${file.status.padEnd(8)} ${file.output}`);
      }
    }
    for (const conversion of refresh.converters) {
      const label = (converter: { tool: string; version: string | null }): string =>
        converter.version ?? `${converter.tool} (version unknown)`;
      say(
        `  converter ${conversion.output} (${label(conversion.previous)} -> ${label(conversion.current)})`
      );
    }
    for (const warning of pack.warnings) {
      say(`  warning: ${warning}`);
    }
    printGuideReview(pack);
  }

  printAgentBlocks(report.agentBlocks);

  if (report.check) {
    const changed = report.packs
      .filter((pack) => pack.status === 'would-build')
      .map((pack) => ` ${pack.id}`)
      .join('');
    say(
      changed !== ''
        ? `refresh --check: upstream or a converter changed; run 'llm-docs refresh${changed}' to rebuild.`
        : report.changed
          ? "refresh --check: every pack matches upstream, but a managed block is out of date; run 'llm-docs sync'."
          : 'refresh --check: every pack matches upstream.'
    );
  }
}

function printVerifyReport(report: VerifyReport): void {
  let failures = 0;
  const packs = new Set<string>();

  for (const entry of report.results) {
    if (entry.packId !== null) {
      packs.add(entry.packId);
    }
    for (const finding of entry.findings) {
      if (finding.status === 'fail') {
        failures += 1;
      }
      const scope = entry.packId ?? 'project';
      const path = finding.path === undefined ? '' : ` ${finding.path}:`;
      // Messages about a whole file (llm-docs.json, manifest.json) start with its name.
      const message =
        finding.path !== undefined && finding.message.startsWith(`${finding.path} `)
          ? finding.message.slice(finding.path.length + 1)
          : finding.message;
      say(`${scope} ${entry.check} ${finding.status}:${path} ${message}`);
    }
  }

  say(
    report.ok
      ? `verify: all checks passed (${packs.size} pack${packs.size === 1 ? '' : 's'}).`
      : `verify: ${failures} problem${failures === 1 ? '' : 's'} found.`
  );
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

/** The codes `--json` reports carry, with what each means, for `capabilities`. */
const OUTCOME_CODES = {
  /** `packs[].status` of sync, add, and refresh. */
  packStatus: {
    unchanged: 'the pack already matches its recipe, lockfile, and sources; nothing was written',
    built: 'the pack was built and swapped into place',
    'would-build': 'under --check: the pack is stale and would be rebuilt',
    failed: 'the pack could not be built; see error and exitCode',
  } satisfies Record<PackSyncStatus, string>,
  /** `packs[].reason` of sync, add, and refresh, with `detail` saying it in words. */
  staleReason: {
    'not-built': 'the pack has never been built',
    'manifest-unreadable': "the pack's manifest.json is unreadable",
    'recipe-edited': 'the recipe in llm-docs.json changed since the last build',
    'lockfile-moved':
      'llm-docs.json is unchanged, but a lockfile now resolves the bound dependency to another version',
    'files-differ': 'the pack files differ from its manifest (edited, added, or deleted by hand)',
    'sources-changed': 'local source files changed since the last build',
    'upstream-changed': 'refresh: the re-acquired sources differ from the recorded ones',
    'converter-changed': 'refresh: the sources are unchanged, but a converter version changed',
  } satisfies Record<StaleReason, string>,
  /** `orphans[].status` of sync. */
  orphanStatus: {
    orphan: `a pack directory with no recipe in ${CONFIG_FILE_NAME}, only reported (sync --prune deletes it)`,
    pruned: 'deleted by sync --prune',
    'would-prune': 'under sync --check --prune: would be deleted',
    kept: 'sync --prune left it in place; see reason',
  } satisfies Record<OrphanStatus, string>,
  /** `agentBlocks[].status` of init, sync, add, and refresh. */
  agentBlockStatus: BLOCK_STATUS_TEXT,
  /** `results[].status` of verify; a `fail` makes verify exit 1. */
  checkStatus: {
    pass: 'the check found nothing',
    fail: 'the check failed',
    warn: 'worth a look, but not a failure',
    info: 'for information only',
    skipped: 'the check could not run; see reason',
  } satisfies Record<CheckStatus, string>,
  /** `changed` of guides stamp. */
  guidesStampChanged: {
    true: 'the citations lock was written',
    false: 'the citations lock already held these stamps; nothing was written',
  },
};

function capabilities(program: Command): unknown {
  const supported = new Set(supportedSourceTypes());

  return {
    name: CLI_NAME,
    version: packageJson.version,
    exitCodes: EXIT_CODES,
    json: JSON_HELP,
    commands: COMMANDS.map((entry) => ({
      ...entry,
      // A name with a space is a subcommand path (`guides stamp`).
      options:
        entry.name
          .split(' ')
          .reduce<Command | undefined>(
            (parent, name) => parent?.commands.find((command) => command.name() === name),
            program
          )
          ?.options.map((option) => ({ flags: option.flags, description: option.description })) ??
        [],
    })),
    outcomes: OUTCOME_CODES,
    sourceTypes: SOURCE_TYPES.map((type) => ({ type, supported: supported.has(type) })),
    converters: CONVERTER_TOOLS.map((tool) => ({
      tool,
      supported: true,
      install: CONVERTER_INSTALL_HINTS[tool],
    })),
    ecosystems: ECOSYSTEMS,
    transforms: TRANSFORM_NAMES,
    checks: { pack: PACK_CHECK_NAMES, project: PROJECT_CHECK_NAMES },
    limits: { ...PACK_LIMITS, maxReadFirst: READ_FIRST_MAX, maxCovers: COVERS_MAX },
  };
}

function buildProgram(): Command {
  const program = new Command();

  // Must precede command() calls: subcommands copy this setting when created.
  program.exitOverride();
  program.showHelpAfterError('(run the command again with --help for its options and examples)');
  // Program options (-V, --version) only before the command name, so `add --version <v>` is add's.
  program.enablePositionalOptions();
  program
    .name(CLI_NAME)
    .description(CLI_DESCRIPTION)
    .version(packageJson.version)
    .addHelpText(
      'after',
      `\n${START_HERE_HELP}\n\n${new Help().boxWrap(JSON_HELP, 80)}\n\nExit codes:\n${Object.entries(
        EXIT_CODES
      )
        .map(([code, meaning]) => `  ${code}  ${meaning}`)
        .join('\n')}`
    );
  program.hook('preAction', (_program, actionCommand) => {
    const project: unknown = actionCommand.opts().project;
    if (typeof project !== 'string') {
      return;
    }
    const names = program.commands.flatMap((command) =>
      [command, ...command.commands]
        .filter((entry) => entry.options.some((option) => option.long === '--project'))
        .map((entry) => (entry === command ? command.name() : `${command.name()} ${entry.name()}`))
    );
    projectHint = {
      pattern: new RegExp(`\\bllm-docs (?:${names.join('|')})(?![\\w-])(?! --project)`, 'g'),
      flag: `--project ${shellQuote(resolve(project))}`,
    };
  });

  withProjectOptions(
    describeCommand(program.command('init'), 'init').option(
      '--packs-dir <dir>',
      'Project-relative directory for the packs (default: agent-docs)'
    ),
    'create'
  ).action(async (options: ProjectOptions & { packsDir?: string }) => {
    const projectRoot = await creatingProjectRoot(options);
    const { created, configPath } = await initProjectConfig(
      projectRoot,
      options.packsDir === undefined ? {} : { packsDir: options.packsDir }
    );
    const loaded = await loadProjectConfig(projectRoot);
    await ensurePacksDir(loaded.packsDir);
    // The same step sync ends with: before any pack is built, each block is empty markers.
    const agentBlocks = await syncAgentBlocks(loaded, { check: false });

    if (options.json === true) {
      writeJson({
        projectRoot,
        configPath,
        created,
        packsDir: loaded.packsDirRelative,
        agentBlocks,
      });
    }
    say(
      created
        ? `Created ${configPath} and ${loaded.packsDirRelative}/.`
        : `${configPath} already exists; left it unchanged.`
    );
    printAgentBlocks(agentBlocks);
    process.exitCode = worstExitCode(agentBlocks, false);
  });

  const add = describeCommand(program.command('add'), 'add').argument(
    '<id>',
    'Pack id: up to 64 lowercase letters, digits, ".", "_", "-", starting with a letter or digit'
  );

  for (const flag of [...ADD_SOURCE_FLAGS, ...ADD_SOURCE_MODIFIERS]) {
    if (flag.repeatable === true) {
      add.option(flag.flags, flag.description, collect);
    } else {
      add.option(flag.flags, flag.description);
    }
  }
  add.option(
    '--site <baseUrl>',
    'The docs website, so links to it resolve to pack pages (default: none)'
  );

  withProjectOptions(
    add
      .option(
        '--dependency <ecosystem:name>',
        `Bind the pack to a dependency, such as npm:vite; ecosystems: ${ECOSYSTEMS.join(', ')} (default: none)`
      )
      .option(
        '--covers <ecosystem:name>',
        `Another package these docs also describe, such as npm:@modelcontextprotocol/client next to a server SDK; status and the session note then count it as documented. It binds no version (repeatable, at most ${COVERS_MAX}; default: none)`,
        collect
      )
      .option(
        '--version <version>',
        'Docs version, filled into {version} placeholders (default: the version the lockfile resolves for --dependency; required without it)'
      )
      .option(
        '--mount <dir>',
        'Subdirectory under pages/ and files/ for this source (default: the pack root)'
      )
      .option('--title <title>', 'Pack title (default: the id)')
      .option(
        '--recipe <json>',
        'More source fields as a JSON object, such as {"exclude": ["**/blog/**"], "passthrough": ["**/*.csv"]} (default: none)'
      )
      .option(
        '--convert <tool>',
        `Convert documents (PDF, DOCX, ...) to pages with ${ADD_CONVERT_TOOLS.join(', ')}; a command converter goes in --recipe (default: none)`
      )
      .option(
        '--convert-include <glob...>',
        'Documents the converter takes (default for docling and markitdown: pdf, docx, pptx, epub, html)'
      )
      .option(
        '--read-first <target>',
        'A page or passthrough file to read first, such as a migration guide: pages/<path> or files/<path>, optionally #<heading slug> (repeatable, at most 5; default: none)',
        collect
      )
      .option('--replace', 'Overwrite an existing pack with this id (default: refuse)')
      .option(
        '--dry-run',
        'Print the recipe and the files it would take, writing nothing (fetches network sources)'
      ),
    'create'
  ).action(async (id: string, options: AddOptions) => {
    if (!PACK_ID_PATTERN.test(id)) {
      throw new UsageError(
        `Pack id "${id}" must match ${PACK_ID_PATTERN.source}: lowercase, such as vite or react-router.`
      );
    }

    const projectRoot = await creatingProjectRoot(options);
    const pack = buildPackRecipe(options);
    const loaded = await loadOrEmptyConfig(projectRoot);

    if (Object.hasOwn(loaded.config.packs, id) && options.replace !== true) {
      throw new UsageError(
        `Pack "${id}" already exists in ${CONFIG_FILE_NAME}; pass --replace to overwrite it.`
      );
    }

    if (options.dryRun === true) {
      const config = { ...loaded.config, packs: { ...loaded.config.packs, [id]: pack } };
      const resolved = await resolvePackRecipe(config, id, {
        resolveDependencyVersion: projectDependencies(loaded.projectRoot, {
          skipDirectories: [loaded.packsDirRelative],
        }).resolveVersion,
      });
      const preview = await previewPack({ ...loaded, config }, resolved);

      if (options.json === true) {
        writeJson({
          id,
          dryRun: true,
          recipe: resolved.recipe,
          recipeHash: resolved.recipeHash,
          ...preview,
        });
      }
      // Under --json the recipe is on stdout already; stderr keeps to prose.
      if (options.json !== true) {
        say(JSON.stringify({ [id]: pack }, null, 2));
      }
      for (const file of preview.files) {
        say(`  ${file.outputPath}  <-  ${file.source}`);
      }
      for (const entry of preview.readFirst) {
        if (!entry.found) {
          const hints = entry.nearest.length === 0 ? '' : ` (nearest: ${entry.nearest.join(', ')})`;
          say(
            `  read first ${entry.target}: not among the files this recipe takes${hints}; the build would fail until packs.${id}.readFirst names one`
          );
        } else if (entry.fragment !== null) {
          say(
            `  read first ${entry.target}: the file is taken; the heading #${entry.fragment} can only be checked once the pages are built, by the real add`
          );
        } else {
          say(`  read first ${entry.target}: the file is taken`);
        }
      }
      for (const warning of preview.warnings) {
        say(`  warning: ${warning}`);
      }
      say(
        `add --dry-run: ${preview.files.length} file${preview.files.length === 1 ? '' : 's'}; nothing written.`
      );
      return;
    }

    const configPath = join(projectRoot, CONFIG_FILE_NAME);
    const previousConfig = await readFile(configPath, 'utf-8').catch((error: unknown) => {
      if (isFileNotFoundError(error)) {
        return null;
      }
      throw error;
    });
    await saveProjectConfig(projectRoot, id, pack);
    say(`Wrote packs.${id} to ${CONFIG_FILE_NAME}.`);
    const report = await syncPacks(projectRoot, [id], { command: `llm-docs add ${id}` });

    // A recipe the build rejects as a config error (exit 2) is not kept: fixing it is a new add.
    const rejected = report.packs.some(
      (entry) => entry.status === 'failed' && entry.exitCode === EXIT_USAGE
    );
    if (rejected) {
      if (previousConfig === null) {
        await rm(configPath, { force: true });
      } else {
        await writeTextFileSafely(configPath, previousConfig);
      }
    }

    if (options.json === true) {
      writeJson({ id, dryRun: false, recipe: pack, configKept: !rejected, sync: report });
    }
    printSyncReport(report);
    if (rejected) {
      say(
        `Left ${CONFIG_FILE_NAME} as it was: the build rejected the recipe for packs.${id}. Fix it and run the add again.`
      );
    }
    process.exitCode = syncExitCode(report);
  });

  withProjectOptions(
    describeCommand(program.command('sync'), 'sync')
      .argument('[ids...]', 'Pack ids to sync (default: every pack in llm-docs.json)')
      .option(
        '--check',
        'Write nothing; exit 1 when a pack or managed block would change (default: write)'
      )
      .option(
        '--offline',
        'Fail a pack that must fetch network sources to rebuild, instead of fetching (default: fetch)'
      )
      .option(
        '--prune',
        'Delete pack directories that have no recipe in llm-docs.json (default: only report them)'
      ),
    'nearest config'
  ).action(
    async (
      ids: string[],
      options: ProjectOptions & { check?: boolean; offline?: boolean; prune?: boolean }
    ) => {
      const projectRoot = await existingProjectRoot(options);
      const report = await syncPacks(projectRoot, ids, {
        check: options.check === true,
        offline: options.offline === true,
        prune: options.prune === true,
        command: `llm-docs sync${ids.length > 0 ? ` ${ids.join(' ')}` : ''}`,
      });

      if (options.json === true) {
        writeJson(report);
      }
      printSyncReport(report);
      process.exitCode = syncExitCode(report);
    }
  );

  withProjectOptions(
    describeCommand(program.command('verify'), 'verify')
      .argument(
        '[ids...]',
        'Pack ids to verify (default: every pack, plus pack directories with no recipe)'
      )
      .option(
        '--strict',
        'Also check link fragments against heading anchors, and fail on an unknown or proprietary license (default: warn on the license)'
      ),
    'nearest config'
  ).action(async (ids: string[], options: ProjectOptions & { strict?: boolean }) => {
    const projectRoot = await existingProjectRoot(options);
    const report = await verifyPacks(projectRoot, ids, { strict: options.strict === true });

    if (options.json === true) {
      writeJson(report);
    }
    printVerifyReport(report);
    process.exitCode = report.ok ? 0 : EXIT_CHECK_FAILED;
  });

  withProjectOptions(
    describeCommand(program.command('refresh'), 'refresh')
      .argument('[ids...]', 'Pack ids to refresh (default: every pack in llm-docs.json)')
      .option(
        '--check',
        'Write nothing; exit 1 when anything changed upstream (default: rebuild the changed packs)'
      ),
    'nearest config'
  ).action(async (ids: string[], options: ProjectOptions & { check?: boolean }) => {
    const projectRoot = await existingProjectRoot(options);
    const report = await syncPacks(projectRoot, ids, {
      refresh: true,
      check: options.check === true,
      command: `llm-docs refresh${ids.length > 0 ? ` ${ids.join(' ')}` : ''}`,
    });

    if (options.json === true) {
      writeJson(report);
    }
    printRefreshReport(report);
    process.exitCode = syncExitCode(report);
  });

  const guides = describeCommand(program.command('guides'), 'guides stamp');

  withProjectOptions(
    describeCommand(guides.command('stamp'), 'guides stamp')
      .argument('<id>', 'Pack whose guides to stamp')
      .argument(
        '[guides...]',
        'Guides to stamp, as guides/x.md, x.md, or a path to the file (default: every guide of the pack)'
      ),
    'nearest config'
  ).action(async (id: string, guidePaths: string[], options: ProjectOptions) => {
    const loaded = await loadProjectConfig(await existingProjectRoot(options));
    const result = await stampGuides(loaded, id, guidePaths, process.cwd());

    if (options.json === true) {
      writeJson(result);
    }
    for (const guide of result.guides) {
      say(
        `${id}: stamped ${guide.path} (${guide.citations} citation${guide.citations === 1 ? '' : 's'})`
      );
    }
    for (const removed of result.removed) {
      say(`${id}: dropped ${removed} from the lock (the guide no longer exists)`);
    }
    for (const warning of result.warnings) {
      say(`  warning: ${warning}`);
    }
    say(result.changed ? `Wrote ${result.lockPath}.` : `${result.lockPath} is up to date.`);
  });

  withProjectOptions(
    describeCommand(program.command('status'), 'status')
      .option(
        '--model <id>',
        'Model id or Claude Code alias, such as claude-opus-5-5 or opus, whose training data cutoff release dates are compared against (default: none)'
      )
      .option(
        '--cutoff <YYYY-MM>',
        `Training data cutoff month; overrides --model (default: model.cutoff in ${CONFIG_FILE_NAME}, else LLM_DOCS_MODEL_CUTOFF, else the --model table entry)`
      )
      .option(
        '--offline',
        'Use cached release dates only, with no network requests (default: look up missing dates)'
      )
      .addOption(
        new Option(
          '--brief',
          'Print only the text the session-start hook would inject, on stdout (not with --json)'
        ).conflicts('json')
      ),
    'nearest config or cwd'
  ).action(
    async (
      options: ProjectOptions & {
        model?: string;
        cutoff?: string;
        offline?: boolean;
        brief?: boolean;
      }
    ) => {
      // --project is the root, as for every other command. Without it, the hook's discovery
      // from the working directory, so --brief prints what a session there would get.
      const projectRoot =
        options.project !== undefined
          ? resolve(options.project)
          : ((await findProjectRoot(process.cwd())) ?? resolve(process.cwd()));
      const status = await gatherProjectStatus(
        { projectRoot, loaded: await loadProjectConfigIfPresent(projectRoot) },
        {
          offline: options.offline === true,
          ...(options.model === undefined ? {} : { model: { id: options.model, source: 'flag' } }),
          ...(options.cutoff === undefined ? {} : { cutoff: options.cutoff }),
          env: process.env,
          homeDir: homedir(),
          cacheDir: defaultCacheDir(),
          now: new Date(),
        }
      );

      if (options.brief === true) {
        const brief = await sessionBrief(status, detectHarness(process.env));
        if (brief !== '') {
          process.stdout.write(`${brief}\n`);
        }
        return;
      }
      if (options.json === true) {
        writeJson(status.report);
      }
      process.stderr.write(withProjectHint(formatStatusHuman(status.report)));
      for (const warning of status.warnings) {
        say(`warning: ${warning}`);
      }
    }
  );

  describeCommand(
    describeCommand(program.command('hook'), 'hook session-start').command('session-start'),
    'hook session-start'
  )
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async () => {
      await runSessionStartHook(nodeHookIo());
      // Output went out with a synchronous write and the warm-up child is unreferenced, so
      // exiting now only drops work that missed the deadline.
      process.exit(0);
    });

  withProjectOptions(
    describeCommand(program.command('migrate'), 'migrate')
      .argument('<v2-pack-dir>', 'Directory of a v2 pack (the one holding its manifest.json)')
      .option('--id <id>', 'Pack id (default: the v2 pack directory name)')
      .option(
        '--version <version>',
        'Docs version the pack describes (required: v2 manifests record none)'
      ),
    'create'
  ).action(async (packDir: string, options: ProjectOptions & { id?: string; version?: string }) => {
    const outcome = await migrateV2Pack(resolve(packDir), {
      projectRoot: await creatingProjectRoot(options),
      id: options.id,
      version: options.version,
    });

    if (outcome.status === 'refused') {
      throw new UsageError(outcome.message);
    }

    const next = `llm-docs sync ${outcome.id}`;

    if (options.json === true) {
      writeJson({
        id: outcome.id,
        recipe: outcome.pack,
        configPath: outcome.configPath,
        warnings: outcome.warnings,
        next,
      });
    }
    say(`Wrote packs.${outcome.id} to ${outcome.configPath}; the v2 pack is unchanged.`);
    for (const warning of outcome.warnings) {
      say(`  warning: ${warning}`);
    }
    say(`Next: run '${next}'.`);
  });

  describeCommand(program.command('discover'), 'discover')
    .option('--url <site>', 'Website to inspect: an https:// URL (its llms.txt and sitemap.xml)')
    .option(
      '--package <ecosystem:name[@version]>',
      `Package to inspect, such as npm:vite@7.1.0; ecosystems: ${ECOSYSTEMS.join(', ')} (swiftpm:<repository url>) (default version: the latest)`
    )
    .option('--json', 'Accepted for consistency: discover always prints JSON on stdout')
    .action(async (options: { url?: string; package?: string }) => {
      if ((options.url === undefined) === (options.package === undefined)) {
        throw new UsageError(
          "discover needs exactly one of --url <site> and --package <ecosystem>:<name>[@<version>]; for example 'llm-docs discover --package npm:vite'."
        );
      }

      if (options.package !== undefined) {
        const discovery = await discoverPackage(parsePackageSpec(options.package));
        writeJson(discovery);
        for (const line of describePackageDiscovery(discovery)) {
          say(line);
        }
        return;
      }

      const inspection = await inspectWebsite({ url: options.url ?? '' }).catch(
        (error: unknown) => {
          // inspectWebsite only throws for invalid input; fetch failures are
          // recorded as warnings in the evidence instead.
          throw new UsageError(errorMessage(error));
        }
      );
      writeJson(inspection);
      const markdownPages = inspection.llmsTxt?.markdownProbes.filter((probe) => probe.markdown);
      const segments = inspection.llmsTxt?.versionSegments
        .slice(0, 5)
        .map((entry) => `${entry.segment} (${entry.urls})`);
      say(
        `Inspected ${inspection.inspectedResources.length} resources at ${inspection.website.origin}: ` +
          `${inspection.candidates.length} candidate URLs, ${inspection.warnings.length} warnings.`
      );
      if (inspection.llmsTxt !== null) {
        say(
          `  llms.txt lists ${inspection.llmsTxt.listedUrls} URLs; Markdown at .md: ${markdownPages?.length ?? 0} of ${inspection.llmsTxt.markdownProbes.length} probed pages; version segments: ${segments?.length === 0 ? 'none' : segments?.join(', ')}.`
        );
      }
      for (const warning of inspection.warnings) {
        say(`  warning: ${warning}`);
      }
    });

  describeCommand(program.command('capabilities'), 'capabilities')
    .option('--json', 'Print every capability as one JSON document (default: one line per command)')
    .action((options: { json?: boolean }) => {
      if (options.json === true) {
        writeJson(capabilities(program));
        return;
      }
      for (const command of COMMANDS) {
        process.stdout.write(`${command.name.padEnd(14)} ${command.summary}\n`);
      }
    });

  for (const removed of REMOVED_COMMANDS) {
    program
      .command(removed.name, { hidden: true })
      .helpOption(false)
      .allowUnknownOption()
      .allowExcessArguments()
      .argument('[args...]')
      .action(() => {
        say(`${CLI_NAME}: '${removed.name}' was removed in v3. ${removed.hint}`);
        process.exitCode = EXIT_USAGE;
      });
  }

  return program;
}

/** Usage and config errors exit 2; everything else (a held lock, I/O, git, network) exits 3. */
function exitCodeFor(error: unknown): number {
  return error instanceof UsageError || error instanceof ConfigError ? EXIT_USAGE : EXIT_RUNTIME;
}

async function main(): Promise<void> {
  try {
    await buildProgram().parseAsync(process.argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      // Commander already printed its message; --help and --version exit 0.
      process.exitCode = error.exitCode === 0 ? 0 : EXIT_USAGE;
      return;
    }
    say(`${CLI_NAME}: ${errorMessage(error).replace(/\s*\n\s*/g, ' ')}`);
    if (process.env.LLM_DOCS_DEBUG === '1' && error instanceof Error && error.stack !== undefined) {
      process.stderr.write(`${error.stack}\n`);
    }
    process.exitCode = exitCodeFor(error);
  }
}

await main();
