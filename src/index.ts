/**
 * Programmatic API: the project config and recipe resolution, sync (which
 * also refreshes), verify, and reading a pack manifest.
 */

export {
  ConfigError,
  findProjectRoot,
  loadProjectConfig,
  recipeHash,
  resolvePackRecipe,
} from './config/project.js';
export type {
  DependencyVersionResolver,
  LoadedProjectConfig,
  PackConfig,
  ProjectConfig,
  ResolvedPack,
  ResolvedPackRecipe,
  ResolvedSource,
  ResolvePackOptions,
  SourceConfig,
} from './config/project.js';
export { syncPacks } from './pack/build.js';
export { SyncLockedError } from './pack/lock.js';
export type { AgentBlockOutcome, AgentBlockStatus } from './agent/block.js';
export type { OrphanResult, PackSyncResult, SyncOptions, SyncReport } from './pack/build.js';
export type {
  RefreshFileChange,
  RefreshFileStatus,
  RefreshRefChange,
  RefreshReport,
} from './pack/refresh.js';
export { verifyPacks } from './pack/verify.js';
export type {
  CheckFinding,
  CheckName,
  CheckResult,
  CheckStatus,
  VerifyOptions,
  VerifyReport,
} from './pack/verify.js';
export { ManifestError, readPackManifest } from './pack/manifest.js';
export type {
  ManifestOrigin,
  ManifestOutputEntry,
  ManifestSourceEntry,
  PackManifest,
} from './pack/manifest.js';
