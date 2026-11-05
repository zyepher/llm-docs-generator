/**
 * Main entry point for programmatic API
 */

// Core exports
export { OpenRefParser, parseOpenRefSpec, getParserStats } from './parsers/openref/parser.js';
export { OpenApiFormatParser, openApiParser, parseOpenApiFile } from './parsers/openapi/index.js';
export { HtmlFormatParser, htmlParser, parseHtmlFile } from './parsers/html/index.js';
export type { HtmlDocument, HtmlLink, HtmlParserWarning } from './parsers/html/index.js';
export { RstFormatParser, parseRstFile, rstParser } from './parsers/rst/index.js';
export type { RstDocument } from './parsers/rst/index.js';
export { LLMFormatter, formatSpecData } from './core/formatter.js';
export { DEFAULT_CHUNK_MAX_CHARACTERS, chunkDocNode } from './core/chunker.js';
export { estimateTokenCount } from './utils/text-metrics.js';
export type {
  ChunkDocNodeOptions,
  ChunkDocNodeResult,
  SemanticChunk,
  SemanticChunkMetadata,
  SemanticChunkSource,
  SemanticChunkSourceLines,
  SemanticChunkWarning,
  SemanticChunkWarningCode,
} from './core/chunker.js';
export {
  detectFormat,
  FormatDetector,
  getFormatDetector,
  getParserForFormat,
} from './core/detector.js';
export { BaseParser, FormatType, ParserError } from './parsers/base.js';
export type {
  Parser,
  ValidationError,
  ValidationResult,
  ValidationWarning,
} from './parsers/base.js';
export type { ApiVersionInfo } from './parsers/openapi/index.js';
export { ContentBlockType, DocNodeType, createContentBlock, createDocNode } from './core/models.js';
export type { ContentBlock, DocNode } from './core/models.js';
export type { Example } from './core/models.js';
export type { Operation } from './core/models.js';
export type { SpecInfo } from './core/models.js';
export type { SpecData } from './core/models.js';
export {
  createSpecData,
  getOperationById,
  getOperationsByIds,
  getTotalExamples,
} from './core/models.js';

// Config exports
export { ConfigLoader, loadConfig } from './config/loader.js';
export type { SDKConfig } from './config/schemas.js';
export type { SDKVersionConfig } from './config/schemas.js';
export type { CategoryConfig } from './config/schemas.js';
export type { SpecConfig } from './config/schemas.js';
export type { OutputConfig } from './config/schemas.js';

// Utils exports
export { fetchSpec, isSpecCached, clearSpecCache } from './utils/fetcher.js';
export { Logger, LogLevel } from './utils/logger.js';
