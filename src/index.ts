/**
 * Programmatic API: the format parsers, format detection, and the DocNode IR
 * they produce; the v3 project config, recipe resolution, sync, verify, and
 * manifest reading.
 */

export { BaseParser, FormatType, ParserError } from './parsers/base.js';
export type {
  Parser,
  ValidationError,
  ValidationResult,
  ValidationWarning,
} from './parsers/base.js';
export { MarkdownFormatParser, markdownParser } from './parsers/markdown/index.js';
export { OpenApiFormatParser, openApiParser, parseOpenApiFile } from './parsers/openapi/index.js';
export type { ApiVersionInfo } from './parsers/openapi/index.js';
export { HtmlFormatParser, htmlParser, parseHtmlFile } from './parsers/html/index.js';
export type { HtmlDocument, HtmlLink, HtmlParserWarning } from './parsers/html/index.js';
export { RstFormatParser, parseRstFile, rstParser } from './parsers/rst/index.js';
export type { RstDocument } from './parsers/rst/index.js';
export {
  detectFormat,
  FormatDetector,
  getFormatDetector,
  getParserForFormat,
} from './core/detector.js';
export { ContentBlockType, DocNodeType, createContentBlock, createDocNode } from './core/models.js';
export type { ContentBlock, DocNode } from './core/models.js';
export { estimateTokenCount } from './utils/text-metrics.js';

// v3 project config, recipes, sync, verify, and manifests.
export {
  ConfigError,
  findProjectRoot,
  loadProjectConfig,
  LockfileResolutionUnavailableError,
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
export { SyncLockedError, syncPacks } from './pack/build.js';
export type {
  AfterSyncContext,
  AfterSyncResult,
  AfterSyncStep,
  OrphanResult,
  PackSyncResult,
  SyncOptions,
  SyncReport,
} from './pack/build.js';
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
