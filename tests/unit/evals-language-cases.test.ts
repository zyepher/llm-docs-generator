import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CACHE_DIR,
  type EvalCase,
  lintCase,
  listFiles,
  loadCase,
  TOOLCHAINS,
  type Toolchain,
} from '../../evals/lib/cases.js';
import { summarizeTranscript } from '../../evals/lib/transcript.js';
import { ensureTemplate } from '../../evals/lib/workspace.js';
import {
  agentInvocation,
  allowedToolsMeta,
  type RunSettings,
  saveAgentFiles,
} from '../../evals/run.js';

const CASES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'evals',
  'language-cases'
);
const ID = 'lang-py-greeting';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A copy of the fixture case with `edit` applied to its case.json and, optionally, a file removed. */
async function variant(
  edit: (raw: Record<string, unknown>) => Record<string, unknown>,
  remove?: string
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'llm-docs-language-case-'));
  tempDirs.push(root);
  await cp(join(CASES, ID), join(root, ID), { recursive: true });
  const casePath = join(root, ID, 'case.json');
  const raw: Record<string, unknown> = JSON.parse(await readFile(casePath, 'utf8'));
  await writeFile(casePath, JSON.stringify(edit(raw)));
  if (remove !== undefined) {
    await rm(join(root, ID, remove), { recursive: true });
  }
  return root;
}

describe('a language case', () => {
  it('loads with its toolchain and version files and lints clean', async () => {
    const evalCase = await loadCase(ID, CASES);
    expect(evalCase).toMatchObject({
      kind: 'post-cutoff',
      stratum: 'language',
      library: { name: 'python', version: '3.15' },
      language: { toolchain: 'python', versionFiles: ['.python-version'] },
    });
    expect(evalCase.checks.map((check) => check.name)).toEqual(['behaviour']);
    expect(await lintCase(evalCase)).toEqual([]);
  });

  it('rejects a toolchain llm-docs does not track', async () => {
    const root = await variant((raw) => ({ ...raw, toolchain: 'cobol' }));
    await expect(loadCase(ID, root)).rejects.toThrow(
      'toolchain must be one of python, go, rust, dart, swift'
    );
  });

  it('lints a version file missing from the fixture', async () => {
    const root = await variant((raw) => raw, 'fixture/.python-version');
    expect(await lintCase(await loadCase(ID, root))).toEqual([
      'fixture/.python-version is missing, but versionFiles lists it',
    ]);
  });

  it('rejects a language case without a behaviour command check', async () => {
    const root = await variant((raw) => raw);
    await writeFile(
      join(root, ID, 'checks', 'checks.json'),
      JSON.stringify({
        checks: [{ name: 'runs', command: ['python3', 'greeting.py'], timeoutSeconds: 300 }],
      })
    );
    await expect(loadCase(ID, root)).rejects.toThrow(
      'a language case needs a command check named behaviour'
    );
  });

  it('rejects a toolchain on a case whose stratum is not language, and the reverse', async () => {
    const typed = await variant((raw) => ({ ...raw, stratum: 'type-invisible' }));
    await expect(loadCase(ID, typed)).rejects.toThrow(
      'stratum is "language" exactly when the case has a toolchain'
    );
    const untooled = await variant(({ toolchain: _, versionFiles: __, ...raw }) => raw);
    await expect(loadCase(ID, untooled)).rejects.toThrow(
      'stratum is "language" exactly when the case has a toolchain'
    );
  });

  it('gets a template that is a copy of the fixture, with nothing installed', async () => {
    const evalCase = await loadCase(ID, CASES);
    await rm(join(CACHE_DIR, 'templates', ID), { recursive: true, force: true });
    const logged: string[] = [];
    const template = await ensureTemplate(evalCase, (line) => logged.push(line));
    tempDirs.push(template);
    expect(await listFiles(template)).toEqual([
      '.eval-template.json',
      ...(await listFiles(join(CASES, ID, 'fixture'))),
    ]);
    expect(existsSync(join(template, 'node_modules'))).toBe(false);
    expect(logged).toEqual([`copying ${ID} template (a language case installs nothing)`]);
    // Reused while the fixture is unchanged.
    expect(await ensureTemplate(evalCase, (line) => logged.push(line))).toBe(template);
    expect(logged).toHaveLength(1);
  });
});

describe('the tools an arm may use', () => {
  const settings: RunSettings = {
    model: 'claude-opus-5-5',
    perRunUsd: 3,
    pluginDir: null,
    pluginName: null,
    hookNotes: { note: new Map(), changes: new Map(), plugin: new Map() },
    effort: null,
  };
  const library: EvalCase = {
    id: 'zod-4-6',
    title: 'zod',
    kind: 'post-cutoff',
    stratum: 'type-visible',
    packageDocumentsAnswer: 'types',
    library: { name: 'zod', version: '4.6.7', released: '2026-10-12' },
    notes: '',
    maxTurns: 30,
    timeoutSeconds: 900,
    dir: '/nonexistent',
    task: 'task',
    checks: [],
    pack: { id: 'zod', pack: {}, sourceTypes: [] },
  };
  const toolsOf = (evalCase: EvalCase): string[] => {
    const { args } = agentInvocation(evalCase, 'baseline', settings);
    return args.slice(args.indexOf('--allowedTools') + 1);
  };
  const COMMON = [
    'Read',
    'Glob',
    'Grep',
    'Edit',
    'Write',
    'WebSearch',
    'WebFetch',
    'Bash(ls)',
    'Bash(ls *)',
    'Bash(cat *)',
  ];

  it('keeps the npm tools for a library case', () => {
    expect(toolsOf(library)).toEqual([
      'Read',
      'Glob',
      'Grep',
      'Edit',
      'Write',
      'WebSearch',
      'WebFetch',
      'Bash(npx tsc)',
      'Bash(npx tsc *)',
      'Bash(npx vitest)',
      'Bash(npx vitest *)',
      'Bash(npm test)',
      'Bash(npm test *)',
      'Bash(ls)',
      'Bash(ls *)',
      'Bash(cat *)',
    ]);
  });

  it('records the library list only when the run has a library case, and each toolchain list', () => {
    const python: EvalCase = {
      ...library,
      stratum: 'language',
      language: { toolchain: 'python', versionFiles: ['.python-version'] },
    };
    const go: EvalCase = { ...python, language: { toolchain: 'go', versionFiles: ['go.mod'] } };
    expect(allowedToolsMeta([library, python, go])).toEqual({
      allowedTools: toolsOf(library),
      languageAllowedTools: {
        python: [...COMMON, 'Bash(python3 *)'],
        go: [...COMMON, 'Bash(go *)'],
      },
    });
    expect(allowedToolsMeta([python])).toEqual({
      languageAllowedTools: { python: [...COMMON, 'Bash(python3 *)'] },
    });
    expect(allowedToolsMeta([library])).toEqual({
      allowedTools: toolsOf(library),
      languageAllowedTools: {},
    });
  });

  it("gives a language case its toolchain's programs in place of the npm ones", () => {
    const extra: Record<Toolchain, string[]> = {
      python: ['Bash(python3 *)'],
      go: ['Bash(go *)'],
      rust: ['Bash(cargo *)', 'Bash(rustc *)'],
      dart: ['Bash(dart *)'],
      swift: ['Bash(swift *)', 'Bash(swiftc *)'],
    };
    for (const toolchain of TOOLCHAINS) {
      const evalCase: EvalCase = {
        ...library,
        stratum: 'language',
        language: { toolchain, versionFiles: ['.version'] },
      };
      expect(toolsOf(evalCase)).toEqual([...COMMON, ...extra[toolchain]]);
    }
  });
});

/** One assistant message per tool call, as the stream reports them. */
function toolCalls(...calls: Array<[string, Record<string, unknown>]>): string {
  return calls
    .map(([name, input], index) =>
      JSON.stringify({
        type: 'assistant',
        parent_tool_use_id: null,
        message: { content: [{ type: 'tool_use', id: `toolu_${index}`, name, input }] },
      })
    )
    .join('\n');
}

describe('what a language case transcript says the agent did', () => {
  it('measures a Python session by the interpreter and its standard library', () => {
    const jsonl = toolCalls(
      [
        'Read',
        {
          file_path:
            '/opt/homebrew/Cellar/python@3.15/3.15.2/Frameworks/Python.framework/Versions/3.15/lib/python3.15/_strptime.py',
        },
      ],
      ['Bash', { command: 'python3 -m py_compile syslog_parse.py' }],
      ['Bash', { command: 'python3 -c "import syslog_parse; print(syslog_parse.parse_line(1))"' }],
      ['Bash', { command: 'cd tests && pytest -q' }],
      ['Bash', { command: 'mypy syslog_parse.py' }],
      ['Bash', { command: 'cat syslog_parse.py' }]
    );
    expect(summarizeTranscript(jsonl, 'python')).toMatchObject({
      installedCodeRead: true,
      ownTestRuns: 2,
      typeCheckRuns: 2,
    });
    // The npm definitions see none of it.
    expect(summarizeTranscript(jsonl)).toMatchObject({
      installedCodeRead: false,
      ownTestRuns: 0,
      typeCheckRuns: 0,
    });
    const help = toolCalls(['Bash', { command: 'python3 -c "import base64; help(base64)"' }]);
    expect(summarizeTranscript(help, 'python')).toMatchObject({
      installedCodeRead: true,
      ownTestRuns: 1,
    });
  });

  it('measures a Go session by GOROOT, go doc, and the go subcommands', () => {
    const jsonl = toolCalls(
      ['Bash', { command: 'go build ./... && go vet ./...' }],
      ['Bash', { command: 'go test ./...' }],
      ['Bash', { command: 'go run ./cmd/demo' }],
      ['Bash', { command: 'go mod tidy' }],
      ['Read', { file_path: 'config.go' }]
    );
    expect(summarizeTranscript(jsonl, 'go')).toMatchObject({
      installedCodeRead: false,
      ownTestRuns: 2,
      typeCheckRuns: 1,
    });
    const read = (call: [string, Record<string, unknown>]): boolean =>
      summarizeTranscript(toolCalls(call), 'go').installedCodeRead;
    expect(read(['Bash', { command: 'go doc encoding/json UnmarshalTypeError' }])).toBe(true);
    expect(
      read([
        'Read',
        { file_path: '/opt/homebrew/Cellar/go/1.27.4/libexec/src/encoding/json/v2_decode.go' },
      ])
    ).toBe(true);
    expect(read(['Grep', { pattern: 'Field', path: '/usr/local/go/src/encoding/json' }])).toBe(
      true
    );
    expect(read(['Bash', { command: 'ls $(go env GOROOT)/src' }])).toBe(true);
  });
});

describe('the files saved from a language case workspace', () => {
  it("leaves out the toolchains' build output at any depth", async () => {
    const root = await mkdtemp(join(tmpdir(), 'llm-docs-agent-files-'));
    tempDirs.push(root);
    const caseDir = join(root, 'case');
    const workspace = join(root, 'workspace');
    const files: Record<string, string> = {
      'src/logfmt.rs': 'pub fn field() {}\n',
      'target/debug/applog.d': 'generated\n',
      '.build/debug/Transfer.swiftmodule': 'generated\n',
      '.dart_tool/package_config.json': '{}\n',
      '__pycache__/cli.cpython-315.pyc': 'generated\n',
      'pkg/__pycache__/x.pyc': 'generated\n',
      'nested/target/out.txt': 'generated\n',
      'targets.md': 'kept\n',
    };
    await mkdir(join(caseDir, 'fixture'), { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      await mkdir(dirname(join(workspace, rel)), { recursive: true });
      await writeFile(join(workspace, rel), content);
    }
    const evalCase = { ...(await loadCase(ID, CASES)), dir: caseDir };
    const out = join(root, 'files.json');
    await saveAgentFiles(evalCase, workspace, out);
    expect(Object.keys(JSON.parse(await readFile(out, 'utf8'))).sort()).toEqual([
      'src/logfmt.rs',
      'targets.md',
    ]);
  });
});
