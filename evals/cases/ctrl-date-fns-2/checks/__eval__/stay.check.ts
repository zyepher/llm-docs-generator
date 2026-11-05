import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { formatStayRange, nightsBetween } from '../src/stay.js';

describe('stay helpers', () => {
  it('formats the stay range for guests', () => {
    expect(formatStayRange(new Date(2025, 2, 3), 3)).toBe('Mon, 3 Mar 2025 to Thu, 6 Mar 2025');
    expect(formatStayRange(new Date(2024, 11, 30, 15, 0), 4)).toBe(
      'Mon, 30 Dec 2024 to Fri, 3 Jan 2025'
    );
  });

  it('counts calendar nights, ignoring the time of day', () => {
    expect(nightsBetween(new Date(2025, 2, 3, 23, 0), new Date(2025, 2, 4, 1, 0))).toBe(1);
    expect(nightsBetween(new Date(2025, 2, 3, 8, 0), new Date(2025, 2, 6, 7, 0))).toBe(3);
    expect(nightsBetween(new Date(2025, 2, 29, 12, 0), new Date(2025, 3, 2, 12, 0))).toBe(4);
  });

  it('uses date-fns as asked', () => {
    expect(readFileSync('src/stay.ts', 'utf8')).toMatch(/from\s+['"]date-fns/);
  });
});
