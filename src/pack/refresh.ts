/**
 * The `refresh` report (spec 5): what a fresh acquisition at the recorded
 * recipe changes against the pack on disk, per upstream file (unchanged,
 * changed, added, removed), and per git source whether the ref now resolves
 * to a different commit. The rebuild itself is the ordinary build in
 * src/pack/build.ts.
 */

import type { PackSelection } from '../sources/acquire.js';
import { canonicalJsonStringify } from '../utils/json.js';
import { compareStringsByCodeUnit } from '../utils/sort.js';
import type { ManifestOrigin, PackManifest } from './manifest.js';

export type RefreshFileStatus = 'unchanged' | 'changed' | 'added' | 'removed';

export interface RefreshFileChange {
  /** `<source index>:<origin-relative path>`, as in manifest outputs. */
  source: string;
  /** The pack file it produces (or produced, when removed). */
  output: string;
  status: RefreshFileStatus;
}

export interface RefreshRefChange {
  source: number;
  repo: string;
  ref: string;
  previousCommit: string;
  commit: string;
}

export interface RefreshReport {
  /** Anything differs: a file, or the commit a git ref resolves to. */
  changed: boolean;
  counts: Record<RefreshFileStatus, number>;
  files: RefreshFileChange[];
  refs: RefreshRefChange[];
}

export function diffRefresh(
  manifest: PackManifest,
  selection: PackSelection,
  origins: readonly ManifestOrigin[]
): RefreshReport {
  const key = (source: number, path: string): string => `${source}:${path}`;
  const previous = new Map(
    manifest.sources.map((entry) => [key(entry.source, entry.path), entry.sha256])
  );
  const previousOutput = new Map<string, string>();

  for (const output of manifest.outputs) {
    for (const source of output.sources ?? []) {
      if (!previousOutput.has(source)) {
        previousOutput.set(source, output.path);
      }
    }
  }

  const files: RefreshFileChange[] = [];
  const seen = new Set<string>();

  for (const selected of selection.files) {
    const source = key(selected.sourceIndex, selected.file.path);
    const before = previous.get(source);
    seen.add(source);
    files.push({
      source,
      output: selected.outputPath,
      status:
        before === undefined ? 'added' : before === selected.file.sha256 ? 'unchanged' : 'changed',
    });
  }

  for (const source of previous.keys()) {
    if (!seen.has(source)) {
      files.push({ source, output: previousOutput.get(source) ?? source, status: 'removed' });
    }
  }

  files.sort(
    (a, b) =>
      compareStringsByCodeUnit(a.output, b.output) || compareStringsByCodeUnit(a.source, b.source)
  );

  const refs: RefreshRefChange[] = [];

  for (const [index, origin] of origins.entries()) {
    const before = manifest.origins[index];

    if (origin.type === 'git' && before?.type === 'git' && before.commit !== origin.commit) {
      refs.push({
        source: index,
        repo: origin.repo,
        ref: origin.ref,
        previousCommit: before.commit,
        commit: origin.commit,
      });
    }
  }

  const counts: Record<RefreshFileStatus, number> = {
    unchanged: 0,
    changed: 0,
    added: 0,
    removed: 0,
  };
  for (const file of files) {
    counts[file.status] += 1;
  }

  // Any other upstream origin difference (an llms.txt index whose hash moved) needs a rebuild to
  // record it. A local origin's host commit moves with every project commit, so it does not count.
  const originsMoved = origins.some(
    (origin, index) =>
      origin.type !== 'local' &&
      canonicalJsonStringify(origin) !== canonicalJsonStringify(manifest.origins[index] ?? null)
  );

  return {
    changed: originsMoved || files.some((file) => file.status !== 'unchanged'),
    counts,
    files,
    refs,
  };
}
