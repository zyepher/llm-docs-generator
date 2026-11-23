---
name: check-installed
description: Check a dependency's installed version before writing code against it. Use before writing or changing code that calls a library, SDK, or framework, above all one the session-start note lists as newer than your training data, or whenever an API does not behave as you remember. Read the installed version's own types, source, and changelog instead of trusting memory, and test the behaviour that changed.
---

# Check the installed code before you write against it

Your memory of a library is a snapshot from before your training data ends. The project has the real thing: the exact version it runs, installed on this machine. That installed code is the authority on what the API is. Read it first, then write.

Two habits prevent most mistakes. Do both.

## 1. Read the installed version, not your memory

1. Find the version the project resolves. The lockfile states it, and `llm-docs status` lists every direct dependency released after or close to your training data cutoff.
2. Open the installed package and read the part you are about to call: the exported names, the signature, the option names, and the defaults written in its types and doc comments. Do this before you write the code, not after it fails.
3. If the package ships a changelog, a migration guide, or notes for agents, read the entries between the version you remember and the installed one.

Where installed code lives:

| Ecosystem | Installed code | Where the version is stated |
|---|---|---|
| npm, pnpm, yarn, bun | `node_modules/<name>/`, with its types in the `.d.ts` files its `package.json` points to | `node_modules/<name>/package.json` |
| Python | `<venv>/lib/python<X.Y>/site-packages/<package>/` | the `<package>-<version>.dist-info` folder beside it |
| Go | the module cache, `<GOMODCACHE>/<module>@<version>/` (usually under `~/go/pkg/mod`, where an uppercase letter in the path is written as `!` and the lowercase letter), or `vendor/` | `go.mod` |
| Rust | `~/.cargo/registry/src/<index>/<crate>-<version>/` | `Cargo.lock` |
| Dart and Flutter | `~/.pub-cache/hosted/pub.dev/<package>-<version>/` | `pubspec.lock` |
| Swift packages | `.build/checkouts/<package>/`, or under Xcode `~/Library/Developer/Xcode/DerivedData/<project>-<id>/SourcePackages/checkouts/<package>/` | `Package.resolved` |

Search the installed code for the exact name you plan to use. If the name is not there, it does not exist in this version, whatever you remember.

## 2. Test the behaviour you depend on

A type check proves names and shapes. It does not prove behaviour. A default that flipped, a stricter parser, or a different order compiles exactly as before and does something else when it runs.

- Run the project's type check or build.
- Then write a small test or script that runs your code on the inputs the task cares about, including the edge cases the task names, and read what it prints. Delete the scratch file when you are done, unless the project wants the test.
- When the result differs from what you remember, the installed version is right. Go back to its source or changelog and find out why before you work around it.

## 3. When the installed code cannot answer

Installed code says what the API is. It does not say what changed, why, or what replaces something that was removed. And some things are not installed at all: a language's own syntax and semantics, a protocol or specification, a hosted API, a closed-source SDK.

- If this repository pins docs for it, the session-start note and the list in `AGENTS.md` say where. Read the pages marked to read first, then the page for the API.
- If it does not, pin them with the `add-docs` skill, or read the docs for the exact version the project uses, not the newest ones.
