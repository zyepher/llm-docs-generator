import { describe, expect, it } from 'vitest';

import { shellQuote } from '../../src/utils/shell-quote.js';

describe('shellQuote', () => {
  it('leaves a plain value alone on every platform', () => {
    expect(shellQuote('agent-docs/demo', 'linux')).toBe('agent-docs/demo');
    expect(shellQuote('C:\\Users\\dev\\project', 'win32')).toBe('C:\\Users\\dev\\project');
  });

  it('double-quotes a Windows path with a space, backslashes untouched', () => {
    expect(shellQuote('C:\\Users\\dev\\my project', 'win32')).toBe('"C:\\Users\\dev\\my project"');
  });

  it('uses PowerShell single quotes on Windows when the value would expand', () => {
    expect(shellQuote('C:\\work\\$cache dir', 'win32')).toBe("'C:\\work\\$cache dir'");
    expect(shellQuote("it's `here`", 'win32')).toBe("'it''s `here`'");
  });

  it('double-quotes a POSIX path with a space', () => {
    expect(shellQuote('/home/dev/my project', 'linux')).toBe('"/home/dev/my project"');
  });

  it('single-quotes a POSIX value that double quotes would expand, escaping its quotes', () => {
    expect(shellQuote('/tmp/$HOME dir', 'darwin')).toBe("'/tmp/$HOME dir'");
    expect(shellQuote("a 'b' \\ c", 'linux')).toBe("'a '\\''b'\\'' \\ c'");
  });
});
