#!/usr/bin/env node

import { Command, CommanderError } from 'commander';

import packageJson from '../package.json';
import { inspectWebsite } from './core/website-discovery.js';
import { errorMessage } from './utils/guards.js';

const CLI_NAME = 'llm-docs';
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
    name: 'discover',
    summary: 'Print read-only evidence about a docs website (llms.txt, sitemap) as JSON',
    status: 'implemented',
  },
  {
    name: 'capabilities',
    summary: 'Describe the commands this build implements',
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

function buildProgram(): Command {
  const program = new Command();

  // Must precede command() calls: subcommands copy this setting when created.
  program.exitOverride();
  program.name(CLI_NAME).description(packageJson.description).version(packageJson.version);

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
        process.stderr.write(
          `Inspected ${inspection.inspectedResources.length} resources at ${inspection.website.origin}: ` +
            `${inspection.candidates.length} candidate URLs, ${inspection.warnings.length} warnings.\n`
        );
      }
    });

  program
    .command('capabilities')
    .description(summaryOf('capabilities'))
    .option('--json', 'Print the machine-readable capabilities')
    .action((options: { json?: boolean }) => {
      if (options.json === true) {
        writeJson({ name: CLI_NAME, version: packageJson.version, commands: COMMANDS });
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
        process.stderr.write(`${CLI_NAME}: '${removed.name}' was removed in v3. ${removed.hint}\n`);
        process.exitCode = EXIT_USAGE;
      });
  }

  return program;
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
    process.stderr.write(`${CLI_NAME}: ${errorMessage(error)}\n`);
    process.exitCode = error instanceof UsageError ? EXIT_USAGE : EXIT_RUNTIME;
  }
}

await main();
