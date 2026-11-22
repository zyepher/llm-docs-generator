import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { isDependencyName } from '../../src/deps/lockfiles.js';
import {
  isToolchainFile,
  minimumOf,
  readToolchainVersions,
  selectToolchainVersions,
  toolchainFeatureRelease,
  toolchainFileNames,
  toolchainVersion,
  TOOLCHAINS,
  type Toolchain,
} from '../../src/deps/toolchains.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'llm-docs-toolchains-'));
  tempDirs.push(root);

  for (const [path, content] of Object.entries(files)) {
    const target = join(root, ...path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }

  return root;
}

/** Read every given file as a scan would, one compact line per resolved toolchain. */
async function readProject(
  files: Record<string, string>
): Promise<{ lines: string[]; warnings: string[] }> {
  const root = await makeProject(files);
  const result = await readToolchainVersions(root, Object.keys(files), {
    maxBytes: 1024 * 1024,
  });
  return {
    lines: result.dependencies.map((entry) => `${entry.name}@${entry.version} ${entry.lockfile}`),
    warnings: result.warnings,
  };
}

/**
 * A minimum of 0.1 for each toolchain, in another directory. A pin under
 * test drops it; a minimum under test leaves it beside its own entry, so the
 * result shows which kind the file declared.
 */
const MINIMUM_PROBES: Readonly<Record<Toolchain, { file: string; text: string }>> = {
  go: { file: 'probe/go.mod', text: 'module example.com/probe\n\ngo 0.1\n' },
  python: { file: 'probe/pyproject.toml', text: '[project]\nrequires-python = ">=0.1"\n' },
  rust: { file: 'probe/Cargo.toml', text: '[package]\nname = "probe"\nrust-version = "0.1"\n' },
  swift: { file: 'probe/Package.swift', text: '// swift-tools-version:0.1\n' },
  dart: { file: 'probe/pubspec.lock', text: 'sdks:\n  dart: ">=0.1"\n' },
  flutter: { file: 'probe-flutter/pubspec.yaml', text: 'environment:\n  flutter: ">=0.1"\n' },
  node: { file: 'probe/package.json', text: '{"engines":{"node":">=0.1"}}' },
};

interface FileCase {
  file: string;
  accepted: string;
  declares: { toolchain: Toolchain; version: string; kind: 'pin' | 'minimum' }[];
  rejected: string;
}

const FILE_CASES: FileCase[] = [
  {
    file: 'go.mod',
    accepted:
      'module example.com/app\n\ngo 1.26.0\n\ntoolchain go1.27.4 // pinned for CI\n\nrequire golang.org/x/text v0.20.0\n',
    declares: [{ toolchain: 'go', version: '1.27', kind: 'pin' }],
    rejected: 'module example.com/app\n\ngo 1.27rc1\n',
  },
  {
    file: 'go.work',
    accepted: 'go 1.25 // workspace\n\ntoolchain default\n\nuse ./app\n',
    declares: [{ toolchain: 'go', version: '1.25', kind: 'minimum' }],
    rejected: 'toolchain local\n\nuse ./app\n',
  },
  {
    file: '.python-version',
    accepted: '# pyenv\n\n3.15.2\n3.14.1\n',
    declares: [{ toolchain: 'python', version: '3.15', kind: 'pin' }],
    rejected: 'pypy3.10\n',
  },
  {
    file: 'Pipfile',
    accepted: '[requires]\npython_version = "3.12"\npython_full_version = "3.13.1"\n',
    declares: [{ toolchain: 'python', version: '3.13', kind: 'pin' }],
    rejected: '[requires]\npython_version = "*"\n',
  },
  {
    file: 'pyproject.toml',
    accepted: '[project]\nname = "app"\nrequires-python = ">=3.11,<3.14"\n',
    declares: [{ toolchain: 'python', version: '3.11', kind: 'minimum' }],
    rejected: '[project]\nrequires-python = "<4"\n',
  },
  {
    file: 'rust-toolchain.toml',
    accepted: '[toolchain]\nchannel = "1.80.1"\ncomponents = ["clippy"]\n',
    declares: [{ toolchain: 'rust', version: '1.80', kind: 'pin' }],
    rejected: '[toolchain]\nchannel = "stable"\n',
  },
  {
    file: 'rust-toolchain',
    accepted: '\n1.79.0\n',
    declares: [{ toolchain: 'rust', version: '1.79', kind: 'pin' }],
    rejected: 'nightly-2026-01-01\n',
  },
  {
    file: 'Cargo.toml',
    accepted: '[package]\nname = "app"\nrust-version = "1.75"\n',
    declares: [{ toolchain: 'rust', version: '1.75', kind: 'minimum' }],
    rejected: '[package]\nname = "app"\nrust-version = "1.75-beta"\n',
  },
  {
    file: '.swift-version',
    accepted: '\n6.4.1\n',
    declares: [{ toolchain: 'swift', version: '6.4', kind: 'pin' }],
    rejected: 'main-snapshot-2026-11-01\n',
  },
  {
    file: 'Package.swift',
    accepted: '\n// swift-tools-version: 6.0\nimport PackageDescription\n',
    declares: [{ toolchain: 'swift', version: '6.0', kind: 'minimum' }],
    rejected: 'import PackageDescription\n// swift-tools-version:6.0\n',
  },
  {
    file: 'pubspec.yaml',
    accepted: 'name: app\nenvironment:\n  sdk: ^3.9.0\n  flutter: ">=3.35.0"\n',
    declares: [
      { toolchain: 'dart', version: '3.9', kind: 'minimum' },
      { toolchain: 'flutter', version: '3.35', kind: 'minimum' },
    ],
    rejected: 'name: app\nenvironment:\n  sdk: "<4.0.0"\n  flutter: any\n',
  },
  {
    file: 'pubspec.lock',
    accepted: 'packages: {}\nsdks:\n  dart: ">=3.5.0 <4.0.0"\n  flutter: ">=3.24.0"\n',
    declares: [
      { toolchain: 'dart', version: '3.5', kind: 'minimum' },
      { toolchain: 'flutter', version: '3.24', kind: 'minimum' },
    ],
    rejected: 'sdks:\n  dart: any\n',
  },
  {
    file: '.fvmrc',
    accepted: '{"flutter": "3.24.3", "flavors": {}}',
    declares: [{ toolchain: 'flutter', version: '3.24', kind: 'pin' }],
    rejected: '{"flutter": "stable"}',
  },
  {
    file: '.nvmrc',
    accepted: '# the CI image\nv22.11.0\n',
    declares: [{ toolchain: 'node', version: '22.11', kind: 'pin' }],
    rejected: 'lts/*\n',
  },
  {
    file: '.node-version',
    accepted: '24\n',
    declares: [{ toolchain: 'node', version: '24', kind: 'pin' }],
    rejected: 'node\n',
  },
  {
    file: 'package.json',
    accepted: '{"volta":{"node":"22.11.0"},"engines":{"node":">=20"}}',
    declares: [{ toolchain: 'node', version: '22.11', kind: 'pin' }],
    rejected: '{"engines":{"node":"*"}}',
  },
  {
    file: '.tool-versions',
    accepted: [
      '# asdf',
      'golang 1.27.4',
      'python 3.15.2 3.14.0 # two versions',
      'rust 1.80.0',
      'swift 6.4',
      'dart 3.9.0',
      'flutter 3.35.1-stable',
      'nodejs 22.11.0',
      'node 20.0.0',
      'ruby 3.3.0',
      '',
    ].join('\n'),
    declares: [
      { toolchain: 'go', version: '1.27', kind: 'pin' },
      { toolchain: 'python', version: '3.15', kind: 'pin' },
      { toolchain: 'rust', version: '1.80', kind: 'pin' },
      { toolchain: 'swift', version: '6.4', kind: 'pin' },
      { toolchain: 'dart', version: '3.9', kind: 'pin' },
      { toolchain: 'flutter', version: '3.35', kind: 'pin' },
      { toolchain: 'node', version: '22.11', kind: 'pin' },
    ],
    rejected: 'ruby 3.3.0\nnodejs lts\nnodejs 22.11.0\n',
  },
];

describe('toolchain version files', () => {
  it.each(FILE_CASES)('$file states its version and its kind', async (testCase) => {
    const probes = Object.fromEntries(
      testCase.declares.map(({ toolchain }) => [
        MINIMUM_PROBES[toolchain].file,
        MINIMUM_PROBES[toolchain].text,
      ])
    );
    const { lines, warnings } = await readProject({
      [testCase.file]: testCase.accepted,
      ...probes,
    });
    const expected = testCase.declares.flatMap(({ toolchain, version, kind }) => [
      `${toolchain}@${version} ${testCase.file}`,
      ...(kind === 'minimum' ? [`${toolchain}@0.1 ${MINIMUM_PROBES[toolchain].file}`] : []),
    ]);

    expect(warnings).toEqual([]);
    expect([...lines].sort()).toEqual([...expected].sort());
  });

  it.each(FILE_CASES)('$file states nothing when the value is not a version', async (testCase) => {
    expect(await readProject({ [testCase.file]: testCase.rejected })).toEqual({
      lines: [],
      warnings: [],
    });
  });

  it('falls back from a toolchain line that names no version, and takes the poetry and workspace forms', async () => {
    const { lines } = await readProject({
      'go/go.mod': 'module example.com/app\n\ngo 1.26.0\ntoolchain local\n',
      'poetry/pyproject.toml': '[tool.poetry.dependencies]\npython = "^3.10"\n',
      'workspace/Cargo.toml':
        '[package]\nname = "app"\nrust-version.workspace = true\n\n[workspace.package]\nrust-version = "1.76"\n',
      'engines/package.json': '{"engines":{"node":"^20.0.0 || ^22.0.0"}}',
    });

    expect(lines).toEqual([
      'go@1.26 go/go.mod',
      'node@20.0 engines/package.json',
      'python@3.10 poetry/pyproject.toml',
      'rust@1.76 workspace/Cargo.toml',
    ]);
    expect(
      (await readProject({ 'rust-toolchain': '# legacy name\n[toolchain]\nchannel = "1.81"\n' }))
        .lines
    ).toEqual(['rust@1.81 rust-toolchain']);
  });

  it('turns a file that is not valid TOML, YAML, or JSON into a warning', async () => {
    const { lines, warnings } = await readProject({
      'a/Pipfile': '[requires\n',
      'b/pubspec.yaml': 'environment: [unclosed\n',
      'c/.fvmrc': '{ "flutter": ',
      'd/package.json': '{ not json',
      'e/.nvmrc': '22\n',
    });

    expect(lines).toEqual(['node@22 e/.nvmrc']);
    expect(warnings).toEqual([
      expect.stringMatching(/^a\/Pipfile: could not be read for a toolchain version: /),
      expect.stringMatching(/^b\/pubspec\.yaml: could not be read for a toolchain version: /),
      expect.stringMatching(/^c\/\.fvmrc: could not be read for a toolchain version: /),
      expect.stringMatching(/^d\/package\.json: could not be read for a toolchain version: /),
    ]);
  });

  it('skips a file that is gone by the time it is read', async () => {
    const root = await makeProject({ '.nvmrc': '22\n' });

    expect(
      await readToolchainVersions(root, ['.nvmrc', 'gone/.python-version'], { maxBytes: 1024 })
    ).toEqual({
      dependencies: [
        {
          ecosystem: 'toolchain',
          name: 'node',
          version: '22',
          direct: true,
          dev: false,
          lockfile: '.nvmrc',
        },
      ],
      unread: [],
      warnings: [],
    });
  });

  it('names exactly the files of the table, in each toolchain order', () => {
    const names = [
      'go.mod',
      'go.work',
      '.python-version',
      'Pipfile',
      'pyproject.toml',
      'rust-toolchain.toml',
      'rust-toolchain',
      'Cargo.toml',
      '.swift-version',
      'Package.swift',
      'pubspec.yaml',
      'pubspec.lock',
      '.fvmrc',
      '.nvmrc',
      '.node-version',
      'package.json',
      '.tool-versions',
    ];

    expect(names.every(isToolchainFile)).toBe(true);
    expect(
      ['mise.toml', '.go-version', 'runtime.txt', 'Pipfile.lock', 'constructor'].some(
        isToolchainFile
      )
    ).toBe(false);
    expect(new Set(TOOLCHAINS.flatMap((toolchain) => toolchainFileNames(toolchain)))).toEqual(
      new Set(names)
    );
    expect(toolchainFileNames('python')).toEqual([
      '.python-version',
      '.tool-versions',
      'Pipfile',
      'pyproject.toml',
    ]);
    expect(toolchainFileNames('node')).toEqual([
      '.nvmrc',
      '.node-version',
      'package.json',
      '.tool-versions',
    ]);
  });
});

describe('toolchain versions', () => {
  it('tracks a version at its feature release', () => {
    expect(toolchainVersion('3.15.2')).toBe('3.15');
    expect(toolchainVersion(' v22.11.0\n')).toBe('22.11');
    expect(toolchainVersion('22')).toBe('22');
    expect(toolchainVersion('6.4')).toBe('6.4');

    for (const text of [
      'stable',
      'lts/*',
      'nightly-2026-01-01',
      '3.13-dev',
      '1.27rc1',
      'pypy3.10',
      'system',
      '1.2.3.4',
      '',
    ]) {
      expect(toolchainVersion(text)).toBeUndefined();
    }
  });

  it('takes the lowest version a constraint allows', () => {
    expect(minimumOf('>=3.11,<3.14')).toBe('3.11');
    expect(minimumOf('^3.5.0')).toBe('3.5');
    expect(minimumOf('>=3.5.0 <4.0.0')).toBe('3.5');
    expect(minimumOf('^20.0.0 || ^22.0.0')).toBe('20.0');
    expect(minimumOf('^22.0.0 || ^20.0.0')).toBe('20.0');
    expect(minimumOf('>=20')).toBe('20');
    expect(minimumOf('~=3.10, !=3.10.2')).toBe('3.10');
    expect(minimumOf('<4')).toBeUndefined();
    expect(minimumOf('*')).toBeUndefined();
  });

  it('finds the feature release a version belongs to', () => {
    expect(toolchainFeatureRelease('3.15')).toEqual({ major: 3, minor: 15 });
    expect(toolchainFeatureRelease('3.15.2')).toEqual({ major: 3, minor: 15 });
    expect(toolchainFeatureRelease('v3.15')).toEqual({ major: 3, minor: 15 });
    expect(toolchainFeatureRelease('22')).toEqual({ major: 22, minor: 0 });
    expect(toolchainFeatureRelease('2026-07-28')).toBeUndefined();
  });

  it('accepts exactly the seven names as toolchain dependency names', () => {
    for (const name of TOOLCHAINS) {
      expect(isDependencyName('toolchain', name)).toBe(true);
    }
    expect(isDependencyName('toolchain', 'Go')).toBe(false);
    expect(isDependencyName('toolchain', 'ruby')).toBe(false);
  });
});

describe('selectToolchainVersions', () => {
  const line = (entry: { name: string; version: string; lockfile: string }): string =>
    `${entry.name}@${entry.version} ${entry.lockfile}`;

  it('keeps a pin over a minimum in one directory', () => {
    expect(
      selectToolchainVersions([
        { toolchain: 'python', version: '3.12', kind: 'minimum', file: 'pyproject.toml' },
        { toolchain: 'python', version: '3.15', kind: 'pin', file: 'Pipfile' },
      ]).map(line)
    ).toEqual(['python@3.15 Pipfile']);
  });

  it('breaks a tie between the same kind by the file order', () => {
    expect(
      selectToolchainVersions([
        { toolchain: 'python', version: '3.14', kind: 'pin', file: 'app/.tool-versions' },
        { toolchain: 'python', version: '3.15', kind: 'pin', file: 'app/.python-version' },
        { toolchain: 'node', version: '20', kind: 'pin', file: '.tool-versions' },
        { toolchain: 'node', version: '22', kind: 'pin', file: 'package.json' },
      ]).map(line)
    ).toEqual(['node@22 package.json', 'python@3.15 app/.python-version']);
  });

  it('drops a minimum in one directory when another directory pins the toolchain', () => {
    expect(
      selectToolchainVersions([
        { toolchain: 'swift', version: '6.0', kind: 'minimum', file: 'Package.swift' },
        { toolchain: 'swift', version: '6.4', kind: 'pin', file: 'app/.swift-version' },
        { toolchain: 'dart', version: '3.5', kind: 'minimum', file: 'a/pubspec.yaml' },
        { toolchain: 'dart', version: '3.9', kind: 'minimum', file: 'b/pubspec.yaml' },
      ]).map(line)
    ).toEqual([
      'dart@3.5 a/pubspec.yaml',
      'dart@3.9 b/pubspec.yaml',
      'swift@6.4 app/.swift-version',
    ]);
  });

  it('keeps two different pins as two entries, each a direct toolchain dependency', () => {
    expect(
      selectToolchainVersions([
        { toolchain: 'node', version: '24', kind: 'pin', file: 'web/.nvmrc' },
        { toolchain: 'node', version: '22', kind: 'pin', file: 'api/.nvmrc' },
      ])
    ).toEqual([
      {
        ecosystem: 'toolchain',
        name: 'node',
        version: '22',
        direct: true,
        dev: false,
        lockfile: 'api/.nvmrc',
      },
      {
        ecosystem: 'toolchain',
        name: 'node',
        version: '24',
        direct: true,
        dev: false,
        lockfile: 'web/.nvmrc',
      },
    ]);
  });
});
