#!/bin/sh
# Compiles every source of the Transfer target with the hidden main.swift, as the researcher's
# swiftc invocation did, and runs the result.
set -e
cd "$(dirname "$0")/.."
swiftc -swift-version 6 $(find Sources/Transfer -name '*.swift' | sort) __eval__/main.swift -o __eval__/check
exec __eval__/check
