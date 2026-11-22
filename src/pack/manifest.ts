/**
 * Manifest v3 (spec 3): the zod schema, reading with a clear error for v2
 * packs, and canonical writing (sorted keys, arrays sorted by stable keys,
 * `\n` line endings, one trailing newline) so a rebuild from the same inputs
 * is byte-identical.
 *
 * The schema already carries the fields later phases fill: origins for every
 * source type, detected licenses, http fetch metadata, converter records, and
 * link statistics. The citations lock is not an output (spec 3, 8).
 */

import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import packageJson from '../../package.json';
import {
  resolvedPackRecipeSchema,
  CONVERTER_TOOLS,
  PACK_ID_PATTERN,
  recipeHash,
  TRANSFORM_NAMES,
  type LoadedProjectConfig,
} from '../config/project.js';
import { ECOSYSTEMS } from '../deps/lockfiles.js';
import { errorMessage, isFileNotFoundError, isRecord } from '../utils/guards.js';
import { canonicalJsonStringify, readJsonFile } from '../utils/json.js';
import { RefusedFileError, writeTextFileSafely } from '../utils/safe-write.js';
import { compareStringsByCodeUnit } from '../utils/sort.js';

export const MANIFEST_FILE_NAME = 'manifest.json';
export const TOOL_NAME = 'llm-docs';
export const TOOL_VERSION: string = packageJson.version;

const OUTPUT_KINDS = ['page', 'index', 'passthrough', 'combined'] as const;

const hashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/, {
  error: 'must be a sha256:<64 hex> hash',
});

/**
 * A relative POSIX path that cannot leave the directory it is joined to: no
 * absolute form, no empty, `.`, or `..` segment, no backslash, and no control
 * character (NUL included). Every path a manifest or the citations lock
 * records is one, so no reader can be steered outside the pack or the origin
 * (on Windows a backslash separates segments, so `pages\..\..\x` climbs).
 */
export function isContainedRelativePath(value: string): boolean {
  return (
    !value.includes('\\') &&
    !/\p{Cc}/u.test(value) &&
    value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  );
}

const relativePathSchema = z.string().refine(isContainedRelativePath, {
  error:
    'must be a relative POSIX path with no "..", ".", or empty segment, backslash, or control character',
});

/** Where each output kind lives in a pack; `combined` is checked against the pack id below. */
const OUTPUT_PATH_RULES: Readonly<
  Record<(typeof OUTPUT_KINDS)[number], (path: string) => boolean>
> = {
  page: (path) => path.startsWith('pages/'),
  passthrough: (path) => path.startsWith('files/'),
  index: (path) => path === 'index.md',
  combined: (path) => path.endsWith('.full.md') && !path.includes('/'),
};

const OUTPUT_PATH_RULE_TEXT: Readonly<Record<(typeof OUTPUT_KINDS)[number], string>> = {
  page: 'a page must be under pages/',
  passthrough: 'a passthrough file must be under files/',
  index: 'the index must be index.md',
  combined: 'the combined file must be <pack id>.full.md',
};

const LICENSE_STATUSES = [
  'permissive',
  'copyleft',
  'attribution',
  'unknown',
  'proprietary',
] as const;
export type LicenseStatus = (typeof LICENSE_STATUSES)[number];

const originSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('git'),
    repo: z.string(),
    /** The repository the recipe's `repo` redirected to, which git fetched from. */
    finalRepo: z.string().optional(),
    ref: z.string(),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    refKind: z.enum(['tag', 'branch', 'commit']),
  }),
  z.strictObject({
    type: z.literal('llms-txt'),
    url: z.string(),
    sha256: hashSchema,
    finalUrl: z.string().optional(),
  }),
  z.strictObject({ type: z.literal('urls') }),
  z.strictObject({
    type: z.literal('local'),
    /** Project-relative POSIX path of the source (the recipe's, so `.` is allowed). */
    path: z
      .string()
      .min(1)
      .refine((path) => path === '.' || isContainedRelativePath(path.replace(/\/+$/, '')), {
        error: 'must be a project-relative POSIX path inside the project',
      }),
    /** HEAD of the git repository holding the source, or null outside git. */
    hostCommit: z.string().nullable(),
    /** Whether that repository had uncommitted changes; null outside git. */
    hostDirty: z.boolean().nullable(),
  }),
]);

const sourceEntrySchema = z.strictObject({
  /** Index into recipe.sources and origins. */
  source: z.number().int().min(0),
  /** Origin-relative POSIX path. */
  path: relativePathSchema,
  url: z.string().optional(),
  sha256: hashSchema,
  bytes: z.number().int().min(0),
  fetch: z
    .strictObject({
      finalUrl: z.string(),
      status: z.number().int(),
      etag: z.string().optional(),
      lastModified: z.string().optional(),
    })
    .optional(),
  converter: z
    .strictObject({
      tool: z.enum(CONVERTER_TOOLS),
      /** `--version` output of the tool; null for agent conversions. */
      version: z.string().nullable(),
      /** Hash of the Markdown the converter (or agent) produced. */
      outputSha256: hashSchema.optional(),
      /**
       * Agent conversions only: the hash of the original the agent's `.md`
       * was written from. It differs from `sha256` while the conversion is
       * stale (the original changed and the `.md` did not).
       */
      inputSha256: hashSchema.optional(),
    })
    .optional(),
});

const outputEntrySchema = z.strictObject({
  /** Pack-relative POSIX path. */
  path: relativePathSchema,
  kind: z.enum(OUTPUT_KINDS),
  sha256: hashSchema,
  bytes: z.number().int().min(0),
  tokens: z.number().int().min(0).optional(),
  title: z.string().optional(),
  /** `<source index>:<origin-relative path>` of the inputs this output came from. */
  sources: z
    .array(
      z
        .string()
        .refine(
          (key) => /^\d+:/.test(key) && isContainedRelativePath(key.slice(key.indexOf(':') + 1)),
          { error: 'must be <source index>:<origin-relative path>' }
        )
    )
    .optional(),
});

const unresolvedLinkSchema = z.strictObject({
  page: relativePathSchema,
  target: z.string(),
  reason: z.string(),
});

const packManifestSchema = z
  .strictObject({
    schemaVersion: z.literal(3),
    tool: z.strictObject({ name: z.literal(TOOL_NAME), version: z.string() }),
    pack: z.strictObject({
      id: z.string().regex(PACK_ID_PATTERN, { error: 'must be a pack id' }),
      title: z.string(),
      version: z.string(),
    }),
    dependency: z.strictObject({ ecosystem: z.enum(ECOSYSTEMS), name: z.string() }).nullable(),
    recipe: resolvedPackRecipeSchema,
    recipeHash: hashSchema,
    acquiredAt: z.iso.datetime(),
    origins: z.array(originSchema),
    license: z.strictObject({
      declared: z.string().nullable(),
      detected: z.strictObject({ spdx: z.string(), evidence: z.string() }).nullable(),
      status: z.enum(LICENSE_STATUSES),
    }),
    sources: z.array(sourceEntrySchema),
    outputs: z.array(outputEntrySchema),
    links: z.strictObject({
      rewritten: z.number().int().min(0),
      external: z.number().int().min(0),
      unresolved: z.array(unresolvedLinkSchema),
    }),
    transforms: z.array(
      z.strictObject({ name: z.enum(TRANSFORM_NAMES), pages: z.number().int().min(0) })
    ),
    warnings: z.array(z.string()),
  })
  .superRefine((manifest, context) => {
    const issue = (path: (string | number)[], message: string): void => {
      context.addIssue({ code: 'custom', path, message });
    };
    // Everything a reader trusts the recipe for must be the recipe's: a manifest
    // edited by hand would otherwise read as up to date while saying something else.
    if (recipeHash(manifest.recipe) !== manifest.recipeHash) {
      issue(['recipeHash'], 'is not the hash of "recipe" (the manifest was edited)');
    }
    if (manifest.pack.title !== manifest.recipe.title) {
      issue(['pack', 'title'], 'differs from recipe.title (the manifest was edited)');
    }
    if (manifest.pack.version !== manifest.recipe.version) {
      issue(['pack', 'version'], 'differs from recipe.version (the manifest was edited)');
    }
    if (JSON.stringify(manifest.dependency) !== JSON.stringify(manifest.recipe.dependency)) {
      issue(['dependency'], 'differs from recipe.dependency (the manifest was edited)');
    }
    if (manifest.origins.length !== manifest.recipe.sources.length) {
      issue(['origins'], 'must hold one origin per recipe source');
    }
    manifest.origins.forEach((origin, index) => {
      if (
        manifest.recipe.sources[index] !== undefined &&
        manifest.recipe.sources[index].type !== origin.type
      ) {
        issue(['origins', index, 'type'], `differs from recipe.sources[${index}].type`);
      }
    });
    manifest.sources.forEach((entry, index) => {
      if (entry.source >= manifest.recipe.sources.length) {
        issue(['sources', index, 'source'], 'names no recipe source');
      }
    });
    manifest.outputs.forEach((output, index) => {
      const fits =
        OUTPUT_PATH_RULES[output.kind](output.path) &&
        (output.kind !== 'combined' || output.path === `${manifest.pack.id}.full.md`);
      if (!fits) {
        issue(['outputs', index, 'path'], `${OUTPUT_PATH_RULE_TEXT[output.kind]}`);
      }
    });
  });

export type PackManifest = z.infer<typeof packManifestSchema>;
export type ManifestOrigin = z.infer<typeof originSchema>;
export type ManifestSourceEntry = z.infer<typeof sourceEntrySchema>;
export type ManifestOutputEntry = z.infer<typeof outputEntrySchema>;
export type ManifestFetch = NonNullable<ManifestSourceEntry['fetch']>;

/** The committed `schema/manifest.schema.json` text (regenerated by `npm run schema`). */
export function manifestJsonSchemaText(): string {
  return `${JSON.stringify(z.toJSONSchema(packManifestSchema, { io: 'input' }), null, 2)}\n`;
}

// Status for a declared or detected SPDX id (spec 4.10). Phase 2c's license
// detection reuses this table for detected licenses.
const LICENSE_STATUS_BY_SPDX: Readonly<Record<string, LicenseStatus>> = {
  MIT: 'permissive',
  'Apache-2.0': 'permissive',
  'BSD-2-Clause': 'permissive',
  'BSD-3-Clause': 'permissive',
  ISC: 'permissive',
  'CC0-1.0': 'permissive',
  Unlicense: 'permissive',
  'CC-BY-4.0': 'attribution',
  'CC-BY-SA-4.0': 'copyleft',
  'MPL-2.0': 'copyleft',
  'GPL-2.0': 'copyleft',
  'GPL-3.0': 'copyleft',
  'LGPL-2.1': 'copyleft',
  'LGPL-3.0': 'copyleft',
  'AGPL-3.0': 'copyleft',
};

/** Lower is less restrictive, for combining SPDX expressions. */
const STATUS_RANK: Readonly<Record<LicenseStatus, number>> = {
  permissive: 0,
  attribution: 1,
  copyleft: 2,
  unknown: 3,
  proprietary: 4,
};

export function licenseStatusFor(spdx: string | null): LicenseStatus {
  if (spdx === null) {
    return 'unknown';
  }

  if (spdx.toLowerCase() === 'proprietary') {
    return 'proprietary';
  }

  // SPDX expressions: OR takes the most permissive choice, AND the most restrictive term.
  const expression = spdx.replace(/[()]/g, ' ').trim();
  if (/\s(?:OR|AND)\s/i.test(expression)) {
    const pick = (statuses: LicenseStatus[], best: boolean): LicenseStatus =>
      [...statuses].sort((a, b) => (STATUS_RANK[a] - STATUS_RANK[b]) * (best ? 1 : -1))[0] ??
      'unknown';
    return pick(
      expression
        .split(/\s+OR\s+/i)
        .map((choice) => pick(choice.split(/\s+AND\s+/i).map(licenseStatusFor), false)),
      true
    );
  }

  // `GPL-3.0-only` and `GPL-3.0-or-later` share their base id's status; an exception keeps it.
  const base = expression.replace(/\s+WITH\s+.*$/i, '').replace(/-(?:only|or-later)$/, '');
  return Object.hasOwn(LICENSE_STATUS_BY_SPDX, base)
    ? (LICENSE_STATUS_BY_SPDX[base] ?? 'unknown')
    : 'unknown';
}

/** Thrown for a manifest that is missing, unreadable, from another schema version, or invalid. */
export class ManifestError extends Error {
  override name = 'ManifestError';

  constructor(
    message: string,
    readonly reason: 'missing' | 'invalid' | 'other-version' | 'link'
  ) {
    super(message);
  }
}

/**
 * Read and validate a pack's manifest: the schema, the paths it records, and
 * its agreement with its own recipe. A pack directory or manifest.json that is
 * a symbolic link is refused, never read through.
 */
export async function readPackManifest(packDir: string): Promise<PackManifest> {
  const path = join(packDir, MANIFEST_FILE_NAME);
  let raw: unknown;

  for (const [target, label] of [
    [packDir, 'the pack directory'],
    [path, MANIFEST_FILE_NAME],
  ] as const) {
    let isLink = false;
    try {
      isLink = (await lstat(target)).isSymbolicLink();
    } catch {
      // Reading the manifest below reports a missing or unreadable one.
    }
    if (isLink) {
      throw new ManifestError(
        `${label} is a symbolic link, which llm-docs never reads a pack through`,
        'link'
      );
    }
  }

  try {
    raw = await readJsonFile(path, { followLinks: false });
  } catch (error) {
    if (isFileNotFoundError(error)) {
      throw new ManifestError(`${MANIFEST_FILE_NAME} is missing`, 'missing');
    }
    if (error instanceof RefusedFileError && error.refusal.kind === 'not-regular') {
      throw new ManifestError(
        `${MANIFEST_FILE_NAME} is ${error.refusal.found}, not a regular file, so llm-docs never reads it`,
        error.refusal.found === 'a symbolic link' ? 'link' : 'invalid'
      );
    }
    throw new ManifestError(
      `${MANIFEST_FILE_NAME} ${error instanceof SyntaxError ? 'is not valid JSON' : 'cannot be read'}: ${errorMessage(error)}`,
      'invalid'
    );
  }

  if (isRecord(raw) && raw.schemaVersion !== 3) {
    throw new ManifestError(
      `${MANIFEST_FILE_NAME} has schemaVersion ${JSON.stringify(raw.schemaVersion ?? null)}, not 3; convert a v2 pack with 'llm-docs migrate <v2-pack-dir>'.`,
      'other-version'
    );
  }

  const parsed = packManifestSchema.safeParse(raw);

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue === undefined ? '' : issue.path.map(String).join('.');
    throw new ManifestError(
      `${MANIFEST_FILE_NAME} does not match the v3 schema${where === '' ? '' : ` at ${where}`}: ${issue?.message ?? 'invalid'}`,
      'invalid'
    );
  }

  return parsed.data;
}

function compareBy<T>(...keys: ((item: T) => string | number)[]): (a: T, b: T) => number {
  return (a, b) => {
    for (const key of keys) {
      const left = key(a);
      const right = key(b);
      const difference =
        typeof left === 'number' && typeof right === 'number'
          ? left - right
          : compareStringsByCodeUnit(String(left), String(right));

      if (difference !== 0) {
        return difference;
      }
    }
    return 0;
  };
}

/**
 * The manifest with every unordered array sorted by a stable key (spec 2.5).
 * `origins` and `recipe` keep their order: both are indexed by source.
 */
function canonicalizeManifest(manifest: PackManifest): PackManifest {
  return {
    ...manifest,
    sources: [...manifest.sources].sort(
      compareBy(
        (entry) => entry.source,
        (entry) => entry.path
      )
    ),
    outputs: [...manifest.outputs]
      .map((entry) =>
        entry.sources === undefined
          ? entry
          : { ...entry, sources: [...entry.sources].sort(compareStringsByCodeUnit) }
      )
      .sort(compareBy((entry) => entry.path)),
    links: {
      ...manifest.links,
      unresolved: [...manifest.links.unresolved].sort(
        compareBy(
          (entry) => entry.page,
          (entry) => entry.target,
          (entry) => entry.reason
        )
      ),
    },
    transforms: [...manifest.transforms].sort(compareBy((entry) => entry.name)),
    warnings: [...new Set(manifest.warnings)].sort(compareStringsByCodeUnit),
  };
}

/** The exact bytes `writePackManifest` writes for `manifest`. */
export function serializePackManifest(manifest: PackManifest): string {
  return `${canonicalJsonStringify(canonicalizeManifest(manifest), 2)}\n`;
}

export async function writePackManifest(packDir: string, manifest: PackManifest): Promise<void> {
  const parsed = packManifestSchema.safeParse(manifest);

  if (!parsed.success) {
    throw new Error(
      `Refusing to write an invalid manifest: ${parsed.error.issues[0]?.message ?? 'invalid'}`
    );
  }

  await writeTextFileSafely(join(packDir, MANIFEST_FILE_NAME), serializePackManifest(manifest));
}

/** How one pack directory's manifest read, as a value instead of a thrown ManifestError. */
export type ProjectPackManifest =
  | { kind: 'ok'; manifest: PackManifest }
  | { kind: 'missing' }
  | {
      kind: 'invalid';
      reason: 'invalid' | 'other-version' | 'link' | 'wrong-id';
      message: string;
    };

export interface ProjectPack {
  id: string;
  /** Absolute pack directory. */
  dir: string;
  /** llm-docs.json lists it. False: an orphan directory that holds a manifest.json. */
  inConfig: boolean;
  manifest: ProjectPackManifest;
}

/**
 * Every pack of the project: configured packs in llm-docs.json order (the
 * order the planner wrote, which the managed block keeps), then orphan
 * directories holding a manifest.json, sorted. Read-only.
 */
export async function readProjectPacks(loaded: LoadedProjectConfig): Promise<ProjectPack[]> {
  const orphans: string[] = [];

  try {
    for (const entry of await readdir(loaded.packsDir, { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        entry.name.startsWith('.') ||
        Object.hasOwn(loaded.config.packs, entry.name)
      ) {
        continue;
      }
      try {
        await lstat(join(loaded.packsDir, entry.name, MANIFEST_FILE_NAME));
        orphans.push(entry.name);
      } catch {
        // Not a pack: no manifest.
      }
    }
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      throw error;
    }
  }

  const ids = [
    ...Object.keys(loaded.config.packs).map((id) => ({ id, inConfig: true })),
    ...orphans.sort(compareStringsByCodeUnit).map((id) => ({ id, inConfig: false })),
  ];

  return Promise.all(
    ids.map(async ({ id, inConfig }) => {
      const dir = join(loaded.packsDir, id);
      return { id, dir, inConfig, manifest: await readManifestValue(dir, id) };
    })
  );
}

async function readManifestValue(dir: string, id: string): Promise<ProjectPackManifest> {
  try {
    const manifest = await readPackManifest(dir);
    return manifest.pack.id === id
      ? { kind: 'ok', manifest }
      : {
          kind: 'invalid',
          reason: 'wrong-id',
          message: `${MANIFEST_FILE_NAME} belongs to pack "${manifest.pack.id}", not "${id}"`,
        };
  } catch (error) {
    if (!(error instanceof ManifestError)) {
      throw error;
    }
    return error.reason === 'missing'
      ? { kind: 'missing' }
      : { kind: 'invalid', reason: error.reason, message: error.message };
  }
}
