/**
 * Programmatic API: the format parsers, format detection, and the DocNode IR
 * they produce.
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
export { DEFAULT_CHUNK_MAX_CHARACTERS, chunkDocNode } from './core/chunker.js';
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
