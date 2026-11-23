# llm-docs plugin

Your coding agent's knowledge of a library stops at its training data cutoff. Your lockfile does not. This plugin tells the agent, at the start of every session, which of your project's dependencies were released after (or shortly before) that cutoff and where the pinned docs for them live in your repository. It also gives the agent four skills and a fact-checking agent for pinning and maintaining those docs with the `llm-docs` CLI.

## What it installs

- A session-start hook runs `llm-docs hook session-start` from the bundled CLI and adds a short note to the agent's context. In Claude Code it runs again after `/clear`, after a compaction, and when a session is resumed or forked, because those drop the earlier note.
- The `check-installed` skill teaches the agent to read the installed version's own types and source before writing against a library, and to test the behaviour that changed.
- The `add-docs` skill teaches the agent to choose a source and version from evidence, write the recipe, build the pack, and verify it.
- The `write-docs-guide` skill teaches it to write a project-specific digest of a pack that cites its pages, fact-check the digest, and stamp the citations.
- The `llm-docs` skill is the command reference. It covers every command, the verify checks with their fixes, and how to read the session-start note.
- The `docs-fact-checker` agent checks each claim in a guide against the pages it cites and reports it as supported, unsupported, or contradicted. It never edits the guide.
- `bin/llm-docs.mjs` is the whole CLI in one file, with a POSIX wrapper (`bin/llm-docs`) and a Windows wrapper (`bin/llm-docs.cmd`). Claude Code puts a plugin's `bin/` folder on the agent's shell PATH, so the agent can run `llm-docs` there without installing anything. In a host that does not, the skills tell the agent to run `node <plugin>/bin/llm-docs.mjs` instead, where `<plugin>` is the installed plugin's folder.
- [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) carries the license and copyright notices of the open source packages bundled into `bin/llm-docs.mjs`.

The npm package is not published yet. Until it is, the plugin and the GitHub Release assets below are the only ways to get the CLI. Do not install `llm-docs` from a package registry: whatever is published under that name there is not this project.

## Run it in CI

A CI job has no plugin. Each GitHub Release carries the same single-file CLI as an asset, `llm-docs.mjs`, with its SHA-256 in `llm-docs.mjs.sha256`. Download it for a pinned version and run it with Node 22.19 or newer:

```sh
curl -fsSLO https://github.com/Zyepher/llm-docs-generator/releases/download/v3.0.0/llm-docs.mjs
node llm-docs.mjs sync --check
node llm-docs.mjs verify
```

Pin the version in the URL rather than fetching the latest release, so a new release never changes your gate without a commit, and check the download against the SHA-256 the release publishes. [Running in CI](../docs/commands.md#running-in-ci) shows the hash check.

## Requirements

- Node.js 22.19 or newer on the PATH that your editor or terminal passes to hooks. If `node` is missing, the hook command fails, the host treats that as a non-blocking hook error, and the session starts without the note.
- Git, for packs built from a git repository. The hook itself never runs git.
- Public sources. llm-docs never sends credentials, so it cannot fetch a private repository or a page behind a login. Copy those docs into a folder in your project and pin that folder as a `local` source.
- Claude Code or Cursor. Codex support is unverified; see the Codex section below.

## Install

### Claude Code

```sh
claude plugin marketplace add Zyepher/llm-docs-generator
claude plugin install llm-docs@llm-docs
```

### Cursor

The repository is a Cursor plugin marketplace (`.cursor-plugin/marketplace.json`). Open **Customize** in the sidebar, import the repository with **From GitHub Repository**, and install `llm-docs`. Teams can add the repository as a team marketplace from the dashboard instead (**Plugins & MCPs**, then **Team Marketplaces**, then **Import from Repo**).

To try a local copy, put the `plugin` folder at `~/.cursor/plugins/local/llm-docs`, then restart Cursor or run **Developer: Reload Window**.

### Codex

Unverified. Codex's documentation describes plugins with a `.codex-plugin/plugin.json` manifest, installed from marketplaces configured in `config.toml`. It does not say that Codex reads the `.claude-plugin` manifests this repository ships, and this plugin has no `.codex-plugin` manifest. The documentation does say that Codex sets `CLAUDE_PLUGIN_ROOT` for plugin hooks and accepts the `hookSpecificOutput` shape the hook prints, so the hook may work once Codex loads the plugin. Nobody has tested that yet.

Codex reads `AGENTS.md`, so the pack list that `llm-docs sync` writes there reaches Codex sessions without the plugin.

## What the note says

The note has up to four parts. The hook leaves out any part with nothing in it.

1. Packs to fix, each with the step that fixes it: the lockfile moved, no lockfile resolves the pack's dependency, the lockfiles install it from another registry, the lockfiles disagree on it, the recipe changed, its local source files changed, its files no longer match its manifest, sync could not use it as it is (a symbolic link where the pack or its `guides/` should be, for example), or it was never built.
2. Packs for library versions released after the model's training data cutoff, or within 90 days before it, newest first, with the path to each pack's index. The note tells the agent its memory of these libraries predates these versions and to read the pinned pages before writing code against them. It then states two habits: read the installed version's own types and source before writing against it, and run a small test of the behaviour the code relies on, because a changed default still passes a type check.
3. Direct dependencies in the same window that have no pack, newest first, at most 8, with their release dates. This part states the same two habits when part 2 is absent, and ends by saying what installed code cannot answer (what changed and why, a language version, a protocol, a hosted API) and that the `add-docs` skill pins docs for those.
4. The pack list itself, when the agent file this host reads has no managed block. This covers projects that keep `AGENTS.md` out of git, and Claude Code sessions where a `CLAUDE.md` hides `AGENTS.md`.

The model's cutoff comes from `model.cutoff` in `llm-docs.json`, the `LLM_DOCS_MODEL_CUTOFF` environment variable, or the model id the host reports, looked up in a table of published cutoffs that ships with the CLI. When none of these gives a cutoff, parts 2 and 3 list releases from the last 180 days under a neutral heading instead of guessing.

The note is at most 2,000 characters. Run `llm-docs status --brief` in a project to see the note a session there would get.

The hook prints nothing when there is nothing to say, when it fails, and when it cannot finish within 1.5 seconds of starting.

## Turn it off

- For one project, set `"hook": { "enabled": false }` in `llm-docs.json`.
- Everywhere, set `LLM_DOCS_HOOK=off` in the environment your editor or terminal starts with.
- Or disable the plugin in the host.

## Log

The hook never writes to stdout except the note, never writes to stderr, and always exits 0. It records problems in `hook.log` in the cache directory. The log rotates at 1 MB and keeps one previous file, `hook.log.1`.

The cache directory is the first of these that applies:

- `$LLM_DOCS_CACHE_DIR`
- `$XDG_CACHE_HOME/llm-docs`
- `~/Library/Caches/llm-docs` on macOS
- `%LOCALAPPDATA%\llm-docs\Cache` on Windows
- `~/.cache/llm-docs` elsewhere

## Privacy and network

The hook lists your project's folders to find lockfiles and the files that state a language version (such as `.python-version`, `go.mod`, `.swift-version`, and `.nvmrc`), skipping `node_modules`, `.git`, build output, and the packs directory. It reads those files and the package manifests beside the lockfiles, `llm-docs.json`, the packs' manifests and files, the local folders packs are built from (to see whether a pack is out of date, for at most 400 ms), `AGENTS.md`, `CLAUDE.md`, and `CLAUDE.local.md` (to see whether the managed block reaches this host), and `.claude/settings.local.json`, `.claude/settings.json`, and `~/.claude/settings.json` (for the model id when the host does not send one). It ignores an `llm-docs.json` that another user owns, or that sits in a folder another user owns, and logs that it did. It writes files only inside the cache directory: `release-dates.json`, `hook.log`, and one marker file per project in `hook-warm/`. It never runs git.

To compare release dates with the cutoff, it needs the publish date of each direct dependency's resolved version and of each pack's version. It looks in `release-dates.json` first. A found date never expires, because a version's publish date never changes. For dates the cache does not have, it may send HTTPS GET requests to these hosts:

| Ecosystem | Host |
|---|---|
| npm | `api.deps.dev`, then `registry.npmjs.org` when deps.dev has no answer |
| PyPI | `pypi.org` |
| Cargo | `crates.io` |
| Go | `proxy.golang.org` |
| pub | `pub.dev` |
| Swift packages on GitHub | `api.github.com`, with `GITHUB_TOKEN` when it is set |
| The Go language | `go.dev` |
| The Python language | `www.python.org` |
| The Rust language | `static.rust-lang.org` |
| The Swift language | `www.swift.org` |
| Dart and Flutter | `storage.googleapis.com` |
| Node.js | `nodejs.org` |

A dependency that a lockfile installs from a registry other than the public one is never looked up: the public registry's date for a package of the same name says nothing about it. Each request URL names one dependency, and for most registries its version. A language lookup fetches the vendor's public list of releases; for Python and Dart the URL also names the feature release, such as `3.15.0`. Requests identify themselves as `llm-docs/<version>` in the User-Agent header. Nothing else from your project leaves your machine. The hook never sends file contents, file paths, project names, or code anywhere.

All lookups in one session start share a budget of 1,000 ms. Dates still missing after that are fetched by a background `llm-docs status` process, started at most once per project every 6 hours, so the next session has them. That process makes the same requests to the same hosts, without the 1,000 ms budget.
