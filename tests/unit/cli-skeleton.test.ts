/**
 * The v3 CLI skeleton, run from source through the tsx loader: version, capabilities, the
 * one-line errors for commands removed in v3, and discover input validation.
 */

import { execFile } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cliPath = join(repoRoot, 'src/cli.ts');

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolveResult) => {
    execFile(
      process.execPath,
      // tsx's loader prints a deprecation warning on newer Node releases, which
      // would otherwise pollute the single stderr line these tests assert on.
      ['--no-deprecation', '--import', 'tsx', cliPath, ...args],
      { cwd: repoRoot, env: { ...process.env, NO_COLOR: '1' } },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
        resolveResult({ code, stdout, stderr });
      }
    );
  });
}

const REMOVED_COMMANDS: Array<[string, string]> = [
  ['generate', "Use 'llm-docs add'"],
  ['validate', 'Supabase SDK catalog was removed'],
  ['list-sdks', 'Supabase SDK catalog was removed'],
  ['source-truth', 'source-truth mode was removed'],
  ['verify-docs', 'source-truth mode was removed'],
  ['plugins', 'convert.tool = "command"'],
  ['agent', 'Install the llm-docs plugin'],
];

describe('llm-docs CLI skeleton', () => {
  it('prints the package version', async () => {
    const result = await runCli(['--version']);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('3.0.0');
  });

  it('lists the implemented commands as JSON', async () => {
    const result = await runCli(['capabilities', '--json']);
    expect(result.code).toBe(0);

    const capabilities: unknown = JSON.parse(result.stdout);
    expect(capabilities).toMatchObject({ name: 'llm-docs', version: '3.0.0' });
    expect(capabilities).toHaveProperty(
      'commands',
      expect.arrayContaining([
        expect.objectContaining({ name: 'discover', status: 'implemented' }),
        expect.objectContaining({ name: 'capabilities', status: 'implemented' }),
      ])
    );
  });

  it.each(REMOVED_COMMANDS)(
    'rejects the removed %s command with a one-line hint and exit code 2',
    async (command, hint) => {
      const result = await runCli([command, 'extra-arg', '--some-old-flag', 'value']);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe('');
      const lines = result.stderr.trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`llm-docs: '${command}' was removed in v3.`);
      expect(lines[0]).toContain(hint);
    }
  );

  it('rejects an invalid discover URL as a usage error without fetching', async () => {
    const result = await runCli(['discover', '--url', 'not-a-url', '--json']);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('llm-docs: Malformed URL for discover --url.');
  });

  it('treats an unknown command as a usage error', async () => {
    const result = await runCli(['no-such-command']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unknown command 'no-such-command'");
  });
});
