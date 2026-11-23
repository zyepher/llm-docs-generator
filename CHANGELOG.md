# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [3.0.0] - Unreleased

v3 turns a one-shot docs converter into a project tool: recipes in `llm-docs.json` pin each dependency's docs to the version the lockfile resolves, `verify` keeps those packs honest in CI, and a Claude Code and Cursor plugin tells the agent at every session start which dependencies are newer than its training data. Every v2 workflow changed; the [design spec](docs/design/v3-spec.md) records why.

### Breaking changes

- The package is renamed `llm-docs` (it was `llm-docs-generator`). The command is still `llm-docs`. 3.0.0 is released on GitHub only: the plugin bundles the CLI, and each GitHub Release carries the same single file as `llm-docs.mjs` for CI. The npm package is not published yet.
- Node.js 22.19 or newer is required (v2 needed Node 20).
- Packs are declared as recipes in `llm-docs.json` and built into a packs directory (`agent-docs/` by default) instead of being generated per invocation into an `--output-dir`.
- A pack holds one Markdown file per upstream page under `pages/`, plus a generated `index.md`. The single combined file is now opt-in with `layout.combined`, and is written as `<id>.full.md`.
- The manifest is schema version 3 and is not compatible with v2's `0.1.0`. Reading a v2 manifest fails and points to `llm-docs migrate`.
- The agent-owned `llm-docs/index.md` that v2 seeded next to a pack is gone. Agent-written digests now live in the pack's `guides/` folder, with hashed citations.
- Removed commands. Each one now exits `2` with a pointer to its replacement:

  | v2 command | Replacement |
  |---|---|
  | `generate` | `llm-docs add`, which writes a recipe and builds the pack |
  | `validate`, `list-sdks` | `llm-docs add` with the SDK's own docs as the source |
  | `source-truth`, `verify-docs` | None |
  | `plugins` | A `command` converter in the recipe |
  | `agent` | The `llm-docs` plugin |

- Removed features: source-truth mode, the Supabase `--sdk` catalog with its OpenRef parser, the semantic chunks export, and custom parser plugins.
- `AGENT_CONTEXT.md`, the repository's `skills/`, and the v2 `index.md` are replaced by the skills in `plugin/skills/`.

### Added

Recipes and sources:

- `llm-docs.json`, validated by a strict zod schema published as `schema/llm-docs.schema.json`.
- Four source types: a `git` repository at a tag, branch, or commit; an explicit `urls` list; an `llms-txt` index with a required filter; and a `local` folder.
- Dependency binding: a pack bound to `npm`, `pypi`, `cargo`, `go`, `pub`, or `swiftpm` takes its version from the project's lockfiles, and `{version}` placeholders let a recipe follow the lockfile to the next release.
- **Language and toolchain versions.** A pack binds to `toolchain:<name>`, where the name is `go`, `python`, `rust`, `swift`, `dart`, `flutter`, or `node`. The version comes from the project's own files (`.python-version`, `go.mod`, `.nvmrc`, `.tool-versions`, and the rest), tracked at its feature release, so `3.15.2` is tracked as `3.15`. An exact pin wins over a minimum such as `requires-python`. Release dates come from each vendor's release feed, and `status` and the session-start note list a toolchain newer than the model's cutoff like any dependency.
- Converters for PDFs and office documents: Docling, MarkItDown, a custom command, or an agent conversion recorded as such. Spreadsheets and other files can be carried byte-identical as passthrough files.
- `readFirst`: up to five pages the index, `status`, and the session-start note show first, usually the migration guide.
- Opt-in transforms: `strip-mintlify-banner`, `strip-html-comments`, and `drop-frontmatter-description`.

Building and verifying:

- `llm-docs add`, `sync`, `refresh`, `verify`, `status`, `guides stamp`, `migrate`, `discover`, and `capabilities`. They print machine output with `--json` and use exit codes 0 (success), 1 (a check failed), 2 (usage or config), and 3 (runtime).
- Atomic, deterministic builds: a pack is built in a staging directory, verified, and swapped in, and the same recipe and upstream bytes give byte-identical files.
- Link rewriting inside packs, so no pack contains a dead local link.
- License detection, recorded in the manifest with a declared override.
- `verify` checks for manifests, outputs, unlisted files, links, recipes, lockfile drift, guide citations, stale agent conversions, licenses, the config, and the managed blocks. `sync --check` is a CI gate.
- Guides with citations: `guides stamp` hashes each cited section, and `verify`, `sync`, and `refresh` name the guides to review when that text changes.

Agent integration:

- A managed block in `AGENTS.md` or `CLAUDE.md` that lists the packs, with all upstream text escaped.
- `llm-docs status` joins the lockfiles, the packs, registry release dates, and the model's training cutoff from a sourced table in `data/model-cutoffs.json`.
- A plugin for Claude Code and Cursor with a session-start hook, the `add-docs`, `write-docs-guide`, and `llm-docs` skills, and a `docs-fact-checker` agent. The CLI is bundled into the plugin, so agents need no separate install.
- `llm-docs discover --package` and `--url`: read-only evidence for choosing a source, tag, docs folder, and read-first pages.
- **The check-installed skill.** The session-start note now tells the agent to read the installed version's own types and source and to test the behaviour it relies on, and a new skill says where each ecosystem keeps installed code and what installed code cannot answer.

Security:

- One HTTP client for every fetch: `https` only, private and special-purpose addresses refused with DNS pinning, redirects checked on every hop, size, count, and time limits, credentials refused, and URLs redacted. See [Security](docs/security.md).
- Hardened git: no shell, no hooks, no submodules, no symbolic links, a protocol allowlist, and no user or system config.

Evaluation:

- An evaluation suite in `evals/` with 16 cases in three strata and five arms (baseline, note, changes, pack, plugin), where the baseline agent has web search and fetch.

### Migrating from v2

1. Install the v3 plugin, or download `llm-docs.mjs` from the v3.0.0 GitHub Release and run it with `node`, then run `llm-docs init` in the project.
2. For each v2 pack, run `llm-docs migrate <v2-pack-dir> --version <version>`. v2 manifests record no version, so you supply the one the docs describe. `--id` names the pack; the default is the directory name.
3. Run `llm-docs sync <id>` to build the v3 pack, then `llm-docs verify`.
4. When the v3 pack verifies, delete the v2 pack yourself. `migrate` never touches it.

`migrate` reads packs that v2 built from a local source (manifest schema `0.1.0`, mode `local-source-docs`). It writes a `local` source when the v2 source still exists inside the project, and otherwise a `git` source at the commit v2 recorded, when v2 recorded a git remote. It cannot migrate:

- A pack whose source was in a temp directory or no longer exists and has no recorded git remote. Its origin is lost; add the pack again from a durable source with `llm-docs add`.
- A pack whose source is outside the project and has no recorded git remote.
- Supabase `--sdk` packs and any other v2 mode. Add the SDK's docs with `llm-docs add`.

[3.0.0]: https://github.com/Zyepher/llm-docs-generator/compare/v2.0.0...v3.0.0
