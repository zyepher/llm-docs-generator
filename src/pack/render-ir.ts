/**
 * DocNode IR to Markdown (spec 4.3): reStructuredText and HTML pages are
 * parsed by the existing parsers and rendered here, keeping the source
 * heading levels, code as fenced blocks with their language, and data blocks
 * as fenced data (tables as Markdown tables). OpenAPI documents become one
 * page per tag plus an index page. The Markdown then goes through
 * `convertMarkdownPage` like any other page, so its links are rewritten.
 */

import { posix } from 'node:path';

import { ConfigError } from '../config/project.js';
import { ContentBlockType, type ContentBlock, type DocNode } from '../core/models.js';
import { parseHtmlFile } from '../parsers/html/index.js';
import { parseOpenApiFile } from '../parsers/openapi/index.js';
import { parseRstFile } from '../parsers/rst/index.js';
import { errorMessage } from '../utils/guards.js';
import type { SelectedPage } from '../sources/acquire.js';

/** One Markdown page rendered from a source file. */
export interface RenderedPage {
  /** Pack-relative POSIX output path. */
  outputPath: string;
  text: string;
}

export interface RenderedSource {
  pages: RenderedPage[];
  warnings: string[];
}

/** A fenced code block whose fence is longer than any backtick run inside it. */
function fenced(content: string, language: string | undefined): string {
  const longest = Math.max(0, ...[...content.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  const info = (language ?? '').replace(/[`\s]+/g, '');
  return `${fence}${info}\n${content.replace(/\n+$/, '')}\n${fence}`;
}

function tableCell(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
}

function isRowList(value: unknown): value is string[][] {
  return (
    Array.isArray(value) &&
    value.every((row) => Array.isArray(row) && row.every((cell) => typeof cell === 'string'))
  );
}

/** A Markdown table: the first row is the header, short rows are padded. */
function markdownTable(rows: readonly (readonly string[])[]): string {
  const width = Math.max(1, ...rows.map((row) => row.length));
  const line = (row: readonly string[]): string =>
    `| ${Array.from({ length: width }, (_, index) => tableCell(row[index] ?? '')).join(' | ')} |`;
  const [header = [], ...body] = rows;
  return [line(header), `| ${Array(width).fill('---').join(' | ')} |`, ...body.map(line)].join(
    '\n'
  );
}

function renderBlock(block: ContentBlock): string {
  switch (block.type) {
    case ContentBlockType.PROSE: {
      const text = block.content.trim();
      return block.annotations?.get('style') === 'blockquote'
        ? text
            .split('\n')
            .map((line) => (line === '' ? '>' : `> ${line}`))
            .join('\n')
        : text;
    }
    case ContentBlockType.CODE:
      return fenced(block.content, block.language);
    case ContentBlockType.DATA: {
      const rows = block.annotations?.get('rows');
      if (block.annotations?.get('type') === 'table' && isRowList(rows) && rows.length > 0) {
        return markdownTable(rows);
      }
      return fenced(block.content, block.language ?? 'text');
    }
  }
}

function headingLevel(node: DocNode, fallback: number): number {
  const level = node.metadata.get('level');
  return Math.min(6, Math.max(1, typeof level === 'number' ? level : fallback));
}

function renderSections(nodes: readonly DocNode[], depth: number, out: string[]): void {
  for (const node of nodes) {
    out.push(`${'#'.repeat(headingLevel(node, depth))} ${node.title}`);
    out.push(...node.content.map(renderBlock).filter((block) => block !== ''));
    renderSections(node.children, depth + 1, out);
  }
}

/**
 * A parsed document (title, top-level content, sections) as Markdown. The
 * title is written as the H1 unless `titleFromSections` and a section is
 * already a level-1 heading (an HTML `<title>` that differs from its `<h1>`).
 */
export function renderDocumentMarkdown(
  document: Pick<DocNode, 'title' | 'content' | 'children'>,
  options: { titleFromSections?: boolean } = {}
): string {
  const out: string[] = [];
  const hasH1 = document.children.some((child) => headingLevel(child, 2) === 1);

  if (!(options.titleFromSections === true && hasH1) && document.title.trim() !== '') {
    out.push(`# ${document.title.trim()}`);
  }

  out.push(...document.content.map(renderBlock).filter((block) => block !== ''));
  renderSections(document.children, 2, out);
  return `${out.join('\n\n')}\n`;
}

// ---------------------------------------------------------------------------
// OpenAPI
// ---------------------------------------------------------------------------

interface DetailBlock {
  title: string;
  lines: string[];
}

/** The parser's detail blocks (`Title` then `- line` items), keyed by section annotation. */
function detailBlocks(node: DocNode): Map<string, DetailBlock> {
  const blocks = new Map<string, DetailBlock>();

  for (const block of node.content) {
    const section = block.annotations?.get('section');
    if (typeof section !== 'string') {
      continue;
    }
    const [title = '', ...rest] = block.content.split('\n');
    blocks.set(section, { title, lines: rest });
  }

  return blocks;
}

/** A single-item detail block's original text (a summary or description, possibly multi-line). */
function detailText(block: DetailBlock | undefined): string | undefined {
  if (block === undefined) {
    return undefined;
  }
  const text = block.lines.join('\n').replace(/^- /, '').trim();
  return text === '' ? undefined : text;
}

function detailSection(block: DetailBlock | undefined, heading: string): string[] {
  return block === undefined || block.lines.length === 0 ? [] : [heading, block.lines.join('\n')];
}

function metadataString(node: DocNode, key: string): string | undefined {
  const value = node.metadata.get(key);
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function renderOperation(operation: DocNode): string[] {
  const details = detailBlocks(operation);
  const method = metadataString(operation, 'method') ?? '';
  const path = metadataString(operation, 'path') ?? '';
  const operationId = metadataString(operation, 'operationId');
  const summary = detailText(details.get('summary'));
  const description = detailText(details.get('description'));
  const out = [`## ${method} ${path}`.trim()];

  if (summary !== undefined) {
    out.push(`**${summary.replace(/\s+/g, ' ')}**`);
  }
  if (description !== undefined) {
    out.push(description);
  }
  if (operation.metadata.get('deprecated') === true) {
    out.push('Deprecated: this operation is marked deprecated.');
  }
  if (operationId !== undefined) {
    out.push(`Operation ID: \`${operationId.replace(/`/g, '')}\``);
  }

  out.push(
    ...detailSection(details.get('security'), '### Authentication'),
    ...detailSection(details.get('parameters'), '### Parameters'),
    ...detailSection(details.get('request-body'), '### Request body'),
    ...detailSection(details.get('responses'), '### Responses')
  );
  return out;
}

/**
 * The file name (without `.md`) of a tag page: the parser's unique tag slug
 * (`untagged` for operations without a tag), never `index`.
 */
function tagPageName(category: DocNode): string {
  return category.id === 'index' ? 'index-tag' : category.id;
}

/**
 * An OpenAPI or Swagger document as pages under `directory`: `index.md` with
 * the info, servers, authentication schemes, and the tag list, plus one page
 * per tag (`untagged.md` for operations without a tag).
 */
export function renderOpenApiPages(root: DocNode, directory: string): RenderedPage[] {
  const title = root.title.trim() || 'API';
  const version = metadataString(root, 'version');
  const specVersion = metadataString(root, 'specVersion');
  const kind = metadataString(root, 'sourceKind') === 'swagger' ? 'Swagger' : 'OpenAPI';
  const servers = root.metadata.get('servers');
  const authentication = root.children.find(
    (child) => child.metadata.get('synthetic') === 'authentication'
  );
  const categories = root.children.filter((child) => child !== authentication);
  const pages: RenderedPage[] = [];
  const index: string[] = [`# ${title}`];

  const article = kind === 'OpenAPI' ? 'an' : 'a';
  const documentKind = `${kind}${specVersion === undefined ? '' : ` ${specVersion}`} document`;
  index.push(
    version === undefined
      ? `Described by ${article} ${documentKind}.`
      : `Version ${version}, described by ${article} ${documentKind}.`
  );
  if (root.description.trim() !== '') {
    index.push(root.description.trim());
  }
  if (Array.isArray(servers) && servers.length > 0) {
    index.push(
      '## Servers',
      servers.map((server) => `- ${String(server).replace(/\s+/g, ' ')}`).join('\n')
    );
  }
  if (authentication !== undefined) {
    const details = detailBlocks(authentication);
    index.push(
      '## Authentication',
      ...detailSection(details.get('security-schemes'), '### Security schemes'),
      ...detailSection(details.get('default-security'), '### Default security')
    );
  }

  index.push('## Tags');
  const tagLines: string[] = [];

  for (const category of categories) {
    const name = tagPageName(category);
    const operations = category.children.length;
    const description = category.description.trim().split('\n')[0] ?? '';
    tagLines.push(
      `- [${category.title.replace(/[[\]\\]/g, '\\$&')}](${encodeURIComponent(name)}.md): ${operations} operation${operations === 1 ? '' : 's'}${description === '' ? '' : `. ${description}`}`
    );

    const page = [`# ${category.title}`];
    if (category.description.trim() !== '') {
      page.push(category.description.trim());
    }
    const scope = category.title === 'Untagged' ? 'without a tag' : `tagged ${category.title}`;
    page.push(`Operations of [${title.replace(/[[\]\\]/g, '\\$&')}](index.md) ${scope}.`);
    for (const operation of category.children) {
      page.push(...renderOperation(operation));
    }
    pages.push({ outputPath: posix.join(directory, `${name}.md`), text: `${page.join('\n\n')}\n` });
  }

  index.push(tagLines.length === 0 ? 'The document declares no operations.' : tagLines.join('\n'));
  pages.unshift({
    outputPath: posix.join(directory, 'index.md'),
    text: `${index.filter((part) => part !== '').join('\n\n')}\n`,
  });
  return pages;
}

// ---------------------------------------------------------------------------
// Selected pages
// ---------------------------------------------------------------------------

function parserWarnings(root: DocNode): string[] {
  const warnings = root.metadata.get('warnings');
  return Array.isArray(warnings)
    ? warnings.filter((warning): warning is string => typeof warning === 'string')
    : [];
}

/** Render a reStructuredText, HTML, or OpenAPI page to Markdown. */
export async function renderSourcePage(page: SelectedPage): Promise<RenderedSource> {
  const path = page.file.absolutePath;

  try {
    switch (page.format) {
      case 'rst':
        return {
          pages: [
            { outputPath: page.outputPath, text: renderDocumentMarkdown(await parseRstFile(path)) },
          ],
          warnings: [],
        };
      case 'html':
        return {
          pages: [
            {
              outputPath: page.outputPath,
              text: renderDocumentMarkdown(await parseHtmlFile(path), { titleFromSections: true }),
            },
          ],
          warnings: [],
        };
      case 'openapi': {
        const root = await parseOpenApiFile(path);
        return {
          pages: renderOpenApiPages(root, posix.dirname(page.outputPath)),
          warnings: parserWarnings(root).map((warning) => `${page.file.sourceLabel}: ${warning}`),
        };
      }
      case 'markdown':
      case 'mdx':
        throw new Error(`${page.file.sourceLabel} is Markdown, not an IR format.`);
    }
  } catch (error) {
    throw new ConfigError(
      `${page.file.sourceLabel} could not be converted (${errorMessage(error)}); exclude it or carry it with "passthrough".`
    );
  }
}
