---
name: add-docs
description: Pin version-matched reference docs for a library into this repository with the llm-docs CLI. Use when the user asks to add, pin, fetch, or vendor docs for a library, SDK, API, or protocol, when the session-start note lists a dependency newer than your training data with no pinned docs, or when a dependency's API in this project does not match what you remember.
---

# Add pinned docs for a library

You are the planner. You choose the source, the version binding, and the page filter. The `llm-docs` CLI fetches exactly what the recipe names, converts it to one Markdown page per upstream page, and records where every byte came from. It never searches, crawls, or guesses. A pack is only as right as the evidence you base the recipe on.

Run the CLI as `llm-docs`. If that command is not found, run `node <skill-dir>/../../bin/llm-docs.mjs` in its place, where `<skill-dir>` is the absolute path of the directory that holds this `SKILL.md` (the plugin ships the whole CLI as that one file). Never fetch the CLI from a package registry: it is not published there. Run `llm-docs <command> --help` before you use a flag this skill does not show.

## 1. Bind the pack to the dependency

If the library is a dependency of this project, bind the pack to it with `--dependency <ecosystem>:<name>` and leave out `--version`. The lockfile then decides the version. When the lockfile moves, `llm-docs sync` rebuilds the pack at the new version and `llm-docs verify` fails until it does, so the docs can never silently drift from the code.

- Use the registry name as the lockfile spells it, such as `npm:@tanstack/react-query` or `pypi:pydantic`. Ecosystems are `npm`, `pypi`, `cargo`, `go`, `pub`, and `swiftpm`.
- Pass `--version` alone only for docs that no lockfile pins, such as a protocol revision (`2026-07-28`) or a hosted API.
- If two workspaces resolve different versions, sync stops and names both. Ask the user which version the docs should follow, then pass it with `--version` next to `--dependency`.
- When one docs set describes several packages of a family that the project depends on (a server and a client SDK, `@tanstack/*` packages), bind the pack to the main one and list each other one with `--covers <ecosystem>:<name>`. The session-start note then stops reporting them as dependencies with no pinned docs. Cover only packages these docs really describe; one whose docs live elsewhere gets its own pack.

## 2. Gather evidence, never memory

Your memory of a repository URL, a tag format, or a docs directory may be out of date or wrong. Ask the CLI instead.

1. Read the version the project uses from its lockfile.
2. Run `llm-docs discover --package <ecosystem>:<name>@<version>`. It prints JSON on stdout and a summary on stderr. Read these fields:
   - `repository.url` and `repository.directory`: the upstream repository and the package's folder inside it.
   - `tags.matches`: the git tags that name this version, each with its `form` (`v-prefixed` is `v8.2.0`, `bare` is `8.2.0`, `name-at` is `vite@8.2.0`). Every form except `suffix` is an exact match.
   - `docDirectories.directories`: the folders that hold Markdown at the matching tag, ranked by file count.
   - `changeDocuments`: changelog, migration, and upgrade files at the matching tag.
   - `registry.metadata.license`: the license the registry declares.
3. If the docs live on a website, also run `llm-docs discover --url <site>`. It reports whether the site publishes an `llms.txt` index, whether its pages serve raw Markdown when `.md` is appended, and the version-looking path segments (`v8`, `2026-07-28`) its index uses.

If the evidence points at two equally plausible sources, ask the user. Do not pick the first one.

## 3. Choose the source

Take the first of these that the evidence supports.

1. **The library's own repository at the tag for this version.** Use `--git <repository.url>`, a `--ref` built from the matching tag, and one `--path` per docs folder. Write the ref with the `{version}` placeholder in the tag's form (`v{version}`, `{version}`, or `vite@{version}`), so the recipe follows the lockfile to the next version without an edit. Monorepos often keep every framework's docs side by side, so take only the folder for the framework this project uses.
2. **An `llms.txt` index, with an explicit filter.** Use `--llms-txt <url>` with at least one `--include` glob over the listed URL paths, and `--strip-prefix` to drop a version segment from the stored paths. Filter on the version segment when the site serves several versions. This source fits only when the site serves raw Markdown and the repository does not hold the docs.
3. **An explicit list of page URLs.** Use `--url` once per page, or `--urls-file` with one URL per line. Build the list from an index the site publishes or from pages you opened yourself.

Never crawl. Do not follow links from page to page to assemble a URL list, and do not take a whole site because you could not decide which pages matter. A pack with the 30 pages the project needs is worth more than one with 3,000.

For docs inside this repository, use `--local <path>`.

A private repository or a page behind a login cannot be fetched, because llm-docs never sends credentials. Copy those docs into a folder in the project and use `--local <path>`.

### When no tag matches

If `tags` reports `no-match`, or only `suffix` matches:

- Look for the release commit another way, such as a tag in a form discover did not try or the commit a release note names. Pin it as a 40-hex `--ref`.
- If the docs site is versioned, take that version's pages with an `llms-txt` or `urls` source instead.
- Never pin a branch to stand in for a version. A branch ref floats, and sync warns that it does.
- If no source describes this exact version, tell the user what exists (for example, docs for 8.1 and for the latest release) and let them choose. Do not label docs for one version as another.

### Documents

PDFs and office files reach a pack through a converter. Use `--local <folder>` or a git source with `--convert docling` or `--convert markitdown`, and `--convert-include` to name the documents. If neither tool is installed, `llm-docs capabilities --json` lists the install command for each. With `--convert agent`, no tool runs. You write a Markdown sibling `X.md` for each document `X`, and the pack records the hashes of both. Spreadsheets stay byte-identical as passthrough files, listed in the `passthrough` source field through `--recipe`.

## 4. Find what changed since your training data

The page an agent needs first is usually the one that says what changed between the version it remembers and the pinned version. Always look for it.

1. Check `changeDocuments` in the discover output, and look for a migration or upgrade guide in the docs folder itself.
2. Include it in the pack. For a git source, add its folder or file with another `--path`.
3. Mark it as a page to read first with `--read-first <target>`. A target is a pack-relative path, `pages/...` or `files/...`, with an optional `#fragment` for one section. Repeat the flag for up to 5 targets. The pack index lists these pages at the top, and the session-start note names them.

Take the target paths from the dry run in the next step, because the output path depends on the folders the source takes.

## 5. Dry-run, then add

Run the same command with `--dry-run` before any acquisition larger than a handful of pages. It prints the recipe and every output path with its source, and writes nothing.

```sh
llm-docs add vite --dependency npm:vite --git https://github.com/vitejs/vite --ref v{version} --path docs --dry-run
```

Read the file list before you go on.

- Every page the project needs is there. Compare against the APIs the code imports.
- Nothing is there that the project does not need: drafts, blog posts, other frameworks, translated copies. Exclude them with `--recipe '{"exclude":["**/blog/**"]}'`.
- The change documents from step 4 are there, and you have their output paths for `--read-first`.

Then run the command without `--dry-run`. `llm-docs add` writes the recipe into `llm-docs.json` and builds the pack in one step. It refuses to overwrite an existing pack id unless you pass `--replace`.

## 6. Set the license

The manifest records the license it detects from the repository's license files. Pages fetched from a website have no license file, so their license is `unknown`, and `llm-docs verify --strict` fails on it. If the discover output, the repository's license file, or the site states the terms, pass `--license` on the `add` command with the SPDX expression (such as `CC-BY-4.0`, or `"Apache-2.0 AND CC-BY-4.0"` when parts of the docs carry different terms), or `proprietary`. Read the license file itself: a repository can license its code, its specification, and its prose differently. For a pack that already exists, set `"license"` on it in `llm-docs.json` and run `llm-docs sync <id>`. A declared license is recorded next to the detected one, and a mismatch is a warning worth reading.

## 7. Verify and read the pack

1. Read every warning the build printed: skipped file types, unresolved links, a floating branch ref, an unknown license.
2. Run `llm-docs verify <id>`. It must pass. The `llm-docs` skill lists each check and its fix.
3. Open `agent-docs/<id>/index.md` (the packs directory is configurable) and confirm it lists the pages you expect.
4. Search `pages/` for the exact symbol names the project uses. If a symbol you need is missing, widen the source with `--replace` and run the dry run again.

Commit `llm-docs.json` and the pack directory. The managed block in `AGENTS.md` or `CLAUDE.md` now points every future session at the pack.

## Hard rules

- Never pass a guessed repository, tag, or docs folder. Every value in the recipe comes from discover output, the lockfile, or a page you read.
- Never upgrade a pinned version on your own. A new version is a lockfile change the user makes.
- Never run scripts, builds, or install hooks from a repository you inspect.
- Never put credentials or tokens in a recipe or URL.
