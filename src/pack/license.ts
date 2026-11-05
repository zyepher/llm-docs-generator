/**
 * License detection (spec 4.10). Git acquisition hands over the license files
 * it found at the repository root and at each taken path's root; this module
 * names their license from an `SPDX-License-Identifier:` line or from
 * fingerprints over normalized text, and combines the declared and detected
 * licenses into the manifest's `license` record.
 *
 * Fingerprints are phrases unique to each license text, matched after
 * lowercasing and collapsing every run of non-alphanumerics to one space, so
 * copyright lines, line wrapping, quotes, and punctuation never matter.
 */

import { posix } from 'node:path';

import { compareStringsByCodeUnit } from '../utils/sort.js';
import { licenseStatusFor, type PackManifest } from './manifest.js';

export type DetectedLicense = NonNullable<PackManifest['license']['detected']>;

export interface LicenseFile {
  /** Repository-relative POSIX path, recorded as the evidence. */
  path: string;
  text: string;
}

/** `LICENSE*`, `LICENCE*`, `COPYING*`, case-insensitive. */
export function isLicenseFileName(name: string): boolean {
  return /^(?:licen[cs]e|copying)/i.test(name);
}

interface Fingerprint {
  spdx: string;
  all: readonly RegExp[];
  none?: readonly RegExp[];
}

const BSD_REDISTRIBUTION =
  /redistribution and use in source and binary forms with or without modification are permitted provided that the following conditions are met/;
const BSD_ENDORSE = /may be used to endorse or promote products derived from this software/;
const BSD_ADVERTISING = /all advertising materials mentioning features or use of this software/;

// Order matters: a license whose text quotes another's title is checked first
// (the LGPL texts name the GPL; CC BY-SA contains "Attribution").
const FINGERPRINTS: readonly Fingerprint[] = [
  { spdx: 'AGPL-3.0', all: [/gnu affero general public license version 3 19 november 2007/] },
  { spdx: 'LGPL-3.0', all: [/gnu lesser general public license version 3 29 june 2007/] },
  { spdx: 'LGPL-2.1', all: [/gnu lesser general public license version 2 1 february 1999/] },
  { spdx: 'GPL-3.0', all: [/gnu general public license version 3 29 june 2007/] },
  { spdx: 'GPL-2.0', all: [/gnu general public license version 2 june 1991/] },
  { spdx: 'MPL-2.0', all: [/mozilla public license version 2 0/] },
  { spdx: 'Apache-2.0', all: [/apache license version 2 0/] },
  { spdx: 'CC-BY-SA-4.0', all: [/attribution sharealike 4 0 international/] },
  {
    spdx: 'CC-BY-4.0',
    all: [/creative commons attribution 4 0 international/],
  },
  { spdx: 'CC0-1.0', all: [/cc0 1 0 universal/] },
  {
    spdx: 'Unlicense',
    all: [/this is free and unencumbered software released into the public domain/],
  },
  {
    spdx: 'BSD-3-Clause',
    all: [BSD_REDISTRIBUTION, BSD_ENDORSE],
    none: [BSD_ADVERTISING],
  },
  {
    spdx: 'BSD-2-Clause',
    all: [
      BSD_REDISTRIBUTION,
      /redistributions of source code must retain the above copyright notice/,
      /redistributions in binary form must reproduce the above copyright notice/,
    ],
    none: [BSD_ENDORSE, BSD_ADVERTISING],
  },
  {
    spdx: 'ISC',
    all: [
      /permission to use copy modify and (?:or )?distribute this software for any purpose with or without fee is hereby granted/,
    ],
  },
  {
    spdx: 'MIT',
    all: [
      /permission is hereby granted free of charge to any person obtaining a copy of this software and associated documentation files/,
      /the above copyright notice and this permission notice shall be included in all copies or substantial portions of the software/,
    ],
  },
];

function normalizeLicenseText(text: string): string {
  return ` ${text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;
}

const SPDX_LINE = /SPDX-License-Identifier:[ \t]*([^\r\n]+)/i;

/** The SPDX id or expression one license text carries, or null when unrecognized. */
export function identifyLicenseText(text: string): string | null {
  const tagged = SPDX_LINE.exec(text)?.[1]
    ?.replace(/\s*(?:\*\/|-->|#}).*$/, '')
    .trim();

  if (tagged !== undefined && tagged !== '') {
    return tagged;
  }

  const normalized = normalizeLicenseText(text);

  for (const fingerprint of FINGERPRINTS) {
    if (
      fingerprint.all.every((phrase) => phrase.test(normalized)) &&
      !(fingerprint.none ?? []).some((phrase) => phrase.test(normalized))
    ) {
      return fingerprint.spdx;
    }
  }

  return null;
}

function depth(path: string): number {
  return path.split('/').length;
}

/**
 * Detect the license of one source from its license files. A file at a taken
 * path's root outranks the repository root (docs often carry their own
 * license), a file whose name mentions docs outranks its siblings, and
 * LICENSE outranks COPYING. Other files naming a different license become a
 * warning.
 */
export function detectLicense(files: readonly LicenseFile[]): {
  detected: DetectedLicense | null;
  warnings: string[];
} {
  const ranked = [...files].sort((a, b) => {
    const name = (path: string): string => posix.basename(path).toLowerCase();
    const keys = (path: string): (number | string)[] => [
      -depth(path),
      name(path).includes('doc') ? 0 : 1,
      name(path).startsWith('copying') ? 1 : 0,
      path,
    ];
    const left = keys(a.path);
    const right = keys(b.path);

    for (const [index, value] of left.entries()) {
      const other = right[index];
      if (value === other || other === undefined) {
        continue;
      }
      return typeof value === 'number' && typeof other === 'number'
        ? value - other
        : compareStringsByCodeUnit(String(value), String(other));
    }
    return 0;
  });

  const found = ranked.flatMap((file) => {
    const spdx = identifyLicenseText(file.text);
    return spdx === null ? [] : [{ spdx, evidence: file.path }];
  });
  const detected = found[0] ?? null;
  const others = found.filter((entry) => entry.spdx !== detected?.spdx);

  return {
    detected,
    warnings:
      detected === null || others.length === 0
        ? []
        : [
            `License files disagree: recorded ${detected.spdx} from ${detected.evidence}; also found ${others
              .map((entry) => `${entry.spdx} in ${entry.evidence}`)
              .join(', ')}.`,
          ],
  };
}

function sameLicense(a: string, b: string): boolean {
  const base = (value: string): string =>
    value
      .trim()
      .toLowerCase()
      .replace(/-(?:only|or-later)$/, '');
  return base(a) === base(b);
}

/**
 * The manifest `license` record from the declared license and each source's
 * detection (null for sources that detect nothing, such as http and local
 * sources). The declared license wins for status; a disagreement is a warning.
 */
export function resolvePackLicense(
  declared: string | null,
  detections: readonly (DetectedLicense | null | undefined)[]
): { license: PackManifest['license']; warnings: string[] } {
  const found = detections.filter((entry): entry is DetectedLicense => entry != null);
  const detected = found[0] ?? null;
  const warnings: string[] = [];
  const disagreeing = found.filter((entry) => !sameLicense(entry.spdx, detected?.spdx ?? ''));

  if (detected !== null && disagreeing.length > 0) {
    warnings.push(
      `Sources carry different licenses: ${[detected, ...disagreeing]
        .map((entry) => `${entry.spdx} (${entry.evidence})`)
        .join(', ')}; the manifest records ${detected.spdx}.`
    );
  }

  if (declared !== null && detected !== null && !sameLicense(declared, detected.spdx)) {
    warnings.push(
      `The declared license ${declared} differs from the detected ${detected.spdx} (${detected.evidence}); the declared license is recorded as authoritative.`
    );
  }

  return {
    license: {
      declared,
      detected,
      status: licenseStatusFor(declared ?? detected?.spdx ?? null),
    },
    warnings,
  };
}
