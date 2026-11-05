/**
 * Converter adapters (spec 4.6): turn a PDF or office document into Markdown
 * that then goes through the ordinary Markdown page path.
 *
 * - `docling`: `docling --to md --image-export-mode placeholder --output <dir> <input>`,
 *   then `<dir>/<stem>.md`. Placeholder images keep base64 data out of pages.
 * - `markitdown`: `markitdown <input>`, Markdown on stdout.
 * - `command`: a trusted argv from the recipe with `{input}` and optional
 *   `{output}` placeholders; reads `{output}` when present, else stdout.
 * - `agent`: no process. An agent writes `X.md` next to each original `X`;
 *   the pack uses it and records both hashes, and a conversion whose original
 *   changed after the `.md` was written is reported stale.
 *
 * Processes run with `spawn` and an argv array, never a shell. The one
 * exception is a Windows batch shim (`.cmd`/`.bat`), which only `cmd.exe` can
 * run: its arguments are quoted, and any argument cmd would still expand
 * (`"`, `%`, line breaks) is refused. Every input is copied under a sanitized
 * name into the build's temp directory first, so the converter only sees
 * paths the engine chose, and it cannot write next to the original.
 *
 * Converter output is not assumed deterministic. Successful conversions are
 * cached in `<user cache dir>/conversions/`, keyed by the input's hash, the
 * tool, its version, and the argv template, so a pack rebuilt for another
 * reason reuses the bytes of an unchanged document instead of reconverting it.
 */

import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join, posix, resolve } from 'node:path';

import { ConfigError, PACK_LIMITS, type ResolvedSource } from '../config/project.js';
import { defaultCacheDir } from '../deps/registries.js';
import type { ManifestSourceEntry } from '../pack/manifest.js';
import { errorMessage, isFileNotFoundError } from '../utils/guards.js';
import { sha256Hex, sha256Prefixed } from '../utils/hash.js';
import { canonicalJsonStringify } from '../utils/json.js';
import { writeTextFileSafely } from '../utils/safe-write.js';
import type { SelectedConversion } from './acquire.js';

export type ConvertSpec = NonNullable<ResolvedSource['convert']>;
export type ConverterTool = ConvertSpec['tool'];
export type ManifestConverter = NonNullable<ManifestSourceEntry['converter']>;

/** A converter failed to run or produced nothing usable: a runtime failure (exit 3). */
export class ConverterError extends Error {
  override name = 'ConverterError';
}

/** How to install each external tool, named in the missing-tool error and in `capabilities`. */
export const CONVERTER_INSTALL_HINTS: Readonly<Record<ConverterTool, string | null>> = {
  docling: 'pipx install docling',
  markitdown: "pipx install 'markitdown[all]'",
  command: null,
  agent: null,
};

/** Inputs above this size are refused before a converter runs. */
const MAX_INPUT_BYTES = PACK_LIMITS.maxMaxFileBytes;
/** Converter output above this size is cut off and reported as an error. */
const MAX_OUTPUT_BYTES = 100 * 1024 * 1024;
const VERSION_TIMEOUT_MS = 60_000;
const STDERR_TAIL_CHARS = 800;
const CACHE_FORMAT = 1;

export interface ConvertedDocument {
  /** The Markdown the converter (or agent) produced, before the page pipeline. */
  markdown: string;
  converter: ManifestConverter;
  /** Origin-relative path of the agent's `.md`, also recorded as a source. */
  agentOutputPath?: string;
  cached: boolean;
  warnings: string[];
}

export interface DocumentConverter {
  tool: ConverterTool;
  /** `--version` first line; null for `agent` and when it could not be read. */
  version: string | null;
  /** Problems found while resolving the tool (an unreadable version). */
  warnings: string[];
  /**
   * Convert one selected document. `previous` is the original's source entry
   * in the last manifest, which the `agent` converter needs to tell a stale
   * conversion from a fresh one.
   */
  convert(
    selected: SelectedConversion,
    previous: ManifestSourceEntry | undefined
  ): Promise<ConvertedDocument>;
}

export interface ConverterOptions {
  /** Realpath'd project root: a relative `command[0]` resolves against it. */
  projectRoot: string;
  /** Empty temp directory for this source's conversions; the caller removes it. */
  workDir: string;
  /** Where the `conversions/` cache lives; null disables it. Default: the user cache dir. */
  cacheDir?: string | null;
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the tool for one source's `convert` spec (executable and version)
 * and return a converter for its documents. A missing tool is an error that
 * names the install command.
 */
export async function createDocumentConverter(
  spec: ConvertSpec,
  options: ConverterOptions
): Promise<DocumentConverter> {
  if (spec.tool === 'agent') {
    return {
      tool: 'agent',
      version: null,
      warnings: [],
      convert: async (selected, previous) => convertWithAgent(selected, previous),
    };
  }

  const tool = spec.tool;
  const env = options.env ?? process.env;
  const argv = spec.command ?? [tool];
  const hasPlaceholder = (value: string): boolean => /\{(?:input|output)\}/.test(value);

  if (spec.tool === 'command') {
    if (!argv.some((value) => value.includes('{input}'))) {
      throw new ConfigError(
        'convert.command must pass the document to the converter with an {input} placeholder.'
      );
    }
    if (hasPlaceholder(argv[0] ?? '')) {
      throw new ConfigError('convert.command[0] must name the executable, not a placeholder.');
    }
  } else if (argv.some(hasPlaceholder)) {
    throw new ConfigError(
      `convert.command for "${spec.tool}" names the executable (and any leading arguments); llm-docs adds the ${spec.tool} arguments itself, so {input} and {output} are not allowed there.`
    );
  }

  const [name, ...leading] = argv;

  if (name === undefined) {
    throw new ConfigError('convert.command must not be empty.');
  }

  const executable = await resolveExecutable(name, options.projectRoot, env);

  if (executable === undefined) {
    const install = CONVERTER_INSTALL_HINTS[spec.tool];
    throw new ConverterError(
      install === null
        ? `The converter command "${name}" was not found; check convert.command.`
        : `${spec.tool} is not installed (no "${name}" on PATH); install it with: ${install} (or point convert.command at the executable).`
    );
  }

  const warnings: string[] = [];
  const version = await readToolVersion(executable, spec.tool === 'command' ? [] : leading, env);

  if (version === null) {
    warnings.push(
      `Could not read the version of the ${spec.tool} converter ("${name} --version"); its conversions are recorded with version null and are not cached.`
    );
  }

  const timeoutMs = spec.timeoutSeconds * 1000;
  const cacheDir = options.cacheDir === undefined ? defaultCacheDir() : options.cacheDir;
  let counter = 0;

  return {
    tool: spec.tool,
    version,
    warnings,
    async convert(selected) {
      const label = selected.file.sourceLabel;

      if (selected.file.bytes > MAX_INPUT_BYTES) {
        throw new ConfigError(
          `${label} is ${selected.file.bytes} bytes, over the ${MAX_INPUT_BYTES} byte converter input limit; exclude it.`
        );
      }

      const template = invocationTemplate(tool, argv);
      const cacheKey =
        version === null || cacheDir === null
          ? undefined
          : sha256Hex(
              canonicalJsonStringify({
                format: CACHE_FORMAT,
                input: selected.file.sha256,
                tool: spec.tool,
                version,
                argv: template,
              })
            );
      const cachePath =
        cacheKey === undefined || cacheDir === null
          ? undefined
          : join(cacheDir, 'conversions', `${cacheKey}.md`);
      const converter = (markdown: string): ManifestConverter => ({
        tool: spec.tool,
        version,
        outputSha256: sha256Prefixed(markdown),
      });

      if (cachePath !== undefined) {
        const cached = await readCachedConversion(cachePath);
        if (cached !== undefined) {
          return { markdown: cached, converter: converter(cached), cached: true, warnings: [] };
        }
      }

      counter += 1;
      const dir = join(options.workDir, `document-${counter}`);
      const outputDir = join(dir, 'out');
      const name = safeFileName(posix.basename(selected.file.path));
      const input = join(dir, name);
      await mkdir(outputDir, { recursive: true });
      await copyFile(selected.file.absolutePath, input);

      const outputFile =
        spec.tool === 'docling'
          ? join(outputDir, `${fileStem(name)}.md`)
          : template.some((value) => value.includes('{output}'))
            ? join(outputDir, 'output.md')
            : undefined;
      // `{output-dir}` is docling's own placeholder; a command argv only takes the documented two.
      const args = template.slice(1).map((value) => {
        const substituted = value
          .replaceAll('{input}', input)
          .replaceAll('{output}', outputFile ?? '');
        return tool === 'docling' ? substituted.replaceAll('{output-dir}', outputDir) : substituted;
      });
      const run = await runProcess(executable, args, { cwd: dir, timeoutMs, env });
      const failure = (reason: string): ConverterError =>
        new ConverterError(
          `Converting ${label} with ${spec.tool} failed: ${reason}${stderrTail(run.stderr)}`
        );

      if (run.timedOut) {
        throw failure(
          `it ran longer than ${spec.timeoutSeconds} s and was stopped (raise convert.timeoutSeconds for large documents)`
        );
      }
      if (run.overflow) {
        throw failure(`it wrote more than ${MAX_OUTPUT_BYTES} bytes`);
      }
      if (run.exitCode !== 0) {
        throw failure(
          run.exitCode === null
            ? `it was killed by ${run.signal ?? 'a signal'}`
            : `exit code ${run.exitCode}`
        );
      }

      let bytes: Buffer;

      if (outputFile === undefined) {
        bytes = run.stdout;
      } else {
        try {
          bytes = await readFile(outputFile);
        } catch (error) {
          if (!isFileNotFoundError(error)) {
            throw error;
          }
          throw failure(`it exited successfully but wrote no ${posix.basename(outputFile)}`);
        }
      }

      let markdown: string;

      try {
        markdown = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw failure('its output is not valid UTF-8');
      }

      if (markdown.trim() === '') {
        throw failure('it produced empty output');
      }

      if (cachePath !== undefined) {
        await writeCachedConversion(cachePath, markdown);
      }

      return { markdown, converter: converter(markdown), cached: false, warnings: [] };
    },
  };
}

/**
 * The argv of one conversion with placeholders left in, element 0 the
 * configured executable. It is also the cache key's record of the arguments.
 */
function invocationTemplate(tool: Exclude<ConverterTool, 'agent'>, argv: string[]): string[] {
  switch (tool) {
    case 'docling':
      return [
        ...argv,
        '--to',
        'md',
        '--image-export-mode',
        'placeholder',
        '--output',
        '{output-dir}',
        '{input}',
      ];
    case 'markitdown':
      return [...argv, '{input}'];
    case 'command':
      return argv;
  }
}

/**
 * The agent's `X.md` next to the original `X`. `inputSha256` is the hash of
 * the original the `.md` was written from: carried over from the last sync
 * while the `.md` is unchanged, so an original that changes under an
 * unchanged conversion stays stale until an agent rewrites the `.md`.
 */
async function convertWithAgent(
  selected: SelectedConversion,
  previous: ManifestSourceEntry | undefined
): Promise<ConvertedDocument> {
  const output = selected.agentOutput;
  const label = selected.file.sourceLabel;

  if (output === undefined) {
    throw new ConfigError(
      `${label} is converted by an agent, but ${label}.md does not exist; have an agent convert the document into ${label}.md, then sync again.`
    );
  }

  let markdown: string;

  try {
    markdown = new TextDecoder('utf-8', { fatal: true }).decode(
      await readFile(output.absolutePath)
    );
  } catch (error) {
    throw new ConfigError(
      `${output.sourceLabel} is not valid UTF-8 text (${errorMessage(error)}).`
    );
  }

  if (markdown.trim() === '') {
    throw new ConfigError(`${output.sourceLabel} is empty; it must hold the agent's conversion.`);
  }

  const previousConverter = previous?.converter;
  const unchangedConversion =
    previousConverter?.tool === 'agent' && previousConverter.outputSha256 === output.sha256;
  const inputSha256 = unchangedConversion
    ? (previousConverter?.inputSha256 ?? previous?.sha256 ?? selected.file.sha256)
    : selected.file.sha256;
  const warnings =
    inputSha256 === selected.file.sha256
      ? []
      : [
          `Agent conversion ${output.sourceLabel} is stale: ${label} changed after it was written; convert the document again into ${output.sourceLabel}, then sync.`,
        ];

  return {
    markdown,
    converter: { tool: 'agent', version: null, outputSha256: output.sha256, inputSha256 },
    agentOutputPath: output.path,
    cached: false,
    warnings,
  };
}

/** Whether an agent conversion recorded in a manifest was stale at the last sync. */
export function isStaleAgentConversion(entry: ManifestSourceEntry): boolean {
  return (
    entry.converter?.tool === 'agent' &&
    entry.converter.inputSha256 !== undefined &&
    entry.converter.inputSha256 !== entry.sha256
  );
}

// ---------------------------------------------------------------------------
// The conversion cache
// ---------------------------------------------------------------------------

async function readCachedConversion(path: string): Promise<string | undefined> {
  try {
    const text = await readFile(path, 'utf-8');
    return text.trim() === '' ? undefined : text;
  } catch {
    // A missing or unreadable entry is a cache miss.
    return undefined;
  }
}

async function writeCachedConversion(path: string, markdown: string): Promise<void> {
  try {
    await mkdir(join(path, '..'), { recursive: true });
    await writeTextFileSafely(path, markdown);
  } catch {
    // The cache is an optimization; a read-only cache dir must not fail the build.
  }
}

// ---------------------------------------------------------------------------
// Resolving and running tools
// ---------------------------------------------------------------------------

const WINDOWS_EXECUTABLE_EXTENSIONS = ['.exe', '.cmd', '.bat', '.com'];

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) {
      return false;
    }
    if (process.platform !== 'win32') {
      await access(path, constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

/** On Windows, a name without an extension also matches `<name>.exe`, `.cmd`, `.bat`, `.com`. */
function candidateNames(path: string): string[] {
  if (process.platform !== 'win32' || /\.[A-Za-z0-9]+$/.test(posix.basename(path))) {
    return [path];
  }
  return WINDOWS_EXECUTABLE_EXTENSIONS.map((extension) => `${path}${extension}`);
}

/**
 * The absolute path of `name`: a path (with a separator) resolves against
 * the project root; a bare name is looked up on PATH.
 */
async function resolveExecutable(
  name: string,
  projectRoot: string,
  env: NodeJS.ProcessEnv
): Promise<string | undefined> {
  const directories = /[\\/]/.test(name)
    ? [isAbsolute(name) ? '' : projectRoot]
    : (env.PATH ?? env.Path ?? '').split(delimiter).filter((entry) => entry !== '');

  for (const directory of directories) {
    for (const candidate of candidateNames(directory === '' ? name : resolve(directory, name))) {
      if (await isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

/** First line of `<executable> [leading...] --version`, trimmed; null when unavailable. */
async function readToolVersion(
  executable: string,
  leading: readonly string[],
  env: NodeJS.ProcessEnv
): Promise<string | null> {
  try {
    const run = await runProcess(executable, [...leading, '--version'], {
      cwd: process.cwd(),
      timeoutMs: VERSION_TIMEOUT_MS,
      env,
    });

    if (run.exitCode !== 0 || run.timedOut || run.overflow) {
      return null;
    }

    const text = run.stdout.toString('utf-8').trim() || run.stderr.trim();
    const line = text.split(/\r?\n/, 1)[0]?.trim() ?? '';
    return line === '' ? null : line;
  } catch {
    return null;
  }
}

interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
  overflow: boolean;
}

/**
 * What to spawn for `executable args`. A Windows batch file runs through
 * `cmd.exe /d /s /c "<line>"`; arguments are double-quoted, which neutralizes
 * every metacharacter except `"`, `%`, and line breaks, so those are refused.
 */
function spawnTarget(
  executable: string,
  args: readonly string[]
): { file: string; args: string[]; verbatim: boolean } {
  if (process.platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(executable)) {
    return { file: executable, args: [...args], verbatim: false };
  }

  for (const value of [executable, ...args]) {
    if (/["%\r\n]/.test(value)) {
      throw new ConverterError(
        `Cannot pass ${JSON.stringify(value)} to the batch file ${executable} safely (it contains ", % or a line break); point convert.command at an executable instead.`
      );
    }
  }

  const line = [executable, ...args].map((value) => `"${value}"`).join(' ');
  return {
    file: process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/v:off', '/s', '/c', `"${line}"`],
    verbatim: true,
  };
}

/** Kill a timed-out converter. On Windows the whole tree, so a batch shim's child dies too. */
function killProcess(pid: number | undefined, kill: () => void): void {
  if (process.platform === 'win32' && pid !== undefined) {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {
      kill();
    });
    return;
  }
  kill();
}

/**
 * Run a process without a shell, collecting stdout (capped) and stderr (its
 * tail). On timeout the child is killed and the result returned at once,
 * without waiting for grandchildren that may still hold the pipes open.
 */
function runProcess(
  executable: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv }
): Promise<ProcessResult> {
  const target = spawnTarget(executable, args);

  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(target.file, target.args, {
      cwd: options.cwd,
      // Python tools write their stdout in the locale encoding unless told otherwise.
      env: { ...options.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: target.verbatim,
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = '';
    let timedOut = false;
    let overflow = false;
    let settled = false;

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolveRun({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout),
        stderr,
        timedOut,
        overflow,
      });
    };
    const stop = (): void => {
      killProcess(child.pid, () => child.kill('SIGKILL'));
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        if (!overflow) {
          overflow = true;
          stop();
        }
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf-8')}`.slice(-STDERR_TAIL_CHARS * 4);
    });
    child.on('error', (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        rejectRun(new ConverterError(`Could not run ${executable}: ${errorMessage(error)}`));
      }
    });
    child.on('exit', (code, signal) => {
      if (timedOut || overflow) {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(code, signal);
      }
    });
    child.on('close', (code, signal) => {
      finish(code, signal);
    });
  });
}

function stderrTail(stderr: string): string {
  const text = stderr.replace(/\s+/g, ' ').trim();

  if (text === '') {
    return '';
  }

  return `; stderr: ${text.length > STDERR_TAIL_CHARS ? `...${text.slice(-STDERR_TAIL_CHARS)}` : text}`;
}

/** A file name with nothing a converter's argument parser or a batch shim could misread. */
function safeFileName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[.-]+/, '_');
  return safe === '' ? 'document' : safe;
}

function fileStem(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}
