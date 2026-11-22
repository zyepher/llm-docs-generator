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

import { lstat } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, resolve } from 'node:path';

import { applyEdits, modify } from 'jsonc-parser';
import { z } from 'zod';

import packageJson from '../../package.json';
import { gitTopLevel } from '../core/git-state.js';
import {
  dependencyKey,
  ECOSYSTEMS,
  isDependencyName,
  isVersionText,
  VERSION_TEXT_MAX,
  type DependencyRef,
  type DependencyVersionLookup,
} from '../deps/lockfiles.js';
import {
  isSameOrDescendant,
  pathCollisionKey,
  resolveEffectiveOutputPath,
} from '../utils/fs-path.js';
import { errorMessage, isFileNotFoundError, isRecord } from '../utils/guards.js';
import { sha256Prefixed } from '../utils/hash.js';
import { canonicalJsonStringify } from '../utils/json.js';
import { redactUrl, urlCredentials } from '../utils/url-credentials.js';
import { readRegularFile, RefusedFileError, writeTextFileSafely } from '../utils/safe-write.js';

export const CONFIG_FILE_NAME = 'llm-docs.json';
const DEFAULT_PACKS_DIR = 'agent-docs';
/**
 * The schema at this version's release tag: the npm package is not published,
 * so a `node_modules` path would resolve to nothing in most projects.
 */
const CONFIG_SCHEMA_REF = `https://raw.githubusercontent.com/Zyepher/llm-docs-generator/v${packageJson.version}/schema/llm-docs.schema.json`;

export const PACK_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const SOURCE_TYPES = ['git', 'urls', 'llms-txt', 'local'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const CONVERTER_TOOLS = ['docling', 'markitdown', 'command', 'agent'] as const;

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

function parsedUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/**
 * https, or plain http to a loopback literal: the network policy (spec 4.1)
 * fetches the latter only under LLM_DOCS_ALLOW_PRIVATE_NETWORK=1, for tests.
 */
function isDocsUrl(url: URL): boolean {
  return (
    url.protocol === 'https:' ||
    (url.protocol === 'http:' && /^(?:127(?:\.\d{1,3}){3}|\[::1\]|localhost)$/i.test(url.hostname))
  );
}

/**
 * An https URL that carries no credential (urlCredentials, the HTTP client's
 * rule): pack manifests record these URLs, so one is refused when the config
 * is read, before `add` writes it. `{version}`-style placeholders may appear.
 */
const httpsUrlSchema = z.string().refine(
  (value) => {
    const url = parsedUrl(value);
    return url !== undefined && isDocsUrl(url) && urlCredentials(url).length === 0;
  },
  {
    error:
      'must be an https:// URL without credentials (no user name or password, and no token, key, signature, or similar parameter)',
  }
);

const gitRepoSchema = z.string().refine(
  (value) => {
    const url = parsedUrl(value);
    return (
      url !== undefined &&
      (url.protocol === 'https:' || url.protocol === 'file:') &&
      urlCredentials(url).length === 0
    );
  },
  {
    error:
      'must be an https:// (or file://) URL without credentials (no user name or password, and no token, key, or similar parameter); ssh and git@ remotes are not supported',
  }
);

const versionSchema = z.string().refine(isVersionText, {
  error: `must be a version: one line of printable characters without whitespace, at most ${VERSION_TEXT_MAX}`,
});

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

const dependencySchema = z
  .strictObject({
    ecosystem: z.enum(ECOSYSTEMS),
    name: z.string().min(1),
  })
  .superRefine((dependency, context) => {
    if (!isDependencyName(dependency.ecosystem, dependency.name)) {
      context.addIssue({
        code: 'custom',
        path: ['name'],
        message: `is not a valid ${dependency.ecosystem} package name`,
      });
    }
  });

export const COVERS_MAX = 20;

/**
 * Other packages the pack's docs also describe (spec 2.2), such as the client
 * of a server SDK documented in one docs set. They bind no version: status
 * and the hook only stop reporting them as undocumented.
 */
const coversSchema = z
  .array(dependencySchema)
  .min(1)
  .max(COVERS_MAX)
  .refine((covers) => new Set(covers.map(dependencyKey)).size === covers.length, {
    error: 'must not repeat a dependency',
  });

export const READ_FIRST_MAX = 5;

/**
 * A read-first target (spec 4.8): a normalized pack-relative POSIX path under
 * `pages/` or `files/`, optionally with `#<heading slug>`, the form guide
 * citations use. Checked on the config text and again after placeholders are
 * substituted, since a version could carry a `/` or `..` into the path.
 */
function isReadFirstTarget(value: string): boolean {
  const hash = value.indexOf('#');
  const path = hash === -1 ? value : value.slice(0, hash);
  const fragment = hash === -1 ? undefined : value.slice(hash + 1);

  return (
    /^(?:pages|files)\/[^/]/.test(path) &&
    !path.includes('\\') &&
    !path.endsWith('/') &&
    posix.normalize(path) === path &&
    !path.split('/').includes('..') &&
    (fragment === undefined || /^[^\s#]+$/u.test(fragment))
  );
}

const readFirstSchema = z
  .array(
    z.string().refine(isReadFirstTarget, {
      error:
        'must be a pack-relative POSIX path under pages/ or files/ (no "..", no backslashes), optionally with #<heading slug>',
    })
  )
  .min(1)
  .max(READ_FIRST_MAX)
  .refine((targets) => new Set(targets).size === targets.length, {
    error: 'must not repeat a target',
  });

export const packConfigSchema = z
  .strictObject({
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    dependency: dependencySchema.optional(),
    covers: coversSchema.optional(),
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
    readFirst: readFirstSchema.optional(),
  })
  .superRefine((pack, context) => {
    if (pack.version === undefined && pack.dependency === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['version'],
        message: 'is required unless "dependency" is set',
      });
    }
    const own = pack.dependency === undefined ? undefined : dependencyKey(pack.dependency);
    const index = pack.covers?.findIndex((covered) => dependencyKey(covered) === own) ?? -1;
    if (index !== -1) {
      context.addIssue({
        code: 'custom',
        path: ['covers', index],
        message:
          'is the pack\'s own "dependency"; list only the other packages these docs describe',
      });
    }
  });

const projectConfigSchema = z.strictObject({
  $schema: z.string().optional(),
  schemaVersion: z.literal(3),
  packsDir: projectPathSchema.optional(),
  agentFiles: z.union([z.literal('auto'), z.array(projectPathSchema)]).optional(),
  block: z.strictObject({ maxBytes: z.number().int().min(1024).max(65_536).optional() }).optional(),
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
  mount: mountSchema,
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

const resolvedSourceSchema = z.discriminatedUnion('type', [
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
  z.strictObject({ type: z.literal('local'), path: projectPathSchema, ...resolvedCommonFields }),
]);

export const resolvedPackRecipeSchema = z.strictObject({
  title: z.string(),
  description: z.string().nullable(),
  dependency: dependencySchema.nullable(),
  version: versionSchema,
  sources: z.array(resolvedSourceSchema),
  site: z
    .strictObject({ baseUrl: z.string(), aliases: z.record(z.string(), z.string()) })
    .nullable(),
  layout: z.strictObject({ combined: z.boolean() }),
  license: z.string().nullable(),
  limits: z.strictObject({ maxFileBytes: z.number().int() }),
  /**
   * Absent, never empty, when the pack marks no pages: the canonical JSON of
   * a recipe without it, and so its recipeHash, is what it was before the
   * field existed, and packs built then stay up to date.
   */
  readFirst: z
    .array(z.string().refine(isReadFirstTarget, { error: 'must be a path under pages/ or files/' }))
    .min(1)
    .optional(),
  /** Absent, never empty, when the pack covers no other package, for the same reason. */
  covers: z.array(dependencySchema).min(1).optional(),
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

/**
 * The nearest ancestor of `cwd` (inclusive) holding an entry named
 * llm-docs.json, or undefined. Any entry stops the walk, so a named pipe or
 * directory there is reported by the load instead of letting a config
 * further up take over.
 */
export async function findProjectRoot(cwd: string): Promise<string | undefined> {
  let current = resolve(cwd);

  while (true) {
    if (
      await lstat(join(current, CONFIG_FILE_NAME)).then(
        () => true,
        () => false
      )
    ) {
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

/**
 * The text of llm-docs.json at `configPath`, or null when it does not exist.
 * Only a regular file is read (a link to one is followed): a named pipe there
 * would block every command, so anything else is a ConfigError naming it.
 */
export async function readProjectConfigText(configPath: string): Promise<string | null> {
  try {
    return (await readRegularFile(configPath, { followLinks: true })).toString('utf-8');
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return null;
    }
    throw refusedConfigFile(error);
  }
}

/** Replace llm-docs.json atomically; a refused target is a ConfigError that says what to do. */
export async function writeProjectConfigText(configPath: string, text: string): Promise<void> {
  try {
    await writeTextFileSafely(configPath, text);
  } catch (error) {
    throw refusedConfigFile(error);
  }
}

function refusedConfigFile(error: unknown): unknown {
  if (!(error instanceof RefusedFileError)) {
    return error;
  }
  switch (error.refusal.kind) {
    case 'not-regular':
      return new ConfigError(
        `${error.message}; llm-docs reads and writes ${CONFIG_FILE_NAME} only as a regular file, so replace it with one (move the current one away first), then run the command again.`
      );
    case 'read-only':
      return new ConfigError(
        `${error.message}, so llm-docs did not change it; make it writable (chmod u+w ${CONFIG_FILE_NAME}), then run the command again.`
      );
    case 'hard-linked':
      return new ConfigError(
        `${error.message}, so replacing it would leave the other links holding the old text; make it a single file (copy it, delete the original, and rename the copy), then run the command again.`
      );
  }
}

/**
 * The project's config, or null when llm-docs.json does not exist. An invalid
 * config still throws ConfigError: "absent" and "broken" are different answers.
 */
export async function loadProjectConfigIfPresent(
  projectRoot: string
): Promise<LoadedProjectConfig | null> {
  const root = resolve(projectRoot);
  const text = await readProjectConfigText(join(root, CONFIG_FILE_NAME));

  return text === null ? null : assertPacksDirInsideProject(parseProjectConfig(root, text));
}

export async function loadProjectConfig(projectRoot: string): Promise<LoadedProjectConfig> {
  const loaded = await loadProjectConfigIfPresent(projectRoot);

  if (loaded === null) {
    throw new ConfigError(
      `No ${CONFIG_FILE_NAME} in ${resolve(projectRoot)}; run 'llm-docs init' first.`
    );
  }

  return loaded;
}

/** The project's config, or an empty one when llm-docs.json does not exist yet (`add`, `migrate`). */
export async function loadOrEmptyConfig(projectRoot: string): Promise<LoadedProjectConfig> {
  return (
    (await loadProjectConfigIfPresent(projectRoot)) ??
    assertPacksDirInsideProject(
      parseProjectConfig(projectRoot, JSON.stringify({ schemaVersion: 3, packs: {} }))
    )
  );
}

/**
 * `parseProjectConfig` can only check packsDir lexically. Every pack write, staging delete,
 * swap, and prune goes through this directory, so a symlink that leads out of the project
 * would let sync create and delete files elsewhere (spec 2.2: inside the project after
 * resolution).
 */
async function assertPacksDirInsideProject(
  loaded: LoadedProjectConfig
): Promise<LoadedProjectConfig> {
  const [projectRoot, packsDir] = await Promise.all([
    resolveEffectiveOutputPath(loaded.projectRoot),
    resolveEffectiveOutputPath(loaded.packsDir),
  ]);

  if (!isSameOrDescendant(projectRoot, packsDir)) {
    throw new ConfigError(
      `${CONFIG_FILE_NAME} packsDir "${loaded.packsDirRelative}" resolves to ${packsDir}, outside the project (${projectRoot}), through a symbolic link. Replace the link with a real directory inside the project, or point packsDir at one.`
    );
  }

  return loaded;
}

/** Validate config text for the project at `projectRoot` (absolute). */
export function parseProjectConfig(projectRoot: string, text: string): LoadedProjectConfig {
  let raw: unknown;

  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(
      `${CONFIG_FILE_NAME} is not valid JSON (${errorMessage(error)}); fix the syntax, then run the command again.`
    );
  }

  if (isRecord(raw) && raw.schemaVersion !== undefined && raw.schemaVersion !== 3) {
    throw new ConfigError(
      `${CONFIG_FILE_NAME} has schemaVersion ${JSON.stringify(raw.schemaVersion)}, and this llm-docs reads only schemaVersion 3; set "schemaVersion": 3 if the file is otherwise v3, or recreate it with 'llm-docs init' and 'llm-docs migrate <v2-pack-dir>'.`
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
      `${CONFIG_FILE_NAME} packsDir must be a subdirectory of the project, not the project root; set it to a directory such as "agent-docs".`
    );
  }

  const packsDir = join(projectRoot, ...packsDirRelative.split('/'));

  if (!isSameOrDescendant(projectRoot, packsDir)) {
    throw new ConfigError(
      `${CONFIG_FILE_NAME} packsDir "${packsDirRelative}" leaves the project; set it to a project-relative directory such as "agent-docs".`
    );
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
function normalizeProjectPath(value: string): string {
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

  if ((await readProjectConfigText(configPath)) !== null) {
    return { created: false, configPath };
  }

  if (options.packsDir !== undefined) {
    const check = projectPathSchema.safeParse(options.packsDir);
    if (!check.success || normalizeProjectPath(options.packsDir) === '.') {
      throw new ConfigError(
        `--packs-dir must be a project-relative subdirectory inside the project, such as agent-docs; got "${options.packsDir}".`
      );
    }
  }

  const text = newConfigText(options.packsDir);
  // Validate the text we are about to write with the same rules a load applies.
  await assertPacksDirInsideProject(parseProjectConfig(projectRoot, text));
  await writeProjectConfigText(configPath, text);
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
  const text = (await readProjectConfigText(configPath)) ?? newConfigText(undefined);

  const edits = modify(text, ['packs', id], pack, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' },
  });
  const updated = `${applyEdits(text, edits).replace(/\s*$/, '')}\n`;
  const loaded = await assertPacksDirInsideProject(parseProjectConfig(projectRoot, updated));
  await writeProjectConfigText(configPath, updated);
  return loaded;
}

// ---------------------------------------------------------------------------
// Recipe resolution
// ---------------------------------------------------------------------------

/**
 * Resolves the version a project's lockfiles pin for a dependency, with the
 * result shape of `findDependencyVersion` in src/deps/lockfiles.ts. Commands
 * pass `projectDependencies(...).resolveVersion`.
 */
export type DependencyVersionResolver = (
  dependency: DependencyRef
) => Promise<DependencyVersionLookup> | DependencyVersionLookup;

export interface ResolvePackOptions {
  resolveDependencyVersion: DependencyVersionResolver;
}

export interface ResolvedPack {
  id: string;
  recipe: ResolvedPackRecipe;
  recipeHash: string;
}

/** sha256 of the canonical (sorted-key, compact) JSON of a resolved recipe. */
export function recipeHash(recipe: ResolvedPackRecipe): string {
  return sha256Prefixed(canonicalJsonStringify(recipe));
}

export async function resolvePackRecipe(
  config: ProjectConfig,
  id: string,
  options: ResolvePackOptions
): Promise<ResolvedPack> {
  const pack = Object.hasOwn(config.packs, id) ? config.packs[id] : undefined;

  if (pack === undefined) {
    throw new ConfigError(
      `No pack "${id}" in ${CONFIG_FILE_NAME}; add it with 'llm-docs add ${id}', or check the id against the keys of "packs".`
    );
  }

  const version = await resolvePackVersion(id, pack, options.resolveDependencyVersion);
  const placeholders = placeholderValues(version);
  const where = (path: string): string => `packs.${id}.${path}`;
  const substitute = (value: string, path: string): string =>
    substitutePlaceholders(value, placeholders, where(path));
  const forbid = (value: string, path: string): string => {
    if (new RegExp(PLACEHOLDER_PATTERN.source).test(value)) {
      throw new ConfigError(
        `${CONFIG_FILE_NAME} ${where(path)}: placeholders are only allowed in ref, paths, url, urls, include, exclude, and readFirst.`
      );
    }
    return value;
  };

  const sources = pack.sources.map((source, index) =>
    resolveSource(source, `sources[${index}]`, substitute, forbid)
  );
  const readFirst = (pack.readFirst ?? []).map((target, index) => {
    const resolved = substitute(target, `readFirst[${index}]`);
    if (!isReadFirstTarget(resolved)) {
      throw new ConfigError(
        `${CONFIG_FILE_NAME} ${where(`readFirst[${index}]`)}: "${resolved}" (from "${target}") is not a path under pages/ or files/ inside the pack; edit packs.${id}.readFirst.`
      );
    }
    return resolved;
  });
  const repeated = readFirst.find((target, index) => readFirst.indexOf(target) !== index);
  if (repeated !== undefined) {
    throw new ConfigError(
      `${CONFIG_FILE_NAME} ${where('readFirst')}: "${repeated}" is listed twice once placeholders are substituted; edit packs.${id}.readFirst.`
    );
  }

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
    ...(readFirst.length === 0 ? {} : { readFirst }),
    ...(pack.covers === undefined
      ? {}
      : { covers: pack.covers.map(({ ecosystem, name }) => ({ ecosystem, name })) }),
  };

  return { id, recipe, recipeHash: recipeHash(recipe) };
}

/**
 * Whether the pack's recipe, resolved at the version a manifest records,
 * hashes to the recorded recipeHash: llm-docs.json is unchanged and only the
 * lockfile's version of the bound dependency moved.
 */
export async function onlyLockfileVersionMoved(
  config: ProjectConfig,
  id: string,
  recorded: { version: string; recipeHash: string }
): Promise<boolean> {
  try {
    const atRecorded = await resolvePackRecipe(config, id, {
      resolveDependencyVersion: () => ({
        kind: 'found',
        version: recorded.version,
        lockfiles: [],
      }),
    });
    return atRecorded.recipeHash === recorded.recipeHash;
  } catch (error) {
    if (error instanceof ConfigError) {
      return false;
    }
    throw error;
  }
}

async function resolvePackVersion(
  id: string,
  pack: PackConfig,
  resolver: DependencyVersionResolver
): Promise<string> {
  if (pack.version !== undefined) {
    return pack.version;
  }

  const dependency = pack.dependency;

  if (dependency === undefined) {
    throw new ConfigError(
      `${CONFIG_FILE_NAME} packs.${id}: set "version" (the docs version) or "dependency" (to take the version from the lockfile).`
    );
  }

  const label = `${dependency.ecosystem}:${dependency.name}`;

  const lookup = await resolver(dependency);

  switch (lookup.kind) {
    case 'found':
      return lookup.version;
    case 'missing': {
      const searched = lookup.searched.length === 0 ? 'none found' : lookup.searched.join(', ');
      throw new ConfigError(
        `Pack "${id}": no lockfile resolves ${label} (lockfiles searched: ${searched}); set packs.${id}.version in ${CONFIG_FILE_NAME}, or install the dependency so a lockfile records it.`
      );
    }
    case 'conflict': {
      const versions = lookup.versions
        .map((entry) => `${entry.version} in ${entry.lockfile}`)
        .join(', ');
      throw new ConfigError(
        `Pack "${id}": lockfiles resolve ${label} to different versions (${versions}); set packs.${id}.version in ${CONFIG_FILE_NAME} to the one these docs describe.`
      );
    }
    case 'other-registry':
      throw new ConfigError(
        `Pack "${id}": ${lookup.lockfiles.join(', ')} install${lookup.lockfiles.length === 1 ? 's' : ''} ${label} from a registry other than the public one, so its version is not taken from the lockfile (the public package of that name is another package); set packs.${id}.version in ${CONFIG_FILE_NAME} to the version these docs describe.`
      );
    case 'unread': {
      const unread = lookup.lockfiles.map((entry) => `${entry.lockfile} ${entry.reason}`);
      throw new ConfigError(
        `Pack "${id}": the version of ${label} is unknown because a lockfile was not read (${unread.join('; ')}); set packs.${id}.version in ${CONFIG_FILE_NAME}.`
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
        `${CONFIG_FILE_NAME} ${where}: placeholder ${token} has no value for version "${placeholders.version}", which has no such numeric part; write that part out literally instead of ${token}.`
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
  const seen = new Map<string, { url: string; path: string }>();

  return entries.map((entry, index) => {
    const where = `${path}.urls[${index}]`;
    const url = substitute(typeof entry === 'string' ? entry : entry.url, where);
    const parsed = parsedUrl(url);

    if (parsed === undefined || !isDocsUrl(parsed)) {
      throw new ConfigError(
        `${CONFIG_FILE_NAME} ${where}: "${redactUrl(url)}" is not an https:// URL; only https:// pages are fetched, so fix the URL.`
      );
    }

    const storedPath =
      typeof entry === 'string'
        ? storedPathForUrl(parsed)
        : substitute(entry.path, `${where}.path`).replace(/^\/+/, '');

    if (storedPath === '' || escapesUpward(storedPath) || isAbsolute(storedPath)) {
      throw new ConfigError(
        `${CONFIG_FILE_NAME} ${where}: stored path "${storedPath}" must be a relative path inside the pack; give the URL an explicit "path" such as "guide/intro.md".`
      );
    }

    const previous = seen.get(pathCollisionKey(storedPath));

    if (previous !== undefined) {
      throw new ConfigError(
        `${CONFIG_FILE_NAME} ${path}.urls: ${redactUrl(previous.url)} and ${redactUrl(url)} would both be stored at "${previous.path === storedPath ? storedPath : `${previous.path}" and "${storedPath}`}"${previous.path === storedPath ? '' : ' (one path on a case- or normalization-insensitive file system)'}; give one an explicit "path".`
      );
    }

    seen.set(pathCollisionKey(storedPath), { url, path: storedPath });
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

  return storedPathForPathname(pathname);
}

/** The stored path for a percent-decoded URL pathname (spec 2.3); llms-txt sources share it. */
export function storedPathForPathname(pathname: string): string {
  if (pathname.endsWith('/')) {
    return `${pathname}index.md`.replace(/^\/+/, '');
  }

  const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1);
  const withExtension = lastSegment.includes('.') ? pathname : `${pathname}.md`;
  return withExtension.replace(/^\/+/, '');
}
