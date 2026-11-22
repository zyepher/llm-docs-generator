# Command reference

Every command of the `llm-docs` CLI: what it does, when to use it, its exit codes, and what its `--json` output contains. For the full option list of a command, run `llm-docs <command> --help`. `llm-docs capabilities --json` describes the installed build, generated from the same tables the code uses.

Most people never type these commands: their coding agent runs them through the plugin's skills. This page is for agents, CI authors, and anyone reading a command's output.

## Conventions

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Success. |
| `1` | A check failed: `verify` found a failing check, or a `--check` mode found something that would change. |
| `2` | A usage or config error: a bad option, an invalid `llm-docs.json`, a recipe the build rejects, a refused URL. Fix the input. |
| `3` | A runtime failure: the network, git, a converter, file I/O, or another sync holding the lock. Retrying may help. |

When a run has both config errors and runtime failures across several packs, it exits `3`.

### Output

- Human output goes to stderr. With `--json`, machine output goes to stdout, so the two never mix.
- Three outputs are on stdout by design: `discover` always prints JSON, `status --brief` prints the session-start note, and `capabilities` without `--json` prints its command list.
- The CLI prints no color.
- `LLM_DOCS_DEBUG=1` adds stack traces to errors.

### Project

`init`, `add`, `sync`, `refresh`, `verify`, `status`, `guides stamp`, and `migrate` take `--project <dir>` to name the project root. Without it, they use the nearest directory at or above the working directory that holds `llm-docs.json`. `status --project <dir>` is no exception: it reports on `<dir>` as given, and with no `llm-docs.json` there it analyses that directory's dependencies. `init`, `add`, and `migrate` create `llm-docs.json` when no project is found: at the git top-level directory, else in the working directory. `discover`, `capabilities`, and `hook session-start` do not read a project and take no `--project`.

## `init`

Creates `llm-docs.json`, the packs directory with a `.gitignore` for `.staging` and `.llm-docs.lock`, and the managed block in each agent file. It never overwrites an existing config, so running it again only brings the managed blocks up to date.

Use it to adopt the tool in a repository before adding packs. `add` creates the config on its own, so `init` is optional.

| Exit | When |
|---|---|
| `0` | Created, or already present. |
| `2` | `--packs-dir` is not a project-relative subdirectory, or an agent file cannot be updated (not UTF-8, mismatched markers, a link out of the project). |
| `3` | An agent file could not be written. |

`--json`: `projectRoot`, `configPath`, `created` (false when the config already existed), `packsDir`, and `agentBlocks` (see [Managed block outcomes](#managed-block-outcomes)).

## `add`

Writes one pack recipe into `llm-docs.json` and builds that pack. It takes exactly one source: `--git` with `--ref`, `--llms-txt` with at least one `--include`, one or more `--url`, `--urls-file`, or `--local`. `--recipe` adds source fields as JSON (such as `exclude`, `passthrough`, `transforms`, or a `command` converter) or names the whole source by itself. Either `--version` or `--dependency` is required.

Use it to create a pack. The [`add-docs` skill](../plugin/skills/add-docs/SKILL.md) is the procedure an agent follows to choose the source and version.

- An existing pack id is refused unless `--replace` is given.
- `--covers <ecosystem>:<name>` (repeatable) lists another package the same docs describe, such as the client package next to a server SDK. It writes `covers` (see [`covers`](config.md#covers)) and binds no version; `--dry-run` shows it in the recipe.
- When the build rejects the recipe as a config error, including an unresolved `--read-first` target, `llm-docs.json` is put back as it was.
- `--dry-run` lists the files the recipe takes without building anything, and writes nothing. It prints the recipe and every output path with the source it comes from, and says for each `--read-first` target whether a taken file lands at its path. A heading fragment can only be checked once pages are built.
- A rebuild that changes sections cited by guides prints the guides to re-review, as `sync` does.

| Exit | When |
|---|---|
| `0` | The pack was built (or, with `--dry-run`, previewed). |
| `2` | A usage error, an invalid id, an existing id without `--replace`, or a recipe the build rejects. |
| `3` | Acquisition or conversion failed at runtime. The recipe stays in `llm-docs.json`, so `llm-docs sync <id>` retries it. |

`--json` with `--dry-run`: `id`, `dryRun: true`, `recipe` (resolved), `recipeHash`, `files` (each output path with its source), `readFirst` (each target, whether it was found, the fragment, and nearby paths), and `warnings`.

`--json` without `--dry-run`: `id`, `dryRun: false`, `recipe` (as written to the config), `configKept` (false when the recipe was rolled back), and `sync` (the [sync report](#sync)).

## `sync`

Brings packs in line with `llm-docs.json` and the lockfiles, then rewrites the managed blocks. With ids, it syncs only those packs.

A pack is skipped when its manifest's `recipeHash` matches the config and its files match the manifest. It is rebuilt when the recipe changed, the lockfile moved its bound dependency to another version, a pack file was edited, added, or removed, it was never built, or (for `local` sources, which are read again on every sync) a source file changed. A rebuild happens in a staging directory and is swapped in only after it verifies. The previous pack stays in place when a build fails.

Use it after editing `llm-docs.json`, after a dependency upgrade, and to repair an edited pack.

- `--check` writes nothing and exits `1` when any pack, orphan, or managed block would change. Use it in CI.
- `--offline` fails any pack that needs a rebuild from a network source, instead of fetching. Local sources still build.
- `--prune` deletes pack directories that are not in the config. It keeps a directory without a `manifest.json` and a pack that holds guides, and reports why. Orphans are handled only when no ids are given. Without `--prune`, orphans are reported.
- After a rebuild, sync lists the guides whose cited sections changed or no longer resolve, with the `guides stamp` command to run once they are reviewed.
- Only one sync runs per project at a time. A second one fails at once (exit `3`). `--check` takes no lock.

| Exit | When |
|---|---|
| `0` | Every pack and block is up to date or was rebuilt. |
| `1` | `--check` found a change. |
| `2` | Invalid config, an unknown id, or a pack or block that failed with a config error. |
| `3` | A runtime failure in any pack or block, or the lock is held. |

`--json` (also the shape of `refresh --json` and of `add`'s `sync` field):

| Field | Meaning |
|---|---|
| `check` | Whether this was a `--check` run. |
| `changed` | Something changed, or under `--check` would change. |
| `packs[]` | `id`; `status` (`unchanged`, `built`, `would-build`, or `failed`); `reason` for a rebuild; `error` and `exitCode` (`2` or `3`) for a failure; `warnings`; `guideReview` when guides need review; `refresh` for `refresh` only. |
| `packs[].guideReview` | `basis` (`sections` after a rebuild, `pages` under `refresh --check`) and `guides[]`, each with `guide` and `citations[]` of `{ target, change }`. `change` is `section-changed` or `unresolved` for `sections`, and `page-changed` or `page-removed` for `pages`. |
| `orphans[]` | `id`, `status` (`orphan`, `pruned`, `would-prune`, or `kept`), and `reason` when kept. |
| `agentBlocks[]` | See [Managed block outcomes](#managed-block-outcomes). |

## `refresh`

Fetches each pack again at the recipe its manifest records and reports what changed upstream: each page as `unchanged`, `changed`, `added`, or `removed`, each git ref that now resolves to another commit, and each converted page whose converter version changed. It then rebuilds the pack unless `--check` is given.

Use `refresh --check` on a schedule to learn when upstream docs moved under the same version or branch. It needs the network, so keep it out of the per-commit gate.

- `--check` writes nothing and exits `1` when anything changed upstream. It lists guides whose cited pages changed, at page level, since sections can only be compared after a rebuild.
- A pack whose recipe changed since the last sync, or that was never built, is refused (exit `2`): run `sync` first.

| Exit | When |
|---|---|
| `0` | Nothing changed, or the packs were rebuilt. |
| `1` | `--check` found an upstream change. |
| `2` | Invalid config, an unknown id, or a pack that is not built or whose recipe changed. |
| `3` | A runtime failure. |

`--json`: the [sync report](#sync), where each pack also has `refresh`: `changed`, `counts` (per status), `files[]` (`source`, `output`, `status`), `refs[]` (`source`, `repo`, `ref`, `previousCommit`, `commit`), and `converters[]` (`source`, `output`, `previous`, `current`).

## `verify`

Runs every check below against the configured packs and any orphan pack directories, or against the named packs. It is read-only and offline.

Use it in CI after `sync --check`, and whenever a pack looks wrong.

- `--strict` also checks link fragments against heading anchors, and fails an `unknown` or `proprietary` license instead of warning.
- Output is one line per finding with the pack id, the check name, and the path.

| Exit | When |
|---|---|
| `0` | No check failed. Warnings and info do not fail. |
| `1` | A check failed, including `config-schema` for an invalid `llm-docs.json`. |
| `2` | No `llm-docs.json` was found, or an id is unknown. |

`--json`: `ok`, `strict`, and `results[]`, one per check per pack: `check`, `packId` (`null` for project checks), `status` (`pass`, `fail`, `warn`, `info`, or `skipped`), `findings[]` (`status`, `message`, and `path` when there is one), and `reason` when skipped. When `manifest-schema` fails, the pack's other checks are `skipped`.

### Verify checks

Project checks:

| Check | Fails when | Fix |
|---|---|---|
| `config-schema` | `llm-docs.json` is not valid JSON or breaks the schema. Unknown keys fail. Verify stops here. | Fix the key the finding names. See [`llm-docs.json` reference](config.md). |
| `agent-block` | A managed block differs from what `sync` would write, or an agent file cannot be read or updated. A missing agent file is a warning, so a project that keeps it out of git can still verify. | Run `llm-docs sync`. Never edit between the markers by hand. |

Pack checks, in report order:

| Check | Fails when | Fix |
|---|---|---|
| `manifest-schema` | `manifest.json` is missing, is not JSON, is not schema version 3, or belongs to another pack id. | Run `llm-docs sync <id>`. For a v2 pack, run `llm-docs migrate` first. |
| `outputs` | A file the manifest lists is missing, or its hash differs. | A tool-written file was edited. Run `llm-docs sync <id>` to rebuild it, and put your own notes in `guides/`. |
| `unlisted-files` | A file in the pack is not in the manifest, or the pack holds a symbolic link. Files under `guides/` and `.DS_Store`, `Thumbs.db`, and `desktop.ini` are reported as info only. | Move the file out of the pack, or into `guides/` if it is agent-written text. |
| `links` | A relative link in a page, the index, or the combined file does not resolve to a file in the pack, points outside it, or is site-absolute (`/x`). Links with a scheme and links in code are ignored. Under `--strict`, also a fragment that matches no heading on the target page (fragments into `guides/` are not checked). | Run `llm-docs sync <id>`. A build never writes a dead local link, so the pack was edited or is stale. |
| `recipe` | The recipe in `llm-docs.json` was edited: resolved at the version the manifest records, it gives another `recipeHash`, or it cannot be resolved. A lockfile that only moved the bound dependency passes here, because `lockfile` reports it. Warns when the config has no such pack (an orphan). | Run `llm-docs sync <id>`. For an orphan, run `llm-docs sync --prune` or add the pack back. |
| `lockfile` | The pack has a dependency and the lockfiles resolve it to another version, or no lockfile resolves it. When lockfiles disagree, warns if one of them matches the pack's version and fails otherwise. A package the pack `covers` never fails it: it warns only when the lockfiles resolve that package to another major version than the pack's, since the pack may not describe that version. | Run `llm-docs sync <id>`. If the recipe sets `version`, change or remove it first, because an explicit version wins. For a covered package on another major, add a pack for it or drop it from `covers`. |
| `citations` | A guide citation no longer resolves, a cited section changed since it was stamped, or `citations.lock.json` is invalid. Warns for an unstamped guide, a guide edited after stamping, and a lock entry for a deleted guide. | Review the guide with the `write-docs-guide` skill, then run `llm-docs guides stamp <id> <guide>`. |
| `conversion` | An `agent` conversion is stale: the original changed after its `.md` was written, as recorded at the last sync or, for local sources, as the original reads on disk now. Warns when a local original no longer exists. | Write the `.md` again from the current original, then run `llm-docs sync <id>`. |
| `license` | Warns for an `unknown` or `proprietary` license. Fails under `--strict`. | Set `license` on the pack in `llm-docs.json` to an SPDX id or `"proprietary"`, then run `llm-docs sync <id>`. |

## `status`

Joins the dependency scan, the packs, release dates, and the model's training cutoff into one report:

- Each pack with its version, dependency, lockfile version, state, release date and whether it is after or near the cutoff, its read-first targets (a count in the table, the full list in JSON), and the step that brings it back to `ok`. Under the row, one line per package the pack `covers` that the lockfiles resolve, with its version and release date, and a note when its major version differs from the pack's.
- Direct dependencies released after the cutoff, or within `hook.nearCutoffDays` before it, that have no pack, each with a `discover` command as the next step. A package a pack `covers` counts as having a pack.
- With no cutoff, direct dependencies released in the last 180 days instead.

It works in a directory with no `llm-docs.json`, where it reports dependencies only. Without `--project`, it finds the project the way the session-start hook does, so `status --brief` prints the note a session started in the same directory gets. With `--project <dir>`, `<dir>` is the project root.

Pack states:

| State | Meaning | Next step |
|---|---|---|
| `ok` | Built, and matches its recipe and lockfile. | None. |
| `stale-pack` | The lockfile resolves another version (or lockfiles disagree and none matches). | `llm-docs sync <id>`, after editing `version` when the recipe pins one. |
| `recipe-changed` | The recipe changed since the last sync. | `llm-docs sync <id>`. |
| `missing` | Configured but not built, or its manifest cannot be read. | `llm-docs sync <id>`. |
| `orphan` | Built but no longer in the config. | `llm-docs sync --prune`, or add it back. |

- `--model <id>` takes a model id or a Claude Code alias. Without it, `status` uses `ANTHROPIC_MODEL`, then the `model` in Claude Code's settings files, as the hook does. The report prints the model and where its id came from. A settings file holds only a default that a session can override, so a cutoff found through one is marked as assumed, and the note words it as an assumption.
- `--cutoff YYYY-MM` sets the cutoff directly. A malformed cutoff, from the option, `model.cutoff`, or `LLM_DOCS_MODEL_CUTOFF`, exits `2`. (The session-start hook instead logs a malformed `LLM_DOCS_MODEL_CUTOFF` and skips it.)
- `--offline` uses cached release dates only. Without it, missing dates are fetched from the registries and cached.
- `--brief` prints only the session-start note on stdout, for the harness detected from the environment, and nothing when there is nothing to say. It takes precedence over `--json`, and it prints even when the hook is turned off.

| Exit | When |
|---|---|
| `0` | The report printed. |
| `2` | A malformed cutoff or an invalid `llm-docs.json`. |
| `3` | A runtime failure. |

`--json`:

| Field | Meaning |
|---|---|
| `packs[]` | `id`, `title`, `version`, `dependency`, `state`, `lockfile` (the lockfile lookup, for packs with a dependency), `indexPath`, `readFirst` (project-relative paths), `covered`, `publishedAt` (of the pack's version of its dependency), `releaseWindow` (`after-cutoff`, `near-cutoff`, `recent`, or `null`), and `nextStep` (`null` when `ok`). Sorted by id. |
| `packs[].covered[]` | Each package the pack `covers`, at each version the lockfiles resolve for it: `ecosystem`, `name`, `version`, `lockfiles`, `publishedAt`, `releaseWindow`, and `majorDiffers` (its major version differs from the pack's). A covered package no lockfile resolves is left out. |
| `model` | `{ id, source }`, where `source` is `flag` (`--model`), `env` (`ANTHROPIC_MODEL`), or `settings` (with `file`, the settings file it was read from), or `null` when no model is known. |
| `cutoff` | `{ cutoff, label, source, assumed }`, or `null` when none resolved. `label` names the model or the setting the cutoff came from. `source` is `flag`, `config`, `env` (`LLM_DOCS_MODEL_CUTOFF`), or `table`. `assumed` is true when the cutoff is the table's for a model read from a settings file. |
| `afterCutoff[]`, `nearCutoff[]`, `recent[]` | Direct dependencies without a pack: `ecosystem`, `name`, `version`, `publishedAt`, `dev`, `lockfiles`, and `nextStep`. `recent` is used only when no cutoff resolves. |
| `recentDays` | The window of `recent`, 180. |
| `directDependencies` | How many direct dependencies were checked. |
| `unknownReleaseDates` | How many of them have no known release date. |

## `guides stamp`

Records, in `guides/citations.lock.json`, the hash of the guide and of every section each guide cites. A citation is a Markdown link from a guide into the pack's `pages/` or `files/`, optionally with a `#fragment`; the section runs from that heading to the next heading of the same or higher level. A citation without a fragment covers the whole page (without its provenance line) or the whole file under `files/`. With guide names, it stamps only those and keeps the other entries. It drops entries for guides that no longer exist.

Use it after writing or reviewing a guide, as the [`write-docs-guide` skill](../plugin/skills/write-docs-guide/SKILL.md) describes. From then on, `verify`, `sync`, and `refresh` report the guide when its cited text changes.

Stamping writes nothing and exits `2` when a citation does not resolve, a link climbs out of the pack, a cited file differs from the manifest, a named guide does not exist, the pack has no guides, or the pack is not built.

| Exit | When |
|---|---|
| `0` | Stamped. |
| `2` | Any of the refusals above. |
| `3` | I/O failure, or a sync holds the lock. |

`--json`: `packId`, `lockPath`, `changed`, `guides[]` (`path`, `sha256`, and `citations`, the count), `removed` (guides dropped from the lock), and `warnings`.

## `migrate`

Reads a v2 pack's `manifest.json` (schema `0.1.0`, mode `local-source-docs`) and writes a v3 recipe for it into `llm-docs.json`. It never changes or deletes the v2 pack, and it does not build anything: run `llm-docs sync <id>` next.

- `--version` is required, because v2 manifests record no version. Without it, migrate refuses and shows the v2 label and tags as evidence.
- `--id` names the pack. The default is the v2 pack's directory name.
- A source that still exists inside the project becomes a `local` source.
- Otherwise, a source with a recorded git remote becomes a `git` source at the recorded commit, with the repository-relative source root as its path and the v2 exclude globs. A remote that is not `https` is normalized to `https` with a warning; a dirty working tree also warns.
- A source with no usable remote that is missing or under the OS temp directory has lost its origin. Migrate refuses and says the pack must be added again from a durable source.
- A source outside the project with no remote is refused.
- Other v2 modes, such as Supabase `--sdk` output, are refused as unsupported.

| Exit | When |
|---|---|
| `0` | The recipe was written. |
| `2` | Any refusal: not a v2 pack, already v3, an unsupported version or mode, a lost origin, outside the project, an invalid or existing id, no `--version`, or a recipe that does not resolve. |

`--json`: `id`, `recipe`, `configPath`, `warnings`, and `next` (the sync command).

## `discover`

Prints read-only evidence for writing a recipe, always as JSON on stdout, with a summary on stderr. It writes no files. Pass exactly one of:

- `--package <ecosystem>:<name>[@<version>]`: registry metadata (repository URL and directory, homepage, documentation URL, license, the version's publish date), the git tags that match the version, the top documentation directories at the matching tag (ranked by Markdown file count), and `changeDocuments`, the changelog, migration, and upgrade files at that tag. Without a version it uses the latest. For `swiftpm`, the name is the repository URL.
- `--url <site>`: the site's `llms.txt` and `sitemap.xml`, whether pages serve raw Markdown when `.md` is appended (at most 3 probes), and the version-looking path segments its `llms.txt` uses.

Use it before `add`: the [`add-docs` skill](../plugin/skills/add-docs/SKILL.md) reads its fields. It reports evidence and never says which source to use.

| Exit | When |
|---|---|
| `0` | The evidence printed. A package or version that does not exist is reported in the JSON. |
| `2` | A usage error, a malformed package spec, or a URL the network policy refuses. |
| `3` | The registry could not be reached. |

`--json` is accepted and changes nothing. `--package` output: `package` (`ecosystem`, `name`, `requestedVersion`, `version`, `versionSource`), `registry`, `repository`, `tags`, `docDirectories`, `changeDocuments`, and `warnings`. `--url` output: `website`, `inspectedResources`, `crawlPolicy`, `candidates`, `llmsTxt` (`url`, `listedUrls`, `versionSegments`, `markdownProbes`, or `null`), and `warnings`.

## `capabilities`

Describes what this build supports. Exit `0`.

`--json`: `name`, `version`, `commands[]` (`name`, `summary`, `status`, and `options[]` of `{ flags, description }`), `sourceTypes`, `converters` (each with its install command), `ecosystems`, `transforms`, `checks` (`pack` and `project`), and `limits` (`maxFiles`, `maxTotalBytes`, `defaultMaxFileBytes`, `maxMaxFileBytes`). Without `--json`, it prints the command list on stdout.

## `hook session-start`

The plugin's session-start hook. It reads the harness's payload on stdin, prints the note as the harness's JSON envelope on stdout, and always exits `0`. It is not for direct use; `llm-docs status --brief` prints the same note. [Plugin reference](plugin.md#the-session-start-hook) describes it.

## The managed block

`init` and `sync` write a block between these markers into each agent file that `agentFiles` selects:

```
<!-- BEGIN llm-docs: generated from llm-docs.json, do not edit by hand -->
...
<!-- END llm-docs -->
```

The block has a fixed heading and paragraph, then one line per built pack in `llm-docs.json` order: the escaped title and version, the path to its `index.md`, and in parentheses the pack's top-level page directories (sorted) plus `guides` when it has guides, followed by its description. Over `block.maxBytes`, topics and descriptions are dropped first, from the last pack backwards; if the bare lines still do not fit, the block lists the first packs and ends with a line saying how many more there are and where.

- A missing block is appended at the end of the file after one blank line, in the file's own line endings.
- Text outside the markers is never changed. A file that is not valid UTF-8, has mismatched markers, would put the block inside an unclosed code fence, or has a `block.maxBytes` too small for even one line is an error for that file only. A problem with one agent file never stops the others or the pack report.

### Managed block outcomes

Each entry of `agentBlocks` in JSON output has `path` (project-relative), `status` (`unchanged`, `created`, `updated`, `would-create`, `would-update`, or `failed`), and for a failure `error` and `exitCode` (`2` for a problem in the file or config, `3` for I/O).

## Removed commands

These v2 commands exit `2` with a one-line pointer to the replacement:

| v2 command | Replacement |
|---|---|
| `generate` | `add` |
| `validate`, `list-sdks` | The Supabase SDK catalog is gone. Add the SDK's docs as a pack with `add`. |
| `source-truth`, `verify-docs` | None. Source-truth mode is gone; agents read the code directly. |
| `plugins` | A `command` converter (`convert.tool: "command"`). |
| `agent` | The `llm-docs` plugin. |

## Running in CI

A CI runner has no plugin, and the npm package is not published yet. Each GitHub Release carries the whole CLI as one file, `llm-docs.mjs`, with its SHA-256 in `llm-docs.mjs.sha256`. A job downloads it for a pinned version and runs it with Node 22.19 or newer:

```sh
curl -fsSLO https://github.com/Zyepher/llm-docs-generator/releases/download/v3.0.0/llm-docs.mjs
echo "<sha256 from llm-docs.mjs.sha256>  llm-docs.mjs" | sha256sum -c -
node llm-docs.mjs sync --check
node llm-docs.mjs verify
```

Pin the version in the URL instead of fetching the latest release, so a new release never changes the gate without a commit. Copy the hash from the release's `llm-docs.mjs.sha256` into the workflow once, when you pick the version, so the job refuses a file that differs from the one you reviewed. On macOS runners, use `shasum -a 256 -c -` in place of `sha256sum -c -`.

Run `node llm-docs.mjs refresh --check` on a schedule instead of on every commit, because it fetches upstream.
