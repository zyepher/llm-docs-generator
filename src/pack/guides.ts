/**
 * Agent-owned guides under `<pack>/guides/` (spec 8). The tool never writes
 * or deletes them; it lists them for the pack index and the managed block.
 */

import { lstat, readFile } from 'node:fs/promises';
import { join, posix, sep } from 'node:path';

import { isFileNotFoundError } from '../utils/guards.js';
import { compareStringsByCodeUnit } from '../utils/sort.js';
import { walkBoundedDirectoryTree } from '../utils/traversal.js';
import type { IndexGuide } from './index-page.js';
import { collectHeadings } from './markdown.js';

function fileStem(path: string): string {
  const name = posix.basename(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Markdown guides under `<packDir>/guides`, with their first-H1 titles. */
export async function listGuides(packDir: string): Promise<IndexGuide[]> {
  const root = join(packDir, 'guides');

  try {
    await lstat(root);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return [];
    }
    throw error;
  }

  const guides: IndexGuide[] = [];

  for await (const event of walkBoundedDirectoryTree({
    root,
    maxDepth: 16,
    maxEntries: 10_000,
    maxFiles: 10_000,
    skipDirectoryNames: false,
  })) {
    if (event.kind !== 'file' || !/\.md$/i.test(event.entry.name)) {
      continue;
    }

    const path = `guides/${event.relativePath.split(sep).join('/')}`;
    const text = await readFile(event.absolutePath, 'utf-8');
    const h1 = collectHeadings(text).find((heading) => heading.level === 1);
    guides.push({ path, title: h1?.text || fileStem(path) });
  }

  return guides.sort((a, b) => compareStringsByCodeUnit(a.path, b.path));
}
