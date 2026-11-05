import { describe, expect, expectTypeOf, it } from 'vitest';

import { type SignupInput, signupSchema, validateSignup } from '../src/signup.js';

expectTypeOf<SignupInput>().toEqualTypeOf<{
  username: string;
  email: string;
  password: string;
  confirmPassword: string;
}>();

const valid = {
  username: 'ada',
  email: 'ada@example.com',
  password: 'correct horse',
  confirmPassword: 'correct horse',
};

function errorsOf(input: unknown): Record<string, unknown> {
  const result: unknown = validateSignup(input);
  expect(result).toMatchObject({ ok: false });
  if (typeof result !== 'object' || result === null || !('fieldErrors' in result)) {
    throw new Error('validateSignup did not return fieldErrors');
  }
  const { fieldErrors } = result;
  if (typeof fieldErrors !== 'object' || fieldErrors === null) {
    throw new Error('fieldErrors is not an object');
  }
  return Object.fromEntries(Object.entries(fieldErrors));
}

describe('signup validation', () => {
  it('accepts a valid form', () => {
    expect(validateSignup(valid)).toEqual({ ok: true, data: valid });
    expect(signupSchema.parse(valid)).toEqual(valid);
  });

  it('reports a password mismatch on confirmPassword', () => {
    const errors = errorsOf({ ...valid, confirmPassword: 'something else' });
    expect(errors.confirmPassword).toEqual(['Passwords do not match']);
    expect(errors.password).toBeUndefined();
  });

  it('reports field errors for invalid fields', () => {
    expect(errorsOf({ ...valid, email: 'not-an-email' }).email).toHaveLength(1);
    expect(errorsOf({ ...valid, username: 'ab' }).username).toHaveLength(1);
    expect(errorsOf({ ...valid, username: 'a'.repeat(21) }).username).toHaveLength(1);
    expect(
      errorsOf({ ...valid, password: 'short', confirmPassword: 'short' }).password
    ).toHaveLength(1);
  });

  it('never throws on garbage', () => {
    expect(() => validateSignup(null)).not.toThrow();
    expect(validateSignup(null)).toMatchObject({ ok: false });
    expect(validateSignup('x')).toMatchObject({ ok: false });
  });
});
