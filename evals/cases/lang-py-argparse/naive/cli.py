"""Drop-in Python replacement for the legacy `imgconv` tool's command line.

Legacy flags (must keep working): -i/-input FILE, -o/-output FILE,
-q/-quality N (default 85), -s/-strip (flag).
"""
import argparse


def parse(argv: list[str]) -> dict:
    p = argparse.ArgumentParser(prog="imgconv")
    p.add_argument("-i", "-input", required=True)
    p.add_argument("-o", "-output", required=True)
    p.add_argument("-q", "-quality", type=int, default=85)
    p.add_argument("-s", "-strip", action="store_true")
    a = p.parse_args(argv)
    return {"input": a.i, "output": a.o, "quality": a.q, "strip": a.s}
