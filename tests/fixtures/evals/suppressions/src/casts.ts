// Real suppressions in code. expected.json lists every line flagged here.
export function loose(value: any): string {
  return String(value);
}

export const forced = JSON.parse('{}') as any;

export const twice = 42 as unknown as string;

export const inTemplate = `${(forced as any).name} text`;

// @ts-ignore
export const ignored: number = 'not a number';

/* @ts-expect-error */
export const expected: number = 'still not a number';

export const afterString = 'as any in a string' + (forced as any);
