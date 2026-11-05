/**
 * License detection (spec 4.10) against the canonical SPDX texts in
 * tests/fixtures/licenses, reworded copyright lines, rewrapped text, SPDX
 * identifier lines, ranking, and the declared/detected resolution.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  detectLicense,
  identifyLicenseText,
  isLicenseFileName,
  resolvePackLicense,
} from '../../src/pack/license.js';
import { licenseStatusFor } from '../../src/pack/manifest.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'licenses');
const LICENSES = [
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'MPL-2.0',
  'CC-BY-4.0',
  'CC-BY-SA-4.0',
  'CC0-1.0',
  'Unlicense',
  'GPL-2.0',
  'GPL-3.0',
  'LGPL-2.1',
  'LGPL-3.0',
  'AGPL-3.0',
] as const;

const canonical = (id: string): Promise<string> => readFile(join(fixtures, `${id}.txt`), 'utf-8');

/** Real-world drift: a filled-in copyright line, CRLF, and text rewrapped at 60 columns. */
function drifted(text: string): string {
  const filled = text
    .replace(/<year>/gi, '2019-2026')
    .replace(/<(?:copyright holders?|owner|organization)>/gi, 'Example Corp. and contributors');
  const words = filled.split(/\s+/);
  const lines: string[] = ['Copyright (c) 2026 Somebody Else <someone@example.com>', ''];
  let line = '';
  for (const word of words) {
    if (line.length + word.length > 60) {
      lines.push(line);
      line = word;
    } else {
      line = line === '' ? word : `${line} ${word}`;
    }
  }
  lines.push(line);
  return lines.join('\r\n');
}

describe('identifyLicenseText', () => {
  it.each(LICENSES)('recognizes the canonical %s text', async (id) => {
    expect(identifyLicenseText(await canonical(id))).toBe(id);
  });

  it.each(LICENSES)('recognizes %s with other copyright lines and wrapping', async (id) => {
    expect(identifyLicenseText(drifted(await canonical(id)))).toBe(id);
  });

  it('returns null for an unknown text and for a 4-clause BSD license', async () => {
    expect(identifyLicenseText('All rights reserved. Do not copy.\n')).toBeNull();
    const fourClause = (await canonical('BSD-3-Clause')).replace(
      '3. Neither',
      '3. All advertising materials mentioning features or use of this software must display an acknowledgement.\n\n4. Neither'
    );
    expect(identifyLicenseText(fourClause)).toBeNull();
  });

  it('prefers an SPDX-License-Identifier line, including expressions', () => {
    expect(identifyLicenseText('SPDX-License-Identifier: MIT OR Apache-2.0\n')).toBe(
      'MIT OR Apache-2.0'
    );
    expect(identifyLicenseText('/* SPDX-License-Identifier: GPL-2.0-only */\n')).toBe(
      'GPL-2.0-only'
    );
  });
});

describe('detectLicense', () => {
  it('ranks a taken path root above the repository root and docs licenses above code licenses', async () => {
    const mit = await canonical('MIT');
    const ccBy = await canonical('CC-BY-4.0');
    const result = detectLicense([
      { path: 'LICENSE', text: mit },
      { path: 'docs/LICENSE-docs', text: ccBy },
      { path: 'docs/LICENSE', text: mit },
    ]);

    expect(result.detected).toEqual({ spdx: 'CC-BY-4.0', evidence: 'docs/LICENSE-docs' });
    expect(result.warnings).toEqual([
      'License files disagree: recorded CC-BY-4.0 from docs/LICENSE-docs; also found MIT in docs/LICENSE, MIT in LICENSE.',
    ]);
  });

  it('prefers LICENSE over COPYING and ignores unrecognized files', async () => {
    const result = detectLicense([
      { path: 'COPYING', text: await canonical('GPL-3.0') },
      { path: 'LICENSE', text: await canonical('LGPL-3.0') },
      { path: 'LICENSE.third-party', text: 'nothing standard here' },
    ]);
    expect(result.detected).toEqual({ spdx: 'LGPL-3.0', evidence: 'LICENSE' });
  });

  it('detects nothing without license files', () => {
    expect(detectLicense([])).toEqual({ detected: null, warnings: [] });
  });

  it('matches license file names case-insensitively', () => {
    expect(
      ['LICENSE', 'license.md', 'Licence.txt', 'COPYING.LESSER', 'copying'].every(isLicenseFileName)
    ).toBe(true);
    expect(['README.md', 'my-LICENSE', 'docs'].some(isLicenseFileName)).toBe(false);
  });
});

describe('resolvePackLicense', () => {
  it('maps every detected license to its status', () => {
    const statuses = Object.fromEntries(LICENSES.map((id) => [id, licenseStatusFor(id)]));
    expect(statuses).toEqual({
      MIT: 'permissive',
      'Apache-2.0': 'permissive',
      'BSD-2-Clause': 'permissive',
      'BSD-3-Clause': 'permissive',
      ISC: 'permissive',
      'MPL-2.0': 'copyleft',
      'CC-BY-4.0': 'attribution',
      'CC-BY-SA-4.0': 'copyleft',
      'CC0-1.0': 'permissive',
      Unlicense: 'permissive',
      'GPL-2.0': 'copyleft',
      'GPL-3.0': 'copyleft',
      'LGPL-2.1': 'copyleft',
      'LGPL-3.0': 'copyleft',
      'AGPL-3.0': 'copyleft',
    });
    expect(licenseStatusFor('MIT OR GPL-3.0-only')).toBe('permissive');
    expect(licenseStatusFor('(MIT AND CC-BY-4.0)')).toBe('attribution');
    expect(licenseStatusFor('GPL-2.0-or-later WITH Classpath-exception-2.0')).toBe('copyleft');
  });

  it('records the detection, lets a declared license win, and warns on a mismatch', () => {
    const detected = { spdx: 'MIT', evidence: 'LICENSE' };

    expect(resolvePackLicense(null, [null, detected])).toEqual({
      license: { declared: null, detected, status: 'permissive' },
      warnings: [],
    });
    expect(resolvePackLicense('MIT', [detected]).warnings).toEqual([]);
    expect(resolvePackLicense('proprietary', [detected])).toEqual({
      license: { declared: 'proprietary', detected, status: 'proprietary' },
      warnings: [
        'The declared license proprietary differs from the detected MIT (LICENSE); the declared license is recorded as authoritative.',
      ],
    });
    expect(resolvePackLicense(null, [null, undefined])).toEqual({
      license: { declared: null, detected: null, status: 'unknown' },
      warnings: [],
    });
  });

  it('warns when sources carry different licenses', () => {
    const result = resolvePackLicense(null, [
      { spdx: 'CC-BY-4.0', evidence: 'LICENSE' },
      { spdx: 'MIT', evidence: 'LICENSE' },
    ]);
    expect(result.license.detected?.spdx).toBe('CC-BY-4.0');
    expect(result.warnings[0]).toMatch(/^Sources carry different licenses/);
  });
});
