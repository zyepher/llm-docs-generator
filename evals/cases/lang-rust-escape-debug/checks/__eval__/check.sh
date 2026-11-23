#!/bin/sh
# Compiles the hidden check against the candidate src/logfmt.rs (check.rs includes it as
# logfmt.rs from its own directory) and runs it.
set -e
cd "$(dirname "$0")"
cp ../src/logfmt.rs logfmt.rs
rustc --edition 2024 -o check check.rs
exec ./check
