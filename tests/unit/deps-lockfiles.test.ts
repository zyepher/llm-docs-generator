import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  findDependencyVersion,
  lockfileEcosystem,
  normalizePypiName,
  parsePep508Name,
  scanDependencies,
  swiftPackageIdentity,
  type DependencyScan,
  type ResolvedDependency,
} from '../../src/deps/lockfiles.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'deps');
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** One compact line per dependency so expectations read like the lockfile. */
function summarize(scan: DependencyScan): string[] {
  return scan.dependencies.map(
    (dependency) =>
      `${dependency.name}@${dependency.version} ${dependency.direct ? 'direct' : 'transitive'}${dependency.dev ? ' dev' : ''}`
  );
}

async function scanFixture(name: string): Promise<DependencyScan> {
  return scanDependencies(join(FIXTURES, name));
}

async function makeProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'llm-docs-deps-'));
  tempDirs.push(root);

  for (const [path, content] of Object.entries(files)) {
    const target = join(root, ...path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }

  return root;
}

describe('npm lockfiles', () => {
  it('reads package-lock v3 with workspaces, hoisting, nesting, aliases, git, links, and tarballs', async () => {
    const scan = await scanFixture('npm-v3-workspaces');

    expect(scan.lockfiles).toEqual(['package-lock.json']);
    expect(summarize(scan)).toEqual([
      '@types/node@20.11.5 direct dev',
      'js-tokens@4.0.0 transitive',
      'loose-envify@1.4.0 transitive',
      'old-lib@2.0.0 transitive',
      'react@17.0.2 transitive',
      'react@18.2.0 direct',
      'undici-types@5.26.5 transitive dev',
      'zod@3.22.4 direct',
    ]);
    expect(scan.dependencies.every((dependency) => dependency.ecosystem === 'npm')).toBe(true);
    expect(scan.warnings).toEqual([
      'Skipped 4 non-registry dependencies (alias, git, url, workspace): package-lock.json: @acme/app (workspace); package-lock.json: left-pad (git); package-lock.json: lodash (alias); package-lock.json: tarball-only (url).',
    ]);
  });

  it('reads package-lock v1 nested trees with package.json directness', async () => {
    const scan = await scanFixture('npm-v1');

    expect(summarize(scan)).toEqual([
      'debug@2.6.9 transitive',
      'debug@4.3.1 transitive dev',
      'express@4.17.1 direct',
      'mocha@8.2.1 direct dev',
    ]);
    expect(scan.warnings).toEqual([
      'Skipped 3 non-registry dependencies (alias, git, path): package-lock.json: left-pad (git); package-lock.json: my-utils (path); package-lock.json: strip (alias).',
    ]);
  });

  it('reads npm-shrinkwrap.json (lockfile v2) from its packages map', async () => {
    const scan = await scanFixture('npm-shrinkwrap-v2');

    expect(scan.lockfiles).toEqual(['npm-shrinkwrap.json']);
    expect(summarize(scan)).toEqual(['commander@12.1.0 direct']);
    expect(scan.warnings).toEqual([]);
  });

  it('reads pnpm v6 single-package lockfiles, stripping peer suffixes', async () => {
    const scan = await scanFixture('pnpm-v6');

    expect(summarize(scan)).toEqual([
      '@babel/core@7.23.2 direct dev',
      'js-tokens@4.0.0 transitive',
      'loose-envify@1.4.0 transitive',
      'react@18.2.0 direct',
      'react-dom@18.2.0 direct',
      'scheduler@0.23.0 transitive',
      'string-width@4.2.3 transitive',
    ]);
    expect(scan.warnings).toEqual([
      'Skipped 3 non-registry dependencies (alias, git, path): pnpm-lock.yaml: shared-utils (path); pnpm-lock.yaml: string-width-cjs (alias); pnpm-lock.yaml: tiny-lib (git).',
    ]);
  });

  it('reads pnpm v9 workspace importers with nested peer suffixes', async () => {
    const scan = await scanFixture('pnpm-v9');

    expect(summarize(scan)).toEqual([
      '@tanstack/query-core@5.40.0 transitive',
      '@tanstack/react-query@5.40.0 direct',
      'js-tokens@4.0.0 transitive',
      'loose-envify@1.4.0 transitive',
      'next@15.0.0 direct',
      'react@18.3.1 direct',
      'react-dom@18.3.1 transitive',
      'string-width@4.2.3 transitive',
      'typescript@5.4.5 direct dev',
    ]);
    expect(scan.warnings).toHaveLength(1);
    expect(scan.warnings[0]).toContain('@acme/shared (path)');
    expect(scan.warnings[0]).toContain('string-width-cjs (alias)');
    expect(scan.warnings[0]).toContain('untar (git)');
  });

  it('accepts pnpm lockfile v7 headers and rejects v5 with a warning', async () => {
    const v7 = await makeProject({
      'pnpm-lock.yaml': [
        "lockfileVersion: '7.0'",
        '',
        'importers:',
        '  .:',
        '    dependencies:',
        '      vite:',
        '        specifier: ^6.0.0',
        '        version: 6.0.1(@types/node@22.9.0)',
        '',
        'packages:',
        '  vite@6.0.1:',
        '    resolution: {integrity: sha512-x}',
        '',
      ].join('\n'),
    });
    const v5 = await makeProject({
      'pnpm-lock.yaml': 'lockfileVersion: 5.4\n\nspecifiers:\n  vite: ^4.0.0\n',
    });

    expect(summarize(await scanDependencies(v7))).toEqual(['vite@6.0.1 direct']);
    expect((await scanDependencies(v5)).warnings).toEqual([
      'pnpm-lock.yaml: pnpm lockfileVersion 5.4 is not supported (6.0 or later is); skipped.',
    ]);
  });

  it('reads yarn classic lockfiles with workspace members and descriptor-exact directness', async () => {
    const scan = await scanFixture('yarn-classic');

    expect(summarize(scan)).toEqual([
      '@babel/core@7.23.2 direct dev',
      'class-variance-authority@0.7.0 direct',
      'lodash@3.10.1 transitive',
      'lodash@4.17.21 direct',
    ]);
    expect(scan.warnings).toEqual([
      'Skipped 3 non-registry dependencies (alias, git, path): yarn.lock: left-pad (git); yarn.lock: local-thing (path); yarn.lock: string-width-cjs (alias).',
    ]);
  });

  it('reads yarn berry lockfiles, unwrapping patch: resolutions', async () => {
    const scan = await scanFixture('yarn-berry');

    expect(summarize(scan)).toEqual(['lodash@4.17.21 direct', 'typescript@5.4.5 direct dev']);
    expect(scan.warnings).toEqual([
      'Skipped 3 non-registry dependencies (alias, git, workspace): yarn.lock: @acme/ui (workspace); yarn.lock: react-icons (git); yarn.lock: string-width-cjs (alias).',
    ]);
  });

  it('reads bun.lock (JSONC with trailing commas) and reports bun.lockb as unsupported', async () => {
    const scan = await scanFixture('bun');

    expect(scan.lockfiles).toEqual(['bun.lock', 'legacy/bun.lockb']);
    expect(summarize(scan)).toEqual([
      '@types/bun@1.1.13 direct dev',
      'bun-types@1.1.34 transitive',
      'hono@4.6.9 direct',
      'zod@3.23.8 direct',
    ]);
    expect(scan.warnings).toEqual([
      'Skipped 3 non-registry dependencies (alias, git, workspace): bun.lock: @acme/api (workspace); bun.lock: str (alias); bun.lock: tiny (git).',
      'legacy/bun.lockb: unsupported lockfile, the binary bun.lockb format is not supported; run `bun install --save-text-lockfile` to produce bun.lock.',
    ]);
  });
});

describe('Python lockfiles', () => {
  it('reads uv.lock with pyproject groups and uv workspace members', async () => {
    const scan = await scanFixture('python-uv');

    expect(summarize(scan)).toEqual([
      'anyio@4.6.2.post1 transitive',
      'fastapi@0.115.4 direct',
      'httpx@0.27.2 direct',
      'pydantic@2.9.2 transitive',
      'pydantic-settings@2.6.1 direct',
      'pytest@8.3.3 direct dev',
      'redis@5.2.0 direct',
      'ruff@0.7.2 direct dev',
      'starlette@0.41.2 transitive',
    ]);
    expect(scan.dependencies.every((dependency) => dependency.ecosystem === 'pypi')).toBe(true);
    expect(scan.warnings).toEqual([
      'Skipped 1 non-registry dependency (git): uv.lock: internal-sdk (git).',
    ]);
  });

  it('reads poetry.lock, excluding python and git sources', async () => {
    const scan = await scanFixture('python-poetry');

    expect(summarize(scan)).toEqual([
      'asgiref@3.8.1 transitive',
      'black@24.10.0 direct dev',
      'django@5.1.2 direct',
      'pytest@8.3.3 direct dev',
      'requests@2.32.3 direct',
    ]);
    expect(scan.warnings).toEqual([
      'Skipped 1 non-registry dependency (git): poetry.lock: my-fork (git).',
    ]);
  });

  it('reads pdm.lock, merging extras entries and using groups for transitive dev', async () => {
    const scan = await scanFixture('python-pdm');

    expect(summarize(scan)).toEqual([
      'flask@3.0.3 direct',
      'h2@4.1.0 transitive',
      'httpx@0.27.2 direct',
      'iniconfig@2.0.0 transitive dev',
      'pytest@8.3.3 direct dev',
    ]);
  });

  it('reads Pipfile.lock with Pipfile directness and PEP 503 names', async () => {
    const scan = await scanFixture('python-pipenv');

    expect(summarize(scan)).toEqual([
      'certifi@2024.8.30 transitive',
      'flask-login@0.6.3 direct',
      'pytest@8.3.3 direct dev',
      'requests@2.32.3 direct',
    ]);
    expect(scan.warnings).toEqual([
      'Skipped 2 non-registry dependencies (git, path): Pipfile.lock: local-pkg (path); Pipfile.lock: some-git-tool (git).',
    ]);
  });

  it('reads only exact pins from requirements files', async () => {
    const scan = await scanFixture('python-requirements');

    expect(scan.lockfiles).toEqual(['requirements-dev.txt', 'requirements.txt']);
    expect(
      scan.dependencies.map(
        (dependency) =>
          `${dependency.name}@${dependency.version} ${dependency.lockfile}${dependency.dev ? ' dev' : ''}`
      )
    ).toEqual([
      'certifi@2024.8.30 requirements.txt',
      'django@5.1.2 requirements.txt',
      'pytest@8.3.3 requirements-dev.txt dev',
      'requests@2.32.3 requirements.txt',
      'zope-interface@7.1.1 requirements.txt',
    ]);
    expect(scan.dependencies.every((dependency) => dependency.direct)).toBe(true);
  });

  it('parses PEP 508 names and PEP 503 normalization', () => {
    expect(parsePep508Name('FastAPI[standard]>=0.115')).toBe('fastapi');
    expect(parsePep508Name("pydantic_settings ; python_version >= '3.12'")).toBe(
      'pydantic-settings'
    );
    expect(parsePep508Name('zope.interface==7.1.1')).toBe('zope-interface');
    expect(parsePep508Name('  ')).toBeUndefined();
    expect(normalizePypiName('Foo__Bar.baz')).toBe('foo-bar-baz');
  });

  it('warns when the manifest that decides directness is missing', async () => {
    const root = await makeProject({
      'uv.lock':
        'version = 1\n\n[[package]]\nname = "Requests"\nversion = "2.32.3"\nsource = { registry = "https://pypi.org/simple" }\n',
    });
    const scan = await scanDependencies(root);

    expect(summarize(scan)).toEqual(['requests@2.32.3 transitive']);
    expect(scan.warnings).toEqual([
      'uv.lock: no pyproject.toml next to the lockfile, so no dependency is marked direct.',
    ]);
  });
});

describe('Cargo, Go, pub, and SwiftPM', () => {
  it('reads Cargo.lock v4 workspaces with renamed, dev, target, and ambiguous dependencies', async () => {
    const scan = await scanFixture('cargo-workspace');

    expect(summarize(scan)).toEqual([
      'clap@4.5.20 direct',
      'insta@1.41.1 direct dev',
      'rand@0.7.3 transitive',
      'rand@0.8.5 direct',
      'serde@1.0.214 direct',
      'serde_json@1.0.132 direct',
      'windows-sys@0.59.0 direct',
    ]);
    expect(scan.warnings).toEqual([
      'Skipped 3 non-registry dependencies (alternate-registry, git, path): Cargo.lock: internal-macros (git); Cargo.lock: local-helper (path); Cargo.lock: private-crate (alternate-registry).',
    ]);
  });

  it('reads Cargo.lock v1 fully qualified dependency references', async () => {
    const scan = await scanFixture('cargo-v1');

    expect(summarize(scan)).toEqual(['libc@0.2.66 direct']);
    expect(scan.warnings).toEqual([]);
  });

  it('reads go.mod require blocks, single requires, indirect markers, and replace directives', async () => {
    const scan = await scanFixture('go-module');

    expect(summarize(scan)).toEqual([
      'github.com/BurntSushi/toml@v1.4.0 direct',
      'github.com/go-chi/chi/v5@v5.1.0 direct',
      'github.com/google/uuid@v1.6.0 direct',
      'golang.org/x/sync@v0.8.0 transitive',
      'golang.org/x/text@v0.0.0-20240909161429-701f63a606c0 transitive',
      'gopkg.in/yaml.v3@v3.0.1 transitive',
    ]);
    expect(
      scan.dependencies.find((dependency) => dependency.name === 'github.com/go-chi/chi/v5')
        ?.repositoryUrl
    ).toBe('https://github.com/go-chi/chi');
    expect(
      scan.dependencies.find((dependency) => dependency.name === 'golang.org/x/sync')?.repositoryUrl
    ).toBeUndefined();
    expect(scan.warnings).toEqual([
      'Skipped 1 non-registry dependency (replaced): go.mod: example.com/forked (replaced).',
    ]);
  });

  it('reads pubspec.lock, keeping hosted pub.dev packages only', async () => {
    const scan = await scanFixture('pub-app');

    expect(summarize(scan)).toEqual([
      'async@2.11.0 transitive',
      'flutter_lints@5.0.0 direct dev',
      'http@1.2.2 direct',
    ]);
    expect(scan.warnings).toEqual([
      'Skipped 3 non-registry dependencies (alternate-registry, git, path): pubspec.lock: internal_ui (path); pubspec.lock: private_pkg (alternate-registry); pubspec.lock: riverpod (git).',
    ]);
  });

  it('reads Package.resolved v3 with Package.swift directness and skips revision-only pins', async () => {
    const scan = await scanFixture('swift-package');

    expect(summarize(scan)).toEqual([
      'swift-argument-parser@1.5.0 direct',
      'swift-custom-dump@1.3.3 transitive',
      'swift-snapshot-testing@1.17.5 direct',
    ]);
    expect(scan.dependencies[0]?.repositoryUrl).toBe(
      'https://github.com/apple/swift-argument-parser.git'
    );
    expect(scan.warnings).toEqual([
      'Skipped 1 non-registry dependency (revision-only): Package.resolved: swift-on-a-branch (revision-only).',
    ]);
  });

  it('reads Package.resolved v1 inside an Xcode project, treating every pin as direct', async () => {
    const scan = await scanFixture('swift-xcode');
    const lockfile = 'App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved';

    expect(scan.lockfiles).toEqual([lockfile]);
    expect(summarize(scan)).toEqual(['alamofire@5.9.1 direct', 'kingfisher@7.12.0 direct']);
    expect(scan.warnings).toEqual([
      `${lockfile}: no parsable Package.swift next to Package.resolved; every pin is treated as a direct dependency.`,
    ]);
  });

  it('reads Package.resolved v2 and falls back when Package.swift computes its URLs', async () => {
    const root = await makeProject({
      'Package.swift':
        'let base = "https://github.com/apple"\nlet package = Package(name: "X", dependencies: [.package(url: base + "/swift-nio.git", from: "2.0.0")])\n',
      'Package.resolved': JSON.stringify({
        pins: [
          {
            identity: 'swift-nio',
            kind: 'remoteSourceControl',
            location: 'https://github.com/apple/swift-nio.git',
            state: { revision: 'abc', version: '2.76.1' },
          },
        ],
        version: 2,
      }),
    });
    const scan = await scanDependencies(root);

    expect(summarize(scan)).toEqual(['swift-nio@2.76.1 direct']);
    expect(scan.warnings).toEqual([
      'Package.resolved: no parsable Package.swift next to Package.resolved; every pin is treated as a direct dependency.',
    ]);
  });

  it('derives SwiftPM identities from repository URLs', () => {
    expect(swiftPackageIdentity('https://github.com/Alamofire/Alamofire.git')).toBe('alamofire');
    expect(swiftPackageIdentity('git@github.com:apple/swift-nio.git')).toBe('swift-nio');
    expect(swiftPackageIdentity('https://github.com/onevcat/Kingfisher/')).toBe('kingfisher');
  });
});

describe('scanDependencies walking', () => {
  it('skips vendored trees, virtualenvs, SwiftPM checkouts, the packs directory, and deep paths', async () => {
    const root = await makeProject({
      'requirements.txt': 'flask==3.0.3\n',
      'services/api/requirements.txt': 'fastapi==0.115.4\n',
      'node_modules/pkg/requirements.txt': 'ghost-a==1.0.0\n',
      '.venv/lib/requirements.txt': 'ghost-b==1.0.0\n',
      '.build/checkouts/x/requirements.txt': 'ghost-c==1.0.0\n',
      'docs/agent-docs/vite/requirements.txt': 'ghost-d==1.0.0\n',
      'a/b/c/d/e/f/g/requirements.txt': 'ghost-e==1.0.0\n',
      'a/b/c/d/e/requirements.txt': 'shallow-enough==1.0.0\n',
    });
    const scan = await scanDependencies(root, { skipDirectories: ['./docs/agent-docs/'] });

    expect(scan.lockfiles).toEqual([
      'a/b/c/d/e/requirements.txt',
      'requirements.txt',
      'services/api/requirements.txt',
    ]);
    expect(scan.dependencies.map((dependency) => dependency.name)).toEqual([
      'fastapi',
      'flask',
      'shallow-enough',
    ]);
  });

  it('honors maxDepth', async () => {
    const root = await makeProject({
      'requirements.txt': 'flask==3.0.3\n',
      'nested/requirements.txt': 'fastapi==0.115.4\n',
    });

    expect((await scanDependencies(root, { maxDepth: 0 })).lockfiles).toEqual(['requirements.txt']);
  });

  it('turns an unparsable lockfile into a warning and keeps scanning', async () => {
    const root = await makeProject({
      'package-lock.json': '{ not json',
      'sub/requirements.txt': 'flask==3.0.3\n',
    });
    const scan = await scanDependencies(root);

    expect(scan.lockfiles).toEqual(['package-lock.json', 'sub/requirements.txt']);
    expect(summarize(scan)).toEqual(['flask@3.0.3 direct']);
    expect(scan.warnings).toHaveLength(1);
    expect(scan.warnings[0]).toMatch(/^package-lock\.json: could not be parsed: /);
  });

  it('returns an empty scan for a project without lockfiles', async () => {
    const root = await makeProject({ 'README.md': '# nothing\n' });

    expect(await scanDependencies(root)).toEqual({ dependencies: [], lockfiles: [], warnings: [] });
  });
});

describe('findDependencyVersion', () => {
  const dependency = (overrides: Partial<ResolvedDependency>): ResolvedDependency => ({
    ecosystem: 'npm',
    name: 'vite',
    version: '6.0.0',
    direct: true,
    dev: false,
    lockfile: 'package-lock.json',
    ...overrides,
  });

  it('finds one version across lockfiles', () => {
    const scan = {
      dependencies: [
        dependency({}),
        dependency({ lockfile: 'apps/web/pnpm-lock.yaml' }),
        dependency({ version: '5.4.0', direct: false }),
      ],
      lockfiles: ['apps/web/pnpm-lock.yaml', 'package-lock.json'],
    };

    expect(findDependencyVersion(scan, { ecosystem: 'npm', name: 'vite' })).toEqual({
      kind: 'found',
      version: '6.0.0',
      lockfiles: ['apps/web/pnpm-lock.yaml', 'package-lock.json'],
    });
  });

  it('falls back to transitive entries when nothing declares the dependency', () => {
    const scan = {
      dependencies: [dependency({ direct: false, version: '5.4.0' })],
      lockfiles: ['package-lock.json'],
    };

    expect(findDependencyVersion(scan, { ecosystem: 'npm', name: 'vite' })).toEqual({
      kind: 'found',
      version: '5.4.0',
      lockfiles: ['package-lock.json'],
    });
  });

  it('reports conflicting direct versions with their lockfiles', () => {
    const scan = {
      dependencies: [
        dependency({}),
        dependency({ version: '5.4.0', lockfile: 'legacy/package-lock.json' }),
      ],
      lockfiles: ['legacy/package-lock.json', 'package-lock.json'],
    };

    expect(findDependencyVersion(scan, { ecosystem: 'npm', name: 'vite' })).toEqual({
      kind: 'conflict',
      versions: [
        { version: '5.4.0', lockfile: 'legacy/package-lock.json' },
        { version: '6.0.0', lockfile: 'package-lock.json' },
      ],
    });
  });

  it('reports the lockfiles of the ecosystem that were searched when missing', () => {
    const scan = {
      dependencies: [dependency({})],
      lockfiles: ['package-lock.json', 'requirements.txt', 'uv.lock'],
    };

    expect(findDependencyVersion(scan, { ecosystem: 'pypi', name: 'Django' })).toEqual({
      kind: 'missing',
      searched: ['requirements.txt', 'uv.lock'],
    });
  });

  it('matches PyPI names after PEP 503 normalization', () => {
    const scan = {
      dependencies: [
        dependency({
          ecosystem: 'pypi',
          name: 'pydantic-settings',
          version: '2.6.1',
          lockfile: 'uv.lock',
        }),
      ],
      lockfiles: ['uv.lock'],
    };

    expect(findDependencyVersion(scan, { ecosystem: 'pypi', name: 'Pydantic_Settings' })).toEqual({
      kind: 'found',
      version: '2.6.1',
      lockfiles: ['uv.lock'],
    });
  });

  it('maps lockfile names to ecosystems', () => {
    expect(lockfileEcosystem('a/yarn.lock')).toBe('npm');
    expect(lockfileEcosystem('requirements-test.txt')).toBe('pypi');
    expect(lockfileEcosystem('x/Package.resolved')).toBe('swiftpm');
    expect(lockfileEcosystem('README.md')).toBeUndefined();
  });
});
