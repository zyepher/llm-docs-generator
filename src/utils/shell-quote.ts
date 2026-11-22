/**
 * `value` as one argument of a command line a person or an agent can paste.
 *
 * POSIX shells: double quotes unless the value holds a character they expand
 * inside double quotes, then single quotes.
 *
 * Windows: cmd.exe and PowerShell both take double quotes, and a backslash is
 * not an escape in either, so a path with spaces is double-quoted as it is.
 * PowerShell expands `$` and the backtick inside double quotes, so a value
 * holding one gets PowerShell's single quotes; cmd.exe has no quoting that
 * serves both shells for such a value.
 */
export function shellQuote(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    if (/^[\w@%+=:,./\\-]+$/.test(value)) {
      return value;
    }
    return /[$`]/.test(value) ? `'${value.replaceAll("'", "''")}'` : `"${value}"`;
  }
  if (/^[\w@%+=:,./-]+$/.test(value)) {
    return value;
  }
  return /["$`!\\]/.test(value) ? `'${value.replaceAll("'", `'\\''`)}'` : `"${value}"`;
}
