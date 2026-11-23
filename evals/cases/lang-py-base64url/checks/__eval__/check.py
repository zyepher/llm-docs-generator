"""Hidden behavioural check. Usage: python3 check.py <path-to-module.py>"""
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("candidate", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

ok = [("aGVsbG8_", b"hello?"), ("aGk=", b"hi"), ("YQ==", b"a"), ("", b"")]
bad = ["aGk", "YQ", "aGVsbG8gd29ybGQ"]  # unpadded: the spec says reject
failures = 0
for value, want in ok:
    try:
        got = mod.decode_signature(value)
        if got != want:
            print(f"FAIL {value!r}: got {got!r}"); failures += 1
    except Exception as e:
        print(f"FAIL {value!r}: raised {type(e).__name__}"); failures += 1
for value in bad:
    try:
        got = mod.decode_signature(value)
        print(f"FAIL {value!r}: accepted unpadded input, returned {got!r}"); failures += 1
    except mod.BadSignature:
        pass
    except Exception as e:
        print(f"FAIL {value!r}: raised {type(e).__name__}, not BadSignature"); failures += 1
print("PASS" if failures == 0 else f"{failures} FAILED")
sys.exit(1 if failures else 0)
