"""Drop-in Python replacement for the legacy `imgconv` tool's command line.

Legacy flags (must keep working): -i/-input FILE, -o/-output FILE,
-q/-quality N (default 85), -s/-strip (flag).
"""
import argparse


def parse(argv: list[str]) -> dict:
    p = argparse.ArgumentParser(prog="imgconv")
    # Explicit dest: the attribute name inferred from a short option paired
    # with a single-dash long option is not something to rely on.
    p.add_argument("-i", "-input", dest="input", required=True)
    p.add_argument("-o", "-output", dest="output", required=True)
    p.add_argument("-q", "-quality", dest="quality", type=int, default=85)
    p.add_argument("-s", "-strip", dest="strip", action="store_true")
    a = p.parse_args(argv)
    return {"input": a.input, "output": a.output, "quality": a.quality, "strip": a.strip}
