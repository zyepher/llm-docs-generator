/**
 * `npm run build:plugin`: bundle the whole CLI into plugin/bin/llm-docs.mjs,
 * write the bundled packages' notices to plugin/THIRD_PARTY_NOTICES.md, and
 * stamp the package.json version into the plugin and marketplace manifests. `npm run check:plugin` (scripts/check-plugin.ts) renders the
 * same files with `renderPlugin` and fails when the committed ones differ.
 */

import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'tsdown';

import packageJson from '../package.json';
import { isRecord } from '../src/utils/guards.js';
import { sha256Prefixed } from '../src/utils/hash.js';
import { compareStringsByCodeUnit } from '../src/utils/sort.js';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const BUNDLE_PATH = 'plugin/bin/llm-docs.mjs';
const NOTICES_PATH = 'plugin/THIRD_PARTY_NOTICES.md';
const PLUGIN_NAME = 'llm-docs';

/** Licenses that let the bundle redistribute a package by carrying its notice. */
const PERMISSIVE_LICENSES = new Set([
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  '0BSD',
  'BlueOak-1.0.0',
]);
const LICENSE_FILE = /^(?:licen[cs]e|copying|notice)(?:[.-].*)?$/i;

/** Repository-relative manifests whose version follows package.json. */
const PLUGIN_MANIFESTS = ['plugin/.claude-plugin/plugin.json', 'plugin/.cursor-plugin/plugin.json'];
const MARKETPLACE_MANIFESTS = [
  '.claude-plugin/marketplace.json',
  '.cursor-plugin/marketplace.json',
];

/**
 * Machine paths that must never reach the committed bundle: building twice on
 * two machines has to give the same bytes.
 */
async function machinePaths(): Promise<string[]> {
  const paths = [REPO_ROOT, homedir(), tmpdir()];
  const real = await Promise.all(paths.map((path) => realpath(path).catch(() => path)));
  return [...new Set([...paths, ...real])].filter((path) => path.length > 1);
}

/** The bundle, and the root folder of every package in node_modules that put code in it. */
async function bundleCli(): Promise<{ bundle: Buffer; packageDirs: string[] }> {
  const outDir = await mkdtemp(join(tmpdir(), 'llm-docs-plugin-'));

  try {
    const { bundles } = await build({
      config: false,
      entry: { [PLUGIN_NAME]: join(REPO_ROOT, 'src', 'cli.ts') },
      outDir,
      outExtensions: () => ({ js: '.mjs' }),
      format: 'esm',
      platform: 'node',
      target: 'node22',
      deps: { alwaysBundle: [/./] },
      sourcemap: false,
      dts: false,
      minify: true,
      clean: false,
      logLevel: 'warn',
      report: false,
      // jsonc-parser's main entry is a UMD build whose require() calls the bundler
      // cannot follow; its module entry is plain ESM.
      inputOptions: { resolve: { mainFields: ['module', 'main'] } },
      outputOptions: { codeSplitting: false },
    });
    const bundle = await readFile(join(outDir, `${PLUGIN_NAME}.mjs`));
    const text = bundle.toString('utf-8');

    for (const path of await machinePaths()) {
      if (text.includes(path) || text.includes(path.replaceAll('\\', '/'))) {
        throw new Error(`The bundle contains the machine path ${path}; it must be portable.`);
      }
    }

    const packageDirs = new Set<string>();
    for (const chunk of bundles.flatMap((entry) => entry.chunks)) {
      for (const [id, module] of Object.entries(chunk.type === 'chunk' ? chunk.modules : {})) {
        // The last node_modules segment names the package, nested installs included.
        const dir = /^(.*[\\/]node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+)/.exec(id)?.[1];
        if (dir !== undefined && module.renderedLength > 0) {
          packageDirs.add(dir);
        }
      }
    }
    return { bundle, packageDirs: [...packageDirs] };
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

/**
 * plugin/THIRD_PARTY_NOTICES.md: the name, version, license, repository, and
 * license file text of every package bundled into the CLI, sorted by name.
 * Throws for a package with no license file or a license outside
 * PERMISSIVE_LICENSES, so a new dependency cannot ship unreviewed.
 */
export async function thirdPartyNotices(packageDirs: readonly string[]): Promise<Buffer> {
  const packages = await Promise.all(
    packageDirs.map(async (dir) => {
      const manifest: unknown = JSON.parse(await readFile(join(dir, 'package.json'), 'utf-8'));

      if (
        !isRecord(manifest) ||
        typeof manifest.name !== 'string' ||
        typeof manifest.version !== 'string'
      ) {
        throw new Error(`A bundled package's package.json has no name or version (${dir}).`);
      }
      const { name, version, license } = manifest;

      if (typeof license !== 'string' || !PERMISSIVE_LICENSES.has(license)) {
        throw new Error(
          `${name} ${version} is bundled into the plugin under license ${JSON.stringify(license ?? null)}, which is not in PERMISSIVE_LICENSES in scripts/build-plugin.ts; review its terms before adding it there, or stop bundling it.`
        );
      }

      const licenseFiles = (await readdir(dir, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && LICENSE_FILE.test(entry.name))
        .map((entry) => entry.name)
        .sort(compareStringsByCodeUnit);

      if (licenseFiles.length === 0) {
        throw new Error(
          `${name} ${version} is bundled into the plugin but ships no LICENSE, COPYING, or NOTICE file, so the bundle cannot carry its notice; find its license text upstream or stop bundling it.`
        );
      }

      const texts = await Promise.all(
        licenseFiles.map((file) => readFile(join(dir, file), 'utf-8'))
      );
      const repository = isRecord(manifest.repository)
        ? manifest.repository.url
        : manifest.repository;

      return {
        name,
        version,
        license,
        repository: typeof repository === 'string' ? repository : 'not given',
        text: texts.map((text) => text.replace(/\r\n?/g, '\n').trim()).join('\n\n'),
      };
    })
  );

  packages.sort(
    (a, b) =>
      compareStringsByCodeUnit(a.name, b.name) || compareStringsByCodeUnit(a.version, b.version)
  );

  const sections = packages.map(({ name, version, license, repository, text }) => {
    const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
    const fence = '`'.repeat(Math.max(3, longest + 1));
    return `## ${name} ${version}\n\nLicense: ${license}. Repository: ${repository}\n\n${fence}text\n${text}\n${fence}\n`;
  });

  return Buffer.from(
    `# Third-party notices\n\n` +
      `\`bin/llm-docs.mjs\` bundles the packages below. \`npm run build:plugin\` writes this file from each package's \`package.json\` and license files; do not edit it by hand.\n\n` +
      sections.join('\n')
  );
}

/** Every generated file, keyed by its repository-relative POSIX path. */
export async function renderPlugin(): Promise<Map<string, Buffer>> {
  const { bundle, packageDirs } = await bundleCli();
  const files = new Map<string, Buffer>([
    [BUNDLE_PATH, bundle],
    [NOTICES_PATH, await thirdPartyNotices(packageDirs)],
  ]);

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
