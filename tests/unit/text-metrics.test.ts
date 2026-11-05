import { describe, expect, it } from 'vitest';

import { estimateTokenCount } from '../../src/utils/text-metrics.js';

describe('estimateTokenCount', () => {
  it('rounds characters divided by four up to a whole token', () => {
    expect(estimateTokenCount('')).toBe(0);
    expect(estimateTokenCount('abcd')).toBe(1);
    expect(estimateTokenCount('abcde')).toBe(2);
  });

  it('sanitizes the divisor instead of producing NaN or Infinity', () => {
    expect(estimateTokenCount('abcdef', 2.9)).toBe(3);
    expect(estimateTokenCount('abc', 0)).toBe(3);
    expect(estimateTokenCount('abcdefgh', Number.NaN)).toBe(2);
  });
});
