# Pack manifest reference

Every pack directory holds a `manifest.json` that `sync` writes. It records the resolved recipe, where every acquired file came from, the hash of every file the tool wrote, and what happened to links on the way. `verify` checks the pack against it offline.

The JSON Schema is [`schema/manifest.schema.json`](../schema/manifest.schema.json), generated from the zod schema in `src/pack/manifest.ts`. Every object is strict.

## What a pack contains

```
agent-docs/<id>/
  manifest.json            tool-written; not listed in itself
  index.md                 tool-written, listed (kind "index")
  pages/**.md              tool-written, listed (kind "page"): one file per upstream page
  files/**                 tool-written, listed (kind "passthrough"): byte-identical copies
  <id>.full.md             tool-written when layout.combined is true, listed (kind "combined")
  guides/                  agent-owned; never written or deleted by sync, not listed
    *.md
    citations.lock.json    written only by 'llm-docs guides stamp', not listed
```

`outputs` lists every tool-written file in the pack except `manifest.json` itself. Nothing under `guides/` is part of the manifest:

- Guides are written by agents, so the tool cannot hash them at sync time without making the manifest depend on them.
- `guides/citations.lock.json` is written only by `llm-docs guides stamp`. `sync` never reads or writes it. The `citations` check of `verify` validates it by recomputing every hash it records.

Because of that split, adding, editing, removing, or stamping a guide changes neither `manifest.json`, `index.md`, nor the combined file, and `sync` never acquires a source for a guide change. A guide change does change the managed block's topic list, which `sync` rewrites without acquiring anything.

## Hashes

Every hash is SHA-256 in the form `sha256:<64 lowercase hex>`.

| Field | Covers |
|---|---|
| `recipeHash` | The canonical JSON (sorted keys, no whitespace) of `recipe`. |
| `origins[].sha256` (`llms-txt`) | The bytes of the `llms.txt` index as fetched. |
| `sources[].sha256` | The bytes of one acquired upstream file, before any conversion. |
| `sources[].converter.outputSha256` | The Markdown a converter or an agent produced from that file. |
| `sources[].converter.inputSha256` | Agent conversions only: the original the agent's `X.md` was written from. |
| `outputs[].sha256` | The bytes of one tool-written pack file, as written. |

## Top-level fields

| Field | Type | Meaning |
|---|---|---|
| `schemaVersion` | `3` | The manifest format. Reading any other value fails and points to `llm-docs migrate`. |
| `tool` | object | `name` (always `"llm-docs"`) and `version`: the tool that wrote the manifest. |
| `pack` | object | `id`, `title`, and `version` of the pack. |
| `dependency` | object or null | `ecosystem` and `name` of the bound dependency, or `null`. |
| `recipe` | object | The resolved recipe. See [`recipe`](#recipe). |
| `recipeHash` | string | Hash of `recipe`. `sync` skips a pack when the config resolves to the same hash and the pack files verify; the `recipe` check fails when they differ. |
| `acquiredAt` | string | ISO 8601 UTC timestamp of the acquisition. Carried over from the previous manifest when the set of acquired files and their hashes is unchanged. |
| `origins` | array | One entry per source, in `recipe.sources` order. See [`origins`](#origins). |
| `license` | object | See [`license`](#license). |
| `sources` | array | Every acquired upstream file. See [`sources`](#sources). |
| `outputs` | array | Every tool-written pack file except `manifest.json`. See [`outputs`](#outputs). |
| `links` | object | See [`links`](#links). |
| `transforms` | array | One entry per transform the recipe names: `name`, and `pages`, how many pages it changed. |
| `warnings` | string array | Human-readable warnings from the build, such as a floating branch ref, skipped file types, or a non-portable origin. |

### `recipe`

The pack's recipe from `llm-docs.json` with every default filled in and every placeholder substituted. Its keys are `title`, `description`, `dependency`, `version`, `sources`, `site`, `layout`, `license`, `limits`, and, only when the pack marks pages to read first, `readFirst`. Defaults are written out: `description`, `dependency`, `site`, and `license` are `null` when unset; `site` otherwise holds `baseUrl` and `aliases` (`{}` by default); `layout.combined` is a boolean; `limits.maxFileBytes` is always present. Each source carries every common key (`mount`, `include`, `exclude`, `passthrough`, `convert`, `transforms`) plus its type's keys, with defaults filled (`paths` is `["."]` for a whole repository, and an `llms-txt` source's `stripPrefix` is `""` when unset); a converter carries `tool`, `include`, `command` (or `null`), and `timeoutSeconds`.

`readFirst` is left out, never written as `[]`, when the pack marks no pages, so packs built before the key existed keep their `recipeHash`.

[`llm-docs.json` reference](config.md) defines each key.

### `origins`

| `type` | Fields |
|---|---|
| `git` | `repo`, `ref` (as resolved, placeholders substituted), `commit` (40 hex), `refKind` (`tag`, `branch`, or `commit`), and `finalRepo` when the repository redirected and git fetched from there. |
| `llms-txt` | `url` of the index, `sha256` of its bytes, and `finalUrl` when redirects led elsewhere. |
| `urls` | No other fields; each page's URL is on its `sources` entry. |
| `local` | `path` (project-relative), `hostCommit` (the host repository's `HEAD`, or `null` outside git), `hostDirty` (whether that repository had uncommitted changes, or `null` outside git). |

### `license`

| Field | Meaning |
|---|---|
| `declared` | The recipe's `license`, or `null`. |
| `detected` | An object with `spdx`, the SPDX id detected, and `evidence`, the file it came from; or `null`. |
| `status` | `permissive`, `attribution`, `copyleft`, `unknown`, or `proprietary`. A declared license wins over the detected one. |

Detection reads `LICENSE*`, `LICENCE*`, and `COPYING*` (case-insensitive) at the root of a git repository and at the root of each taken path, at the recorded commit, even when they are outside `paths`. It recognizes MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, MPL-2.0, CC-BY-4.0, CC-BY-SA-4.0, CC0-1.0, Unlicense, GPL-2.0, GPL-3.0, LGPL-2.1, LGPL-3.0, AGPL-3.0, and an `SPDX-License-Identifier:` line.

| Status | Licenses |
|---|---|
| `permissive` | MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, CC0-1.0, Unlicense |
| `attribution` | CC-BY-4.0 |
| `copyleft` | GPL, LGPL, AGPL, MPL-2.0, CC-BY-SA-4.0 |
| `unknown` | Nothing detected or declared, or an id outside these lists |
| `proprietary` | Declared `"proprietary"` |

For an SPDX expression, `OR` takes the most permissive choice and `AND` the most restrictive term. `-only` and `-or-later` suffixes and `WITH` exceptions keep the base license's status.

### `sources`

One entry per acquired upstream file, including the `X.md` an agent wrote for a document `X`.

| Field | Meaning |
|---|---|
| `source` | Index into `recipe.sources` and `origins`. |
| `path` | Origin-relative POSIX path. |
| `url` | Where the file lives upstream, when it has one: the fetched URL for `urls` and `llms-txt` sources, and a blob URL pinned to the commit for git sources on `github.com`. |
| `sha256`, `bytes` | Hash and size of the acquired bytes. |
| `fetch` | HTTP sources only: `finalUrl` after redirects, `status`, and `etag` and `lastModified` when the server sent them. |
| `converter` | Converted documents only: `tool`, `version` (the first line of the tool's `--version` output, or `null` when it could not be read and always for `agent`), `outputSha256`, and for `agent` conversions `inputSha256`. |

An agent conversion is stale when `inputSha256` differs from `sha256`: the original changed and its `.md` did not. `sync` still builds and warns. `verify` fails the `conversion` check.

### `outputs`

| Field | Meaning |
|---|---|
| `path` | Pack-relative POSIX path. |
| `kind` | `page`, `index`, `passthrough`, or `combined`. |
| `sha256`, `bytes` | Hash and size of the file as written. |
| `tokens` | Approximate token count. Pages, the index, and the combined file only. |
| `title` | The title: for a page, the first H1, else the frontmatter title, else the file name without its extension. Pages, the index, and the combined file only. |
| `sources` | The inputs the file came from, as `<source index>:<origin-relative path>`. Pages and passthrough files only. |

### `links`

| Field | Meaning |
|---|---|
| `rewritten` | How many link targets the build changed: to the relative path of another pack file, or to an absolute upstream URL. |
| `external` | How many links point outside the pack after the build, whether rewritten or left as written. |
| `unresolved` | An entry with `page`, `target`, and `reason` for each link the build could neither keep, point at a pack file, nor point at an upstream URL. The build turns each one into plain text, `[label] (unresolved: target)`. In raw HTML it renames the attribute instead (`data-unresolved-href`, `data-unresolved-src`, and so on). A link whose scheme is not `https`, `http`, or `mailto` is treated the same way. A pack therefore never contains a dead local link. |

`reason` is one of `not-found`, `not-in-pack`, `outside-source`, `outside-repository`, `outside-pack-non-github-remote`, `site-absolute-without-base-url`, `malformed`, or `disallowed-scheme`.

## Determinism

Given the same recipe and the same upstream bytes, `sync` writes byte-identical pack files, `manifest.json` included:

- Objects are written with sorted keys, two-space indentation, and one trailing newline.
- `sources` is sorted by source index then path; `outputs` by path, with each `outputs[].sources` sorted; `links.unresolved` by page, target, then reason; `transforms` by name; `warnings` sorted and deduplicated. `origins` and `recipe.sources` keep recipe order, because both are indexed by source.
- `acquiredAt` carries over while no acquired file changed.
- Generated text uses `\n` line endings and ends with exactly one newline.
- Paths are POSIX and relative to the project, the pack, or the origin. Nothing machine-specific is recorded, with one exception you opt into: a `file://` git repository records its URL, and sync warns that such an origin only works on this machine.
