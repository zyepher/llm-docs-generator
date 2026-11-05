/**
 * loadYaml keeps the js-yaml 4 load() contract the parsers were written
 * against: merge keys and timestamps resolve, and an empty stream is
 * `undefined` rather than an error.
 */

import { FAILSAFE_SCHEMA } from 'js-yaml';
import { describe, expect, it } from 'vitest';

import { loadYaml } from '../../src/utils/yaml.js';

describe('loadYaml', () => {
  it('returns undefined for a stream with no document', () => {
    expect(loadYaml('')).toBeUndefined();
    expect(loadYaml('# only a comment\n')).toBeUndefined();
    expect(loadYaml('', FAILSAFE_SCHEMA)).toBeUndefined();
  });

  it('resolves merge keys and timestamps by default', () => {
    expect(loadYaml('base: &b {x: 1}\nchild:\n  <<: *b\n  y: 2\n')).toEqual({
      base: { x: 1 },
      child: { x: 1, y: 2 },
    });
    expect(loadYaml('date: 2024-01-02')).toEqual({ date: new Date('2024-01-02T00:00:00.000Z') });
  });

  it('keeps every scalar a string under the failsafe schema', () => {
    expect(loadYaml('version: 1.10\nflag: true', FAILSAFE_SCHEMA)).toEqual({
      version: '1.10',
      flag: 'true',
    });
  });

  it('rejects a stream with more than one document', () => {
    expect(() => loadYaml('a: 1\n---\nb: 2\n')).toThrow(/single document/);
  });
});
