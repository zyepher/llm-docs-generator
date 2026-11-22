/**
 * Prose and data that mention suppressions without using one. Nothing here may be flagged.
 * Never write `value as any` or `x: any`; an `as unknown as` double cast hides real errors.
 */

// Callers may pass any value: any string, any number.
/* A block comment: as any, : any, as unknown as */
export const HELP = 'Do not cast as any. Labels look like "name: any" in the legacy form.';
export const QUOTED = "the type : any is banned, so is as unknown as";
export const ESCAPED = 'it\'s fine: any quote';
export const PATTERN = /["']: any|as any/g;
export const RATIO = 4 / 2 / 1; // a division, not a regex: as any
export const MESSAGE = `rule: any cast (as any) is rejected, ${HELP.length} chars, as unknown as`;
export const NESTED = `outer ${`inner: any ${QUOTED}`} tail as any`;
export const DIRECTIVE_TEXT = '// @ts-ignore is written here as a string, not a directive';

export function describe(input: unknown): string {
  // The word "any" in code that is not a type: an identifier and a property.
  const any = typeof input;
  const labels = { any: 'anything' };
  return `${any} ${labels.any}`;
}
