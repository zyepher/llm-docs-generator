# llm-docs

AI coding agents write code for the library and language versions they were trained on. Your project may use a newer release, or stay on an older one on purpose. `llm-docs` saves the docs for the exact versions you use inside your repository, and tells the agent at the start of each session which of them are newer than its training data and which page to read first.

This README has two parts: [for humans](#for-humans) and [for agents](#for-agents).

## For humans

### The problem

An AI model's knowledge stops on the day its training data ends. Your dependencies keep changing after that.

A real case: Zod 4.5 (August 2026) made `z.iso.datetime()` require seconds. Code written the old way still compiles and still passes the type checker. It then rejects every time a web calendar sends without seconds, such as `2026-12-01T09:30Z`. Nothing warns the agent, so it has no reason to look anything up. When an agent does search the web, it usually lands on the docs for the newest release, not the version you have installed.

### What it does

- **Saves the right docs in your repo.** For each library or language you choose, it fetches the official docs for the exact version your project uses and stores them as plain Markdown files, one per page.
- **Tells the agent what is new to it.** When a session starts, the agent gets a short note: which of your libraries and languages were released after its training data ends, where their docs are, and which page to read first (usually the upgrade guide).
- **Notices when the docs go stale.** If you upgrade a library or move to a new language version, someone edits a saved page, or a link breaks, one check reports it. The check works offline, so it can run in CI.
- **Records where every page came from.** Each set of docs lists its source (a repository and commit, or a URL), a fingerprint of every file, and the license it found.

### Get started

You need Node.js 22.19 or newer, and git.

In Claude Code:

```sh
claude plugin marketplace add Zyepher/llm-docs-generator
claude plugin install llm-docs@llm-docs
```

In Cursor, open **Customize**, choose **From GitHub Repository**, import this repository, and install `llm-docs`. The [plugin README](plugin/README.md#install) has the details.

Then ask your agent, in your own words:

> Pin the docs for zod.

It works the same for a language:

> Pin the docs for the Swift version we use.

The agent finds the official docs for your version, saves them under `agent-docs/`, and checks the result. You review and commit the new files. From then on:

- `AGENTS.md` (or `CLAUDE.md`) holds a short list of the saved docs, kept up to date for you.
- Each new session starts with the note described above.

### Does it help?

We measure it instead of claiming it. The [evaluation](evals/README.md) gives the same coding tasks to the same agent three ways: without `llm-docs`, with saved docs, and with saved docs plus the session note. The agent can search the web in all three. There are 16 tasks. Twelve use library changes released after the model's training data ends, and in seven of those the old code still compiles, so nothing tells the agent to look. Four use old, well-known versions, to check that the tool does no harm.

<!-- EVAL-RESULTS -->
Results will be published here with the date, the model, the Claude Code version, and the number of runs.

### Good to know

- **It only helps with what you pin.** For other new libraries and languages, the session note lists them and suggests pinning their docs.
- **Languages are tracked by feature release.** The tool reads the Go, Python, Rust, Swift, Dart, Flutter, or Node.js version from your project's own files, such as `.python-version`, `go.mod`, `.swift-version`, or `.nvmrc`. It follows 3.15 or 6.4, not each patch release, because patch releases do not change a language. It knows only what those files say: a project that states a minimum, such as "3.12 or newer", is tracked at that minimum.
- **Not every language keeps docs for old versions.** Python, Node.js, and Swift publish their docs with each release. Go and Rust do so for the language itself, but keep some guides and release notes where they are not marked by version. Dart and Flutter publish docs for their current release only, so an older version of those cannot be pinned exactly.
- **Saved docs are copies of someone else's work.** Check each library's license before you commit or share them. The tool records the license it finds and warns when it finds none.
- **It fetches without logging in.** A private repository or a site behind a login cannot be fetched. Put those docs in a folder inside your project and pin that folder.
- **Docs take space.** Expect a few hundred kilobytes to a few megabytes per library.
- **It is not on npm yet.** Version 3 is distributed through this repository. The plugin includes the tool, so installing the plugin is all you need.
- **Claude Code and Cursor are supported.** Codex reads the list in `AGENTS.md`, but the plugin is untested there.
- **The session note is skipped rather than late.** If it cannot be ready within 1.5 seconds, the agent gets no note that time.
- **Sometimes it has to assume the model.** Some sessions do not say which model is running. The note then uses your configured default and says that it is assuming.
- **It fetches only what it is told to.** It does not search the web, crawl sites, write docs from your code, or judge whether the docs are right.
- **Fetched docs are treated as untrusted.** [Security](docs/security.md) explains what is checked and what can reach your agent.

## For agents

You are reading the repository of `llm-docs`, a command-line tool and a plugin for coding agents. What to do depends on why you are here.

### A user asked you to pin docs for a library

Follow the `add-docs` skill the plugin installs ([plugin/skills/add-docs/SKILL.md](plugin/skills/add-docs/SKILL.md)). In short:

1. Read the library's version from the project's lockfile.
2. Run `llm-docs discover --package <ecosystem>:<name>@<version>`. It reports the real repository, the matching tag, the docs folders, and the files that describe what changed. Never fill these in from memory.
3. Run `llm-docs add` with `--dependency`, so the docs follow the lockfile, and `--read-first` for the page that says what changed. Try it with `--dry-run` first.
4. Run `llm-docs verify`. It must pass.

A language or toolchain (Go, Python, Rust, Swift, Dart, Flutter, Node.js) has no registry to ask. Bind the pack with `--dependency toolchain:<name>`, so the docs follow the version the project's own files state, and follow the skill's "Languages and toolchains" section to find and confirm the docs repository.

Run the tool as `llm-docs`. If that is not found, run `node <plugin folder>/bin/llm-docs.mjs`. Do not run `npx llm-docs`: the package is not on npm, so a package with that name is not this tool.

### The project already has pinned docs

- Before you write code against a pinned library, open `agent-docs/<id>/index.md`. Read the pages under "Read first", then the page for the API you need. Trust these pages over your memory.
- Guides in `agent-docs/<id>/guides/` are summaries written for the project. Pages outrank them.
- When the session note or `llm-docs status` reports a problem, run the command it gives you.
- Do not edit files under `agent-docs/<id>/pages/`. They are checked against recorded fingerprints, and `verify` will fail.

### Reference

- `llm-docs --help` and `llm-docs <command> --help` show every option with examples. `llm-docs capabilities --json` lists the same in a form you can parse.
- Exit codes: 0 success, 1 a check failed, 2 a usage or configuration error, 3 a runtime failure such as network or git.
- With `--json`, a command prints one JSON document on stdout and its messages on stderr.
- [Commands](docs/commands.md), including how to run the checks in CI. [Configuration](docs/config.md). [Security](docs/security.md). [All reference pages](docs/README.md).

### You are changing this repository

Read [CONTRIBUTING.md](CONTRIBUTING.md) and the [design spec](docs/design/v3-spec.md) first. Before you report work as done, run `npm run type-check`, `npm run lint`, `npm run format:check`, `npm run build`, `npm run check:plugin`, and `npm test`, and try the changed command against a throwaway project.

## License

[MIT](LICENSE). See the [changelog](CHANGELOG.md) for what changed in version 3 and how to move from version 2.
