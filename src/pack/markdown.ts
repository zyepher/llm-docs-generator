/**
 * The source-preserving Markdown, MDX, and DocC page pipeline (spec 4.3 first
 * bullet, 4.4) and the Markdown syntax primitives the rest of the pack code
 * shares: a region scanner that marks code and raw HTML, link-target
 * discovery, and heading anchors.
 *
 * A page is the upstream text kept as written except for deterministic steps,
 * each of which skips fenced code, indented code, and inline code: frontmatter
 * removal (its title and description become an H1 and a first paragraph),
 * the comment-directive tab dialect, DocC directives and cross-references,
 * MDX import/export removal, layout-wrapper unwrapping, the named transforms,
 * then link rewriting through the LinkRewriter seam.
 */

import { parse as parseToml } from 'smol-toml';

import type { ResolvedPackRecipe, TransformName } from '../config/project.js';
import { applyMarkdownDirectives } from '../parsers/markdown/directives/index.js';
import {
  delimiterBalance,
  getMdxDeclarationKind,
  readYamlFrontmatter,
  shouldContinueMdxDeclaration,
  transformDocCBlockDirectives,
  unwrapDocCReferences,
} from '../parsers/markdown/dialects.js';
import { isRecord } from '../utils/guards.js';
import { loadYaml } from '../utils/yaml.js';
import type { ManifestOrigin } from './manifest.js';

// ---------------------------------------------------------------------------
// Region scanner
// ---------------------------------------------------------------------------

export type MarkdownRegionKind = 'text' | 'html' | 'fenced-code' | 'indented-code' | 'code-span';

/** A half-open `[start, end)` range of one kind. Regions are sorted, disjoint, and cover the text. */
export interface MarkdownRegion {
  kind: MarkdownRegionKind;
  start: number;
  end: number;
}

export interface MarkdownSyntaxOptions {
  /**
   * MDX rules: no indented code (indentation is JSX nesting), fences may be
   * indented any amount, and any tag-only line is a JSX flow line.
   */
  mdx?: boolean;
}

const KIND_TEXT = 0;
const KIND_HTML = 1;
const KIND_FENCED = 2;
const KIND_INDENTED = 3;
const KIND_SPAN = 4;

const KIND_NAMES: readonly MarkdownRegionKind[] = [
  'text',
  'html',
  'fenced-code',
  'indented-code',
  'code-span',
];

interface SourceLine {
  start: number;
  /** Offset of the line's end, excluding its newline. */
  end: number;
  text: string;
}

function splitSourceLines(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;

  while (start <= text.length) {
    const newline = text.indexOf('\n', start);
    const end = newline === -1 ? text.length : newline;
    lines.push({ start, end, text: text.slice(start, end) });

    if (newline === -1) {
      break;
    }
    start = newline + 1;
  }

  return lines;
}

interface Cursor {
  index: number;
  column: number;
}

function nextTabStop(column: number): number {
  return column + 4 - (column % 4);
}

/** Columns of whitespace at `cursor` and the cursor after them. */
function measureIndent(text: string, cursor: Cursor): { columns: number; after: Cursor } {
  let { index, column } = cursor;

  while (index < text.length) {
    const char = text[index];
    if (char === ' ') {
      column += 1;
    } else if (char === '\t') {
      column = nextTabStop(column);
    } else {
      break;
    }
    index += 1;
  }

  return { columns: column - cursor.column, after: { index, column } };
}

/** Consume up to `columns` columns of whitespace. */
function consumeIndent(text: string, cursor: Cursor, columns: number): Cursor {
  let { index, column } = cursor;
  const target = cursor.column + columns;

  while (index < text.length && column < target) {
    const char = text[index];
    if (char === ' ') {
      column += 1;
    } else if (char === '\t') {
      column = nextTabStop(column);
    } else {
      break;
    }
    index += 1;
  }

  return { index, column };
}

type Container = { kind: 'quote' } | { kind: 'item'; indent: number };

type Leaf =
  | { kind: 'none' }
  | { kind: 'paragraph' }
  | { kind: 'fenced'; marker: string; length: number; depth: number }
  | { kind: 'indented'; depth: number }
  | { kind: 'html'; end: RegExp | 'blank'; depth: number };

const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const ATX_HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/;
const FENCE_OPENING = /^(`{3,}|~{3,})(.*)$/;

const HTML_BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

const HTML_BLOCK_STARTS: ReadonlyArray<{
  start: RegExp;
  end: RegExp | 'blank';
  interruptsParagraph: boolean;
}> = [
  {
    start: /^<(?:script|pre|style|textarea)(?:\s|>|$)/i,
    end: /<\/(?:script|pre|style|textarea)>/i,
    interruptsParagraph: true,
  },
  { start: /^<!--/, end: /-->/, interruptsParagraph: true },
  { start: /^<\?/, end: /\?>/, interruptsParagraph: true },
  { start: /^<![A-Za-z]/, end: />/, interruptsParagraph: true },
  { start: /^<!\[CDATA\[/, end: /\]\]>/, interruptsParagraph: true },
  {
    start: new RegExp(`^</?(?:${HTML_BLOCK_TAGS})(?:\\s|/?>|$)`, 'i'),
    end: 'blank',
    interruptsParagraph: true,
  },
  {
    start:
      /^(?:<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)\s*$/,
    end: 'blank',
    interruptsParagraph: false,
  },
];

/** CommonMark list item start at `cursor`, or null. */
function matchListItem(
  text: string,
  cursor: Cursor,
  interruptsParagraph: boolean
): { indent: number; after: Cursor } | null {
  const { columns: before, after: markerStart } = measureIndent(text, cursor);

  if (before > 3) {
    return null;
  }

  const rest = text.slice(markerStart.index);

  if (THEMATIC_BREAK.test(rest)) {
    return null;
  }

  const ordered = /^(\d{1,9})[.)]/.exec(rest);
  const bullet = /^[-+*]/.exec(rest);
  const marker = ordered?.[0] ?? bullet?.[0];

  if (marker === undefined) {
    return null;
  }

  const afterMarker = rest.slice(marker.length);
  const empty = afterMarker.trim() === '';

  if (!empty && afterMarker[0] !== ' ' && afterMarker[0] !== '\t') {
    return null;
  }

  if (interruptsParagraph && (empty || (ordered !== null && ordered[1] !== '1'))) {
    return null;
  }

  const markerEnd: Cursor = {
    index: markerStart.index + marker.length,
    column: markerStart.column + marker.length,
  };
  const { columns: spaces } = measureIndent(text, markerEnd);
  const padding = empty || spaces > 4 ? 1 : spaces;
  const indent = before + marker.length + padding;

  return { indent, after: consumeIndent(text, markerEnd, padding) };
}

function matchQuoteMarker(text: string, cursor: Cursor): Cursor | null {
  const { columns, after } = measureIndent(text, cursor);

  if (columns > 3 || text[after.index] !== '>') {
    return null;
  }

  const afterMarker: Cursor = { index: after.index + 1, column: after.column + 1 };
  return text[afterMarker.index] === ' ' || text[afterMarker.index] === '\t'
    ? consumeIndent(text, afterMarker, 1)
    : afterMarker;
}

const MAX_TAG_LENGTH = 16_384;

interface JsxTag {
  start: number;
  /** Offset just past the closing `>`. */
  end: number;
  name: string;
  closing: boolean;
  selfClosing: boolean;
  /** Raw text between the name and the closing `>` (or `/>`). */
  attributes: string;
}

/**
 * Parse an HTML or JSX tag starting at `start` (a `<`). Quoted attribute
 * values and `{...}` expressions are skipped, so a `>` inside them does not
 * end the tag. Returns null when no complete tag starts there.
 */
function scanJsxTag(text: string, start: number): JsxTag | null {
  let index = start + 1;
  const closing = text[index] === '/';

  if (closing) {
    index += 1;
  }

  const nameMatch = /^[A-Za-z][\w.-]*/.exec(text.slice(index, index + 256));

  if (nameMatch === null) {
    return null;
  }

  const name = nameMatch[0];
  index += name.length;

  if (!/^[\s/>]/.test(text.charAt(index))) {
    return null;
  }
  const attributesStart = index;
  const limit = Math.min(text.length, start + MAX_TAG_LENGTH);
  let braceDepth = 0;
  let quote: string | null = null;

  while (index < limit) {
    const char = text[index];

    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else if (char === '\\' && braceDepth > 0) {
        index += 1;
      }
    } else if (char === '"' || char === "'" || (char === '`' && braceDepth > 0)) {
      quote = char;
    } else if (char === '{') {
      braceDepth += 1;
    } else if (char === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
    } else if (braceDepth === 0) {
      if (char === '>') {
        const attributesEnd = text[index - 1] === '/' ? index - 1 : index;
        return {
          start,
          end: index + 1,
          name,
          closing,
          selfClosing: text[index - 1] === '/',
          attributes: text.slice(attributesStart, attributesEnd),
        };
      }
      if (char === '<' || (char === '\n' && text[index + 1] === '\n')) {
        return null;
      }
    }

    index += 1;
  }

  return null;
}

/** The end offset of a run of tags (and whitespace) filling the rest of a line, or -1. */
function tagOnlyLineEnd(text: string, start: number, accept: (tag: JsxTag) => boolean): number {
  let index = start;
  let sawTag = false;

  while (index < text.length) {
    const char = text[index];

    if (char === ' ' || char === '\t') {
      index += 1;
      continue;
    }

    if (char === '\n') {
      return sawTag ? index : -1;
    }

    if (char !== '<') {
      return -1;
    }

    const tag = scanJsxTag(text, index);

    if (tag === null || !accept(tag)) {
      return -1;
    }

    sawTag = true;
    index = tag.end;
  }

  return sawTag ? index : -1;
}

function isCapitalizedTag(tag: JsxTag): boolean {
  return /^[A-Z]/.test(tag.name);
}

/**
 * Mark fenced code, indented code, inline code spans, and raw HTML in
 * Markdown or MDX. A line-oriented block pass tracks blockquote and list
 * containers (so fences inside lists and quotes are found and an unclosed
 * fence ends with its container), then an inline pass finds code spans
 * inside each paragraph (backtick runs of equal length, backslash escapes,
 * inline HTML and autolinks treated as opaque).
 *
 * Lines that hold only capitalized tags (`<Tabs>`, `</TabItem>`) are JSX
 * flow lines in both syntaxes, so Markdown between them (fences included)
 * is still Markdown, as MDX-flavored `.md` files expect.
 */
export function scanMarkdownRegions(
  text: string,
  options: MarkdownSyntaxOptions = {}
): MarkdownRegion[] {
  return regionsFromKinds(scanKinds(text, options));
}

function regionsFromKinds(kinds: Uint8Array): MarkdownRegion[] {
  const regions: MarkdownRegion[] = [];
  let start = 0;

  for (let index = 1; index <= kinds.length; index += 1) {
    if (index === kinds.length || kinds[index] !== kinds[start]) {
      regions.push({ kind: KIND_NAMES[kinds[start] ?? 0] ?? 'text', start, end: index });
      start = index;
    }
  }

  return regions;
}

function isCodeKind(kind: number | undefined): boolean {
  return kind === KIND_FENCED || kind === KIND_INDENTED || kind === KIND_SPAN;
}

/** Per-character region kinds; the internal form every helper here works on. */
function scanKinds(text: string, options: MarkdownSyntaxOptions): Uint8Array {
  const mdx = options.mdx === true;
  const kinds = new Uint8Array(text.length);
  const lines = splitSourceLines(text);
  // Lines of one paragraph share a run id; inline code spans never cross runs.
  const runIds = new Int32Array(lines.length).fill(-1);
  let nextRunId = 0;
  const containers: Container[] = [];
  let leaf: Leaf = { kind: 'none' };

  const markLine = (line: SourceLine, kind: number): void => {
    // The newline belongs to the line's region so whole-line regions stay contiguous.
    kinds.fill(kind, line.start, Math.min(text.length, line.end + 1));
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];

    if (line === undefined) {
      break;
    }

    const content = line.text;
    let cursor: Cursor = { index: 0, column: 0 };
    let matched = 0;

    for (const container of containers) {
      if (container.kind === 'quote') {
        const next = matchQuoteMarker(content, cursor);
        if (next === null) {
          break;
        }
        cursor = next;
      } else {
        const rest = content.slice(cursor.index);
        if (rest.trim() !== '') {
          const { columns } = measureIndent(content, cursor);
          if (columns < container.indent) {
            break;
          }
          cursor = consumeIndent(content, cursor, container.indent);
        }
      }
      matched += 1;
    }

    const allMatched = matched === containers.length;
    let rest = content.slice(cursor.index);
    const blank = rest.trim() === '';

    if (leaf.kind === 'fenced' && allMatched) {
      const { columns, after } = measureIndent(content, cursor);
      const candidate = content.slice(after.index);
      const closing = new RegExp(`^${leaf.marker === '`' ? '`' : '~'}{${leaf.length},}[ \\t]*$`);

      if ((mdx || columns <= 3) && closing.test(candidate)) {
        leaf = { kind: 'none' };
      }
      markLine(line, KIND_FENCED);
      continue;
    }

    if (leaf.kind === 'html' && allMatched) {
      if (leaf.end === 'blank') {
        if (!blank) {
          markLine(line, KIND_HTML);
          continue;
        }
        leaf = { kind: 'none' };
      } else {
        markLine(line, KIND_HTML);
        if (leaf.end.test(rest)) {
          leaf = { kind: 'none' };
        }
        continue;
      }
    }

    // Lazy continuation: a paragraph line may drop its container prefixes.
    if (!allMatched && leaf.kind === 'paragraph' && !blank && !startsBlock(content, cursor, mdx)) {
      markLine(line, KIND_TEXT);
      runIds[lineIndex] = nextRunId - 1;
      continue;
    }

    if (!allMatched) {
      containers.length = matched;
      if (leaf.kind !== 'none' && leaf.kind !== 'paragraph' && leaf.depth > matched) {
        leaf = { kind: 'none' };
      } else if (leaf.kind === 'paragraph') {
        leaf = { kind: 'none' };
      }
    }

    if (leaf.kind === 'fenced' || leaf.kind === 'html') {
      leaf = { kind: 'none' };
    }

    // Open new containers.
    let openedContainer = false;

    while (true) {
      const quote = matchQuoteMarker(content, cursor);

      if (quote !== null) {
        containers.push({ kind: 'quote' });
        cursor = quote;
        openedContainer = true;
        continue;
      }

      const item = matchListItem(content, cursor, leaf.kind === 'paragraph' && !openedContainer);

      if (item !== null) {
        containers.push({ kind: 'item', indent: item.indent });
        cursor = item.after;
        openedContainer = true;
        continue;
      }

      break;
    }

    if (openedContainer && leaf.kind === 'paragraph') {
      leaf = { kind: 'none' };
    }

    rest = content.slice(cursor.index);

    if (rest.trim() === '') {
      if (leaf.kind === 'paragraph') {
        leaf = { kind: 'none' };
      }
      markLine(line, KIND_TEXT);
      continue;
    }

    const { columns: indentColumns, after: contentStart } = measureIndent(content, cursor);
    const trimmedRest = content.slice(contentStart.index);

    if (leaf.kind === 'indented' && indentColumns >= 4) {
      markLine(line, KIND_INDENTED);
      continue;
    }

    if (leaf.kind === 'indented') {
      leaf = { kind: 'none' };
    }

    if (!mdx && indentColumns >= 4 && leaf.kind !== 'paragraph') {
      leaf = { kind: 'indented', depth: containers.length };
      markLine(line, KIND_INDENTED);
      continue;
    }

    const fence = FENCE_OPENING.exec(trimmedRest);

    if (
      fence?.[1] !== undefined &&
      (mdx || indentColumns <= 3) &&
      !(fence[1].startsWith('`') && (fence[2] ?? '').includes('`'))
    ) {
      leaf = {
        kind: 'fenced',
        marker: fence[1].charAt(0),
        length: fence[1].length,
        depth: containers.length,
      };
      markLine(line, KIND_FENCED);
      continue;
    }

    if (indentColumns <= 3 || mdx) {
      const lineOffset = line.start + contentStart.index;

      // JSX flow lines: only tags on the line (capitalized ones in Markdown, any in MDX).
      if (trimmedRest.startsWith('<') && !trimmedRest.startsWith('<!')) {
        const end = tagOnlyLineEnd(text, lineOffset, (tag) => mdx || isCapitalizedTag(tag));

        if (end !== -1) {
          let lastLine = lineIndex;
          while ((lines[lastLine]?.end ?? text.length) < end) {
            lastLine += 1;
          }
          for (let index = lineIndex; index <= lastLine; index += 1) {
            const covered = lines[index];
            if (covered !== undefined) {
              markLine(covered, KIND_HTML);
            }
          }
          lineIndex = lastLine;
          leaf = { kind: 'none' };
          continue;
        }
      }

      if (indentColumns <= 3) {
        const html = HTML_BLOCK_STARTS.find(
          (candidate, index) =>
            (!mdx || index < 5) &&
            (candidate.interruptsParagraph || leaf.kind !== 'paragraph') &&
            candidate.start.test(trimmedRest)
        );

        if (html !== undefined) {
          markLine(line, KIND_HTML);
          const endsHere = html.end !== 'blank' && html.end.test(trimmedRest.slice(2));
          leaf = endsHere
            ? { kind: 'none' }
            : { kind: 'html', end: html.end, depth: containers.length };
          continue;
        }
      }
    }

    markLine(line, KIND_TEXT);

    const continuesParagraph = leaf.kind === 'paragraph' && !openedContainer;

    if (continuesParagraph && SETEXT_UNDERLINE.test(rest)) {
      runIds[lineIndex] = nextRunId++;
      leaf = { kind: 'none' };
      continue;
    }

    if (continuesParagraph && !startsBlock(content, cursor, mdx)) {
      runIds[lineIndex] = nextRunId - 1;
      continue;
    }

    runIds[lineIndex] = nextRunId++;
    const singleLine = ATX_HEADING.test(rest) || THEMATIC_BREAK.test(rest) || /^\s*\|/.test(rest);
    leaf = singleLine ? { kind: 'none' } : { kind: 'paragraph' };
  }

  markInlineSpans(text, kinds, lines, runIds);
  return kinds;
}

/** True when the line at `cursor` starts a block that can interrupt a paragraph. */
function startsBlock(content: string, cursor: Cursor, mdx: boolean): boolean {
  const { columns, after } = measureIndent(content, cursor);
  const rest = content.slice(after.index);

  if (columns > 3 && !mdx) {
    return false;
  }

  return (
    ATX_HEADING.test(rest) ||
    THEMATIC_BREAK.test(rest) ||
    FENCE_OPENING.test(rest) ||
    rest.startsWith('>') ||
    matchListItem(content, cursor, true) !== null ||
    HTML_BLOCK_STARTS.some(
      (candidate) => candidate.interruptsParagraph && candidate.start.test(rest)
    )
  );
}

const AUTOLINK = /^<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*>/;
const EMAIL_AUTOLINK =
  /^<[\w.!#$%&'*+/=?^`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9-]+)*>/;

/** Mark code spans inside each paragraph run of text lines. */
function markInlineSpans(
  text: string,
  kinds: Uint8Array,
  lines: readonly SourceLine[],
  runIds: Int32Array
): void {
  let index = 0;

  while (index < lines.length) {
    const runId = runIds[index] ?? -1;
    const first = lines[index];

    if (runId === -1 || first === undefined) {
      index += 1;
      continue;
    }

    let last = index;
    while (last + 1 < lines.length && runIds[last + 1] === runId) {
      last += 1;
    }

    const runEnd = lines[last]?.end ?? text.length;
    scanInlineRun(text, kinds, first.start, runEnd);
    index = last + 1;
  }
}

function scanInlineRun(text: string, kinds: Uint8Array, start: number, end: number): void {
  let index = start;

  while (index < end) {
    const char = text[index];

    if (kinds[index] !== KIND_TEXT) {
      index += 1;
      continue;
    }

    if (char === '\\') {
      index += 2;
      continue;
    }

    if (char === '`') {
      let runEnd = index;
      while (runEnd < end && text[runEnd] === '`') {
        runEnd += 1;
      }
      const length = runEnd - index;
      const closing = findBacktickRun(text, runEnd, end, length);

      if (closing === -1) {
        index = runEnd;
        continue;
      }

      kinds.fill(KIND_SPAN, index, closing + length);
      index = closing + length;
      continue;
    }

    if (char === '<') {
      const opaqueEnd = inlineHtmlEnd(text, index, end);
      if (opaqueEnd !== -1) {
        index = opaqueEnd;
        continue;
      }
    }

    index += 1;
  }
}

function findBacktickRun(text: string, from: number, end: number, length: number): number {
  let index = from;

  while (index < end) {
    const next = text.indexOf('`', index);

    if (next === -1 || next >= end) {
      return -1;
    }

    let runEnd = next;
    while (runEnd < end && text[runEnd] === '`') {
      runEnd += 1;
    }

    if (runEnd - next === length) {
      return next;
    }

    index = runEnd;
  }

  return -1;
}

/** End offset of inline raw HTML, a comment, or an autolink at `index`, or -1. */
function inlineHtmlEnd(text: string, index: number, end: number): number {
  if (text.startsWith('<!--', index)) {
    const close = text.indexOf('-->', index + 4);
    return close !== -1 && close + 3 <= end ? close + 3 : -1;
  }

  const slice = text.slice(index, Math.min(end, index + 2048));
  const autolink = AUTOLINK.exec(slice) ?? EMAIL_AUTOLINK.exec(slice);

  if (autolink !== null) {
    return index + autolink[0].length;
  }

  const tag = scanJsxTag(text, index);
  return tag !== null && tag.end <= end ? tag.end : -1;
}

// ---------------------------------------------------------------------------
// Shared helpers over regions
// ---------------------------------------------------------------------------

/**
 * Apply `transform` to every maximal stretch of text outside code (text and
 * raw HTML), leaving fenced code, indented code, and code spans untouched.
 */
function mapOutsideCode(
  text: string,
  options: MarkdownSyntaxOptions,
  transform: (segment: string) => string
): string {
  const kinds = scanKinds(text, options);
  let output = '';
  let index = 0;

  while (index < text.length) {
    let end = index;
    const code = isCodeKind(kinds[index]);

    while (end < text.length && isCodeKind(kinds[end]) === code) {
      end += 1;
    }

    const segment = text.slice(index, end);
    output += code ? segment : transform(segment);
    index = end;
  }

  return output;
}

export type LinkTargetKind =
  'inline' | 'image' | 'reference-definition' | 'autolink' | 'html-attribute';

/** A half-open `[start, end)` range of the text. */
export interface TextRange {
  start: number;
  end: number;
}

/** One link destination in a page; `start`/`end` delimit `target` in the text. */
export interface LinkTarget {
  kind: LinkTargetKind;
  target: string;
  start: number;
  end: number;
  /**
   * The whole construct: `[label](target "title")`, `![alt](target)`, a
   * definition from its `[` through its destination, `<url>`, or one HTML
   * attribute `name="value"`.
   */
  span: TextRange;
  /**
   * The link text, image alt, or definition label (inside the brackets); the
   * attribute name for an HTML attribute; the target itself for an autolink.
   */
  label: TextRange;
}

/**
 * Every link destination outside code: inline links and images, reference
 * definitions, autolinks, and `href`/`src` attributes of lowercase (HTML)
 * tags. Capitalized JSX component props are not links. Verify's `links`
 * check reads exactly this set, so Phase 2b's rewriter must rewrite through
 * it too (the two must never disagree about what a link is).
 */
export function findLinkTargets(text: string, options: MarkdownSyntaxOptions = {}): LinkTarget[] {
  const kinds = scanKinds(text, options);
  const targets: LinkTarget[] = [];
  let index = 0;

  while (index < text.length) {
    const kind = kinds[index];

    if (isCodeKind(kind)) {
      index += 1;
      continue;
    }

    const char = text[index];

    if (kind === KIND_TEXT && char === '\\') {
      index += 2;
      continue;
    }

    if (kind === KIND_TEXT && (char === '[' || (char === '!' && text[index + 1] === '['))) {
      const link = matchInlineLink(text, kinds, index);

      if (link !== null) {
        targets.push(link);
      }

      index += char === '!' ? 2 : 1;
      continue;
    }

    if (char === '<' && text.startsWith('<!--', index)) {
      const close = text.indexOf('-->', index + 4);
      index = close === -1 ? text.length : close + 3;
      continue;
    }

    if (char === '<') {
      const slice = text.slice(index, index + 2048);
      const autolink = kind === KIND_TEXT ? AUTOLINK.exec(slice) : null;

      if (autolink !== null) {
        const start = index + 1;
        const end = index + autolink[0].length - 1;
        targets.push({
          kind: 'autolink',
          target: autolink[0].slice(1, -1),
          start,
          end,
          span: { start: index, end: end + 1 },
          label: { start, end },
        });
        index += autolink[0].length;
        continue;
      }

      const tag = scanJsxTag(text, index);

      if (tag !== null) {
        if (!tag.closing && /^[a-z]/.test(tag.name)) {
          targets.push(...htmlAttributeTargets(tag));
        }
        index = tag.end;
        continue;
      }
    }

    index += 1;
  }

  targets.push(...referenceDefinitionTargets(text, kinds));
  return targets.sort((a, b) => a.start - b.start);
}

function htmlAttributeTargets(tag: JsxTag): LinkTarget[] {
  const targets: LinkTarget[] = [];
  const attributesOffset = tag.end - (tag.selfClosing ? 2 : 1) - tag.attributes.length;
  const pattern = /(?:^|\s)(href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`{]+))/gi;

  for (const match of tag.attributes.matchAll(pattern)) {
    const value = match[2] ?? match[3] ?? match[4];

    if (value === undefined) {
      continue;
    }

    const name = match[1] ?? '';
    const quoted = match[4] === undefined ? 1 : 0;
    const valueOffset = match.index + match[0].length - value.length - quoted;
    const start = attributesOffset + valueOffset;
    const nameStart = attributesOffset + match.index + match[0].indexOf(name);
    targets.push({
      kind: 'html-attribute',
      target: value,
      start,
      end: start + value.length,
      span: { start: nameStart, end: start + value.length + quoted },
      label: { start: nameStart, end: nameStart + name.length },
    });
  }

  return targets;
}

/** Index of the `]` closing a bracket opened before `from`, within one paragraph, or -1. */
function findClosingBracket(text: string, kinds: Uint8Array, from: number): number {
  let depth = 0;
  let index = from;

  while (index < text.length) {
    const kind = kinds[index];

    if (kind === KIND_FENCED || kind === KIND_INDENTED) {
      return -1;
    }

    if (kind === KIND_SPAN) {
      index += 1;
      continue;
    }

    const char = text[index];

    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === '\n' && /^\n[ \t]*\n/.test(text.slice(index, index + 64))) {
      return -1;
    }
    if (char === '[') {
      depth += 1;
    } else if (char === ']') {
      if (depth === 0) {
        return index;
      }
      depth -= 1;
    }
    index += 1;
  }

  return -1;
}

/** An inline link or image at `start` (`[` or `![`) whose destination follows `](`. */
function matchInlineLink(text: string, kinds: Uint8Array, start: number): LinkTarget | null {
  const image = text[start] === '!';
  const open = image ? start + 1 : start;
  const close = findClosingBracket(text, kinds, open + 1);

  if (close === -1 || text[close + 1] !== '(') {
    return null;
  }

  const destination = parseInlineDestination(text, close + 1);
  return destination === null
    ? null
    : {
        kind: image ? 'image' : 'inline',
        target: text.slice(destination.start, destination.end),
        start: destination.start,
        end: destination.end,
        span: { start, end: destination.close + 1 },
        label: { start: open + 1, end: close },
      };
}

/**
 * CommonMark inline destination after `(` at `open`: `<...>` or a balanced
 * run, then an optional title and `)` (at `close`).
 */
function parseInlineDestination(
  text: string,
  open: number
): { start: number; end: number; close: number } | null {
  let index = open + 1;
  const skipSpace = (): void => {
    let newlines = 0;
    while (index < text.length && /[ \t\n]/.test(text[index] ?? '')) {
      if (text[index] === '\n' && ++newlines > 1) {
        return;
      }
      index += 1;
    }
  };

  skipSpace();
  let start: number;
  let end: number;

  if (text[index] === '<') {
    start = index + 1;
    end = start;
    while (end < text.length && text[end] !== '>' && text[end] !== '\n' && text[end] !== '<') {
      end += text[end] === '\\' ? 2 : 1;
    }
    if (text[end] !== '>') {
      return null;
    }
    index = end + 1;
  } else {
    start = index;
    let depth = 0;
    while (index < text.length) {
      const char = text[index] ?? '';
      if (char === '\\') {
        index += 2;
        continue;
      }
      if (/[\s\p{Cc}]/u.test(char)) {
        break;
      }
      if (char === '(') {
        depth += 1;
      } else if (char === ')') {
        if (depth === 0) {
          break;
        }
        depth -= 1;
      }
      index += 1;
    }
    end = index;
  }

  skipSpace();
  const titleOpen = text[index];

  if (titleOpen === '"' || titleOpen === "'" || titleOpen === '(') {
    const titleClose = titleOpen === '(' ? ')' : titleOpen;
    index += 1;
    while (index < text.length && text[index] !== titleClose) {
      if (text[index] === '\n' && text[index + 1] === '\n') {
        return null;
      }
      index += text[index] === '\\' ? 2 : 1;
    }
    if (text[index] !== titleClose) {
      return null;
    }
    index += 1;
    skipSpace();
  }

  return text[index] === ')' ? { start, end, close: index } : null;
}

const REFERENCE_DEFINITION =
  /^((?:[ \t]*>)*[ \t]*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)?\[(?:[^\]\\\n]|\\.){1,999}\]:[ \t]*)(?:<([^>\n]*)>|(\S+))/gm;

function referenceDefinitionTargets(text: string, kinds: Uint8Array): LinkTarget[] {
  const targets: LinkTarget[] = [];

  for (const match of text.matchAll(REFERENCE_DEFINITION)) {
    if (kinds[match.index] !== KIND_TEXT || isCodeKind(kinds[match.index + match[0].length - 1])) {
      continue;
    }

    const prefix = match[1] ?? '';
    const value = match[2] ?? match[3] ?? '';
    const angled = match[2] === undefined ? 0 : 1;
    const start = match.index + prefix.length + angled;
    const open = match.index + prefix.indexOf('[');
    targets.push({
      kind: 'reference-definition',
      target: value,
      start,
      end: start + value.length,
      span: { start: open, end: start + value.length + angled },
      label: { start: open + 1, end: match.index + prefix.lastIndexOf(']:') },
    });
  }

  return targets;
}

export interface MarkdownHeading {
  level: number;
  text: string;
  /** Offset of the start of the heading's (first) line. */
  offset: number;
}

/** ATX headings and single-line setext headings outside code, in document order. */
export function collectHeadings(
  text: string,
  options: MarkdownSyntaxOptions = {}
): MarkdownHeading[] {
  const kinds = scanKinds(text, options);
  const lines = splitSourceLines(text);
  const headings: MarkdownHeading[] = [];

  for (const [index, line] of lines.entries()) {
    if (kinds[line.start] !== KIND_TEXT || line.text.trim() === '') {
      continue;
    }

    const stripped = line.text.replace(/^(?:[ \t]*>)*/, '');
    const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(stripped);

    if (atx?.[1] !== undefined) {
      headings.push({ level: atx[1].length, text: (atx[2] ?? '').trim(), offset: line.start });
      continue;
    }

    const next = lines[index + 1];
    const previous = lines[index - 1];

    if (
      next !== undefined &&
      kinds[next.start] === KIND_TEXT &&
      /^ {0,3}(?:=+|-+)[ \t]*$/.test(next.text) &&
      (previous === undefined || previous.text.trim() === '') &&
      !/^ {0,3}(?:[-*+>|]|\d+[.)])/.test(line.text)
    ) {
      headings.push({
        level: next.text.trim().startsWith('=') ? 1 : 2,
        text: line.text.trim(),
        offset: line.start,
      });
    }
  }

  return headings;
}

/**
 * GitHub's heading slug: lowercase, punctuation dropped (not hyphenated),
 * each space a hyphen, Unicode letters, digits, and marks kept. Upstream
 * docs write their fragment links against this rule, so `### \`Client.close([callback])\``
 * is `#clientclosecallback`.
 */
function githubHeadingSlug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** Each heading with its GitHub anchor (`-1`, `-2` suffixes for duplicates), in document order. */
export function headingSlugs(
  text: string,
  options: MarkdownSyntaxOptions = {}
): (MarkdownHeading & { slug: string })[] {
  const counts = new Map<string, number>();

  return collectHeadings(text, options).map((heading) => {
    const plain = heading.text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
    const base = githubHeadingSlug(plain);
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    return { ...heading, slug: seen === 0 ? base : `${base}-${seen}` };
  });
}

/**
 * Fragment anchors a page defines: GitHub heading slugs with `-1`, `-2`
 * suffixes for duplicates, plus HTML `id`/`name` attributes. Used by
 * `verify --strict`; Phase 5 resolves citations with it.
 */
export function headingAnchors(text: string, options: MarkdownSyntaxOptions = {}): Set<string> {
  const anchors = new Set(headingSlugs(text, options).map((heading) => heading.slug));

  for (const match of text.matchAll(/<[a-z][\w-]*\s[^>]*?\b(?:id|name)\s*=\s*["']([^"']+)["']/gi)) {
    if (match[1] !== undefined) {
      anchors.add(match[1]);
    }
  }

  return anchors;
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

interface Frontmatter {
  title: string | null;
  description: string | null;
  body: string;
}

function frontmatterString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];

  if (typeof value === 'string' && value.trim() !== '') {
    return value.trim();
  }

  return typeof value === 'number' || typeof value === 'boolean' ? String(value) : null;
}

/** Remove YAML (`---`) or TOML (`+++`) frontmatter and read its title and description. */
function splitFrontmatter(text: string): Frontmatter {
  const yaml = readYamlFrontmatter(text);

  if (yaml !== null) {
    let parsed: unknown;
    try {
      parsed = loadYaml(yaml.frontmatter);
    } catch {
      parsed = null;
    }
    const record = isRecord(parsed) ? parsed : {};
    return {
      title: frontmatterString(record, 'title'),
      description: frontmatterString(record, 'description'),
      body: yaml.contentAfter,
    };
  }

  const lines = text.split('\n');

  if (lines[0]?.trim() === '+++') {
    const close = lines.findIndex((line, index) => index > 0 && line.trim() === '+++');

    if (close !== -1) {
      try {
        const record = parseToml(lines.slice(1, close).join('\n'));
        return {
          title: frontmatterString(record, 'title'),
          description: frontmatterString(record, 'description'),
          body: lines.slice(close + 1).join('\n'),
        };
      } catch {
        // Not TOML: the `+++` lines are document content.
      }
    }
  }

  return { title: null, description: null, body: text };
}

// ---------------------------------------------------------------------------
// MDX / JSX layout wrappers and ESM
// ---------------------------------------------------------------------------

/** Layout wrappers unwrapped to their children (spec 4.3). */
const LAYOUT_WRAPPERS: ReadonlySet<string> = new Set([
  'Tabs',
  'Tab',
  'TabItem',
  'Steps',
  'Step',
  'Callout',
  'Note',
  'Tip',
  'Warning',
  'Info',
  'Card',
  'CardGroup',
  'Accordion',
  'AccordionGroup',
  'CodeGroup',
  'Frame',
  'Details',
]);

/** Wrappers whose `title`/`label` prop becomes a bold line. */
const LABELED_WRAPPERS: ReadonlySet<string> = new Set([
  'Tab',
  'TabItem',
  'Accordion',
  'Card',
  'Step',
]);

/** `Tabs.Tab` is a `Tab`: the last dotted segment names the component. */
function componentBaseName(name: string): string {
  return name.slice(name.lastIndexOf('.') + 1);
}

/** A string-literal prop value (`title="x"`, `title='x'`, `title={"x"}`), single-line and safe. */
function stringProp(attributes: string, name: string): string | undefined {
  const pattern = new RegExp(
    `(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|\\{\\s*(?:"([^"]*)"|'([^']*)'|\`([^\`$]*)\`)\\s*\\})`
  );
  const match = pattern.exec(attributes);
  const value = (match?.[1] ?? match?.[2] ?? match?.[3] ?? match?.[4] ?? match?.[5])
    ?.replace(/\s+/g, ' ')
    .trim();

  return value === undefined || value === '' || /[<>{}]/.test(value) ? undefined : value;
}

/** A Markdown link destination for `url`, angle-bracketed when it holds spaces or parentheses. */
function linkDestination(url: string): string {
  return /[\s()]/.test(url) ? `<${url}>` : url;
}

/**
 * The bold line a labeled wrapper becomes: its `title` (or `label`) prop, and
 * for a `Card` with an `href`, that title as a link (the href alone when the
 * card has no title).
 */
function wrapperLabel(base: string, attributes: string): string | undefined {
  if (!LABELED_WRAPPERS.has(base)) {
    return undefined;
  }

  const title = stringProp(attributes, 'title') ?? stringProp(attributes, 'label');
  const href = base === 'Card' ? stringProp(attributes, 'href') : undefined;

  if (href === undefined) {
    return title === undefined ? undefined : `**${title}**`;
  }

  const text = (title ?? href).replace(/[[\]\\]/g, '\\$&');
  return `**[${text}](${linkDestination(href)})**`;
}

interface WrapperFrame {
  name: string;
  tagIndent: number;
  bodyIndent: number | null;
}

function leadingWhitespace(line: string): number {
  return line.length - line.trimStart().length;
}

interface MdxUnwrapResult {
  text: string;
  /** Capitalized components left as written, by name, counted per opening tag. */
  unknownComponents: Map<string, number>;
}

/**
 * Unwrap the known layout wrappers (keeping their children, dedented by the
 * nesting they added), turn `title`/`label` of Tab, TabItem, Accordion, Card,
 * and Step into a bold line (a Card `href` makes it a link), leave every other capitalized component as written
 * (counted), and, for MDX, remove top-level `import`/`export` declarations.
 * Code is never touched.
 */
function unwrapMdxComponents(text: string, options: MarkdownSyntaxOptions): MdxUnwrapResult {
  const mdx = options.mdx === true;
  const kinds = scanKinds(text, options);
  const lines = splitSourceLines(text);
  const out: string[] = [];
  const frames: WrapperFrame[] = [];
  const unknownComponents = new Map<string, number>();
  let componentDepth = 0;
  // Set when lines were removed or synthesized since the last content line, so
  // the blank lines around them collapse to one.
  let edited = false;
  let previousRemoved = true;

  const stripWidth = (): number =>
    frames.reduce(
      (sum, frame) =>
        frame.bodyIndent === null ? sum : sum + Math.max(0, frame.bodyIndent - frame.tagIndent),
      0
    );
  const noteBodyLine = (line: string): void => {
    if (line.trim() === '') {
      return;
    }
    for (const frame of frames) {
      if (frame.bodyIndent === null) {
        frame.bodyIndent = leadingWhitespace(line);
      }
    }
  };
  const dedent = (line: string): string => {
    const width = Math.min(stripWidth(), leadingWhitespace(line));
    return line.slice(width);
  };
  const push = (line: string): void => {
    if (line.trim() === '') {
      if (out.length === 0 || (edited && out.at(-1)?.trim() === '')) {
        return;
      }
      out.push('');
      return;
    }
    edited = false;
    out.push(line);
  };
  const pushLabel = (indent: string, label: string): void => {
    if (out.length > 0 && out.at(-1)?.trim() !== '') {
      out.push('');
    }
    out.push(`${indent}${label}`);
    out.push('');
    edited = true;
  };

  let lineIndex = 0;

  while (lineIndex < lines.length) {
    const line = lines[lineIndex];

    if (line === undefined) {
      break;
    }

    const kind = kinds[line.start];

    if (kind === KIND_FENCED || kind === KIND_INDENTED) {
      noteBodyLine(line.text);
      push(dedent(line.text));
      previousRemoved = false;
      lineIndex += 1;
      continue;
    }

    // Top-level MDX ESM: column 0, outside every component, starting a block.
    const declarationKind =
      mdx && componentDepth === 0 && /^(?:import|export)\s/.test(line.text)
        ? getMdxDeclarationKind(line.text.trim())
        : null;

    if (declarationKind !== null && (previousRemoved || out.at(-1)?.trim() === '')) {
      const first = delimiterBalance(line.text.trim(), null);
      let balance = first.balance;
      let quote = first.quote;
      lineIndex += 1;

      if (shouldContinueMdxDeclaration(line.text.trim(), declarationKind, balance)) {
        while (lineIndex < lines.length) {
          const next = delimiterBalance(lines[lineIndex]?.text ?? '', quote);
          balance += next.balance;
          quote = next.quote;
          lineIndex += 1;
          if (balance <= 0 && quote === null) {
            break;
          }
        }
      }

      edited = true;
      previousRemoved = true;
      continue;
    }

    // Capitalized tags starting on this line, outside code spans.
    const tags: JsxTag[] = [];
    let scan = line.start;

    while (scan < line.end) {
      const open = text.indexOf('<', scan);

      if (open === -1 || open >= line.end) {
        break;
      }

      const tag = isCodeKind(kinds[open]) ? null : scanJsxTag(text, open);

      if (tag === null || !isCapitalizedTag(tag)) {
        scan = open + 1;
        continue;
      }

      tags.push(tag);
      // Later tags on the same (or a continued) line are found from the tag's end.
      scan = tag.end;

      while (scan < text.length && text[scan] !== '\n') {
        const nextOpen = text.indexOf('<', scan);
        const lineBreak = text.indexOf('\n', scan);
        const stop = lineBreak === -1 ? text.length : lineBreak;

        if (nextOpen === -1 || nextOpen >= stop) {
          scan = stop;
          break;
        }

        const nextTag = isCodeKind(kinds[nextOpen]) ? null : scanJsxTag(text, nextOpen);

        if (nextTag !== null && isCapitalizedTag(nextTag)) {
          tags.push(nextTag);
          scan = nextTag.end;
        } else {
          scan = nextOpen + 1;
        }
      }
      break;
    }

    if (tags.length === 0) {
      noteBodyLine(line.text);
      push(dedent(line.text));
      previousRemoved = false;
      lineIndex += 1;
      continue;
    }

    const lastTag = tags.at(-1);
    let lastLineIndex = lineIndex;
    while ((lines[lastLineIndex]?.end ?? text.length) < (lastTag?.end ?? 0)) {
      lastLineIndex += 1;
    }

    const lastLine = lines[lastLineIndex] ?? line;
    // Text pieces of the rewritten line, with labels standing where their tags were.
    const pieces: (string | { label: string })[] = [];
    const labels: string[] = [];
    let cursor = line.start;
    let unwrappedAny = false;

    // The tag line itself is body content of every frame already open.
    noteBodyLine(line.text);
    const indent = ' '.repeat(Math.max(0, leadingWhitespace(line.text) - stripWidth()));

    for (const tag of tags) {
      pieces.push(text.slice(cursor, tag.start));
      cursor = tag.end;
      const base = componentBaseName(tag.name);

      if (!LAYOUT_WRAPPERS.has(base)) {
        pieces.push(text.slice(tag.start, tag.end));
        if (!tag.closing) {
          unknownComponents.set(tag.name, (unknownComponents.get(tag.name) ?? 0) + 1);
        }
        if (!tag.selfClosing) {
          componentDepth = Math.max(0, componentDepth + (tag.closing ? -1 : 1));
        }
        continue;
      }

      unwrappedAny = true;

      if (tag.closing) {
        const frameIndex = frames.map((frame) => frame.name).lastIndexOf(tag.name);
        if (frameIndex !== -1) {
          frames.splice(frameIndex);
        }
        componentDepth = Math.max(0, componentDepth - 1);
        continue;
      }

      const label = wrapperLabel(base, tag.attributes);

      if (label !== undefined) {
        labels.push(label);
        pieces.push({ label });
      }

      if (!tag.selfClosing) {
        frames.push({
          name: tag.name,
          tagIndent: leadingWhitespace(line.text),
          bodyIndent: null,
        });
        componentDepth += 1;
      }
    }

    pieces.push(text.slice(cursor, lastLine.end));
    lineIndex = lastLineIndex + 1;
    const plain = pieces.map((piece) => (typeof piece === 'string' ? piece : '')).join('');

    if (!unwrappedAny) {
      for (const kept of plain.split('\n')) {
        push(kept);
      }
      previousRemoved = false;
      continue;
    }

    if (plain.trim() === '') {
      // The line held only wrapper tags: drop it, keeping any labels.
      if (labels.length === 0) {
        edited = true;
      }
      for (const label of labels) {
        pushLabel(indent, label);
      }
      previousRemoved = true;
      continue;
    }

    const inline = pieces
      .map((piece) => (typeof piece === 'string' ? piece : `${piece.label} `))
      .join('');
    for (const kept of inline.split('\n')) {
      push(dedent(kept));
    }
    previousRemoved = false;
  }

  while (out.at(-1)?.trim() === '') {
    out.pop();
  }

  return { text: out.join('\n'), unknownComponents };
}

// ---------------------------------------------------------------------------
// Transforms (spec 4.4)
// ---------------------------------------------------------------------------

/** The page body during conversion, before the frontmatter title and description are placed. */
interface PageDraft {
  body: string;
  description: string | null;
  mdx: boolean;
}

/** Returns whether it changed the page. */
type PageTransform = (draft: PageDraft) => boolean;

const MINTLIFY_BANNER =
  /^(?:[ \t]*\n)*> ## Documentation Index\n> Fetch the complete documentation index at: [^\n]*\n> Use this file to discover all available pages before exploring further\.\n(?:[ \t]*\n)?/;

const HTML_COMMENT_LINE = /^[ \t]*<!--(?:(?!-->)[\s\S])*-->[ \t]*(?:\n|$)/gm;
const HTML_COMMENT = /<!--(?:(?!-->)[\s\S])*-->/g;

/** Every named transform; `TransformName` (src/config/project.ts) keeps this exhaustive. */
const PAGE_TRANSFORMS: Readonly<Record<TransformName, PageTransform>> = {
  'strip-mintlify-banner': (draft) => {
    const stripped = draft.body.replace(MINTLIFY_BANNER, '');
    const changed = stripped !== draft.body;
    draft.body = stripped;
    return changed;
  },
  'strip-html-comments': (draft) => {
    let changed = false;
    draft.body = mapOutsideCode(draft.body, { mdx: draft.mdx }, (segment) => {
      const stripped = segment.replace(HTML_COMMENT_LINE, '').replace(HTML_COMMENT, '');
      if (stripped === segment) {
        return segment;
      }
      changed = true;
      return stripped.replace(/\n{3,}/g, '\n\n');
    });
    return changed;
  },
  'drop-frontmatter-description': (draft) => {
    const changed = draft.description !== null;
    draft.description = null;
    return changed;
  },
};

// ---------------------------------------------------------------------------
// Link rewriting seam (spec 4.5; the rewriter is src/pack/links.ts)
// ---------------------------------------------------------------------------

/** A page or passthrough file of the pack being built. */
export interface PackFileRef {
  sourceIndex: number;
  /** Origin-relative POSIX path of the upstream file. */
  sourcePath: string;
  /** Pack-relative POSIX output path. */
  outputPath: string;
  /** Upstream URL of the file (repository blob URL, fetched URL); absent for local files. */
  url?: string | undefined;
  /** Project-relative POSIX path, for files of local sources. */
  localPath?: string | undefined;
}

/** Everything a rewriter may consult: the recipe (site, aliases), origins, and every output. */
export interface PackLinkContext {
  recipe: ResolvedPackRecipe;
  origins: readonly ManifestOrigin[];
  pages: readonly PackFileRef[];
  passthrough: readonly PackFileRef[];
  /**
   * Per source index: every origin-relative file path present at the origin,
   * selected or not, when the acquirer can list them. A link to an excluded
   * page then goes upstream (or is reported as such) instead of being dead.
   */
  inventories?: readonly (readonly string[] | undefined)[];
}

export interface LinkRewriteInput extends PackFileRef {
  text: string;
  mdx: boolean;
}

export interface LinkRewriteResult {
  text: string;
  rewritten: number;
  external: number;
  /** Targets left unresolved (never relative paths, spec 4.5 step 5). */
  unresolved: { target: string; reason: string }[];
  /** Dead local links converted to plain text; reported as one manifest warning. */
  plainTextConversions: number;
}

export type LinkRewriter = (page: LinkRewriteInput) => LinkRewriteResult;

// ---------------------------------------------------------------------------
// The page pipeline
// ---------------------------------------------------------------------------

export interface MarkdownPageInput {
  /** Upstream text (any line endings, optional BOM). */
  text: string;
  syntax: 'markdown' | 'mdx';
  sourceIndex: number;
  /** Origin-relative POSIX path, the title fallback. */
  sourcePath: string;
  /** Pack-relative POSIX output path. */
  outputPath: string;
  transforms: readonly TransformName[];
  /** `id@version` and the `source:` value of the provenance line. */
  provenance: { packId: string; version: string; source: string };
  rewriteLinks: LinkRewriter;
}

export interface MarkdownPageResult {
  /** The page bytes as written: provenance line, blank line, content, one trailing newline. */
  text: string;
  title: string;
  /** Transforms that changed this page. */
  changedBy: TransformName[];
  unknownComponents: Map<string, number>;
  links: Omit<LinkRewriteResult, 'text'>;
}

/** Make text safe inside a single-line HTML comment. */
function commentSafe(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/-->/g, '--&gt;');
}

function provenanceLine(packId: string, version: string, source: string): string {
  return `<!-- llm-docs: ${commentSafe(`${packId}@${version}`)} | source: ${commentSafe(source)} -->`;
}

function singleLine(value: string): string {
  return value
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fileTitle(sourcePath: string): string {
  const name = sourcePath.slice(sourcePath.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Insert the frontmatter title (when no H1 exists) and description at the top of the body. */
function placeFrontmatter(
  body: string,
  title: string | null,
  description: string | null,
  mdx: boolean
): string {
  const hasH1 = collectHeadings(body, { mdx }).some((heading) => heading.level === 1);
  let head = '';
  let rest = body.replace(/^(?:[ \t]*\n)+/, '');

  if (title !== null && !hasH1) {
    head = `# ${singleLine(title)}`;
  } else if (description !== null && /^ {0,3}# /.test(rest)) {
    const newline = rest.indexOf('\n');
    head = newline === -1 ? rest : rest.slice(0, newline);
    rest = newline === -1 ? '' : rest.slice(newline + 1).replace(/^(?:[ \t]*\n)+/, '');
  }

  const parts = [head, description?.trim() ?? '', rest].filter((part) => part !== '');
  return parts.join('\n\n');
}

/** Convert one Markdown or MDX file into its page (spec 4.3, 4.4). */
export function convertMarkdownPage(input: MarkdownPageInput): MarkdownPageResult {
  const mdx = input.syntax === 'mdx';
  const normalized = input.text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const frontmatter = splitFrontmatter(normalized);
  let body = applyMarkdownDirectives(frontmatter.body);
  body = transformDocCBlockDirectives(body);
  const unwrapped = unwrapMdxComponents(body, { mdx });
  body = mapOutsideCode(unwrapped.text, { mdx }, unwrapDocCReferences);

  const draft: PageDraft = { body, description: frontmatter.description, mdx };
  const changedBy: TransformName[] = [];

  for (const name of input.transforms) {
    if (PAGE_TRANSFORMS[name](draft)) {
      changedBy.push(name);
    }
  }

  body = placeFrontmatter(draft.body, frontmatter.title, draft.description, mdx).replace(
    /\s+$/,
    ''
  );

  const rewritten = input.rewriteLinks({
    text: body,
    mdx,
    sourceIndex: input.sourceIndex,
    sourcePath: input.sourcePath,
    outputPath: input.outputPath,
  });
  body = rewritten.text;

  const h1 = collectHeadings(body, { mdx }).find((heading) => heading.level === 1);
  const title =
    (h1 !== undefined && h1.text !== '' ? h1.text : null) ??
    (frontmatter.title === null ? null : singleLine(frontmatter.title)) ??
    fileTitle(input.sourcePath);
  const header = provenanceLine(
    input.provenance.packId,
    input.provenance.version,
    input.provenance.source
  );
  return {
    text: body === '' ? `${header}\n` : `${header}\n\n${body}\n`,
    title,
    changedBy,
    unknownComponents: unwrapped.unknownComponents,
    links: {
      rewritten: rewritten.rewritten,
      external: rewritten.external,
      unresolved: rewritten.unresolved,
      plainTextConversions: rewritten.plainTextConversions,
    },
  };
}
