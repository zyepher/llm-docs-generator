"""Parse classic BSD syslog lines (RFC 3164 style timestamps)."""
import re
from datetime import datetime

_LINE = re.compile(
    r"^(?P<ts>[A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2}) (?P<host>\S+) "
    r"(?P<app>[^\[:\s]+)(?:\[(?P<pid>\d+)\])?: (?P<msg>.*)$"
)


def parse_line(line: str, year: int) -> dict:
    m = _LINE.match(line)
    if m is None:
        raise ValueError(f"not a syslog line: {line!r}")
    # The year goes into the parsed string so that the date is never
    # interpreted without one (this also makes Feb 29 parse in leap years).
    ts = datetime.strptime(f"{year} {m['ts']}", "%Y %b %d %H:%M:%S")
    return {
        "time": ts,
        "host": m["host"],
        "app": m["app"],
        "pid": int(m["pid"]) if m["pid"] else None,
        "message": m["msg"],
    }
