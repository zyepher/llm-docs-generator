/**
 * Manifest v3 (spec 3): the zod schema, reading with a clear error for v2
 * packs, and canonical writing (sorted keys, arrays sorted by stable keys,
 * `\n` line endings, one trailing newline) so a rebuild from the same inputs
 * is byte-identical.
 *
 * The schema already carries the fields later phases fill: origins for every
 * source type, detected licenses, http fetch metadata, converter records,
 * link statistics, and the `citations` output kind.
 */

import { join } from 'node:path';

import { z } from 'zod';

import packageJson from '../../package.json';
import { resolvedPackRecipeSchema, CONVERTER_TOOLS, TRANSFORM_NAMES } from '../config/project.js';
import { ECOSYSTEMS } from '../deps/lockfiles.js';
import { errorMessage, isFileNotFoundError, isRecord } from '../utils/guards.js';
import { canonicalJsonStringify, readJsonFile } from '../utils/json.js';
import { writeTextFileSafely } from '../utils/safe-write.js';
import { compareStringsByCodeUnit } from '../utils/sort.js';

export const MANIFEST_FILE_NAME = 'manifest.json';
export const TOOL_NAME = 'llm-docs';
export const TOOL_VERSION: string = packageJson.version;

const hashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/, {
  error: 'must be a sha256:<64 hex> hash',
});
const relativePathSchema = z.string().min(1);

const OUTPUT_KINDS = ['page', 'index', 'passthrough', 'combined', 'citations'] as const;

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
    /** Project-relative POSIX path of the source. */
    path: z.string(),
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
  sources: z.array(z.string()).optional(),
});

const unresolvedLinkSchema = z.strictObject({
  page: z.string(),
  target: z.string(),
  reason: z.string(),
});

const packManifestSchema = z.strictObject({
  schemaVersion: z.literal(3),
  tool: z.strictObject({ name: z.literal(TOOL_NAME), version: z.string() }),
  pack: z.strictObject({ id: z.string(), title: z.string(), version: z.string() }),
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

export function licenseStatusFor(spdx: string | null): LicenseStatus {
  if (spdx === null) {
    return 'unknown';
  }

  if (spdx.toLowerCase() === 'proprietary') {
    return 'proprietary';
  }

  // `GPL-3.0-only` and `GPL-3.0-or-later` share their base id's status.
  const base = spdx.replace(/-(?:only|or-later)$/, '');
  return Object.hasOwn(LICENSE_STATUS_BY_SPDX, base)
    ? (LICENSE_STATUS_BY_SPDX[base] ?? 'unknown')
    : 'unknown';
}

/** Thrown for a manifest that is missing, unreadable, from another schema version, or invalid. */
export class ManifestError extends Error {
  override name = 'ManifestError';

  constructor(
    message: string,
    readonly reason: 'missing' | 'invalid' | 'other-version'
  ) {
    super(message);
  }
}

export async function readPackManifest(packDir: string): Promise<PackManifest> {
  const path = join(packDir, MANIFEST_FILE_NAME);
  let raw: unknown;

  try {
    raw = await readJsonFile(path);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      throw new ManifestError(`${MANIFEST_FILE_NAME} is missing`, 'missing');
    }
    throw new ManifestError(
      `${MANIFEST_FILE_NAME} is not valid JSON: ${errorMessage(error)}`,
      'invalid'
    );
  }

  if (isRecord(raw) && raw.schemaVersion !== 3) {
    throw new ManifestError(
      `${MANIFEST_FILE_NAME} has schemaVersion ${JSON.stringify(raw.schemaVersion ?? null)}, not 3; convert a v2 pack with 'llm-docs migrate <pack-dir>'.`,
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
