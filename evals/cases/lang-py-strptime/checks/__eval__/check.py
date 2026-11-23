"""Hidden behavioural check. Usage: python3 check.py <path-to-module.py>"""
import importlib.util
import sys
from datetime import datetime

spec = importlib.util.spec_from_file_location("candidate", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

cases = [
    ("Mar  5 14:02:11 web01 sshd[4121]: Accepted publickey for deploy", 2026,
     {"time": datetime(2026, 3, 5, 14, 2, 11), "host": "web01", "app": "sshd", "pid": 4121,
      "message": "Accepted publickey for deploy"}),
    ("Nov 23 09:00:00 db1 cron: job started", 2026,
     {"time": datetime(2026, 11, 23, 9, 0, 0), "host": "db1", "app": "cron", "pid": None,
      "message": "job started"}),
]
failures = 0
for line, year, want in cases:
    try:
        got = mod.parse_line(line, year)
    except Exception as e:
        print(f"FAIL {line!r}: raised {type(e).__name__}: {e}")
        failures += 1
        continue
    if got != want:
        print(f"FAIL {line!r}: got {got!r}")
        failures += 1
print("PASS" if failures == 0 else f"{failures} FAILED")
sys.exit(1 if failures else 0)
