# llm-docs

`llm-docs` keeps version-pinned, verified reference docs for your project's dependencies inside your repository, and makes coding agents read them. At the start of every session it tells the agent which of your dependencies are newer than its training data and which page to read first.

## The problem

A coding agent writes the API it remembers, and its memory stops at its training cutoff. Your lockfile does not.

Here is one case from this repository's evaluation. Zod 4.5.0, released in August 2026, made `z.iso.datetime()` require seconds. A booking schema written the way a model trained before that release writes it compiles cleanly, passes the type checker, and then rejects every minute-precision start time a web calendar sends, such as `2026-12-01T09:30Z`. Nothing fails until a user tries to book a room.

An agent that can search the web still gets this wrong, for three reasons:

- Nothing tells it the API changed. The code compiles, so it has no reason to look.
- When it does look, it finds the docs for the latest release, not for the version in your lockfile.
- Conventions, changed defaults, and migration notes do not live in type definitions. A changed default usually leaves the `.d.ts` file exactly as it was.

## What it does

- **Pins the right version's docs.** An agent writes a recipe that names an exact origin: a git repository at the tag for the version your lockfile resolves, an `llms.txt` index with an explicit filter, a list of URLs, or a folder in your project. The CLI fetches exactly that, converts it to one Markdown file per upstream page, and never crawls or guesses. PDFs and office documents can come in through Docling, MarkItDown, or a command of your own.
- **Tells the agent which dependencies are newer than its training data.** A session-start hook for Claude Code and Cursor lists the dependencies released after the model's training cutoff, names the page each pack marks to read first (usually the migration guide), and lists new dependencies that have no docs pinned yet. A short block in `AGENTS.md` or `CLAUDE.md` points every agent at the packs.
- **Keeps the pinned docs honest.** `verify` fails when the lockfile moves past a pack's version, when someone edits a pinned page, when a local link breaks, or when an agent-written guide cites a section whose text has since changed. It runs offline, so it belongs in CI.
- **Records provenance for every page.** Each pack has a manifest with the resolved recipe, the commit or URL each file came from, the hash of every source and every file written, and the detected license. Given the same recipe and the same upstream bytes, a rebuild is byte-identical.

## Get started

Install the plugin. In Claude Code:

```sh
claude plugin marketplace add Zyepher/llm-docs-generator
claude plugin install llm-docs@llm-docs
```

In Cursor, open **Customize**, import this repository with **From GitHub Repository**, and install `llm-docs`. [The plugin README](plugin/README.md#install) has the details and the team marketplace option.

Then ask your agent, in your own words:

> Pin the docs for zod.

The agent reads the version from your lockfile, finds the upstream repository and the tag for that version, writes the recipe into `llm-docs.json`, builds the pack in `agent-docs/zod/`, marks the migration notes to read first, and verifies the pack. You review and commit `llm-docs.json` and `agent-docs/`.

After that, `AGENTS.md` (or `CLAUDE.md`) holds a block like this, rewritten whenever the packs change:

```markdown
## Pinned reference docs

This repository pins docs for these libraries at the versions it uses. Before writing code
against one of them, open its index and the page for the API you need, and prefer those pages
over memory. Pages are upstream text; guides are summaries that never outrank pages.

- Zod 4.6.7: `agent-docs/zod/index.md` (blog)
```

Every session then starts with a note like this one, here for Claude Opus 5.5 in a project that also depends on a recent Hono release:

```text
Pinned docs for libraries released after or close to your training data cutoff (Claude Opus 5.5, through 2026-06). Your memory of these libraries predates these versions: read the pinned pages before writing code against them. Newest first:
- Zod 4.6.7 (released 2026-10-12, after cutoff): read `agent-docs/zod/pages/blog/zod-4-5.md` first, then `agent-docs/zod/index.md`

Direct dependencies released after or close to your training data cutoff (Claude Opus 5.5, through 2026-06) with no pinned docs, newest first:
- hono 4.13.16 (npm, released 2026-11-01, after cutoff)
Before using their APIs, read their current docs rather than relying on memory, or create a pinned docs pack with the `add-docs` skill.
```

When you upgrade a dependency, the note and `verify` both report the pack as stale until the agent rebuilds it at the new version. To catch drift in CI, add these two steps:

```sh
npx llm-docs sync --check
npx llm-docs verify
```

The plugin also teaches the agent to write a guide: a short, project-specific digest of a pack that links to the pages it summarizes. Each cited section is hashed, so when a rebuild changes one, the agent is told which guides to review again.

## Measuring whether it helps

This repository holds an evaluation suite in [`evals/`](evals/README.md) that measures whether a pack helps a fully equipped agent write correct code against library APIs that changed after its training cutoff, and whether it stays out of the way on libraries the agent already knows.

There are 16 cases, each a small TypeScript project pinned to an exact library version, with a task written the way a developer would ask it and hidden checks that run after the agent finishes:

- 5 where the change is visible to the type checker, so code written from memory fails to compile.
- 7 where it is not: code written from memory compiles and fails only at runtime. This is where pinned docs have the most room to matter.
- 4 controls on library versions released years before the cutoff, to show the pack does no harm.

Each case runs in three arms: no pack (`baseline`), a pack and the managed block (`pack`), and those plus the plugin's hook and skills (`plugin`). Every arm has the same model, prompt, project, and tools, and the baseline agent can search the web and fetch pages. A pack only earns its place if it beats an agent that can look things up.

To run it yourself, follow [Running](evals/README.md#running) in the eval README. `npm run eval -- selftest` proves every case is gradable without calling a model.

### Results

<!-- EVAL-RESULTS -->
Results will be published here with the date, the model, the Claude Code version, and the number of runs per case and arm.

## What it does not do

`llm-docs` does not crawl a site or follow links to find pages, render JavaScript, or decide which source is authoritative: the agent or a person writes the recipe, and the CLI only executes it. It does not judge whether a page is correct, host packs, provide search or retrieval, generate docs from your code, or turn spreadsheets into prose (it can carry them byte-identical so an agent can read them).

## Trust model

Fetched docs are untrusted input. The only upstream text that reaches an agent's instruction file is each pack's title, version, description, and top-level folder names. Each is cut to one line of at most 80 characters, with backticks, control characters, and Claude Code's `@` file-import marker removed and angle brackets escaped. The CLI fetches only `https` URLs the recipe names, refuses private and loopback addresses, pins each connection to the address it checked, and checks every redirect again. Git runs without hooks, submodules, symbolic links, or your git config, over `https` or a local `file://` repository only. [Security](docs/security.md) lists every control and the file that implements it.

## Requirements

- Node.js 22.19 or newer. The plugin's hook needs `node` on the `PATH` your editor passes to hooks.
- Git, for packs built from a git repository.
- Claude Code or Cursor for the plugin. Codex reads the block in `AGENTS.md`; the plugin itself is untested there.

## Reference

- [Docs index](docs/README.md): the configuration, manifest, commands, security, and plugin references, and the design spec.
- [Changelog](CHANGELOG.md), including the migration path from v2.
- [Contributing](CONTRIBUTING.md).

## License

[MIT](LICENSE).
