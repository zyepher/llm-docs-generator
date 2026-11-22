/**
 * `npm run build:plugin`: bundle the whole CLI into plugin/bin/llm-docs.mjs
 * and stamp the package.json version into the plugin and marketplace
 * manifests. `npm run check:plugin` (scripts/check-plugin.ts) renders the
 * same files with `renderPlugin` and fails when the committed ones differ.
 */

import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'tsup';

import packageJson from '../package.json';
import { isRecord } from '../src/utils/guards.js';
import { sha256Prefixed } from '../src/utils/hash.js';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const BUNDLE_PATH = 'plugin/bin/llm-docs.mjs';
const PLUGIN_NAME = 'llm-docs';

/** Repository-relative manifests whose version follows package.json. */
const PLUGIN_MANIFESTS = ['plugin/.claude-plugin/plugin.json', 'plugin/.cursor-plugin/plugin.json'];
const MARKETPLACE_MANIFESTS = [
  '.claude-plugin/marketplace.json',
  '.cursor-plugin/marketplace.json',
];

// CommonJS dependencies (commander among them) call require() for Node built-ins,
// which an ESM bundle does not define.
const REQUIRE_SHIM =
  "import { createRequire as __llmDocsCreateRequire } from 'node:module'; const require = __llmDocsCreateRequire(import.meta.url);";

/**
 * Machine paths that must never reach the committed bundle: building twice on
 * two machines has to give the same bytes.
 */
async function machinePaths(): Promise<string[]> {
  const paths = [REPO_ROOT, homedir(), tmpdir()];
  const real = await Promise.all(paths.map((path) => realpath(path).catch(() => path)));
  return [...new Set([...paths, ...real])].filter((path) => path.length > 1);
}

async function bundleCli(): Promise<Buffer> {
  const outDir = await mkdtemp(join(tmpdir(), 'llm-docs-plugin-'));

  try {
    await build({
      config: false,
      entry: { [PLUGIN_NAME]: join(REPO_ROOT, 'src', 'cli.ts') },
      outDir,
      outExtension: () => ({ js: '.mjs' }),
      format: ['esm'],
      platform: 'node',
      target: 'node22',
      noExternal: [/./],
      splitting: false,
      sourcemap: false,
      dts: false,
      minify: true,
      clean: false,
      silent: true,
      banner: { js: REQUIRE_SHIM },
    });
    const bundle = await readFile(join(outDir, `${PLUGIN_NAME}.mjs`));
    const text = bundle.toString('utf-8');

    for (const path of await machinePaths()) {
      if (text.includes(path) || text.includes(path.replaceAll('\\', '/'))) {
        throw new Error(`The bundle contains the machine path ${path}; it must be portable.`);
      }
    }
    return bundle;
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

/** The manifest at `path` with its version (or its llm-docs marketplace entry's) set. */
async function stampVersion(path: string, kind: 'plugin' | 'marketplace'): Promise<Buffer> {
  const manifest: unknown = JSON.parse(await readFile(join(REPO_ROOT, path), 'utf-8'));

  if (!isRecord(manifest)) {
    throw new Error(`${path} is not a JSON object.`);
  }

  if (kind === 'plugin') {
    manifest.version = packageJson.version;
  } else {
    const entries = Array.isArray(manifest.plugins) ? manifest.plugins.filter(isRecord) : [];
    const entry = entries.find((plugin) => plugin.name === PLUGIN_NAME);

    if (entry === undefined) {
      throw new Error(`${path} lists no "${PLUGIN_NAME}" plugin.`);
    }
    entry.version = packageJson.version;
  }

  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
}

/** Every generated file, keyed by its repository-relative POSIX path. */
export async function renderPlugin(): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>([[BUNDLE_PATH, await bundleCli()]]);

  for (const path of PLUGIN_MANIFESTS) {
    files.set(path, await stampVersion(path, 'plugin'));
  }
  for (const path of MARKETPLACE_MANIFESTS) {
    files.set(path, await stampVersion(path, 'marketplace'));
  }
  return files;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const [path, bytes] of await renderPlugin()) {
    await writeFile(join(REPO_ROOT, path), bytes);
    process.stdout.write(`${path}  ${sha256Prefixed(bytes)}  ${bytes.length} bytes\n`);
  }
  process.stdout.write(`Built the llm-docs ${packageJson.version} plugin. Commit these files.\n`);
}
