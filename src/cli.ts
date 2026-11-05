#!/usr/bin/env node

import { resolve } from 'node:path';

import { Command, CommanderError } from 'commander';

import packageJson from '../package.json';
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
  loadProjectConfig,
  packConfigSchema,
  parseProjectConfig,
  projectRootForCreate,
  resolvePackRecipe,
  saveProjectConfig,
  sourceConfigSchema,
  PACK_ID_PATTERN,
  type LoadedProjectConfig,
  type PackConfig,
} from './config/project.js';
import { inspectWebsite } from './core/website-discovery.js';
import { ECOSYSTEMS, type Ecosystem } from './deps/lockfiles.js';
import { ensurePacksDir, previewPack, syncPacks, type SyncReport } from './pack/build.js';
import {
  PACK_CHECK_NAMES,
  PROJECT_CHECK_NAMES,
  verifyPacks,
  type VerifyReport,
} from './pack/verify.js';
import { supportedSourceTypes } from './sources/acquire.js';
import { CONVERTER_INSTALL_HINTS } from './sources/convert.js';
import { errorMessage, isRecord } from './utils/guards.js';

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
    summary: 'Create llm-docs.json and the packs directory (never overwrites config)',
    status: 'implemented',
  },
  {
    name: 'add',
    summary: 'Write a pack recipe into llm-docs.json, then sync that pack',
    status: 'implemented',
  },
  {
    name: 'sync',
    summary: 'Build or rebuild packs so they match their recipes',
    status: 'implemented',
  },
  {
    name: 'verify',
    summary: 'Check packs against their manifests, recipes, and links (read-only, offline)',
    status: 'implemented',
  },
  {
    name: 'discover',
    summary: 'Print read-only evidence about a docs website (llms.txt, sitemap) as JSON',
    status: 'implemented',
  },
  {
    name: 'capabilities',
    summary: 'Describe the commands, sources, converters, transforms, and limits of this build',
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
  dependency?: string;
  version?: string;
  mount?: string;
  title?: string;
  recipe?: string;
  convert?: string;
  convertInclude?: string[];
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

/**
 * Source flags of `add`, each building one source object. Phase 2c adds
 * `--git/--ref/--path`, `--url`, `--urls-file`, and `--llms-txt/--include`
 * here; `--site` goes next to them. `--convert` is read by readConvertFlags.
 */
const ADD_SOURCE_FLAGS: ReadonlyArray<{
  flags: string;
  description: string;
  read(options: AddOptions): Record<string, unknown> | undefined;
}> = [
  {
    flags: '--local <path>',
    description: 'Take the docs from a project-relative directory or file',
    read: (options) =>
      options.local === undefined ? undefined : { type: 'local', path: options.local },
  },
];

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
  // Keep the source exactly as the user wrote it (not the parsed copy) so the config stays minimal.
  pack.sources = [source];

  const checkedPack = packConfigSchema.safeParse(pack);

  if (!checkedPack.success) {
    throw new UsageError(formatSchemaIssues('pack', checkedPack.error));
  }

  return checkedPack.data;
}

async function loadOrEmptyConfig(projectRoot: string): Promise<LoadedProjectConfig> {
  try {
    return await loadProjectConfig(projectRoot);
  } catch (error) {
    if (error instanceof ConfigError && error.message.startsWith(`No ${CONFIG_FILE_NAME}`)) {
      return parseProjectConfig(projectRoot, JSON.stringify({ schemaVersion: 3, packs: {} }));
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** The exit code a sync report implies: the worst failure, else 1 for `--check` changes. */
function syncExitCode(report: SyncReport): number {
  const failures = report.packs.filter((pack) => pack.status === 'failed');

  if (failures.length > 0) {
    return failures.some((pack) => pack.exitCode === EXIT_RUNTIME) ? EXIT_RUNTIME : EXIT_USAGE;
  }

  return report.check && report.changed ? EXIT_CHECK_FAILED : 0;
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

  for (const message of report.afterSync?.messages ?? []) {
    say(message);
  }

  if (report.packs.length === 0) {
    say(
      `No packs in ${CONFIG_FILE_NAME}; add one with 'llm-docs add <id> --local <path> --version <v>'.`
    );
  } else if (report.check) {
    say(
      report.changed
        ? 'sync --check: packs are out of date.'
        : 'sync --check: everything is up to date.'
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
      options:
        program.commands
          .find((command) => command.name() === entry.name)
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
    // Phase 4: insert the empty managed agent-file blocks (spec 7.1) here.

    if (options.json === true) {
      writeJson({ projectRoot, configPath, created, packsDir: loaded.packsDirRelative });
    }
    say(
      created
        ? `Created ${configPath} and ${loaded.packsDirRelative}/.`
        : `${configPath} already exists; left it unchanged.`
    );
  });

  const add = program
    .command('add')
    .description(summaryOf('add'))
    .argument('<id>', 'Pack id (lowercase letters, digits, ".", "_", "-")');

  for (const flag of ADD_SOURCE_FLAGS) {
    add.option(flag.flags, flag.description);
  }

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
      const resolved = await resolvePackRecipe(config, id);
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
      for (const warning of preview.warnings) {
        say(`  warning: ${warning}`);
      }
      say(
        `add --dry-run: ${preview.files.length} file${preview.files.length === 1 ? '' : 's'}; nothing written.`
      );
      return;
    }

    await saveProjectConfig(projectRoot, id, pack);
    say(`Wrote packs.${id} to ${CONFIG_FILE_NAME}.`);
    const report = await syncPacks(projectRoot, [id], { command: `llm-docs add ${id}` });

    if (options.json === true) {
      writeJson({ id, dryRun: false, recipe: pack, sync: report });
    }
    printSyncReport(report);
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
      .option('--strict', 'Also check link fragments against heading anchors')
  ).action(async (ids: string[], options: ProjectOptions & { strict?: boolean }) => {
    const projectRoot = await existingProjectRoot(options);
    const report = await verifyPacks(projectRoot, ids, { strict: options.strict === true });

    if (options.json === true) {
      writeJson(report);
    }
    printVerifyReport(report);
    process.exitCode = report.ok ? 0 : EXIT_CHECK_FAILED;
  });

  program
    .command('discover')
    .description(summaryOf('discover'))
    .requiredOption('--url <site>', 'Website to inspect (its llms.txt and sitemap.xml)')
    .option(
      '--allow-private-hosts',
      'Allow private and link-local IP literals (refused by default as an SSRF guard)'
    )
    .option('--json', 'Print only the JSON evidence, without the stderr summary')
    .action(async (options: { url: string; allowPrivateHosts?: boolean; json?: boolean }) => {
      const inspection = await inspectWebsite({
        url: options.url,
        allowPrivateHosts: options.allowPrivateHosts === true,
      }).catch((error: unknown) => {
        // inspectWebsite only throws for invalid input; fetch failures are
        // recorded as warnings in the evidence instead.
        throw new UsageError(errorMessage(error));
      });
      writeJson(inspection);
      if (options.json !== true) {
        say(
          `Inspected ${inspection.inspectedResources.length} resources at ${inspection.website.origin}: ` +
            `${inspection.candidates.length} candidate URLs, ${inspection.warnings.length} warnings.`
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
