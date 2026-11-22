import { describe, expect, it } from 'vitest';

import { slugifyText } from '../../src/utils/slug.js';

describe('slugifyText', () => {
  it('keeps pure-ASCII slugs byte-identical to the old behavior', () => {
    expect(slugifyText('Sign in with OTP')).toBe('sign-in-with-otp');
    expect(slugifyText('  Weird -- Spacing!  ')).toBe('weird-spacing');
    expect(slugifyText('v2.0 Release Notes')).toBe('v2-0-release-notes');
  });

  it('preserves non-Latin letters instead of collapsing to the fallback', () => {
    expect(slugifyText('快速入门')).toBe('快速入门');
    expect(slugifyText('Émigré Café')).toBe('émigré-café');
    expect(slugifyText('시작 하기')).toBe('시작-하기');
    expect(slugifyText('Привет Мир')).toBe('привет-мир');
  });

  it('drops symbols and emoji, trimming the hyphens they leave at the ends', () => {
    expect(slugifyText('🚀 Launch!')).toBe('launch');
    expect(slugifyText('--a__b--')).toBe('a-b');
  });

  it('falls back when nothing letter-like remains', () => {
    expect(slugifyText('???')).toBe('section');
    expect(slugifyText('')).toBe('section');
    expect(slugifyText('🚀', 'api-document')).toBe('api-document');
  });
});
