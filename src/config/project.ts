/**
 * The project config (`llm-docs.json`, spec 2.2 and 2.3): its zod schema, the
 * JSON Schema generated from it, project discovery, loading and saving, and
 * recipe resolution (placeholders substituted, defaults filled, hashed).
 *
 * The schema covers every source type and field v3 defines, including the
 * ones later phases act on (git, urls, llms-txt, convert, site, layout,
 * license, limits), so those phases never reshape it. Objects are strict:
 * an unknown key is an error, so a typo can never silently disable behavior.
 */

import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, resolve } from 'node:path';

import { applyEdits, modify } from 'jsonc-parser';
import { z } from 'zod';

import { gitTopLevel } from '../core/git-state.js';
import { ECOSYSTEMS, type DependencyRef, type DependencyVersionLookup } from '../deps/lockfiles.js';
import { isSameOrDescendant } from '../utils/fs-path.js';
import { errorMessage, isFileNotFoundError, isRecord } from '../utils/guards.js';
import { sha256Prefixed } from '../utils/hash.js';
import { canonicalJsonStringify } from '../utils/json.js';
import { writeTextFileSafely } from '../utils/safe-write.js';

export const CONFIG_FILE_NAME = 'llm-docs.json';
export const DEFAULT_PACKS_DIR = 'agent-docs';
export const CONFIG_SCHEMA_REF = './node_modules/llm-docs/schema/llm-docs.schema.json';

export const PACK_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const SOURCE_TYPES = ['git', 'urls', 'llms-txt', 'local'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const CONVERTER_TOOLS = ['docling', 'markitdown', 'command', 'agent'] as const;
export type ConverterTool = (typeof CONVERTER_TOOLS)[number];

/** Named page transforms (spec 4.4); the implementations live in src/pack/markdown.ts. */
export const TRANSFORM_NAMES = [
  'strip-mintlify-banner',
  'strip-html-comments',
  'drop-frontmatter-description',
] as const;
export type TransformName = (typeof TRANSFORM_NAMES)[number];

const MEBIBYTE = 1024 * 1024;

/** Acquisition caps (spec 4.1). The per-file cap is configurable per pack up to its maximum. */
export const PACK_LIMITS = {
  maxFiles: 5_000,
  maxTotalBytes: 500 * MEBIBYTE,
  defaultMaxFileBytes: 20 * MEBIBYTE,
  maxMaxFileBytes: 200 * MEBIBYTE,
} as const;

const DEFAULT_TREE_INCLUDE = ['**/*.{md,mdx,markdown,rst,html,htm}'];
const DEFAULT_URLS_INCLUDE = ['**'];
// xlsx is converted only when listed explicitly: spreadsheets are passthrough by default.
const DEFAULT_CONVERT_INCLUDE = ['**/*.{pdf,docx,pptx,epub,html,htm}'];
const DEFAULT_CONVERT_TIMEOUT_SECONDS = 300;

const PLACEHOLDER_PATTERN = /\{(version|major|minor|patch)\}/g;

/** A config or recipe problem the user fixes by editing input: exit code 2. */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

function isAbsoluteLike(value: string): boolean {
  return value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:/.test(value);
}

function escapesUpward(value: string): boolean {
  const normalized = posix.normalize(value.replace(/\\/g, '/'));
  return normalized === '..' || normalized.startsWith('../');
}

/** A project-relative path that stays inside the project lexically (spec 2.2). */
const projectPathSchema = z
  .string()
  .min(1)
  .refine((value) => !isAbsoluteLike(value), { error: 'must be project-relative, not absolute' })
  .refine((value) => !escapesUpward(value), { error: 'must stay inside the project' });

/** A relative POSIX subdirectory with no `..` segment (mount points). */
const mountSchema = z
  .string()
  .refine((value) => !isAbsoluteLike(value) && !value.includes('\\'), {
    error: 'must be a relative POSIX path',
  })
  .refine((value) => !value.split('/').includes('..'), { error: 'must not contain ".."' });

const globSchema = z.string().min(1);
const globListSchema = z.array(globSchema);

function hasCredentials(url: URL): boolean {
  return url.username !== '' || url.password !== '';
}

function parsedUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/** An https URL without credentials; `{version}`-style placeholders may appear in it. */
const httpsUrlSchema = z.string().refine(
  (value) => {
    const url = parsedUrl(value);
    return url !== undefined && url.protocol === 'https:' && !hasCredentials(url);
  },
  { error: 'must be an https:// URL without credentials' }
);

const gitRepoSchema = z.string().refine(
  (value) => {
    const url = parsedUrl(value);
    return (
      url !== undefined &&
      (url.protocol === 'https:' || url.protocol === 'file:') &&
      !hasCredentials(url)
    );
  },
  {
    error:
      'must be an https:// (or file://) URL without credentials; ssh and git@ remotes are not supported',
  }
);

const versionSchema = z
  .string()
  .regex(/^[^\s<>\p{Cc}]+$/u, { error: 'must be a non-empty version without whitespace' });

const convertSchema = z
  .strictObject({
    tool: z.enum(CONVERTER_TOOLS),
    include: globListSchema.min(1).optional(),
    command: z.array(z.string().min(1)).min(1).optional(),
    timeoutSeconds: z.number().int().min(1).max(3600).optional(),
  })
  .superRefine((value, context) => {
    if ((value.tool === 'command' || value.tool === 'agent') && value.include === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['include'],
        message: `is required for the "${value.tool}" converter`,
      });
    }
    if (value.tool === 'command' && value.command === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['command'],
        message: 'is required for the "command" converter',
      });
    }
    if (value.tool === 'agent' && value.command !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['command'],
        message: 'is not allowed for the "agent" converter (no process runs)',
      });
    }
  });

const commonSourceFields = {
  mount: mountSchema.optional(),
  include: globListSchema.optional(),
  exclude: globListSchema.optional(),
  passthrough: globListSchema.optional(),
  convert: convertSchema.nullable().optional(),
  transforms: z
    .array(z.enum(TRANSFORM_NAMES))
    .refine((names) => new Set(names).size === names.length, { error: 'must not repeat a name' })
    .optional(),
};

const gitSourceSchema = z.strictObject({
  type: z.literal('git'),
  repo: gitRepoSchema,
  ref: z.string().min(1),
  paths: z.array(z.string().min(1)).min(1).optional(),
  ...commonSourceFields,
});

const urlEntrySchema = z.union([
  httpsUrlSchema,
  z.strictObject({ url: httpsUrlSchema, path: z.string().min(1) }),
]);

const urlsSourceSchema = z.strictObject({
  type: z.literal('urls'),
  urls: z.array(urlEntrySchema).min(1),
  ...commonSourceFields,
});

const llmsTxtSourceSchema = z.strictObject({
  type: z.literal('llms-txt'),
  url: httpsUrlSchema,
  stripPrefix: z.string().optional(),
  ...commonSourceFields,
  // The planner must state the filter: at least one include.
  include: globListSchema.min(1),
});

const localSourceSchema = z.strictObject({
  type: z.literal('local'),
  path: projectPathSchema,
  ...commonSourceFields,
});

export const sourceConfigSchema = z.discriminatedUnion('type', [
  gitSourceSchema,
  urlsSourceSchema,
  llmsTxtSourceSchema,
  localSourceSchema,
]);

const dependencySchema = z.strictObject({
  ecosystem: z.enum(ECOSYSTEMS),
  name: z.string().min(1),
});

export const packConfigSchema = z
  .strictObject({
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    dependency: dependencySchema.optional(),
    version: versionSchema.optional(),
    sources: z.array(sourceConfigSchema).min(1),
    site: z
      .strictObject({
        baseUrl: httpsUrlSchema,
        aliases: z.record(z.string().min(1), z.string().min(1)).optional(),
      })
      .optional(),
    layout: z.strictObject({ combined: z.boolean().optional() }).optional(),
    license: z.string().min(1).nullable().optional(),
    limits: z
      .strictObject({
        maxFileBytes: z.number().int().min(1).max(PACK_LIMITS.maxMaxFileBytes).optional(),
      })
      .optional(),
  })
  .superRefine((pack, context) => {
    if (pack.version === undefined && pack.dependency === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['version'],
        message: 'is required unless "dependency" is set',
      });
    }
  });

export const projectConfigSchema = z.strictObject({
  $schema: z.string().optional(),
  schemaVersion: z.literal(3),
  packsDir: projectPathSchema.optional(),
  agentFiles: z.union([z.literal('auto'), z.array(projectPathSchema)]).optional(),
  block: z.strictObject({ maxBytes: z.number().int().min(256).max(65_536).optional() }).optional(),
  hook: z
    .strictObject({
      enabled: z.boolean().optional(),
      nearCutoffDays: z.number().int().min(0).max(3650).optional(),
    })
    .optional(),
  model: z
    .strictObject({
      cutoff: z
        .string()
        .regex(/^\d{4}-(0[1-9]|1[0-2])$/, { error: 'must be a YYYY-MM month' })
        .optional(),
    })
    .optional(),
  packs: z.record(
    z.string().regex(PACK_ID_PATTERN, {
      error: 'pack ids must match ^[a-z0-9][a-z0-9._-]{0,63}$',
    }),
    packConfigSchema
  ),
});

export type ProjectConfig = z.infer<typeof projectConfigSchema>;
export type PackConfig = z.infer<typeof packConfigSchema>;
export type SourceConfig = z.infer<typeof sourceConfigSchema>;

// The resolved recipe: every default filled, placeholders substituted. It is
// what the manifest records and what recipeHash covers.

const resolvedCommonFields = {
  mount: z.string(),
  include: z.array(z.string()),
  exclude: z.array(z.string()),
  passthrough: z.array(z.string()),
  convert: z
    .strictObject({
      tool: z.enum(CONVERTER_TOOLS),
      include: z.array(z.string()),
      command: z.array(z.string()).nullable(),
      timeoutSeconds: z.number().int(),
    })
    .nullable(),
  transforms: z.array(z.enum(TRANSFORM_NAMES)),
};

export const resolvedSourceSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('git'),
    repo: z.string(),
    ref: z.string(),
    paths: z.array(z.string()),
    ...resolvedCommonFields,
  }),
  z.strictObject({
    type: z.literal('urls'),
    urls: z.array(z.strictObject({ url: z.string(), path: z.string() })),
    ...resolvedCommonFields,
  }),
  z.strictObject({
    type: z.literal('llms-txt'),
    url: z.string(),
    stripPrefix: z.string(),
    ...resolvedCommonFields,
  }),
  z.strictObject({ type: z.literal('local'), path: z.string(), ...resolvedCommonFields }),
]);

export const resolvedPackRecipeSchema = z.strictObject({
  title: z.string(),
  description: z.string().nullable(),
  dependency: dependencySchema.nullable(),
  version: z.string(),
  sources: z.array(resolvedSourceSchema),
  site: z
    .strictObject({ baseUrl: z.string(), aliases: z.record(z.string(), z.string()) })
    .nullable(),
  layout: z.strictObject({ combined: z.boolean() }),
  license: z.string().nullable(),
  limits: z.strictObject({ maxFileBytes: z.number().int() }),
});

export type ResolvedSource = z.infer<typeof resolvedSourceSchema>;
export type ResolvedPackRecipe = z.infer<typeof resolvedPackRecipeSchema>;
export type ResolvedSourceOfType<T extends SourceType> = Extract<ResolvedSource, { type: T }>;

/** The committed `schema/llm-docs.schema.json` text (regenerated by `npm run schema`). */
export function projectConfigJsonSchemaText(): string {
  return `${JSON.stringify(z.toJSONSchema(projectConfigSchema, { io: 'input' }), null, 2)}\n`;
}

/** One readable line per issue: `packs.vite.sources[0].incude: unknown key`. */
export function formatSchemaIssues(label: string, error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const path = formatIssuePath(issue.path);
    const where = path === '' ? label : `${label} ${path}`;

    if (issue.code === 'unrecognized_keys') {
      const keys = issue.keys.map((key) => `"${key}"`).join(', ');
      return `${where}: unknown key${issue.keys.length === 1 ? '' : 's'} ${keys}`;
    }

    if (issue.code === 'invalid_key') {
      return `${where}: ${issue.issues[0]?.message ?? issue.message}`;
    }

    return `${where}: ${issue.message}`;
  });

  return [...new Set(lines)].join('; ');
}

function formatIssuePath(path: readonly PropertyKey[]): string {
  let result = '';

  for (const segment of path) {
    if (typeof segment === 'number') {
      result += `[${segment}]`;
    } else {
      const key = String(segment);
      result += result === '' ? key : `.${key}`;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Discovery, loading, saving
// ---------------------------------------------------------------------------

export interface LoadedProjectConfig {
  /** Absolute project root (the directory holding llm-docs.json). */
  projectRoot: string;
  configPath: string;
  config: ProjectConfig;
  /** Project-relative POSIX packs directory, normalized. */
  packsDirRelative: string;
  /** Absolute packs directory. */
  packsDir: string;
}

/** The nearest ancestor of `cwd` (inclusive) holding llm-docs.json, or undefined. */
export async function findProjectRoot(cwd: string): Promise<string | undefined> {
  let current = resolve(cwd);

  while (true) {
    if (await isFile(join(current, CONFIG_FILE_NAME))) {
      return current;
    }

    const parent = dirname(current);

    if (parent === current) {
      return undefined;
    }

    current = parent;
  }
}

/**
 * Where `init` and `add` create config: an existing project above `cwd`, else
 * the git top-level directory, else `cwd` itself (spec 2.1).
 */
export async function projectRootForCreate(cwd: string): Promise<string> {
  return (await findProjectRoot(cwd)) ?? (await gitTopLevel(cwd)) ?? resolve(cwd);
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function loadProjectConfig(projectRoot: string): Promise<LoadedProjectConfig> {
  const root = resolve(projectRoot);
  const configPath = join(root, CONFIG_FILE_NAME);
  let text: string;

  try {
    text = await readFile(configPath, 'utf-8');
  } catch (error) {
    if (isFileNotFoundError(error)) {
      throw new ConfigError(`No ${CONFIG_FILE_NAME} in ${root}; run 'llm-docs init' first.`);
    }
    throw error;
  }

  return parseProjectConfig(root, text);
}

/** Validate config text for the project at `projectRoot` (absolute). */
export function parseProjectConfig(projectRoot: string, text: string): LoadedProjectConfig {
  let raw: unknown;

  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${CONFIG_FILE_NAME} is not valid JSON: ${errorMessage(error)}`);
  }

  if (isRecord(raw) && raw.schemaVersion !== undefined && raw.schemaVersion !== 3) {
    throw new ConfigError(
      `${CONFIG_FILE_NAME} has schemaVersion ${JSON.stringify(raw.schemaVersion)}; this llm-docs reads schemaVersion 3.`
    );
  }

  const parsed = projectConfigSchema.safeParse(raw);

  if (!parsed.success) {
    throw new ConfigError(formatSchemaIssues(CONFIG_FILE_NAME, parsed.error));
  }

  const config = parsed.data;
  const packsDirRelative = normalizeProjectPath(config.packsDir ?? DEFAULT_PACKS_DIR);

  if (packsDirRelative === '.') {
    throw new ConfigError(
      `${CONFIG_FILE_NAME} packsDir must be a subdirectory of the project, not the project root.`
    );
  }

  const packsDir = join(projectRoot, ...packsDirRelative.split('/'));

  if (!isSameOrDescendant(projectRoot, packsDir)) {
    throw new ConfigError(`${CONFIG_FILE_NAME} packsDir must stay inside the project.`);
  }

  return {
    projectRoot,
    configPath: join(projectRoot, CONFIG_FILE_NAME),
    config,
    packsDirRelative,
    packsDir,
  };
}

/** Normalize a validated project-relative path to POSIX form without `./` or a trailing slash. */
export function normalizeProjectPath(value: string): string {
  const normalized = posix.normalize(value.replace(/\\/g, '/')).replace(/\/+$/, '');
  return normalized === '' ? '.' : normalized;
}

function newConfigText(packsDir: string | undefined): string {
  const config: Record<string, unknown> = { $schema: CONFIG_SCHEMA_REF, schemaVersion: 3 };

  if (packsDir !== undefined && packsDir !== DEFAULT_PACKS_DIR) {
    config.packsDir = packsDir;
  }

  config.packs = {};
  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * Create llm-docs.json in `projectRoot` unless it exists. Never overwrites:
 * returns `created: false` and leaves an existing file untouched.
 */
export async function initProjectConfig(
  projectRoot: string,
  options: { packsDir?: string } = {}
): Promise<{ created: boolean; configPath: string }> {
  const configPath = join(projectRoot, CONFIG_FILE_NAME);

  if (await isFile(configPath)) {
    return { created: false, configPath };
  }

  if (options.packsDir !== undefined) {
    const check = projectPathSchema.safeParse(options.packsDir);
    if (!check.success || normalizeProjectPath(options.packsDir) === '.') {
      throw new ConfigError(
        `--packs-dir must be a project-relative subdirectory inside the project, got "${options.packsDir}".`
      );
    }
  }

  const text = newConfigText(options.packsDir);
  // Validate the text we are about to write with the same rules a load applies.
  parseProjectConfig(projectRoot, text);
  await writeTextFileSafely(configPath, text);
  return { created: true, configPath };
}

/**
 * Insert or replace `packs[id]` in llm-docs.json, creating the file when it
 * is absent. The existing text is edited in place, so every key keeps its
 * position (the edited `packs` object is re-indented as 2-space JSON) and the
 * file ends with one newline. The result is validated before writing.
 */
export async function saveProjectConfig(
  projectRoot: string,
  id: string,
  pack: PackConfig
): Promise<LoadedProjectConfig> {
  const configPath = join(projectRoot, CONFIG_FILE_NAME);
  let text: string;

  try {
    text = await readFile(configPath, 'utf-8');
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      throw error;
    }
    text = newConfigText(undefined);
  }

  const edits = modify(text, ['packs', id], pack, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' },
  });
  const updated = `${applyEdits(text, edits).replace(/\s*$/, '')}\n`;
  const loaded = parseProjectConfig(projectRoot, updated);
  await writeTextFileSafely(configPath, updated);
  return loaded;
}

// ---------------------------------------------------------------------------
// Recipe resolution
// ---------------------------------------------------------------------------

/**
 * Resolves the version a project's lockfiles pin for a dependency. The result
 * matches `findDependencyVersion` in src/deps/lockfiles.ts; Phase 4 injects an
 * implementation backed by `scanDependencies`. When no resolver is supplied, a
 * pack that needs lockfile resolution fails with a clear message.
 */
export type DependencyVersionResolver = (
  dependency: DependencyRef
) => Promise<DependencyVersionLookup> | DependencyVersionLookup;

export interface ResolvePackOptions {
  resolveDependencyVersion?: DependencyVersionResolver | undefined;
}

export interface ResolvedPack {
  id: string;
  recipe: ResolvedPackRecipe;
  recipeHash: string;
}

/** Thrown when a pack's version can only come from lockfiles and no resolver is available. */
export class LockfileResolutionUnavailableError extends ConfigError {
  override name = 'LockfileResolutionUnavailableError';
}

/** sha256 of the canonical (sorted-key, compact) JSON of a resolved recipe. */
export function recipeHash(recipe: ResolvedPackRecipe): string {
  return sha256Prefixed(canonicalJsonStringify(recipe));
}

export async function resolvePackRecipe(
  config: ProjectConfig,
  id: string,
  options: ResolvePackOptions = {}
): Promise<ResolvedPack> {
  const pack = Object.hasOwn(config.packs, id) ? config.packs[id] : undefined;

  if (pack === undefined) {
    throw new ConfigError(`No pack "${id}" in ${CONFIG_FILE_NAME}.`);
  }

  const version = await resolvePackVersion(id, pack, options.resolveDependencyVersion);
  const placeholders = placeholderValues(version);
  const where = (path: string): string => `packs.${id}.${path}`;
  const substitute = (value: string, path: string): string =>
    substitutePlaceholders(value, placeholders, where(path));
  const forbid = (value: string, path: string): string => {
    if (new RegExp(PLACEHOLDER_PATTERN.source).test(value)) {
      throw new ConfigError(
        `${CONFIG_FILE_NAME} ${where(path)}: placeholders are only allowed in ref, paths, url, urls, include, and exclude.`
      );
    }
    return value;
  };

  const sources = pack.sources.map((source, index) =>
    resolveSource(source, `sources[${index}]`, substitute, forbid)
  );

  const recipe: ResolvedPackRecipe = {
    title: pack.title ?? id,
    description: pack.description ?? null,
    dependency: pack.dependency ?? null,
    version,
    sources,
    site:
      pack.site === undefined
        ? null
        : { baseUrl: pack.site.baseUrl, aliases: pack.site.aliases ?? {} },
    layout: { combined: pack.layout?.combined ?? false },
    license: pack.license ?? null,
    limits: { maxFileBytes: pack.limits?.maxFileBytes ?? PACK_LIMITS.defaultMaxFileBytes },
  };

  return { id, recipe, recipeHash: recipeHash(recipe) };
}

async function resolvePackVersion(
  id: string,
  pack: PackConfig,
  resolver: DependencyVersionResolver | undefined
): Promise<string> {
  if (pack.version !== undefined) {
    return pack.version;
  }

  const dependency = pack.dependency;

  if (dependency === undefined) {
    throw new ConfigError(`${CONFIG_FILE_NAME} packs.${id}: set "version" or "dependency".`);
  }

  const label = `${dependency.ecosystem}:${dependency.name}`;

  if (resolver === undefined) {
    throw new LockfileResolutionUnavailableError(
      `Pack "${id}" takes its version from the lockfile entry for ${label}, but lockfile resolution is not available; set "version" for packs.${id} in ${CONFIG_FILE_NAME}.`
    );
  }

  const lookup = await resolver(dependency);

  switch (lookup.kind) {
    case 'found':
      return lookup.version;
    case 'missing': {
      const searched = lookup.searched.length === 0 ? 'none found' : lookup.searched.join(', ');
      throw new ConfigError(
        `Pack "${id}": no lockfile resolves ${label} (lockfiles searched: ${searched}); set "version" explicitly.`
      );
    }
    case 'conflict': {
      const versions = lookup.versions
        .map((entry) => `${entry.version} in ${entry.lockfile}`)
        .join(', ');
      throw new ConfigError(
        `Pack "${id}": lockfiles resolve ${label} to different versions (${versions}); set "version" explicitly.`
      );
    }
  }
}

type Placeholders = Record<'version' | 'major' | 'minor' | 'patch', string | undefined>;

function placeholderValues(version: string): Placeholders {
  const match = /^v?(\d+)(?:\.(\d+)(?:\.(\d+))?)?(?=$|[-+.])/.exec(version);
  return { version, major: match?.[1], minor: match?.[2], patch: match?.[3] };
}

function substitutePlaceholders(value: string, placeholders: Placeholders, where: string): string {
  return value.replace(PLACEHOLDER_PATTERN, (token, name: keyof Placeholders) => {
    const replacement = placeholders[name];

    if (replacement === undefined) {
      throw new ConfigError(
        `${CONFIG_FILE_NAME} ${where}: placeholder ${token} has no value for version "${placeholders.version}".`
      );
    }

    return replacement;
  });
}

function resolveSource(
  source: SourceConfig,
  path: string,
  substitute: (value: string, path: string) => string,
  forbid: (value: string, path: string) => string
): ResolvedSource {
  const list = (values: readonly string[] | undefined, field: string): string[] =>
    (values ?? []).map((value, index) => substitute(value, `${path}.${field}[${index}]`));
  const plain = (values: readonly string[] | undefined, field: string): string[] =>
    (values ?? []).map((value, index) => forbid(value, `${path}.${field}[${index}]`));

  const defaultInclude = source.type === 'urls' ? DEFAULT_URLS_INCLUDE : DEFAULT_TREE_INCLUDE;
  const common = {
    mount: normalizeMount(forbid(source.mount ?? '', `${path}.mount`)),
    include: list(source.include ?? defaultInclude, 'include'),
    exclude: list(source.exclude, 'exclude'),
    passthrough: plain(source.passthrough, 'passthrough'),
    convert:
      source.convert === undefined || source.convert === null
        ? null
        : {
            tool: source.convert.tool,
            include: plain(source.convert.include ?? DEFAULT_CONVERT_INCLUDE, 'convert.include'),
            command:
              source.convert.command === undefined
                ? null
                : plain(source.convert.command, 'convert.command'),
            timeoutSeconds: source.convert.timeoutSeconds ?? DEFAULT_CONVERT_TIMEOUT_SECONDS,
          },
    transforms: [...(source.transforms ?? [])],
  };

  switch (source.type) {
    case 'git':
      return {
        type: 'git',
        repo: forbid(source.repo, `${path}.repo`),
        ref: substitute(source.ref, `${path}.ref`),
        paths: list(source.paths ?? ['.'], 'paths'),
        ...common,
      };
    case 'urls':
      return {
        type: 'urls',
        urls: resolveUrlEntries(source.urls, path, substitute),
        ...common,
      };
    case 'llms-txt':
      return {
        type: 'llms-txt',
        url: substitute(source.url, `${path}.url`),
        stripPrefix: forbid(source.stripPrefix ?? '', `${path}.stripPrefix`),
        ...common,
      };
    case 'local':
      return {
        type: 'local',
        path: normalizeProjectPath(forbid(source.path, `${path}.path`)),
        ...common,
      };
  }
}

function normalizeMount(mount: string): string {
  const normalized = posix.normalize(mount === '' ? '.' : mount).replace(/\/+$/, '');
  return normalized === '.' ? '' : normalized;
}

/**
 * Fill each URL's stored path (spec 2.3): the URL pathname, percent-decoded,
 * `.md` appended when the last segment has no extension, `index.md` for a
 * trailing slash. Duplicate stored paths are an error naming both URLs.
 */
function resolveUrlEntries(
  entries: readonly (string | { url: string; path: string })[],
  path: string,
  substitute: (value: string, path: string) => string
): { url: string; path: string }[] {
  const seen = new Map<string, string>();

  return entries.map((entry, index) => {
    const where = `${path}.urls[${index}]`;
    const url = substitute(typeof entry === 'string' ? entry : entry.url, where);
    const parsed = parsedUrl(url);

    if (parsed === undefined || parsed.protocol !== 'https:') {
      throw new ConfigError(`${CONFIG_FILE_NAME} ${where}: "${url}" is not an https:// URL.`);
    }

    const storedPath =
      typeof entry === 'string'
        ? storedPathForUrl(parsed)
        : substitute(entry.path, `${where}.path`).replace(/^\/+/, '');

    if (storedPath === '' || escapesUpward(storedPath) || isAbsolute(storedPath)) {
      throw new ConfigError(
        `${CONFIG_FILE_NAME} ${where}: stored path "${storedPath}" must be a relative path inside the pack.`
      );
    }

    const previous = seen.get(storedPath);

    if (previous !== undefined) {
      throw new ConfigError(
        `${CONFIG_FILE_NAME} ${path}.urls: ${previous} and ${url} would both be stored at "${storedPath}"; give one an explicit "path".`
      );
    }

    seen.set(storedPath, url);
    return { url, path: storedPath };
  });
}

function storedPathForUrl(url: URL): string {
  let pathname: string;

  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    pathname = url.pathname;
  }

  if (pathname.endsWith('/')) {
    return `${pathname}index.md`.replace(/^\/+/, '');
  }

  const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1);
  const withExtension = lastSegment.includes('.') ? pathname : `${pathname}.md`;
  return withExtension.replace(/^\/+/, '');
}
