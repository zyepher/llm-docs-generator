---
name: llm-docs
description: Reference for the llm-docs CLI, which keeps version-pinned, verified library docs in a repository. Lists every command and flag, exit codes, JSON output, CI checks, what each verify check means and how to fix it, and how to read the session-start note. Use when running llm-docs, reading its output or a failing verify, wiring it into CI, or acting on the note about dependencies newer than your training data.
---

# llm-docs reference

`llm-docs` keeps version-pinned reference docs inside a repository. The recipes live in `llm-docs.json`, and each pack lives in `agent-docs/<id>/` (the packs directory is configurable). To create a pack, follow the `add-docs` skill. To write a guide for one, follow the `write-docs-guide` skill.

Run the CLI as `llm-docs`. If that command is not found, run `node <skill-dir>/../../bin/llm-docs.mjs` in its place, where `<skill-dir>` is the absolute path of the directory that holds this `SKILL.md` (the plugin ships the whole CLI as that one file). Never fetch the CLI from a package registry: it is not published there. Every command prints its own options with `--help`. `llm-docs capabilities --json` describes the installed build: commands, options, source types, converters, ecosystems, transforms, checks, and limits. Trust it over this page when the two differ.

## Conventions

- Exit codes: `0` success, `1` a check failed (`verify`, and the `--check` modes), `2` a usage or config error, `3` a runtime failure (network, git, or a converter).
- `--json` prints machine output on stdout. Human output always goes to stderr, so the two never mix.
- `--project <dir>` names the project root. Without it, commands use the nearest directory above the working directory that holds `llm-docs.json`. `init`, `add`, and `migrate` create the config at the git top level, or in the working directory outside git.
- Every error names what went wrong and the command or config key that fixes it.

## Commands

| Command | What it does |
|---|---|
| `llm-docs init` | Creates `llm-docs.json`, the packs directory with its `.gitignore`, and empty managed blocks in the agent files. Never overwrites config. `--packs-dir <dir>` sets the packs directory. |
| `llm-docs add <id>` | Writes one pack recipe into `llm-docs.json`, then builds that pack. Takes one source flag. See the next table. |
| `llm-docs sync [ids...]` | Builds or rebuilds packs whose recipe, lockfile version, or files changed, then rewrites the managed blocks. Packs already up to date are skipped. |
| `llm-docs verify [ids...]` | Runs every check below. Read-only and offline. `--strict` also checks link fragments against heading anchors and fails on an unknown or proprietary license. |
| `llm-docs refresh [ids...]` | Fetches each pack again at its recorded recipe and reports each page as changed, added, removed, or unchanged, and each git ref that now resolves to another commit. Rebuilds the pack unless `--check`. |
| `llm-docs status` | Lists the packs with their state and the direct dependencies released after or near the model's training data cutoff. Works without `llm-docs.json`. |
| `llm-docs guides stamp <id> [guides...]` | Records the hash of every section each guide cites in `guides/citations.lock.json`. Fails on a citation that does not resolve. |
| `llm-docs migrate <v2-pack-dir>` | Writes a recipe for a v2 pack into `llm-docs.json`. `--id <id>` names the pack and `--version <version>` sets the version, since v2 manifests record none. Never touches the v2 pack. |
| `llm-docs discover` | Prints read-only evidence for writing a recipe, always as JSON on stdout. `--package <ecosystem>:<name>[@<version>]` reports registry metadata, the git tags that match the version, and the Markdown folders at that tag. `--repo <url>[@<version or tag>]` reports the same for a repository that is not a package, such as a protocol specification. `--url <site>` reports the site's `llms.txt`, sitemap, whether pages serve raw Markdown, version segments, and the path prefixes to filter on. |
| `llm-docs capabilities` | Lists the commands. With `--json`, describes everything this build supports. |
| `llm-docs hook session-start` | The plugin's session-start hook. Reads the harness payload on stdin and prints the session-start note. Not for direct use. |

### Options of `add`

| Option | Meaning |
|---|---|
| `--git <repo>` with `--ref <ref>` | A git repository over `https://` at a tag, a branch, or a 40-hex commit. `--path <path>` (repeatable) limits it to folders or files. |
| `--llms-txt <url>` with `--include <glob>` | The pages an `llms.txt` index lists whose URL path matches a glob. At least one `--include` is required. `--strip-prefix <prefix>` drops a path prefix from the stored page paths. |
| `--url <url>` | One page to fetch (repeatable). |
| `--urls-file <file>` | Pages to fetch, one URL per line, `#` starts a comment. |
| `--local <path>` | A project-relative folder or file. |
| `--dependency <ecosystem>:<name>` | Binds the pack to a dependency, so the lockfile decides the version. |
| `--covers <ecosystem>:<name>` | Another package the same docs describe, such as a client next to a server SDK (repeatable, at most 20). Status and the session-start note then count it as documented. Binds no version. |
| `--version <version>` | The docs version. Required unless `--dependency` is set. |
| `--include <glob>` | Files a source takes (repeatable). For `--llms-txt`, URL paths. |
| `--mount <dir>` | Subfolder under `pages/` and `files/` for this source. |
| `--title <title>` | Pack title. The id by default. |
| `--site <baseUrl>` | The docs website, so absolute links to it resolve to pack pages. |
| `--alias <from>=<to>` | A path on the `--site` website that stands for another, such as `/guide/latest=/guide/{version}` (repeatable). |
| `--license <license>` | The docs license: an SPDX expression such as `CC-BY-4.0`, or `proprietary`. Set it for pages fetched from a website, which have no license file. |
| `--convert <tool>` | Converts documents with `docling`, `markitdown`, or `agent`. `--convert-include <glob...>` names the documents. |
| `--recipe <json>` | Extra source fields as JSON, such as `exclude`, `passthrough`, `transforms`, or a `command` converter. |
| `--read-first <target>` | A page to read first, `pages/...` or `files/...` with an optional `#fragment` (repeatable, at most 5). The index lists it at the top and the session-start note names it. |
| `--replace` | Overwrites an existing pack with the same id. |
| `--dry-run` | Prints the recipe and every output path with its source. Writes nothing. |

`{version}`, `{major}`, `{minor}`, and `{patch}` in `ref`, `paths`, `url`, `urls`, `include`, `exclude`, and `--alias` targets are replaced from the resolved version. A recipe whose ref is `v{version}` follows the lockfile to the next version.

### Options of `sync` and `refresh`

- `llm-docs sync --check` writes nothing and exits `1` when any pack or managed block would change.
- `llm-docs sync --offline` fails instead of fetching a network source.
- `llm-docs sync --prune` deletes pack directories that are not in `llm-docs.json`. Without it, sync reports them as orphans.
- `llm-docs refresh --check` writes nothing and exits `1` when anything changed upstream or a converter version changed.

### Options of `status`

- `--model <id>` takes a model id or a Claude Code alias (`opus`, `sonnet`) and looks up its training data cutoff.
- `--cutoff <YYYY-MM>` sets the cutoff month directly. Any other format exits `2`.
- `--offline` uses cached release dates only.
- `--brief` prints only the session-start note, and nothing when there is nothing to say.
- `--json` prints the full report.

The cutoff comes from the first of these that is set: `--cutoff`, `model.cutoff` in `llm-docs.json`, the `LLM_DOCS_MODEL_CUTOFF` environment variable, then the built-in table for the model id. With no cutoff, status and the hook list dependencies released in the last 180 days instead.

## Use it in CI

A CI runner has no plugin, so the workflow downloads the CLI from the GitHub Release that matches `llm-docs --version` (`https://github.com/Zyepher/llm-docs-generator/releases/download/v<version>/llm-docs.mjs`, with its SHA-256 in `llm-docs.mjs.sha256` beside it) and runs each command below as `node llm-docs.mjs <command>`.

| Step | Command | Fails when |
|---|---|---|
| Packs match config and lockfiles | `llm-docs sync --check` | A pack or managed block would change. |
| Packs are intact | `llm-docs verify` | Any check fails. Add `--strict` to also check link fragments and fail on unknown licenses. |
| Upstream still matches, on a schedule | `llm-docs refresh --check` | Upstream changed. It needs the network, so keep it out of the per-commit gate. |

## Verify checks

Each check reports `pass`, `fail`, or `warn`, one line per problem with the pack id, the check name, and the path.

| Check | Fails when | Fix |
|---|---|---|
| `manifest-schema` | `manifest.json` is missing, unreadable, not a regular file, not schema 3, disagrees with its own recipe, or records a path that could leave the pack. | Run `llm-docs sync <id>`. For a v2 pack, run `llm-docs migrate <v2-pack-dir>` first. |
| `outputs` | A file the manifest lists is missing or its hash differs. | Someone edited a tool-written file. Run `llm-docs sync <id>` to rebuild it. Put your own notes in `guides/` instead. |
| `unlisted-files` | A file in the pack is not in the manifest, the pack holds a symbolic link, or part of the pack could not be examined. `guides/` and operating system files such as `.DS_Store` are reported as info only. | Move the file out of the pack, or into `guides/` if it is agent-written text. |
| `links` | A link in a page, the index, or the combined file has a scheme other than `https`, `http`, or `mailto`, or a relative link does not resolve inside the pack. Under `--strict`, also a fragment in the index or combined file with no matching heading. A page's fragment with no matching heading only warns: it is upstream text and its target page exists. | Run `llm-docs sync <id>`. A build never writes a dead local link, so the pack was edited or is stale. |
| `recipe` | The recipe in `llm-docs.json` changed since the last sync. Warns when the config has no pack with this id (an orphan). | Run `llm-docs sync <id>`. For an orphan, run `llm-docs sync --prune` or add the pack back to the config. |
| `lockfile` | The lockfile resolves the bound dependency to another version than the pack's, or no lockfile resolves it. When the lockfiles install it only from another registry, it fails unless the recipe sets `version`. | Run `llm-docs sync <id>`. If the recipe pins `version`, change it first, because an explicit version wins. For a dependency from another registry, set `version`. |
| `citations` | A guide citation no longer resolves, or a cited section changed since stamping. Warns for an unstamped guide or one edited after stamping. | Re-review the guide with the `write-docs-guide` skill, then run `llm-docs guides stamp <id> <guide>`. |
| `conversion` | A document's `agent` conversion is stale: the original changed after its `.md` was written. | Write the `.md` conversion again from the current original, then run `llm-docs sync <id>`. |
| `license` | Warns for an `unknown` or `proprietary` license. Fails under `--strict`. | Set `"license"` on the pack in `llm-docs.json` to an SPDX id or `"proprietary"`, then run `llm-docs sync <id>`. |
| `config-schema` | `llm-docs.json` does not parse or breaks the schema. Unknown keys are errors. | Fix the key the message names. |
| `agent-block` | A managed block in an agent file differs from what sync writes. Warns when the agent file does not exist. | Run `llm-docs sync`. Never edit the text between the markers by hand. |

## Read the session-start note

When the plugin is installed, each session starts with a note from `llm-docs hook session-start`. `llm-docs status --brief` prints the same text. It has up to four parts, and leaves out any part with nothing in it.

1. **Pinned docs packs to fix.** Each line says what is wrong and ends with the step that fixes it, usually `llm-docs sync <id>`. Do it before you rely on that pack. A pack whose files no longer match its manifest, or that llm-docs cannot use as it is, is listed only here, never as pinned docs: do not read its pages until the fix has run.
2. **Pinned docs for libraries released after or close to your training data cutoff.** Your memory of these libraries predates the pinned versions. Read the pack index and the pages for the APIs you touch before you write code against them, starting with the pages the pack marks to read first.
3. **Direct dependencies released after or close to your cutoff with no pinned docs.** Read their current docs before you use their APIs, or pin them with the `add-docs` skill.
4. **The pack list**, when the agent file your harness reads has no managed block. Treat it like the managed block.

When no cutoff is known for the model, parts 2 and 3 list releases from the last 180 days under a neutral heading. A list cut for length ends with how many entries it left out and points to `llm-docs status`.

The hook prints nothing when there is nothing to say, when `LLM_DOCS_HOOK=off` is set, or when `llm-docs.json` sets `"hook": { "enabled": false }`. It always exits `0` and writes its errors to `hook.log` in the cache directory.

## Configuration keys

| Key | Meaning |
|---|---|
| `packsDir` | Project-relative packs directory. Default `agent-docs`. |
| `agentFiles` | `"auto"`, or a list of agent files to hold the managed block. `"auto"` uses `AGENTS.md`, and `CLAUDE.md` when it exists without an `@AGENTS.md` import. |
| `block.maxBytes` | Managed block budget, 1024 to 65536 bytes. Default 4096. |
| `hook.enabled`, `hook.nearCutoffDays` | Turns the session-start note off, and sets how many days before the cutoff count as near it (default 90). |
| `model.cutoff` | Training data cutoff as `YYYY-MM`, for status and the hook. |
| `packs.<id>.dependency`, `.version` | The dependency binding and the explicit version. |
| `packs.<id>.covers` | Up to 20 more dependencies the pack's docs describe, as `--covers` sets them. They bind no version; `verify` warns when one resolves to another major version than the pack's. |
| `packs.<id>.sources` | The sources. Each has a `type` (`git`, `urls`, `llms-txt`, `local`) and may set `mount`, `include`, `exclude`, `passthrough`, `convert`, and `transforms`. |
| `packs.<id>.sources[].transforms` | Opt-in text transforms: `strip-mintlify-banner`, `strip-html-comments`, `drop-frontmatter-description`. |
| `packs.<id>.site` | `baseUrl` and path `aliases` of the docs website. |
| `packs.<id>.layout.combined` | Also writes `<id>.full.md`, every page in one file, for hosts without file access. |
| `packs.<id>.license` | Declared license: an SPDX id, `"proprietary"`, or `null`. |
| `packs.<id>.readFirst` | Up to 5 pages to read first, as `--read-first` sets them. |
| `packs.<id>.limits.maxFileBytes` | Per-file download cap, up to 200 MB. Default 20 MB. |

Environment variables: `LLM_DOCS_CACHE_DIR` moves the cache directory. `LLM_DOCS_HOOK=off` silences the hook. `LLM_DOCS_MODEL_CUTOFF` sets the cutoff. `GITHUB_TOKEN` is sent only to `api.github.com`. `LLM_DOCS_DEBUG=1` prints stack traces on errors.
