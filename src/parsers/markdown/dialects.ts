/**
 * Text-level Markdown dialect helpers shared by the DocNode parser and the v3
 * source-preserving page pipeline (src/pack/markdown.ts): YAML frontmatter
 * detection, DocC block directives and cross-references, and MDX ESM
 * declaration detection. Pure functions over strings, so both callers apply
 * exactly one rule for each dialect.
 */

import { load as yamlLoad } from 'js-yaml';

import { getOpeningFence, isClosingFence, type FenceState } from './fences.js';

export type MdxDeclarationKind = 'import' | 'export';

/** Replace DocC `<doc:Reference>` cross-references with their plain text. */
export function unwrapDocCReferences(text: string): string {
  return text.replace(/<doc:([^>]+)>/g, '$1');
}

/**
 * Rewrite block-level DocC directives across the whole document.
 *
 * - @Metadata / @Options / @Comment blocks are dropped entirely.
 * - @Row / @Column / @TabNavigator / @Tab are unwrapped: the directive lines
 *   and closing braces vanish, the body is dedented and kept (a @Tab keeps
 *   its quoted title as a heading, matching the MDX Tab precedent).
 * - @Image / @Video render a single-line placeholder carrying source and alt;
 *   @Snippet renders its path reference as inline code.
 *
 * Line-oriented pass with per-frame brace balancing (delimiterBalance
 * precedent): nested directive bodies are tracked with counters, never with
 * backtracking regex, and fenced code inside a directive body is passed
 * through without brace counting.
 */
export function transformDocCBlockDirectives(content: string): string {
  interface DirectiveFrame {
    kind: 'drop' | 'unwrap';
    depth: number;
    // Leading whitespace of the frame's first non-blank body line; stripped
    // from every body line so unwrapped content is not misread as indented
    // code by the markdown lexer.
    stripIndent: number | null;
  }

  const output: string[] = [];
  const frames: DirectiveFrame[] = [];
  let fence: FenceState | null = null;

  const inDropFrame = (): boolean => frames.some((frame) => frame.kind === 'drop');
  const dedent = (line: string): string => {
    const strip = frames.at(-1)?.stripIndent ?? 0;
    let index = 0;
    while (index < strip && index < line.length) {
      const char = line[index];
      if (char !== ' ' && char !== '\t') {
        break;
      }
      index += 1;
    }
    return line.slice(index);
  };

  for (const line of content.split('\n')) {
    if (fence !== null) {
      if (!inDropFrame()) {
        output.push(dedent(line));
      }
      if (isClosingFence(dedent(line), fence)) {
        fence = null;
      }
      continue;
    }

    const frame = frames.at(-1);
    if (frame !== undefined && frame.stripIndent === null && line.trim() !== '') {
      frame.stripIndent = line.length - line.trimStart().length;
    }

    const openingFence = getOpeningFence(dedent(line));
    if (openingFence !== null) {
      if (!inDropFrame()) {
        output.push(dedent(line));
      }
      fence = openingFence;
      continue;
    }

    const directive = inDropFrame() ? null : matchDocCBlockDirective(line);
    if (directive !== null) {
      output.push(...directive.replacement.map((replacementLine) => dedent(replacementLine)));
      if (directive.frame !== null) {
        frames.push(directive.frame);
      }
      continue;
    }

    if (frames.length === 0) {
      output.push(line);
      continue;
    }

    const wasInDrop = inDropFrame();
    const dedented = dedent(line);
    const top = frames.at(-1);
    if (top !== undefined) {
      top.depth += braceBalance(line);
    }
    let poppedUnwrap = false;
    while (frames.length > 0 && frames[frames.length - 1]!.depth <= 0) {
      const overshoot = frames[frames.length - 1]!.depth;
      poppedUnwrap = poppedUnwrap || frames[frames.length - 1]!.kind === 'unwrap';
      frames.pop();
      const parent = frames.at(-1);
      if (parent !== undefined) {
        parent.depth += overshoot;
      }
    }

    if (wasInDrop) {
      continue;
    }
    if (poppedUnwrap && /^[\s}]*$/.test(line)) {
      // A bare closing-brace line only terminates the directive body.
      continue;
    }
    output.push(dedented);
  }

  return output.join('\n');
}

/**
 * Match one block-level DocC directive line. Returns the lines that replace
 * it plus the frame to push when the directive opens a braced body, or null
 * when the line is not a recognized directive.
 */
function matchDocCBlockDirective(line: string): {
  replacement: string[];
  frame: { kind: 'drop' | 'unwrap'; depth: number; stripIndent: null } | null;
} | null {
  const match = line.match(/^\s*@([A-Za-z][A-Za-z0-9]*)\b\s*(.*)$/);
  const name = match?.[1];
  if (name === undefined) {
    return null;
  }
  const rest = match?.[2] ?? '';
  const balance = braceBalance(rest);
  const bodyFrame = (
    kind: 'drop' | 'unwrap'
  ): { kind: 'drop' | 'unwrap'; depth: number; stripIndent: null } | null =>
    balance > 0 ? { kind, depth: balance, stripIndent: null } : null;

  if (name === 'Metadata' || name === 'Options' || name === 'Comment') {
    return { replacement: [], frame: bodyFrame('drop') };
  }

  if (name === 'Row' || name === 'Column' || name === 'TabNavigator' || name === 'Tab') {
    const title = name === 'Tab' ? /"([^"]*)"/.exec(rest)?.[1]?.trim() : undefined;
    const replacement = title !== undefined && title !== '' ? [`### ${title}`, ''] : [];
    return { replacement, frame: bodyFrame('unwrap') };
  }

  if (name === 'Image' || name === 'Video' || name === 'Snippet') {
    const args = parseDocCDirectiveArguments(rest);
    const replacement: string[] = [];
    if (name === 'Image') {
      const source = args.get('source');
      if (source !== undefined) {
        replacement.push(`![${args.get('alt') ?? ''}](${source})`);
      }
    } else if (name === 'Video') {
      const source = args.get('source');
      if (source !== undefined) {
        const alt = args.get('alt');
        replacement.push(`[Video${alt !== undefined ? `: ${alt}` : ''}](${source})`);
      }
    } else {
      const path = args.get('path');
      if (path !== undefined) {
        const slice = args.get('slice');
        replacement.push(`\`${path}${slice !== undefined ? `#${slice}` : ''}\``);
      }
    }
    // A trailing braced body (e.g. an @Image accessibility block) is dropped.
    return { replacement, frame: bodyFrame('drop') };
  }

  return null;
}

/**
 * Parse `name: value` arguments from a DocC directive's parenthesized
 * argument list. Values may be double-quoted or bare.
 */
function parseDocCDirectiveArguments(rest: string): Map<string, string> {
  const args = new Map<string, string>();
  const argumentPattern = /([A-Za-z][\w-]*)\s*:\s*(?:"([^"]*)"|([^,()]+))/g;
  for (const match of rest.matchAll(argumentPattern)) {
    const name = match[1];
    const value = (match[2] ?? match[3] ?? '').trim();
    if (name !== undefined && value !== '') {
      args.set(name, value);
    }
  }
  return args;
}

/**
 * Net `{` versus `}` count for one line. Quotes are not tracked: prose
 * braces outside fenced code are rare in documentation, and a linear count
 * cannot be fooled into backtracking.
 */
function braceBalance(line: string): number {
  let balance = 0;
  for (const char of line) {
    if (char === '{') {
      balance += 1;
    } else if (char === '}') {
      balance -= 1;
    }
  }
  return balance;
}

export function readYamlFrontmatter(
  content: string
): { frontmatter: string; contentAfter: string; bodyStartLineIndex: number } | null {
  const withoutBom = content.replace(/^\uFEFF/, '');
  const lines = withoutBom.split('\n');

  if (lines[0]?.trim() !== '---') {
    return null;
  }

  for (let index = 1; index < lines.length; index += 1) {
    const trimmed = lines[index]?.trim();
    if (trimmed === '---' || trimmed === '...') {
      const frontmatter = lines.slice(1, index).join('\n');
      if (!isYamlMappingBlock(frontmatter)) {
        return null;
      }

      return {
        frontmatter,
        contentAfter: lines.slice(index + 1).join('\n'),
        bodyStartLineIndex: index + 1,
      };
    }
  }

  return null;
}

/**
 * A leading '---' can open a thematic break rather than a frontmatter fence.
 * Only treat the captured block as frontmatter when it parses as a YAML
 * mapping (or is empty); a scalar, sequence, or parse error means the
 * delimiters were real document content that must not be stripped.
 */
function isYamlMappingBlock(block: string): boolean {
  try {
    const parsed = yamlLoad(block);
    if (parsed === null || parsed === undefined) {
      return true;
    }

    return typeof parsed === 'object' && Object.getPrototypeOf(parsed) === Object.prototype;
  } catch {
    return false;
  }
}

export function getMdxDeclarationKind(line: string): MdxDeclarationKind | null {
  if (
    /^import\s+/.test(line) &&
    (/^import\s+['"]/.test(line) ||
      /\bfrom\s+['"]/.test(line) ||
      // A default binding followed by a comma is only a real import when the
      // comma introduces named/namespace bindings (`import Foo, { … }` /
      // `import Foo, * as NS`) or ends the line as a continuation. Requiring
      // `{`, `*`, or end-of-line after the comma stops ordinary prose such as
      // "import them, then run setup." from being misread as an import and
      // silently dropped.
      /^import\s+(?:type\s+)?(?:\{|\*|[\w$]+\s*,\s*(?:\{|\*|$))/.test(line))
  ) {
    return 'import';
  }

  if (
    /^export\s+/.test(line) &&
    /^export\s+(?:\{|\*|default\b|const\b|let\b|var\b|function\b|class\b|type\b|interface\b|enum\b)/.test(
      line
    )
  ) {
    return 'export';
  }

  return null;
}

export function shouldContinueMdxDeclaration(
  line: string,
  kind: MdxDeclarationKind,
  balance: number
): boolean {
  if (balance > 0) {
    return true;
  }

  if (kind === 'import') {
    return !isMdxDeclarationEnd(line, kind);
  }

  return /[({[,]\s*$/.test(line);
}

function isMdxDeclarationEnd(line: string, kind: MdxDeclarationKind): boolean {
  const normalized = normalizeMdxDeclarationLine(line);

  if (normalized.endsWith(';')) {
    return true;
  }

  if (kind === 'import') {
    return isCompleteMdxImportDeclaration(normalized);
  }

  return (
    /^[})\]](?:\s+(?:as\s+const|satisfies\s+[\w.]+))?;?$/.test(normalized) ||
    /^}\s*from\s+['"][^'"]+['"];?$/.test(normalized)
  );
}

function normalizeMdxDeclarationLine(line: string): string {
  return line
    .replace(/\s+\/\/.*$/, '')
    .replace(/\s+\/\*.*?\*\/\s*$/, '')
    .trim();
}

function isCompleteMdxImportDeclaration(line: string): boolean {
  const importAttributes = String.raw`(?:\s+(?:assert|with)\s+\{.*\})?`;
  return (
    new RegExp(String.raw`^import\s+['"][^'"]+['"]${importAttributes}$`).test(line) ||
    new RegExp(String.raw`\bfrom\s+['"][^'"]+['"]${importAttributes}$`).test(line)
  );
}

export function delimiterBalance(
  text: string,
  openQuote: string | null
): { balance: number; quote: string | null } {
  // Count brace/paren/bracket balance while skipping quoted-string contents.
  // A single linear pass tracks the active quote and honors backslash escapes,
  // so this is O(n). The previous global quote-stripping regex, even after the
  // ReDoS fix, still rescanned to end-of-line from every quote start on an
  // unterminated quote run: O(n^2), ~65s on one ~400KB line.
  //
  // `openQuote` carries an unterminated template literal in from the previous
  // line, so delimiters inside multi-line backtick strings stay hidden. Only
  // backticks survive the line break in the returned state: ' and " strings
  // cannot span lines in JavaScript, and treating a stray apostrophe (e.g. in
  // a trailing comment) as still open would swallow the rest of the document.
  // A trailing backslash escapes the newline itself, so the escape state never
  // carries into the next line.
  let balance = 0;
  let quote: string | null = openQuote;
  let escaped = false;

  for (const char of text) {
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char;
    } else if (char === '{' || char === '(' || char === '[') {
      balance += 1;
    } else if (char === '}' || char === ')' || char === ']') {
      balance -= 1;
    }
  }

  return { balance, quote: quote === '`' ? quote : null };
}
