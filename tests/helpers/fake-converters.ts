/**
 * Fake `docling` and `markitdown` executables for converter tests. Each is a
 * small Node script that follows the real tool's documented CLI contract:
 *
 * - markitdown 0.1.x: `markitdown <file>` writes Markdown to stdout;
 *   `markitdown --version` prints `markitdown <version>`.
 * - docling 2.x: `docling [--to md] [--image-export-mode <mode>] [--output <dir>] <source>`
 *   writes `<dir>/<stem>.md`; `docling --version` prints several lines, the
 *   first `Docling version: <version>`.
 *
 * Markers in the input text drive failures: `FAIL` (stderr and exit 1),
 * `EMPTY` (no output, exit 0), `SLEEP` (writes its pid to FAKE_PID_FILE and
 * hangs). Each conversion appends `<tool> <file name>` to FAKE_CONVERTER_LOG.
 * POSIX gets executable scripts with a node shebang; Windows gets `.cmd`
 * shims, the way pipx and npm install tools there.
 */

import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const COMMON = String.raw`
const fs = require('node:fs');
const path = require('node:path');

function convertText(tool, input) {
  if (process.env.FAKE_CONVERTER_LOG) {
    fs.appendFileSync(process.env.FAKE_CONVERTER_LOG, tool + ' ' + path.basename(input) + '\n');
  }
  const text = fs.readFileSync(input, 'utf-8');
  if (text.includes('SLEEP')) {
    if (process.env.FAKE_PID_FILE) fs.writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
    setTimeout(() => {}, 120000);
    return null;
  }
  if (text.includes('FAIL')) {
    process.stderr.write('Traceback (most recent call last):\nValueError: cannot parse ' + path.basename(input) + '\n');
    process.exit(1);
  }
  if (text.includes('EMPTY')) {
    return '';
  }
  return '# ' + path.basename(input) + '\n\nConverted by ' + tool + ': ' + text.trim() + '\n';
}
`;

const MARKITDOWN = String.raw`
const args = process.argv.slice(2);
if (args[0] === '--version' || args[0] === '-v') {
  process.stdout.write('markitdown ' + (process.env.FAKE_MARKITDOWN_VERSION || '0.1.9') + '\n');
  process.exit(0);
}
if (args.length !== 1 || args[0].startsWith('-')) {
  process.stderr.write('usage: markitdown <OPTIONAL: FILENAME>\n');
  process.exit(2);
}
const markdown = convertText('markitdown', args[0]);
if (markdown !== null) process.stdout.write(markdown);
`;

const DOCLING = String.raw`
const args = process.argv.slice(2);
if (args[0] === '--version') {
  process.stdout.write('Docling version: 2.147.0\nDocling Core version: 2.50.0\nDocling Parse version: 4.1.0\n');
  process.exit(0);
}
const to = [];
let output = '.';
let imageMode = 'embedded';
const sources = [];
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--to') to.push(args[++i]);
  else if (arg === '--output') output = args[++i];
  else if (arg === '--image-export-mode') imageMode = args[++i];
  else if (arg.startsWith('-')) { process.stderr.write('No such option: ' + arg + '\n'); process.exit(2); }
  else sources.push(arg);
}
if (sources.length === 0) { process.stderr.write('Missing argument SOURCE\n'); process.exit(2); }
for (const source of sources) {
  const markdown = convertText('docling', source);
  if (markdown === null) continue;
  if (to.length === 0 || to.includes('md')) {
    const name = path.basename(source);
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, stem + '.md'), markdown === '' ? '' : markdown + '\n<!-- image (' + imageMode + ') -->\n');
  }
}
`;

/** Write fake `docling` and `markitdown` into `binDir` (created when missing). */
export async function installFakeConverters(binDir: string): Promise<void> {
  await mkdir(binDir, { recursive: true });

  for (const [name, body] of [
    ['markitdown', MARKITDOWN],
    ['docling', DOCLING],
  ] as const) {
    const code = `${COMMON}\n${body}`;

    if (process.platform === 'win32') {
      await writeFile(join(binDir, `${name}.cjs`), code);
      await writeFile(
        join(binDir, `${name}.cmd`),
        `@"${process.execPath}" "%~dp0${name}.cjs" %*\r\n`
      );
    } else {
      const path = join(binDir, name);
      await writeFile(path, `#!${process.execPath}\n${code}`);
      await chmod(path, 0o755);
    }
  }
}

/** A Node script usable as a `command` converter: `node <script> <input> [--out <output>]`. */
export async function writeCommandConverter(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'convert-command.cjs');
  await writeFile(
    path,
    `${COMMON}
const args = process.argv.slice(2);
const markdown = convertText('command', args[0]);
if (markdown !== null) {
  const out = args.indexOf('--out');
  if (out !== -1) fs.writeFileSync(args[out + 1], markdown);
  else process.stdout.write(markdown);
}
`
  );
  return path;
}
