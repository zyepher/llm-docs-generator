#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { Command, CommanderError } from 'commander';

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
  type PackSyncResult,
  type SyncReport,
} from './pack/build.js';
import { stampGuides, type PageChange, type SectionChange } from './pack/guides.js';
import {
  PACK_CHECK_NAMES,
  PROJECT_CHECK_NAMES,
  verifyPacks,
  type VerifyReport,
} from './pack/verify.js';
import { supportedSourceTypes } from './sources/acquire.js';
import { CONVERTER_INSTALL_HINTS } from './sources/convert.js';
import { errorMessage, isFileNotFoundError, isRecord } from './utils/guards.js';
import { writeTextFileSafely } from './utils/safe-write.js';

const CLI_NAME = 'llm-docs';
const EXIT_CHECK_FAILED = 1;
const EXIT_USAGE = 2;
const EXIT_RUNTIME = 3;

interface CommandEntry {
  name: string;
  summary: string;
  status: 'implemented';
}

// The single source for `capabilities` and for each command's help text. A
// command registered below must have an entry here so the two cannot drift.
const COMMANDS = [
  {
    name: 'init',
    summary:
      'Create llm-docs.json, the packs directory, and empty managed blocks in the agent files (never overwrites config)',
    status: 'implemented',
  },
  {
    name: 'add',
    summary: 'Write a pack recipe into llm-docs.json, then sync that pack',
    status: 'implemented',
  },
  {
    name: 'sync',
    summary:
      'Build or rebuild packs so they match their recipes and lockfiles, then update the managed blocks',
    status: 'implemented',
  },
  {
    name: 'refresh',
    summary: 'Re-acquire packs at their recorded recipes and report what changed upstream',
    status: 'implemented',
  },
  {
    name: 'verify',
    summary:
      'Check packs against their manifests, recipes, lockfiles, and links, and the managed blocks (read-only, offline)',
    status: 'implemented',
  },
  {
    name: 'status',
    summary:
      "Show the packs and their lockfile drift, and the direct dependencies released after or near the model's training data cutoff",
    status: 'implemented',
  },
  {
    name: 'guides stamp',
    summary:
      'Record the hash of every section each guide cites, so verify, refresh, and sync report the guides to re-review when that text changes',
    status: 'implemented',
  },
  {
    name: 'migrate',
    summary:
      'Write a recipe into llm-docs.json for a v2 pack, from its manifest (the v2 pack is left as is)',
    status: 'implemented',
  },
  {
    name: 'discover',
    summary:
      'Print read-only evidence for writing a recipe as JSON: a docs website (--url: llms.txt, sitemap, Markdown probe, version segments) or a package (--package: registry metadata, matching git tags, Markdown directories, change documents)',
    status: 'implemented',
  },
  {
    name: 'capabilities',
    summary: 'Describe the commands, sources, converters, transforms, and limits of this build',
    status: 'implemented',
  },
  {
    name: 'hook session-start',
    summary: 'Used by the plugin',
    status: 'implemented',
  },
] as const satisfies readonly CommandEntry[];

type CommandName = (typeof COMMANDS)[number]['name'];

const REMOVED_COMMANDS: ReadonlyArray<{ name: string; hint: string }> = [
  { name: 'generate', hint: "Use 'llm-docs add' (see docs/design/v3-spec.md)." },
  {
    name: 'validate',
    hint: "The Supabase SDK catalog was removed; add the SDK docs as a pack with 'llm-docs add'.",
  },
  {
    name: 'list-sdks',
    hint: "The Supabase SDK catalog was removed; add the SDK docs as a pack with 'llm-docs add'.",
  },
  { name: 'source-truth', hint: 'Read the code directly; source-truth mode was removed.' },
  { name: 'verify-docs', hint: 'Read the code directly; source-truth mode was removed.' },
  { name: 'plugins', hint: 'Use a converter command (convert.tool = "command") instead.' },
  { name: 'agent', hint: 'Install the llm-docs plugin instead.' },
];

class UsageError extends Error {}

function summaryOf(name: CommandName): string {
  const entry = COMMANDS.find((command) => command.name === name);
  if (entry === undefined) {
    throw new Error(`Command ${name} has no COMMANDS entry`);
  }
  return entry.summary;
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Human output always goes to stderr, so stdout carries only `--json` output. */
function say(line: string): void {
  process.stderr.write(`${line}\n`);
}

interface ProjectOptions {
  project?: string;
  json?: boolean;
}

function withProjectOptions(command: Command): Command {
  return command
    .option('--project <dir>', `Project root (the directory holding ${CONFIG_FILE_NAME})`)
    .option('--json', 'Print machine-readable JSON on stdout (human output stays on stderr)');
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
    throw new UsageError(`Cannot read --urls-file ${path}: ${errorMessage(error)}`);
  }

  const urls = text
    .split(/\r?\n/)
    .map((line) => line.replace(/(?:^|\s)#.*$/, '').trim())
    .filter((line) => line !== '');

  if (urls.length === 0) {
    throw new UsageError(`--urls-file ${path} lists no URLs.`);
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
    description: 'Take the docs from a project-relative directory or file',
    read: (options) =>
      options.local === undefined ? undefined : { type: 'local', path: options.local },
  },
  {
    flags: '--git <repo>',
    description: 'Take the docs from a git repository (https://) at --ref, limited to --path',
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
    description: 'Fetch exactly this page (repeatable)',
    repeatable: true,
    read: (options) =>
      options.url === undefined ? undefined : { type: 'urls', urls: options.url },
  },
  {
    flags: '--urls-file <file>',
    description: 'Fetch the pages listed in a file, one URL per line (# comments)',
    read: (options) =>
      options.urlsFile === undefined
        ? undefined
        : { type: 'urls', urls: readUrlsFile(options.urlsFile) },
  },
  {
    flags: '--llms-txt <url>',
    description: 'Fetch the pages an llms.txt index lists that pass --include',
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
    description: 'Tag, branch, or 40-hex commit for --git',
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
      'Glob a page must match: URL paths for --llms-txt, file paths otherwise (repeatable)',
    key: 'include',
    repeatable: true,
  },
  {
    flags: '--strip-prefix <prefix>',
    description: 'URL path prefix removed from --llms-txt page paths',
    key: 'stripPrefix',
    needs: 'llms-txt',
  },
];

function collect(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

function parseDependency(value: string): { ecosystem: Ecosystem; name: string } {
  const separator = value.indexOf(':');
  const ecosystem = ECOSYSTEMS.find((entry) => entry === value.slice(0, separator));
  const name = value.slice(separator + 1);

  if (separator <= 0 || name === '' || ecosystem === undefined) {
    throw new UsageError(
      `--dependency must be <ecosystem>:<name> with an ecosystem of ${ECOSYSTEMS.join(', ')}; got "${value}".`
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
    throw new UsageError('Pass one source flag per add.');
  }

  const extra = options.recipe === undefined ? {} : parseRecipeJson(options.recipe);
  const source: Record<string, unknown> = { ...(fromFlags[0] ?? {}) };
  const convert = readConvertFlags(options);

  if (convert !== undefined) {
    source.convert = convert;
  }

  for (const [key, value] of Object.entries(extra)) {
    if (Object.hasOwn(source, key) && source[key] !== value) {
      throw new UsageError(`--recipe sets "${key}", which a source flag already sets.`);
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
      throw new UsageError('--mount and --recipe both set "mount".');
    }
    source.mount = options.mount;
  }

  for (const modifier of ADD_SOURCE_MODIFIERS) {
    if (
      options[modifier.key] !== undefined &&
      modifier.needs !== undefined &&
      source.type !== modifier.needs
    ) {
      throw new UsageError(`${modifier.flags.split(' ')[0]} only applies to --${modifier.needs}.`);
    }
  }

  if (options.include !== undefined) {
    if (Object.hasOwn(source, 'include')) {
      throw new UsageError('--include and --recipe both set "include".');
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
    pack.dependency = parseDependency(options.dependency);
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
    say(`  after re-reviewing them: llm-docs guides stamp ${pack.id} ${guides}`);
  }
}

function printSyncReport(report: SyncReport): void {
  for (const pack of report.packs) {
    switch (pack.status) {
      case 'unchanged':
        say(`${pack.id}: up to date`);
        break;
      case 'built':
        say(`${pack.id}: built (${pack.reason ?? 'rebuilt'})`);
        break;
      case 'would-build':
        say(`${pack.id}: would rebuild (${pack.reason ?? 'out of date'})`);
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
    say(
      report.changed
        ? "sync --check: packs or managed blocks are out of date; run 'llm-docs sync'."
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
    const reason = pack.reason ?? 'upstream changed';
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
    say(
      report.changed
        ? 'refresh --check: upstream or a converter changed; run refresh without --check to rebuild.'
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
      say(`${scope} ${entry.check} ${finding.status}:${path} ${finding.message}`);
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

function capabilities(program: Command): unknown {
  const supported = new Set(supportedSourceTypes());

  return {
    name: CLI_NAME,
    version: packageJson.version,
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
    sourceTypes: SOURCE_TYPES.map((type) => ({ type, supported: supported.has(type) })),
    converters: CONVERTER_TOOLS.map((tool) => ({
      tool,
      supported: true,
      install: CONVERTER_INSTALL_HINTS[tool],
    })),
    ecosystems: ECOSYSTEMS,
    transforms: TRANSFORM_NAMES,
    checks: { pack: PACK_CHECK_NAMES, project: PROJECT_CHECK_NAMES },
    limits: PACK_LIMITS,
  };
}

function buildProgram(): Command {
  const program = new Command();

  // Must precede command() calls: subcommands copy this setting when created.
  program.exitOverride();
  // Program options (-V, --version) only before the command name, so `add --version <v>` is add's.
  program.enablePositionalOptions();
  program.name(CLI_NAME).description(packageJson.description).version(packageJson.version);

  withProjectOptions(
    program
      .command('init')
      .description(summaryOf('init'))
      .option('--packs-dir <dir>', 'Project-relative packs directory (default agent-docs)')
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

  const add = program
    .command('add')
    .description(summaryOf('add'))
    .argument('<id>', 'Pack id (lowercase letters, digits, ".", "_", "-")');

  for (const flag of [...ADD_SOURCE_FLAGS, ...ADD_SOURCE_MODIFIERS]) {
    if (flag.repeatable === true) {
      add.option(flag.flags, flag.description, collect);
    } else {
      add.option(flag.flags, flag.description);
    }
  }
  add.option('--site <baseUrl>', 'The docs website, so links to it resolve to pack pages');

  withProjectOptions(
    add
      .option(
        '--dependency <ecosystem:name>',
        `Bind the pack to a dependency (${ECOSYSTEMS.join(', ')})`
      )
      .option('--version <version>', 'Docs version (required unless --dependency is set)')
      .option('--mount <dir>', 'Subdirectory under pages/ and files/ for this source')
      .option('--title <title>', 'Pack title (default: the id)')
      .option('--recipe <json>', 'Extra source fields as JSON (include, exclude, passthrough, ...)')
      .option(
        '--convert <tool>',
        `Convert documents (PDF, DOCX, ...) to pages with ${ADD_CONVERT_TOOLS.join(', ')} (a command converter goes in --recipe)`
      )
      .option(
        '--convert-include <glob...>',
        'Documents the converter takes (default for docling and markitdown: pdf, docx, pptx, epub, html)'
      )
      .option(
        '--read-first <target>',
        'A page or passthrough file to read first, such as a migration guide: pages/<path> or files/<path>, optionally #<heading slug> (repeatable, at most 5)',
        collect
      )
      .option('--replace', 'Overwrite an existing pack with this id')
      .option('--dry-run', 'Print the recipe and the files it would take, writing nothing')
  ).action(async (id: string, options: AddOptions) => {
    if (!PACK_ID_PATTERN.test(id)) {
      throw new UsageError(`Pack id "${id}" must match ${PACK_ID_PATTERN.source}.`);
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
      say(JSON.stringify({ [id]: pack }, null, 2));
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
    program
      .command('sync')
      .description(summaryOf('sync'))
      .argument('[ids...]', 'Packs to sync (default: all)')
      .option('--check', 'Write nothing; exit 1 when any pack would change')
      .option('--offline', 'Fail rather than acquire network sources')
      .option('--prune', 'Delete pack directories that are not in the config')
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
    program
      .command('verify')
      .description(summaryOf('verify'))
      .argument('[ids...]', 'Packs to verify (default: all, plus orphan pack directories)')
      .option(
        '--strict',
        'Also check link fragments against heading anchors, and fail on an unknown or proprietary license'
      )
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
    program
      .command('refresh')
      .description(summaryOf('refresh'))
      .argument('[ids...]', 'Packs to refresh (default: all)')
      .option('--check', 'Write nothing; exit 1 when anything changed upstream')
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

  const guides = program.command('guides').description(summaryOf('guides stamp'));

  withProjectOptions(
    guides
      .command('stamp')
      .description(summaryOf('guides stamp'))
      .argument('<id>', 'Pack whose guides to stamp')
      .argument(
        '[guides...]',
        'Guides to stamp (default: every guide), as guides/x.md, x.md, or a path to the file'
      )
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
    program
      .command('status')
      .description(summaryOf('status'))
      .option(
        '--model <id>',
        'Model id or Claude Code alias whose training data cutoff release dates are compared against'
      )
      .option('--cutoff <YYYY-MM>', 'Training data cutoff month (overrides --model)')
      .option('--offline', 'Use cached release dates only, with no network requests')
      .option('--brief', 'Print only the text the session-start hook would inject, on stdout')
  ).action(
    async (
      options: ProjectOptions & {
        model?: string;
        cutoff?: string;
        offline?: boolean;
        brief?: boolean;
      }
    ) => {
      // The same project rule as the hook, so --brief prints what a session there would get.
      const start = resolve(options.project ?? process.cwd());
      const projectRoot = (await findProjectRoot(start)) ?? start;
      const status = await gatherProjectStatus(
        { projectRoot, loaded: await loadProjectConfigIfPresent(projectRoot) },
        {
          offline: options.offline === true,
          ...(options.model === undefined ? {} : { modelId: options.model }),
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
      process.stderr.write(formatStatusHuman(status.report));
      for (const warning of status.warnings) {
        say(`warning: ${warning}`);
      }
    }
  );

  program
    .command('hook')
    .description(summaryOf('hook session-start'))
    .command('session-start')
    .description(summaryOf('hook session-start'))
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async () => {
      await runSessionStartHook(nodeHookIo());
      // Output went out with a synchronous write and the warm-up child is unreferenced, so
      // exiting now only drops work that missed the deadline.
      process.exit(0);
    });

  withProjectOptions(
    program
      .command('migrate')
      .description(summaryOf('migrate'))
      .argument('<v2-pack-dir>', 'Directory of a v2 pack (the one holding its manifest.json)')
      .option('--id <id>', 'Pack id (default: the v2 pack directory name)')
      .option('--version <version>', 'Docs version the pack describes (v2 manifests record none)')
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
    say(`Next: ${next}`);
  });

  program
    .command('discover')
    .description(summaryOf('discover'))
    .option('--url <site>', 'Website to inspect (its llms.txt and sitemap.xml)')
    .option(
      '--package <ecosystem:name[@version]>',
      `Package to inspect (${ECOSYSTEMS.join(', ')}; swiftpm:<repository url>); default version: the latest`
    )
    .option('--json', 'Accepted for consistency: discover always prints JSON on stdout')
    .action(async (options: { url?: string; package?: string }) => {
      if ((options.url === undefined) === (options.package === undefined)) {
        throw new UsageError(
          'discover needs exactly one of --url and --package. Usage: llm-docs discover --url <site> | --package <ecosystem>:<name>[@<version>]'
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
    });

  program
    .command('capabilities')
    .description(summaryOf('capabilities'))
    .option('--json', 'Print the machine-readable capabilities')
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
