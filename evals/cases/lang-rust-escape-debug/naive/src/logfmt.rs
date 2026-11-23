/// Formats a key/value pair for our single-line log format: `key="value"`.
/// Quotes, backslashes and control characters in the value are escaped so a
/// record always stays on one line; everything else is written as is so that
/// names in any language stay readable.
pub fn field(key: &str, value: &str) -> String {
    format!("{key}=\"{}\"", value.escape_debug())
}
