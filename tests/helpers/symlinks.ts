import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Windows lets only an elevated process (or one with Developer Mode enabled)
 * create symbolic links, so tests that build symlinks probe once and skip on a
 * machine that cannot. CI runners are elevated and still run them; POSIX
 * systems always can.
 */
export const canCreateSymlinks: boolean = probeSymlinks();

function probeSymlinks(): boolean {
  if (process.platform !== 'win32') {
    return true;
  }

  const dir = mkdtempSync(join(tmpdir(), 'llm-docs-symlink-probe-'));
  try {
    writeFileSync(join(dir, 'target'), '');
    symlinkSync(join(dir, 'target'), join(dir, 'link'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
