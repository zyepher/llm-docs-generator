/**
 * The `refresh` report (spec 5): what a fresh acquisition at the recorded
 * recipe changes against the pack on disk, per upstream file (unchanged,
 * changed, added, removed), per git source whether the ref now resolves to
 * a different commit, and, separately, the converted pages whose converter
 * version changed (spec 4.6) even though their original did not. The
 * rebuild itself is the ordinary build in src/pack/build.ts.
 */

import type { PackSelection } from '../sources/acquire.js';
import { canonicalJsonStringify } from '../utils/json.js';
import { compareStringsByCodeUnit } from '../utils/sort.js';
import type { ManifestOrigin, ManifestSourceEntry, PackManifest } from './manifest.js';

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

/** The converter that produced (or would now produce) a page: tool and `--version` line. */
export type ConverterIdentity = Pick<
  NonNullable<ManifestSourceEntry['converter']>,
  'tool' | 'version'
>;

export interface RefreshConverterChange {
  /** `<source index>:<origin-relative path>` of the converted original. */
  source: string;
  output: string;
  previous: ConverterIdentity;
  current: ConverterIdentity;
}

export interface RefreshReport {
  /** Anything differs: a file, the commit a git ref resolves to, or a converter version. */
  changed: boolean;
  counts: Record<RefreshFileStatus, number>;
  files: RefreshFileChange[];
  refs: RefreshRefChange[];
  /**
   * Converted pages whose original is unchanged (or changed too) but whose
   * converter now reports a different tool or version than the manifest
   * records, so their text may change for that reason alone.
   */
  converters: RefreshConverterChange[];
}

/**
 * `converters` maps a source index to the converter its documents would be
 * converted with now; sources without one (or with an `agent` converter,
 * which has no version) are absent.
 */
export function diffRefresh(
  manifest: PackManifest,
  selection: PackSelection,
  origins: readonly ManifestOrigin[],
  converters: ReadonlyMap<number, ConverterIdentity>
): RefreshReport {
  const key = (source: number, path: string): string => `${source}:${path}`;
  const previous = new Map(manifest.sources.map((entry) => [key(entry.source, entry.path), entry]));
  const previousOutput = new Map<string, string>();

  for (const output of manifest.outputs) {
    for (const source of output.sources ?? []) {
      if (!previousOutput.has(source)) {
        previousOutput.set(source, output.path);
      }
    }
  }

  const files: RefreshFileChange[] = [];
  const converterChanges: RefreshConverterChange[] = [];
  const seen = new Set<string>();

  for (const selected of selection.files) {
    const source = key(selected.sourceIndex, selected.file.path);
    const before = previous.get(source);
    seen.add(source);
    files.push({
      source,
      output: selected.outputPath,
      status:
        before === undefined
          ? 'added'
          : before.sha256 === selected.file.sha256
            ? 'unchanged'
            : 'changed',
    });

    const current = converters.get(selected.sourceIndex);
    const recorded = before?.converter;
    if (
      selected.kind === 'convert' &&
      current !== undefined &&
      recorded !== undefined &&
      (recorded.tool !== current.tool || recorded.version !== current.version)
    ) {
      converterChanges.push({
        source,
        output: selected.outputPath,
        previous: { tool: recorded.tool, version: recorded.version },
        current,
      });
    }
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
    changed:
      originsMoved ||
      converterChanges.length > 0 ||
      files.some((file) => file.status !== 'unchanged'),
    counts,
    files,
    refs,
    converters: converterChanges.sort((a, b) => compareStringsByCodeUnit(a.output, b.output)),
  };
}
