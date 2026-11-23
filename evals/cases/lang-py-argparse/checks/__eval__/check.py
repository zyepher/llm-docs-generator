"""Hidden behavioural check. Usage: python3 check.py <path-to-module.py>"""
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("candidate", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

cases = [
    (["-input", "a.png", "-output", "b.jpg"], {"input": "a.png", "output": "b.jpg", "quality": 85, "strip": False}),
    (["-i", "a.png", "-o", "b.jpg", "-q", "60", "-s"], {"input": "a.png", "output": "b.jpg", "quality": 60, "strip": True}),
    (["-input", "x", "-o", "y", "-quality", "90", "-strip"], {"input": "x", "output": "y", "quality": 90, "strip": True}),
]
failures = 0
for argv, want in cases:
    try:
        got = mod.parse(argv)
    except BaseException as e:
        print(f"FAIL {argv}: raised {type(e).__name__}: {e}")
        failures += 1
        continue
    if got != want:
        print(f"FAIL {argv}: got {got}")
        failures += 1
print("PASS" if failures == 0 else f"{failures} FAILED")
sys.exit(1 if failures else 0)
