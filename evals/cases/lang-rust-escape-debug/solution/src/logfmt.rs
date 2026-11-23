/// Formats a key/value pair for our single-line log format: `key="value"`.
/// Quotes, backslashes and control characters in the value are escaped so a
/// record always stays on one line; everything else is written as is so that
/// names in any language stay readable.
pub fn field(key: &str, value: &str) -> String {
    let mut out = String::with_capacity(key.len() + value.len() + 3);
    out.push_str(key);
    out.push_str("=\"");
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => out.extend(c.escape_unicode()),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
