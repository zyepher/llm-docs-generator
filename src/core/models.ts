/**
 * The unified, format-agnostic intermediate representation (IR) every parser
 * produces: a tree of DocNodes carrying ContentBlocks.
 *
 * Performance considerations:
 * - Zod schemas are created once and reused (O(1) schema lookup)
 * - Lazy validation only when needed
 * - Immutable data structures for safety
 * - Efficient property access patterns
 */

import { z } from 'zod';

// ============================================================================
// UNIFIED INTERMEDIATE REPRESENTATION (IR)
// ============================================================================

/**
 * Content block types within documentation
 * - prose: Descriptive text, explanations
 * - code: Code examples with language
 * - data: SQL schemas, JSON responses, etc.
 */
export enum ContentBlockType {
  PROSE = 'prose',
  CODE = 'code',
  DATA = 'data',
}

/**
 * ContentBlock - A single content element
 *
 * Can represent prose paragraphs, code blocks, data schemas, etc.
 * Format-agnostic representation used by all parsers.
 */
export const ContentBlockSchema = z.object({
  type: z.enum(ContentBlockType),
  language: z.string().optional(), // e.g., 'swift', 'sql', 'json'
  content: z.string(),
  annotations: z.map(z.string(), z.unknown()).optional(), // Flexible metadata
});

export type ContentBlock = z.infer<typeof ContentBlockSchema>;

/**
 * DocNode types representing the documentation hierarchy
 */
export enum DocNodeType {
  ROOT = 'root', // Top-level document
  CATEGORY = 'category', // Major section (e.g., "Database Operations")
  SECTION = 'section', // Subsection or chapter
  OPERATION = 'operation', // Single API method or topic
  ITEM = 'item', // Individual example or detail
}

/**
 * DocNode - Universal documentation node
 *
 * Hierarchical tree structure that can represent:
 * - Markdown: File → H2 → H3 → H4 → Code block
 * - Any other format with hierarchical structure
 *
 * Performance: O(1) access to children, O(log n) tree operations
 */
// Defaults are factories so each parsed node gets its own array and Map
// instead of sharing one mutable instance across every parse.
export const DocNodeSchema: z.ZodType<DocNode, unknown> = z.lazy(() =>
  z.object({
    type: z.enum(DocNodeType),
    id: z.string(),
    title: z.string(),
    description: z.string().default(''),
    content: z.array(ContentBlockSchema).default(() => []),
    children: z.array(DocNodeSchema).default(() => []),
    metadata: z.map(z.string(), z.unknown()).default(() => new Map()),
  })
);

export interface DocNode {
  type: DocNodeType;
  id: string;
  title: string;
  description: string;
  content: ContentBlock[];
  children: DocNode[];
  metadata: Map<string, unknown>;
}

/**
 * Builder for creating DocNodes with sensible defaults
 */
export function createDocNode(
  type: DocNodeType,
  id: string,
  title: string,
  options?: {
    description?: string;
    content?: ContentBlock[];
    children?: DocNode[];
    metadata?: Map<string, unknown>;
  }
): DocNode {
  return {
    type,
    id,
    title,
    description: options?.description ?? '',
    content: options?.content ?? [],
    children: options?.children ?? [],
    metadata: options?.metadata ?? new Map(),
  };
}

/**
 * Builder for creating ContentBlocks
 */
export function createContentBlock(
  type: ContentBlockType,
  content: string,
  options?: {
    language?: string;
    annotations?: Map<string, unknown>;
  }
): ContentBlock {
  const block: ContentBlock = {
    type,
    content,
  };

  if (options?.language !== undefined) {
    block.language = options.language;
  }

  if (options?.annotations !== undefined) {
    block.annotations = options.annotations;
  }

  return block;
}
