/**
 * `llm-docs migrate` (spec 9): carry a v2 `local-source-docs` pack into a v3
 * project as a recipe. The v2 manifest is parsed at the boundary, the recipe is
 * decided by a pure function of that manifest and a few file system facts, and
 * the result is written through the same config path `add` uses. The v2 pack is
 * only ever read.
 */

import { tmpdir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';

import { z } from 'zod';

import {
  CONFIG_FILE_NAME,
  PACK_ID_PATTERN,
  formatSchemaIssues,
  loadOrEmptyConfig,
  packConfigSchema,
  resolvePackRecipe,
  saveProjectConfig,
  type PackConfig,
  type SourceConfig,
} from './project.js';
import {
  isSameOrDescendant,
  realpathIfExists,
  resolveEffectiveOutputPath,
} from '../utils/fs-path.js';
import { projectDependencies } from '../deps/lockfiles.js';
import { errorMessage, isFileNotFoundError, isRecord } from '../utils/guards.js';
import { readJsonFile } from '../utils/json.js';
import { compareStringsByCodeUnit } from '../utils/sort.js';

const MANIFEST_FILE_NAME = 'manifest.json';
const V2_SCHEMA_VERSION = '0.1.0';
const V2_SOURCE_DOCS_MODE = 'local-source-docs';

/** The v2 fields migration reads. v2 manifests carry many more, which are ignored. */
const v2ManifestSchema = z.looseObject({
  schemaVersion: z.literal(V2_SCHEMA_VERSION),
  mode: z.literal(V2_SOURCE_DOCS_MODE),
  source: z.looseObject({
    resolvedPath: z.string().min(1),
    label: z.string().optional(),
    git: z
      .looseObject({
        remoteUrl: z.string().min(1).nullable(),
        commit: z.string().regex(/^[0-9a-f]{40}$/, { error: 'must be a 40-hex commit' }),
        tags: z.array(z.string()).optional(),
        dirty: z.boolean(),
        sourceRootFromRepo: z.string(),
      })
      .optional(),
    // Recorded verbatim by later v2 builds; older ones kept only the globs that matched a file.
    excludeGlobs: z.array(z.string().min(1)).optional(),
    excluded: z.array(z.looseObject({ glob: z.string().min(1) })).optional(),
  }),
});

type V2Manifest = z.infer<typeof v2ManifestSchema>;

export type MigrationRefusalReason =
  | 'not-a-v2-pack'
  | 'already-v3'
  | 'unsupported-version'
  | 'unsupported-mode'
  | 'origin-lost'
  | 'outside-project'
  | 'invalid-id'
  | 'version-required'
  | 'invalid-recipe'
  | 'id-exists';

interface MigrationRefusal {
  status: 'refused';
  reason: MigrationRefusalReason;
  message: string;
}

export type MigrationOutcome =
  | { status: 'migrated'; id: string; pack: PackConfig; configPath: string; warnings: string[] }
  | MigrationRefusal;

type MigrationPlan =
  { status: 'planned'; id: string; pack: PackConfig; warnings: string[] } | MigrationRefusal;

/** What the decision needs from the file system, gathered before it runs. */
interface MigrationFacts {
  packDir: string;
  /** Canonical (symlinks resolved) project root. */
  projectRoot: string;
  /** The recorded source path with symlinks resolved, or undefined when it no longer exists. */
  sourceRealPath: string | undefined;
  tempRoots: readonly string[];
  id: string;
  idFromFlag: boolean;
  version: string | undefined;
}

function refuse(reason: MigrationRefusalReason, message: string): MigrationRefusal {
  return { status: 'refused', reason, message };
}

export interface MigrateOptions {
  projectRoot: string;
  id?: string | undefined;
  version?: string | undefined;
}

/**
 * Write the v3 recipe for the v2 pack in `packDir` into the project's
 * llm-docs.json (creating it when absent), or say why it cannot be migrated.
 * Never overwrites an existing pack id and never touches the v2 pack.
 */
export async function migrateV2Pack(
  packDir: string,
  options: MigrateOptions
): Promise<MigrationOutcome> {
  const read = await readV2Manifest(packDir);

  if (read.status === 'refused') {
    return read;
  }

  const plan = planMigration(read.manifest, {
    packDir,
    projectRoot: await resolveEffectiveOutputPath(options.projectRoot),
    sourceRealPath: await realpathIfExists(read.manifest.source.resolvedPath),
    tempRoots: await tempRoots(),
    id: options.id ?? basename(packDir),
    idFromFlag: options.id !== undefined,
    version: options.version,
  });

  if (plan.status === 'refused') {
    return plan;
  }

  const loaded = await loadOrEmptyConfig(options.projectRoot);

  if (Object.hasOwn(loaded.config.packs, plan.id)) {
    return refuse(
      'id-exists',
      `Pack "${plan.id}" already exists in ${CONFIG_FILE_NAME}; pass --id <id> to migrate under another id, or remove packs.${plan.id} from ${CONFIG_FILE_NAME} first.`
    );
  }

  // Resolving before writing means a recipe that would fail at sync never reaches the config.
  await resolvePackRecipe(
    { ...loaded.config, packs: { ...loaded.config.packs, [plan.id]: plan.pack } },
    plan.id,
    {
      resolveDependencyVersion: projectDependencies(loaded.projectRoot, {
        skipDirectories: [loaded.packsDirRelative],
      }).resolveVersion,
    }
  );
  const saved = await saveProjectConfig(options.projectRoot, plan.id, plan.pack);

  return {
    status: 'migrated',
    id: plan.id,
    pack: plan.pack,
    configPath: saved.configPath,
    warnings: plan.warnings,
  };
}

async function readV2Manifest(
  packDir: string
): Promise<{ status: 'read'; manifest: V2Manifest } | MigrationRefusal> {
  const path = join(packDir, MANIFEST_FILE_NAME);
  let raw: unknown;

  try {
    raw = await readJsonFile(path);
  } catch (error) {
    return refuse(
      'not-a-v2-pack',
      isFileNotFoundError(error)
        ? `No ${MANIFEST_FILE_NAME} in ${packDir}; pass the directory of a v2 pack (the one holding its ${MANIFEST_FILE_NAME}).`
        : `${path} is not valid JSON (${errorMessage(error)}); pass the directory of a v2 pack.`
    );
  }

  if (isRecord(raw) && raw.schemaVersion === 3) {
    return refuse(
      'already-v3',
      `${packDir} is already a v3 pack (${MANIFEST_FILE_NAME} schemaVersion 3) and needs no migration; its recipe lives in the ${CONFIG_FILE_NAME} of the project that built it.`
    );
  }

  if (!isRecord(raw) || raw.schemaVersion !== V2_SCHEMA_VERSION) {
    const version = isRecord(raw) ? JSON.stringify(raw.schemaVersion ?? null) : 'none';
    return refuse(
      'unsupported-version',
      `${path} has schemaVersion ${version}, which v3 does not support: migrate reads v2 pack manifests (schemaVersion "${V2_SCHEMA_VERSION}"). Add these docs with 'llm-docs add' instead.`
    );
  }

  if (raw.mode !== V2_SOURCE_DOCS_MODE) {
    return refuse(
      'unsupported-mode',
      `${path} is a v2 ${JSON.stringify(raw.mode ?? null)} manifest, a mode v3 does not support; only "${V2_SOURCE_DOCS_MODE}" packs migrate. Add these docs with 'llm-docs add' instead.`
    );
  }

  const parsed = v2ManifestSchema.safeParse(raw);

  if (!parsed.success) {
    return refuse(
      'not-a-v2-pack',
      `${path} is not a valid v2 "${V2_SOURCE_DOCS_MODE}" manifest (${formatSchemaIssues(MANIFEST_FILE_NAME, parsed.error)}); add these docs with 'llm-docs add' instead.`
    );
  }

  return { status: 'read', manifest: parsed.data };
}

/**
 * The recipe a v2 manifest maps to (spec 9). A source that still exists inside
 * the project becomes a `local` source even when it sits in a git work tree:
 * there the remote is usually the project's own repository, and fetching it
 * again would be slower and fail for a private one. Otherwise a recorded git
 * remote pins the exact commit; without one, a missing or temp-directory
 * source is a lost origin and any other path is outside the project.
 */
function planMigration(manifest: V2Manifest, facts: MigrationFacts): MigrationPlan {
  const { source } = manifest;
  const { git } = source;
  const recorded = source.resolvedPath;
  const repo =
    git === undefined || git.remoteUrl === null ? undefined : normalizeGitRemote(git.remoteUrl);
  const warnings: string[] = [];
  let origin: SourceConfig;

  if (
    facts.sourceRealPath !== undefined &&
    isSameOrDescendant(facts.projectRoot, facts.sourceRealPath)
  ) {
    origin = { type: 'local', path: projectRelativePath(facts.projectRoot, facts.sourceRealPath) };
  } else if (git !== undefined && git.remoteUrl !== null && repo !== undefined) {
    const root = git.sourceRootFromRepo.replace(/\/+$/, '');
    origin = { type: 'git', repo, ref: git.commit, paths: [root === '' ? '.' : root] };

    if (!/^(?:https|file):/i.test(git.remoteUrl)) {
      warnings.push(
        `the v2 remote ${git.remoteUrl} is fetched over https as ${repo}, because v3 git sources take https URLs only.`
      );
    }
    if (git.dirty) {
      warnings.push(
        `the v2 pack was built from a working tree with uncommitted changes, so the v3 pack built from commit ${git.commit.slice(0, 12)} may differ from it.`
      );
    }
  } else if (facts.sourceRealPath === undefined || isUnderTemp(recorded, facts)) {
    const missing = facts.sourceRealPath === undefined;
    const where = !isUnderTemp(recorded, facts)
      ? 'no longer exists'
      : `${missing ? 'was' : 'is'} in the OS temp directory${missing ? ' and no longer exists' : ''}`;
    return refuse(
      'origin-lost',
      `The origin of the v2 pack ${facts.packDir} is lost: it was built from ${recorded}, which ${where}, and its manifest records no git remote v3 can fetch the same files from. Re-add the docs from a durable source with 'llm-docs add ${facts.id} --git <https repo> --ref <tag or commit>' (or --url, --llms-txt, or --local with a path inside the project).`
    );
  } else {
    return refuse(
      'outside-project',
      `The v2 pack ${facts.packDir} was built from ${recorded}, which is outside this project (${facts.projectRoot}), and its manifest records no git remote v3 can fetch. v3 local sources must live inside the project: add the docs from their git repository with 'llm-docs add ${facts.id} --git <https repo> --ref <tag or commit>', or copy them into the project and add them with 'llm-docs add ${facts.id} --local <path> --version <v>'.`
    );
  }

  if (!PACK_ID_PATTERN.test(facts.id)) {
    return refuse(
      'invalid-id',
      facts.idFromFlag
        ? `--id "${facts.id}" must match ${PACK_ID_PATTERN.source}.`
        : `The pack id "${facts.id}" taken from the v2 pack directory name must match ${PACK_ID_PATTERN.source}; pass --id <id>.`
    );
  }

  if (facts.version === undefined) {
    return refuse('version-required', versionRequiredMessage(manifest, facts.packDir));
  }

  const exclude = excludeGlobs(source);
  const pack: PackConfig = {
    version: facts.version,
    sources: [exclude.length === 0 ? origin : { ...origin, exclude }],
  };
  const checked = packConfigSchema.safeParse(pack);

  if (!checked.success) {
    return refuse(
      'invalid-recipe',
      `The recipe migrated from ${facts.packDir} is invalid (${formatSchemaIssues(`packs.${facts.id}`, checked.error)}); fix the flag it names, or add the pack with 'llm-docs add'.`
    );
  }

  return { status: 'planned', id: facts.id, pack, warnings };
}

/** v2 recorded no docs version, so the planner states it; the label and tags are its evidence. */
function versionRequiredMessage(manifest: V2Manifest, packDir: string): string {
  const { label, git } = manifest.source;
  const tags = git?.tags ?? [];
  const evidence = [
    label === undefined ? undefined : `its label is ${JSON.stringify(label)}`,
    tags.length === 0
      ? undefined
      : `the tags at its commit are ${tags.slice(0, 5).join(', ')}${tags.length > 5 ? ', ...' : ''}`,
  ].filter((entry) => entry !== undefined);

  return `v2 manifests record no docs version${evidence.length === 0 ? '' : ` (for ${packDir}, ${evidence.join('; ')})`}; pass the version these docs describe with --version <v>.`;
}

function excludeGlobs(source: V2Manifest['source']): string[] {
  const globs = new Set([
    ...(source.excludeGlobs ?? []),
    ...(source.excluded ?? []).map((entry) => entry.glob),
  ]);
  return [...globs].sort(compareStringsByCodeUnit);
}

function projectRelativePath(projectRoot: string, path: string): string {
  const relativePath = relative(projectRoot, path).split(sep).join('/');
  return relativePath === '' ? '.' : relativePath;
}

function isUnderTemp(recorded: string, facts: MigrationFacts): boolean {
  return [recorded, facts.sourceRealPath].some(
    (path) => path !== undefined && facts.tempRoots.some((root) => isSameOrDescendant(root, path))
  );
}

async function tempRoots(): Promise<string[]> {
  // os.tmpdir() is $TMPDIR, a per-user folder on macOS, while scratch work just as often lands in /tmp.
  const roots = process.platform === 'win32' ? [tmpdir()] : [tmpdir(), '/tmp'];
  const canonical = await Promise.all(roots.map((root) => realpathIfExists(root)));
  return [...roots, ...canonical.filter((root) => root !== undefined)];
}

/**
 * The https form of a recorded git remote: scp-like `git@host:owner/repo.git`,
 * `ssh://`, `git://`, and `http://` remotes become `https://host/owner/repo`.
 * A `file://` remote is kept as is (v3 accepts it as a non-portable origin).
 * Undefined for anything else, such as a bare local path.
 */
function normalizeGitRemote(remote: string): string | undefined {
  // A host of one letter would be a Windows drive (C:\repo), not an scp-like remote.
  const scp = /^(?:[^@/\s]+@)?([^:/\\\s]{2,}):(?!\/)(.+)$/.exec(remote);

  if (scp !== null) {
    const [, host = '', path = ''] = scp;
    return httpsRepoUrl(host, path);
  }

  let url: URL;

  try {
    url = new URL(remote);
  } catch {
    return undefined;
  }

  switch (url.protocol) {
    case 'file:':
      return remote;
    case 'https:':
      return httpsRepoUrl(url.host, url.pathname);
    case 'http:':
    case 'ssh:':
    case 'git:':
    case 'git+ssh:':
    case 'ssh+git:':
      // The port belongs to the old transport, never to https.
      return httpsRepoUrl(url.hostname, url.pathname);
    default:
      return undefined;
  }
}

function httpsRepoUrl(host: string, path: string): string | undefined {
  const repoPath = path
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');

  if (host === '' || repoPath === '') {
    return undefined;
  }

  try {
    return new URL(`https://${host.toLowerCase()}/${repoPath}`).href;
  } catch {
    return undefined;
  }
}
