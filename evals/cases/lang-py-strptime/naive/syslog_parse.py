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
    ts = datetime.strptime(m["ts"], "%b %d %H:%M:%S").replace(year=year)
    return {
        "time": ts,
        "host": m["host"],
        "app": m["app"],
        "pid": int(m["pid"]) if m["pid"] else None,
        "message": m["msg"],
    }
