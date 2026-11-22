/**
 * discover --package: spec parsing, repository URL normalization, tag
 * matching, Markdown directory ranking, registry metadata for every
 * ecosystem against a local server, the full flow against a file://
 * repository, and every failure recorded as evidence.
 */

import { execFile } from 'node:child_process';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfigError } from '../../src/config/project.js';
import {
  changeDocumentPattern,
  describePackageDiscovery,
  discoverPackage,
  findChangeDocuments,
  latestSemverTag,
  matchVersionTags,
  normalizeRepositoryUrl,
  parsePackageSpec,
  rankMarkdownDirectories,
  tagDateWarnings,
  type PackageDiscovery,
} from '../../src/core/package-discovery.js';
import {
  fetchPackageMetadata,
  type PackageMetadataQuery,
  type RegistryEndpoints,
} from '../../src/deps/registries.js';
import {
  ALLOW_PRIVATE_NETWORK_ENV,
  createHttpClient,
  HttpRequestError,
} from '../../src/sources/http.js';

const execFileAsync = promisify(execFile);
const cleanups: (() => Promise<void>)[] = [];

beforeEach(() => {
  vi.stubEnv(ALLOW_PRIVATE_NETWORK_ENV, '1');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function json(value: unknown): (response: ServerResponse) => void {
  return (response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  };
}

/** A registry stand-in: unknown paths answer 404, like the real registries. */
async function startRegistry(
  routes: Record<string, (response: ServerResponse) => void>
): Promise<{ endpoints: RegistryEndpoints; base: string }> {
  const server: Server = createServer((request, response) => {
    const route = routes[request.url ?? ''];
    if (route === undefined) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{}');
      return;
    }
    route(response);
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const { port } = server.address() as AddressInfo;
  cleanups.push(
    () =>
      new Promise<void>((resolveClose) => {
        server.closeAllConnections();
        server.close(() => resolveClose());
      })
  );
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    endpoints: {
      depsDev: `${base}/depsdev`,
      npmRegistry: `${base}/npm`,
      pypi: `${base}/pypi-host`,
      cratesIo: `${base}/crates`,
      goProxy: `${base}/goproxy`,
      pubDev: `${base}/pub`,
      githubApi: `${base}/github`,
    },
  };
}

async function metadataFor(query: PackageMetadataQuery, endpoints: RegistryEndpoints) {
  const client = createHttpClient();
  try {
    return await fetchPackageMetadata(query, { client, endpoints });
  } finally {
    await client.close();
  }
}

/** Plain git for building fixtures, isolated from the developer's config. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  return gitAt(cwd, undefined, ...args);
}

/** `git` with the author and committer dates pinned, when `date` is given. */
async function gitAt(cwd: string, date: string | undefined, ...args: string[]): Promise<string> {
  const config = join(cwd, '..', 'fixture-gitconfig');
  await writeFile(config, '');
  const { stdout } = await execFileAsync('git', ['-c', 'protocol.file.allow=always', ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      ...(date === undefined ? {} : { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }),
    },
  });
  return stdout.trim();
}

const V1_DATE = '2024-01-15T12:00:00+01:00';
const V11_DATE = '2024-03-01T09:30:00+01:00';

/**
 * A repository standing in for an upstream: v1.0.0 (annotated) and widget@1.0.0
 * on the first commit (committed V1_DATE), v1.1.0 (lightweight) on the second
 * (committed V11_DATE).
 */
async function makeUpstream(): Promise<{ url: string; v1: string; v11: string }> {
  const dir = join(await temp('llm-docs-upstream-'), 'widget');
  await mkdir(dir);
  const files: Record<string, string> = {
    'README.md': '# Widget\n',
    'docs/index.md': '# Docs\n',
    'docs/guide/start.md': '# Start\n',
    'docs/guide/deploy.mdx': '# Deploy\n',
    'docs/api/client.md': '# Client\n',
    'site/content/en/intro/a.md': '# A\n',
    'site/content/en/intro/b.md': '# B\n',
    '.github/ISSUE_TEMPLATE.md': '# Issue\n',
    'src/index.ts': 'export {};\n',
    'CHANGELOG.md': '# Changelog\n',
  };
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, ...path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  await git(dir, 'init', '--quiet', '--initial-branch=main');
  await git(dir, 'add', '.');
  await gitAt(dir, V1_DATE, 'commit', '--quiet', '-m', 'v1');
  const v1 = await git(dir, 'rev-parse', 'HEAD');
  await git(dir, 'tag', '-a', 'v1.0.0', '-m', 'release 1.0.0');
  await git(dir, 'tag', 'widget@1.0.0');
  await writeFile(join(dir, 'docs', 'changes.md'), '# Changes\n');
  await git(dir, 'add', '.');
  await gitAt(dir, V11_DATE, 'commit', '--quiet', '-m', 'v1.1');
  const v11 = await git(dir, 'rev-parse', 'HEAD');
  await git(dir, 'tag', 'v1.1.0');
  return { url: pathToFileURL(dir).href, v1, v11 };
}

describe('parsePackageSpec', () => {
  it('reads the ecosystem, name, and optional version', () => {
    expect(parsePackageSpec('npm:@hono/node-server@1.13.0')).toEqual({
      ecosystem: 'npm',
      name: '@hono/node-server',
      version: '1.13.0',
    });
    expect(parsePackageSpec('npm:@hono/node-server')).toEqual({
      ecosystem: 'npm',
      name: '@hono/node-server',
      version: undefined,
    });
    expect(parsePackageSpec('go:github.com/BurntSushi/toml@v1.4.0')).toEqual({
      ecosystem: 'go',
      name: 'github.com/BurntSushi/toml',
      version: 'v1.4.0',
    });
    expect(parsePackageSpec('swiftpm:https://github.com/apple/swift-nio@2.65.0')).toEqual({
      ecosystem: 'swiftpm',
      name: 'https://github.com/apple/swift-nio',
      version: '2.65.0',
    });
    expect(parsePackageSpec('swiftpm:https://github.com/apple/swift-nio')).toMatchObject({
      version: undefined,
    });
  });

  it.each([
    ['hono', /--package must be <ecosystem>:<name>\[@<version>\]/],
    ['maven:junit', /with an ecosystem of npm, pypi, cargo, go, pub, swiftpm/],
    ['npm:', /--package must be/],
    ['npm:hono@', /version "" is not a version/],
    ['npm:hono@4 .1', /is not a version/],
    ['npm:../../evil', /is not a npm package name/],
    ['swiftpm:git@github.com:apple/swift-nio.git', /needs an https:\/\/ or file:\/\/ URL/],
    ['swiftpm:https://user:secret@example.com/repo', /without credentials/],
  ])('refuses %s as a usage error', (value, message) => {
    expect(() => parsePackageSpec(value)).toThrow(ConfigError);
    expect(() => parsePackageSpec(value)).toThrow(message);
  });
});

describe('normalizeRepositoryUrl', () => {
  it.each([
    ['git+https://github.com/honojs/hono.git', 'https://github.com/honojs/hono', null],
    ['git+ssh://git@github.com/honojs/hono.git', 'https://github.com/honojs/hono', null],
    ['ssh://git@github.com/honojs/hono', 'https://github.com/honojs/hono', null],
    ['git://github.com/honojs/hono.git', 'https://github.com/honojs/hono', null],
    ['git@github.com:honojs/hono.git', 'https://github.com/honojs/hono', null],
    ['http://github.com/encode/httpx/', 'https://github.com/encode/httpx', null],
    ['https://user@bitbucket.org/acme/widget.git', 'https://bitbucket.org/acme/widget', null],
    [
      'https://github.com/dart-lang/http/tree/master/pkgs/http',
      'https://github.com/dart-lang/http',
      'pkgs/http',
    ],
    ['https://github.com/acme/widget#readme', 'https://github.com/acme/widget', null],
    [
      'https://gitlab.com/group/sub/project/-/tree/main',
      'https://gitlab.com/group/sub/project',
      null,
    ],
    ['https://go.googlesource.com/net', 'https://go.googlesource.com/net', null],
  ])('%s', (declared, url, directory) => {
    expect(normalizeRepositoryUrl(declared)).toEqual({ url, directory });
  });

  it.each([
    ['file:///etc/repo', /uses file:; only repositories reachable over https:\/\/ are inspected/],
    ['svn://svn.example.org/widget', /uses svn:/],
    ['not a url', /is not a URL/],
    ['https://github.com/acme', /does not name a repository on github\.com/],
  ])('refuses %s', (declared, message) => {
    const result = normalizeRepositoryUrl(declared);
    expect('refused' in result && result.refused).toMatch(message);
  });
});

describe('matchVersionTags', () => {
  const tags = new Map(
    [
      'v1.2.3',
      '1.2.3',
      'widget@1.2.3',
      'widget-v1.2.3',
      '@acme/widget@1.2.3',
      'release-1.2.3',
      'v11.2.3',
      '11.2.3',
      'v1.2.3-beta.1',
      'dev1.2.3',
      'packages/widget/v1.2.3',
    ].map((tag, index) => [tag, String(index).padStart(40, '0')])
  );

  it('lists exact forms first in a fixed order, then separator-bounded suffixes sorted', () => {
    expect(
      matchVersionTags(tags, '1.2.3', 'widget', 'packages/widget').map(({ tag, form }) => [
        tag,
        form,
      ])
    ).toEqual([
      ['v1.2.3', 'v-prefixed'],
      ['1.2.3', 'bare'],
      ['widget@1.2.3', 'name-at'],
      ['widget-v1.2.3', 'name-dash-v'],
      ['packages/widget/v1.2.3', 'directory'],
      ['@acme/widget@1.2.3', 'suffix'],
      ['release-1.2.3', 'suffix'],
    ]);
  });

  it('matches a v-prefixed version (Go) the same way and reports each commit', () => {
    const matches = matchVersionTags(tags, 'v1.2.3', 'github.com/acme/widget', null);
    expect(matches[0]).toEqual({ tag: 'v1.2.3', form: 'v-prefixed', commit: tags.get('v1.2.3') });
    expect(matches.map((match) => match.tag)).not.toContain('v11.2.3');
    expect(matchVersionTags(tags, '9.9.9', 'widget', null)).toEqual([]);
  });

  it('picks the highest release tag for a SwiftPM package with no version', () => {
    expect(
      latestSemverTag(
        new Map([
          ['1.9.0', 'a'],
          ['v1.10.0', 'b'],
          ['2.0.0-rc1', 'c'],
        ])
      )
    ).toBe('v1.10.0');
    expect(latestSemverTag(new Map([['main-snapshot', 'a']]))).toBeNull();
  });
});

describe('rankMarkdownDirectories', () => {
  it('ranks by Markdown count at any depth, skipping hidden paths and pass-through parents', () => {
    const blob = (path: string) => ({ mode: '100644', type: 'blob', path });
    const ranked = rankMarkdownDirectories([
      blob('README.md'),
      blob('docs/a.md'),
      blob('docs/guide/b.mdx'),
      blob('docs/guide/c.md'),
      blob('site/content/en/d.md'),
      blob('site/content/en/e.md'),
      blob('.changeset/f.md'),
      blob('src/index.ts'),
      { mode: '120000', type: 'blob', path: 'docs/link.md' },
    ]);
    expect(ranked).toEqual({
      markdownFiles: 6,
      directories: [
        { path: 'docs', markdownFiles: 3 },
        { path: 'docs/guide', markdownFiles: 2 },
        { path: 'site/content/en', markdownFiles: 2 },
      ],
    });
  });
});

describe('changeDocuments', () => {
  const blob = (path: string) => ({ mode: '100644', type: 'blob', path });

  it.each([
    ['CHANGELOG.md', 'changelog'],
    ['packages/core/CHANGES.rst', 'changes'],
    ['HISTORY.txt', 'history'],
    ['docs/releases.mdx', 'releases'],
    ['RELEASE_NOTES.md', 'release-notes'],
    ['docs/release-notes/v4.md', 'release-notes'],
    ['docs/ReleaseNotes.md', 'release-notes'],
    ['docs/guide/migration.md', 'migration'],
    ['docs/migrating-to-v4.md', 'migrating'],
    ['docs/migrate/index.md', 'migrate'],
    ['UPGRADE.md', 'upgrade'],
    ['docs/upgrading.md', 'upgrading'],
    ['docs/breaking-changes.md', 'changes'],
    ['docs/v4/breaking.md', 'breaking'],
    ['docs/whats-new.md', 'whats-new'],
    ["docs/what's-new/index.md", 'whats-new'],
    ['docs/upgrade-guide/changelog.md', 'changelog'],
  ])('accepts %s as %s', (path, pattern) => {
    expect(changeDocumentPattern(path)).toBe(pattern);
  });

  it.each([
    'src/changes.ts',
    'CHANGELOG',
    'docs/changelog.html',
    'docs/exchanges.md',
    'docs/changelogs.md',
    'docs/release.md',
    'docs/guide/start.md',
    'docs/new.md',
  ])('rejects %s', (path) => {
    expect(changeDocumentPattern(path)).toBeUndefined();
  });

  it('skips hidden paths, vendored trees, symlinks, and trees, ordered by depth then path', () => {
    const found = findChangeDocuments([
      blob('docs/guide/migration.md'),
      blob('docs/CHANGELOG.md'),
      blob('CHANGELOG.md'),
      blob('.changeset/history.md'),
      blob('docs/.vitepress/changelog.md'),
      blob('node_modules/x/CHANGELOG.md'),
      blob('packages/a/node_modules/y/HISTORY.md'),
      { mode: '120000', type: 'blob', path: 'UPGRADE.md' },
      { mode: '040000', type: 'tree', path: 'docs/migration.md' },
      blob('Changes.md'),
    ]);

    expect(found).toEqual({
      documents: [
        { path: 'CHANGELOG.md', pattern: 'changelog' },
        { path: 'Changes.md', pattern: 'changes' },
        { path: 'docs/CHANGELOG.md', pattern: 'changelog' },
        { path: 'docs/guide/migration.md', pattern: 'migration' },
      ],
      more: 0,
    });
  });

  it('lists at most 20 and counts the rest', () => {
    const paths = Array.from(
      { length: 23 },
      (_, index) => `packages/p${String(index).padStart(2, '0')}/CHANGELOG.md`
    );
    const found = findChangeDocuments([...paths].reverse().map(blob));

    expect(found.documents.map((document) => document.path)).toEqual(paths.slice(0, 20));
    expect(found.more).toBe(3);
  });
});

describe('fetchPackageMetadata', () => {
  it('reads npm version manifests, expanding repository shorthand', async () => {
    const { endpoints } = await startRegistry({
      '/npm/@acme%2Fwidget/latest': json({
        version: '2.0.0',
        repository: { url: 'git+https://github.com/acme/widget.git', directory: 'packages/w' },
        license: 'MIT',
      }),
      '/npm/@acme%2Fwidget/1.5.0': json({
        version: '1.5.0',
        repository: 'github:acme/widget',
        homepage: 'https://widget.dev',
        license: { type: 'ISC' },
      }),
      '/depsdev/v3/systems/npm/packages/%40acme%2Fwidget/versions/1.5.0': json({
        publishedAt: '2025-03-01T10:00:00Z',
      }),
    });

    expect(
      await metadataFor({ ecosystem: 'npm', name: '@acme/widget', version: '1.5.0' }, endpoints)
    ).toEqual({
      lookup: {
        status: 'found',
        source: 'npm-registry',
        metadata: {
          version: '1.5.0',
          latestVersion: '2.0.0',
          repository: {
            field: 'repository',
            url: 'https://github.com/acme/widget',
            directory: null,
          },
          homepage: 'https://widget.dev',
          documentationUrl: null,
          license: 'ISC',
          publishedAt: '2025-03-01T10:00:00.000Z',
        },
      },
      warnings: [],
    });

    const latest = await metadataFor(
      { ecosystem: 'npm', name: '@acme/widget', version: undefined },
      endpoints
    );
    expect(latest.lookup).toMatchObject({
      status: 'found',
      metadata: {
        version: '2.0.0',
        repository: { url: 'git+https://github.com/acme/widget.git', directory: 'packages/w' },
        publishedAt: null,
      },
    });
  });

  it('reads PyPI project_urls by label and the license name', async () => {
    const release = json({
      info: {
        version: '0.27.0',
        home_page: '',
        project_urls: {
          Changelog: 'https://github.com/encode/httpx/blob/master/CHANGELOG.md',
          Documentation: 'https://www.python-httpx.org',
          'Source Code': 'https://github.com/encode/httpx',
        },
        license: 'BSD-3-Clause',
      },
      urls: [{ upload_time_iso_8601: '2024-02-21T13:07:00.000000Z' }],
    });
    const { endpoints } = await startRegistry({
      '/pypi-host/pypi/httpx/0.27.0/json': release,
      '/pypi-host/pypi/httpx/json': json({
        info: {
          version: '0.28.1',
          project_urls: { Homepage: 'https://github.com/encode/httpx' },
          license: 'Copyright (c) 2019\nAll rights reserved.',
          classifiers: ['License :: OSI Approved :: BSD License'],
        },
      }),
    });

    expect(
      (await metadataFor({ ecosystem: 'pypi', name: 'httpx', version: '0.27.0' }, endpoints)).lookup
    ).toEqual({
      status: 'found',
      source: 'pypi',
      metadata: {
        version: '0.27.0',
        latestVersion: '0.28.1',
        repository: {
          field: 'project_urls.Source Code',
          url: 'https://github.com/encode/httpx',
          directory: null,
        },
        homepage: null,
        documentationUrl: 'https://www.python-httpx.org',
        license: 'BSD-3-Clause',
        publishedAt: '2024-02-21T13:07:00.000Z',
      },
    });

    const latest = await metadataFor(
      { ecosystem: 'pypi', name: 'httpx', version: undefined },
      endpoints
    );
    expect(latest.lookup).toMatchObject({
      status: 'found',
      metadata: {
        version: '0.28.1',
        // No source label: the forge-hosted homepage entry is the repository evidence.
        repository: { field: 'project_urls.Homepage', url: 'https://github.com/encode/httpx' },
        homepage: 'https://github.com/encode/httpx',
        // The license field holds license text, so the classifier names it.
        license: 'BSD License',
      },
    });
  });

  it('reads crates.io crate and version documents', async () => {
    const { endpoints } = await startRegistry({
      '/crates/api/v1/crates/serde': json({
        crate: {
          max_stable_version: '1.0.229',
          max_version: '1.0.230-beta',
          repository: 'https://github.com/serde-rs/serde',
          homepage: 'https://serde.rs',
          documentation: 'https://docs.rs/serde',
        },
      }),
      '/crates/api/v1/crates/serde/1.0.229': json({
        version: { license: 'MIT OR Apache-2.0', created_at: '2025-09-01T00:00:00Z' },
      }),
    });

    expect(
      (await metadataFor({ ecosystem: 'cargo', name: 'serde', version: undefined }, endpoints))
        .lookup
    ).toEqual({
      status: 'found',
      source: 'crates.io',
      metadata: {
        version: '1.0.229',
        latestVersion: '1.0.229',
        repository: {
          field: 'repository',
          url: 'https://github.com/serde-rs/serde',
          directory: null,
        },
        homepage: 'https://serde.rs',
        documentationUrl: 'https://docs.rs/serde',
        license: 'MIT OR Apache-2.0',
        publishedAt: '2025-09-01T00:00:00.000Z',
      },
    });
  });

  it('reads pub.dev pubspecs, with the license from score tags for the latest version only', async () => {
    const pubspec = {
      repository: 'https://github.com/dart-lang/http/tree/master/pkgs/http',
      documentation: 'https://pub.dev/documentation/http',
    };
    const { endpoints } = await startRegistry({
      '/pub/api/packages/http': json({
        latest: { version: '1.2.2', pubspec },
        versions: [
          { version: '1.2.1', pubspec, published: '2024-03-13T18:00:00.000Z' },
          { version: '1.2.2', pubspec, published: '2024-07-15T20:00:00.000Z' },
        ],
      }),
      '/pub/api/packages/http/score': json({
        tags: ['license:bsd-3-clause', 'license:osi-approved', 'license:fsf-libre', 'sdk:dart'],
      }),
    });

    expect(
      (await metadataFor({ ecosystem: 'pub', name: 'http', version: undefined }, endpoints)).lookup
    ).toEqual({
      status: 'found',
      source: 'pub.dev',
      metadata: {
        version: '1.2.2',
        latestVersion: '1.2.2',
        repository: { field: 'pubspec.repository', url: pubspec.repository, directory: null },
        homepage: null,
        documentationUrl: 'https://pub.dev/documentation/http',
        license: 'bsd-3-clause',
        publishedAt: '2024-07-15T20:00:00.000Z',
      },
    });
    expect(
      (await metadataFor({ ecosystem: 'pub', name: 'http', version: '1.2.1' }, endpoints)).lookup
    ).toMatchObject({
      metadata: { version: '1.2.1', license: null, publishedAt: '2024-03-13T18:00:00.000Z' },
    });
  });

  it('reads the Go module proxy Origin and the license from deps.dev', async () => {
    const info = json({
      Version: 'v1.4.0',
      Time: '2024-06-06T21:23:24Z',
      Origin: { VCS: 'git', URL: 'https://github.com/BurntSushi/toml', Subdir: 'v2' },
    });
    const { endpoints } = await startRegistry({
      '/goproxy/github.com/!burnt!sushi/toml/@latest': info,
      '/goproxy/github.com/!burnt!sushi/toml/@v/v1.4.0.info': info,
      '/depsdev/v3/systems/go/packages/github.com%2FBurntSushi%2Ftoml/versions/v1.4.0': json({
        licenses: ['MIT'],
        links: [{ label: 'SOURCE_REPO', url: 'https://github.com/BurntSushi/toml' }],
      }),
    });

    expect(
      (
        await metadataFor(
          { ecosystem: 'go', name: 'github.com/BurntSushi/toml', version: undefined },
          endpoints
        )
      ).lookup
    ).toEqual({
      status: 'found',
      source: 'proxy.golang.org',
      metadata: {
        version: 'v1.4.0',
        latestVersion: 'v1.4.0',
        repository: {
          field: 'Origin.URL',
          url: 'https://github.com/BurntSushi/toml',
          directory: 'v2',
        },
        homepage: null,
        documentationUrl: null,
        license: 'MIT',
        publishedAt: '2024-06-06T21:23:24.000Z',
      },
    });
  });
});

describe('discoverPackage', () => {
  it('lists the tags and Markdown directories of a file:// repository (SwiftPM identity)', async () => {
    const upstream = await makeUpstream();
    const discovery = await discoverPackage(parsePackageSpec(`swiftpm:${upstream.url}@1.0.0`));

    expect(discovery.package).toEqual({
      ecosystem: 'swiftpm',
      name: upstream.url,
      requestedVersion: '1.0.0',
      version: '1.0.0',
      versionSource: 'requested',
    });
    expect(discovery.registry.status).toBe('not-applicable');
    expect(discovery.repository).toEqual({ status: 'ok', url: upstream.url, directory: null });
    expect(discovery.tags).toEqual({
      status: 'matched',
      tagCount: 3,
      matches: [
        { tag: 'v1.0.0', form: 'v-prefixed', commit: upstream.v1, committerDate: V1_DATE },
        { tag: 'widget@1.0.0', form: 'name-at', commit: upstream.v1, committerDate: V1_DATE },
      ],
    });
    expect(discovery.docDirectories).toEqual({
      status: 'listed',
      tag: 'v1.0.0',
      commit: upstream.v1,
      markdownFiles: 8,
      directories: [
        { path: 'docs', markdownFiles: 4 },
        { path: 'docs/guide', markdownFiles: 2 },
        { path: 'site/content/en/intro', markdownFiles: 2 },
        { path: 'docs/api', markdownFiles: 1 },
      ],
    });
    expect(discovery.changeDocuments).toEqual({
      status: 'listed',
      tag: 'v1.0.0',
      commit: upstream.v1,
      documents: [{ path: 'CHANGELOG.md', pattern: 'changelog' }],
      more: 0,
    });
    // No registry, so no publish date to compare the commit dates with.
    expect(discovery.warnings).toEqual([
      '2 tags match 1.0.0; the directory listing uses v1.0.0, the first exact form.',
    ]);
    expect(describePackageDiscovery(discovery)).toEqual(
      expect.arrayContaining([
        `  tags: v1.0.0 (v-prefixed, committed ${V1_DATE}), widget@1.0.0 (name-at, committed ${V1_DATE})`,
        '  change documents at v1.0.0: CHANGELOG.md (changelog)',
      ])
    );

    const latest = await discoverPackage(parsePackageSpec(`swiftpm:${upstream.url}`));
    expect(latest.package).toMatchObject({ version: '1.1.0', versionSource: 'latest-tag' });
    expect(latest.tags).toMatchObject({ matches: [{ tag: 'v1.1.0', committerDate: V11_DATE }] });
    expect(latest.docDirectories).toMatchObject({
      tag: 'v1.1.0',
      commit: upstream.v11,
      markdownFiles: 9,
    });
    expect(latest.changeDocuments).toMatchObject({
      documents: [
        { path: 'CHANGELOG.md', pattern: 'changelog' },
        { path: 'docs/changes.md', pattern: 'changes' },
      ],
      more: 0,
    });
  });

  it('warns when a tag was committed more than 14 days from the version publish date', async () => {
    const upstream = await makeUpstream();
    const discovery = await discoverPackage(parsePackageSpec(`swiftpm:${upstream.url}@1.0.0`));
    // A registry-declared repository must be https://, so the publish date joins the file:// evidence here.
    const publishedOn = (publishedAt: string | null): PackageDiscovery => ({
      ...discovery,
      package: { ...discovery.package, ecosystem: 'npm', name: 'widget' },
      registry: {
        status: 'found',
        source: 'npm-registry',
        metadata: {
          version: '1.0.0',
          latestVersion: '1.0.0',
          repository: null,
          homepage: null,
          documentationUrl: null,
          license: null,
          publishedAt,
        },
      },
    });

    expect(tagDateWarnings(publishedOn('2026-10-03T10:11:01.000Z'))).toEqual([
      `Tag v1.0.0 was committed on 2024-01-15 but npm-registry published widget 1.0.0 on 2026-10-03, 992 days apart, so the tag (and the docDirectories and changeDocuments listed at it) may belong to another package from this repository, such as one under a former name. Check the package manifest at v1.0.0 before pinning it with 'llm-docs add --git ${upstream.url} --ref v1.0.0'.`,
      `Tag widget@1.0.0 was committed on 2024-01-15 but npm-registry published widget 1.0.0 on 2026-10-03, 992 days apart, so the tag may belong to another package from this repository, such as one under a former name. Check the package manifest at widget@1.0.0 before pinning it with 'llm-docs add --git ${upstream.url} --ref widget@1.0.0'.`,
    ]);
    expect(tagDateWarnings(publishedOn('2024-01-20T08:00:00.000Z'))).toEqual([]);
    expect(tagDateWarnings(publishedOn(null))).toEqual([]);
  });

  it('dates the commits of the first 10 matched tags and says which stay undated', async () => {
    const dir = join(await temp('llm-docs-upstream-'), 'monorepo');
    await mkdir(dir);
    await writeFile(join(dir, 'README.md'), '# Monorepo\n');
    await git(dir, 'init', '--quiet', '--initial-branch=main');
    await git(dir, 'add', '.');
    await gitAt(dir, V1_DATE, 'commit', '--quiet', '-m', 'first');
    const names = Array.from({ length: 12 }, (_, index) => `p${String(index).padStart(2, '0')}`);
    for (const name of names.slice(0, 10)) {
      await git(dir, 'tag', `${name}@2.0.0`);
    }
    await writeFile(join(dir, 'README.md'), '# Monorepo, later\n');
    await gitAt(dir, V11_DATE, 'commit', '--quiet', '-am', 'second');
    for (const name of names.slice(10)) {
      await git(dir, 'tag', `${name}@2.0.0`);
    }

    const discovery = await discoverPackage(
      parsePackageSpec(`swiftpm:${pathToFileURL(dir).href}@2.0.0`)
    );
    expect(discovery.tags.status === 'matched' && discovery.tags.matches).toEqual(
      names.map((name, index) => ({
        tag: `${name}@2.0.0`,
        form: 'suffix',
        commit: expect.stringMatching(/^[0-9a-f]{40}$/),
        committerDate: index < 10 ? V1_DATE : null,
      }))
    );
    expect(discovery.warnings).toEqual([
      "2 of the 12 tags matching 2.0.0 have committerDate null because their commits were not fetched (only the first 10 tags' commits are), so they were not compared with the publish date.",
    ]);
    expect(describePackageDiscovery(discovery).join('\n')).toContain(
      'p11@2.0.0 (suffix, committer date not read)'
    );
  });

  it('records an unknown package, an unknown version, and a missing repository as evidence', async () => {
    const { endpoints } = await startRegistry({
      '/crates/api/v1/crates/norepo': json({ crate: { max_stable_version: '0.1.0' } }),
      '/crates/api/v1/crates/norepo/0.1.0': json({ version: { license: 'MIT' } }),
    });

    const unknown = await discoverPackage(parsePackageSpec('cargo:nothing@1.0.0'), { endpoints });
    expect(unknown.registry).toEqual({ status: 'package-not-found', source: 'crates.io' });
    expect(unknown.repository).toEqual({
      status: 'missing',
      reason: 'crates.io has no package cargo:nothing.',
    });
    expect(unknown.tags.status).toBe('skipped');

    const noVersion = await discoverPackage(parsePackageSpec('cargo:norepo@9.9.9'), { endpoints });
    expect(noVersion.registry).toEqual({
      status: 'version-not-found',
      source: 'crates.io',
      latestVersion: '0.1.0',
    });
    expect(noVersion.repository).toMatchObject({
      status: 'missing',
      reason: 'crates.io has no version 9.9.9 of norepo; the latest is 0.1.0.',
    });

    const noRepo = await discoverPackage(parsePackageSpec('cargo:norepo'), { endpoints });
    expect(noRepo.package).toMatchObject({ version: '0.1.0', versionSource: 'registry-latest' });
    expect(noRepo.registry.status).toBe('found');
    expect(noRepo.repository).toEqual({
      status: 'missing',
      reason: 'The registry metadata names no repository.',
    });
  });

  it('refuses a non-https repository from registry metadata without running git', async () => {
    const upstream = await makeUpstream();
    const { endpoints } = await startRegistry({
      '/npm/widget/latest': json({ version: '1.0.0', repository: upstream.url }),
    });

    const discovery = await discoverPackage(parsePackageSpec('npm:widget'), { endpoints });
    expect(discovery.repository).toEqual({
      status: 'refused',
      declared: upstream.url,
      reason: expect.stringMatching(/uses file:; only repositories reachable over https:\/\//),
    });
    expect(discovery.tags.status).toBe('skipped');
  });

  it('records an unreachable repository and a version with no tag', async () => {
    const upstream = await makeUpstream();
    const { endpoints } = await startRegistry({
      '/npm/gone/latest': json({ version: '1.0.0', repository: 'https://127.0.0.1:9/gone.git' }),
    });

    const gone = await discoverPackage(parsePackageSpec('npm:gone'), { endpoints });
    expect(gone.repository).toEqual({
      status: 'ok',
      url: 'https://127.0.0.1:9/gone',
      directory: null,
    });
    expect(gone.tags).toEqual({
      status: 'unreachable',
      error: expect.stringMatching(/^git ls-remote failed for https:\/\/127\.0\.0\.1:9\/gone/),
    });

    const untagged = await discoverPackage(parsePackageSpec(`swiftpm:${upstream.url}@3.0.0`));
    expect(untagged.tags).toEqual({ status: 'no-match', tagCount: 3 });
    expect(untagged.docDirectories).toEqual({ status: 'skipped', reason: 'No tag names 3.0.0.' });
    expect(untagged.changeDocuments).toEqual({
      status: 'skipped',
      reason: 'No tree was listed at a matched tag; see docDirectories.',
    });
    expect(describePackageDiscovery(untagged).join('\n')).not.toContain('change documents');
  });

  it('throws when the registry itself cannot be reached', async () => {
    await expect(
      discoverPackage(parsePackageSpec('cargo:serde'), {
        endpoints: { cratesIo: 'http://127.0.0.1:9' },
      })
    ).rejects.toThrow(HttpRequestError);
  });
});
