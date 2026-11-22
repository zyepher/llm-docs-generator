/**
 * The error the reStructuredText, HTML, and OpenAPI parsers throw when a
 * source file cannot be parsed.
 */
export class ParserError extends Error {
  constructor(
    message: string,
    public readonly parser?: string
  ) {
    super(message);
    this.name = 'ParserError';
  }
}
