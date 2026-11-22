import { describe, expect, it } from 'vitest';

import { compareStringsByCodeUnit } from '../../src/utils/sort.js';

describe('compareStringsByCodeUnit', () => {
  it('orders by UTF-16 code unit, not by locale', () => {
    const words = ['b', 'é', 'B', '_x', 'a', 'Z', 'e', 'A', '10', '9'];

    expect([...words].sort(compareStringsByCodeUnit)).toEqual([
      '10',
      '9',
      'A',
      'B',
      'Z',
      '_x',
      'a',
      'b',
      'e',
      'é',
    ]);
    expect([...words].sort((a, b) => a.localeCompare(b, 'en'))).not.toEqual(
      [...words].sort(compareStringsByCodeUnit)
    );
  });

  it('sorts a prefix before its extensions', () => {
    expect(['ab', 'a', 'abc', ''].sort(compareStringsByCodeUnit)).toEqual(['', 'a', 'ab', 'abc']);
  });

  it('places astral characters by their surrogate code units, not their code points', () => {
    // U+1F600 is encoded as 0xD83D 0xDE00, which sorts before U+FF61 by code unit even
    // though its code point is larger.
    const halfwidthStop = String.fromCodePoint(0xff61);
    const grinningFace = String.fromCodePoint(0x1f600);

    expect([halfwidthStop, grinningFace].sort(compareStringsByCodeUnit)).toEqual([
      grinningFace,
      halfwidthStop,
    ]);
  });

  it('agrees with the default JavaScript string sort', () => {
    const words = ['Zebra', 'apple', 'Äpfel', 'ä', '日本', '\u{1F600}', 'a-b', 'a_b', 'a b', ''];

    expect([...words].sort(compareStringsByCodeUnit)).toEqual([...words].sort());
  });

  it('returns zero for equal strings and opposite signs when swapped', () => {
    expect(compareStringsByCodeUnit('same', 'same')).toBe(0);
    expect(Math.sign(compareStringsByCodeUnit('a', 'b'))).toBe(-1);
    expect(Math.sign(compareStringsByCodeUnit('b', 'a'))).toBe(1);
  });
});
