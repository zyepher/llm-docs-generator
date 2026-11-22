# `llm-docs.json` reference

`llm-docs.json` holds the project's recipes: which docs each pack takes, at which version, and from where. It lives at the project root. Agents and people edit it; `llm-docs add`, `llm-docs init`, and `llm-docs migrate` also write it.

The JSON Schema is [`schema/llm-docs.schema.json`](../schema/llm-docs.schema.json). It is generated from the zod schema in `src/config/project.ts` with `npm run schema`, and a test fails when the committed copy is out of date. Every object is strict: an unknown key is a config error (exit 2), so a typo never silently turns a setting off.

## Project root

The project root is the nearest directory at or above the working directory that holds `llm-docs.json`. `--project <dir>` names the root instead, on every command that reads a project. `init`, `add`, and `migrate` create the file when no project is found: at the git top-level directory, else in the working directory.

## Top-level keys

| Key | Type | Default | Constraints |
|---|---|---|---|
| `$schema` | string | none | Any string. `init` writes the schema's URL at the release tag of the CLI that ran it, `https://raw.githubusercontent.com/Zyepher/llm-docs-generator/v<version>/schema/llm-docs.schema.json`. |
| `schemaVersion` | number | required | Must be `3`. Any other value is an error that names the version this build reads. |
| `packsDir` | string | `"agent-docs"` | A project-relative subdirectory. Not absolute, not `..`, not the project root itself, and still inside the project after symbolic links are resolved. |
| `agentFiles` | `"auto"` or string array | `"auto"` | Each entry is a project-relative path that stays inside the project. `[]` writes no managed block. |
| `block.maxBytes` | integer | `4096` | 1024 to 65536. The managed block's size in UTF-8 bytes, markers included. |
| `hook.enabled` | boolean | `true` | `false` makes the session-start hook print nothing for this project. |
| `hook.nearCutoffDays` | integer | `90` | 0 to 3650. Releases this many days before the training data cutoff count as near it. |
| `model.cutoff` | string | none | `YYYY-MM` with a month from `01` to `12`. Overrides the cutoff looked up for the model, for `status` and the hook. |
| `packs` | object | required | Keys are pack ids. Values are pack recipes. `{}` is valid. |

### `agentFiles`

`"auto"` picks the files the managed block goes into:

1. `AGENTS.md` when it exists.
2. `CLAUDE.md` when it exists and has no `@AGENTS.md` import line.
3. `AGENTS.md`, created, when neither of the above applies.

A list names the files exactly; a listed file that does not exist is created. Each file is written through its real path, so a `CLAUDE.md` that is a symbolic link to `AGENTS.md` is one file, written once. A path whose real location is outside the project is an error for that file only. A file that is not valid UTF-8 is never rewritten. [Commands](commands.md#the-managed-block) describes the block itself.

### Cutoff resolution

`status` and the hook take the training data cutoff from the first of these that is set: the `--cutoff` option of `status`, `model.cutoff`, the `LLM_DOCS_MODEL_CUTOFF` environment variable, then the model id looked up in [`data/model-cutoffs.json`](../data/model-cutoffs.json). With no cutoff, they list releases from the last 180 days under a neutral heading instead.

## Pack ids

A pack id matches `^[a-z0-9][a-z0-9._-]{0,63}$`. It is the pack's directory name under `packsDir`.

## Pack keys

| Key | Type | Default | Constraints |
|---|---|---|---|
| `title` | string | the pack id | Non-empty. Shown in the index, the managed block, `status`, and the hook note. |
| `description` | string | none | One line shown after the pack in the managed block, escaped (see [Escaping](#escaping)). |
| `dependency` | object | none | `{ "ecosystem": ..., "name": ... }`. Binds the pack to a dependency the lockfiles resolve. |
| `dependency.ecosystem` | string | required | One of `npm`, `pypi`, `cargo`, `go`, `pub`, `swiftpm`. |
| `dependency.name` | string | required | The registry name as the lockfile spells it, such as `@scope/name`. PyPI names are matched after PEP 503 normalization. |
| `covers` | object array | none | 1 to 20 more dependencies these docs also describe, each `{ "ecosystem": ..., "name": ... }` with the same rules as `dependency`. Distinct, and none equal to `dependency`. Binds no version. See [`covers`](#covers). |
| `version` | string | the lockfile version | Required unless `dependency` is set. No whitespace, no `<` or `>`, no control characters. Need not be semver: `2026-07-28` is valid. |
| `sources` | array | required | At least one source. See [Sources](#sources). |
| `site.baseUrl` | string | required with `site` | An `https://` URL without credentials: the docs website, so absolute links to it resolve to pack pages. |
| `site.aliases` | object | `{}` | Site path to site path, applied before matching, such as `{ "/guide/latest": "/guide" }`. |
| `layout.combined` | boolean | `false` | Also writes `<id>.full.md`: the index and every page in one file. |
| `license` | string or null | `null` | A declared SPDX id or expression, or `"proprietary"`. Recorded next to the detected license and wins for the license status. |
| `limits.maxFileBytes` | integer | `20971520` (20 MiB) | 1 to `209715200` (200 MiB). The per-file download and checkout cap for this pack. |
| `readFirst` | string array | none | 1 to 5 distinct targets. See [`readFirst`](#readfirst). |

### Version resolution

- With `version` set, the pack uses it. When `dependency` is also set and the lockfile resolves another version, the `lockfile` check of `verify` fails, because the point of binding a dependency is that the two agree.
- With only `dependency`, the version is the one the project's lockfiles resolve. No lockfile entry is a config error that names the lockfiles searched. Two lockfiles that resolve different versions is a config error that lists each; set `version` to choose one.

## Sources

Every source has a `type` and these common keys:

| Key | Type | Default | Constraints |
|---|---|---|---|
| `mount` | string | `""` | A relative POSIX path with no `..` segment and no backslash. The source's pages go under `pages/<mount>/` and its passthrough files under `files/<mount>/`. |
| `include` | string array | depends on the type | Globs a file must match, over the source-relative path (for `llms-txt`, over the listed URL paths). |
| `exclude` | string array | `[]` | Globs that drop a file `include` matched. |
| `passthrough` | string array | `[]` | Globs for files copied byte-identical to `files/<mount>/<path>`. A file matched by both `passthrough` and the converter's `include` is passthrough. |
| `convert` | object or null | `null` | A document converter. See [`convert`](#convert). |
| `transforms` | string array | `[]` | Distinct names from `strip-mintlify-banner`, `strip-html-comments`, `drop-frontmatter-description`. See [Transforms](#transforms). |

Default `include` for `git` and `local` sources is `**/*.{md,mdx,markdown,rst,html,htm}`; OpenAPI files are taken only when an explicit `include` lists them. For `urls` it is `**`. For `llms-txt` there is no default: at least one glob is required, so the recipe states the filter.

### `git`

| Key | Type | Default | Constraints |
|---|---|---|---|
| `repo` | string | required | An `https://` URL without credentials: no user name or password, and no token, key, signature, or similar parameter. `file://` is accepted with a warning that the origin is not portable. `ssh://` and `git@` remotes are rejected. |
| `ref` | string | required | A tag, a branch, or a 40-hex commit. A branch is accepted with a warning that the pin floats until the next sync records a new commit. |
| `paths` | string array | `["."]` (the whole repository) | Repository-relative directories or files to take. No absolute paths and no `..`. |

llm-docs never sends credentials to git, and it clears git's credential helpers, so it cannot fetch a private repository. To pin docs from one, copy them into a folder in the project and use a [`local`](#local) source.

```json
{
  "type": "git",
  "repo": "https://github.com/vitejs/vite",
  "ref": "v{version}",
  "paths": ["docs"],
  "exclude": ["**/blog/**"]
}
```

### `urls`

| Key | Type | Default | Constraints |
|---|---|---|---|
| `urls` | array | required | At least one entry. An entry is an `https://` URL string, or `{ "url": ..., "path": ... }` to choose the stored path. A URL must carry no credentials: no user name or password, and no token, key, signature, or similar parameter. |

The stored path of a URL string is its pathname, percent-decoded, with `.md` appended when the last segment has no extension and `index.md` for a trailing slash. Two entries with the same stored path are a config error naming both URLs.

llm-docs sends no cookies, tokens, or other credentials with a request, so it cannot fetch a page behind a login. The same holds for `llms-txt` sources. To pin such docs, copy them into a folder in the project and use a [`local`](#local) source.

```json
{
  "type": "urls",
  "urls": [
    "https://docs.example.com/api/clients.md",
    { "url": "https://docs.example.com/changes", "path": "changes.md" }
  ]
}
```

### `llms-txt`

| Key | Type | Default | Constraints |
|---|---|---|---|
| `url` | string | required | The `https://` URL of an `llms.txt` file, without credentials. |
| `include` | string array | required | At least one glob over the pathnames of the URLs the index lists. |
| `stripPrefix` | string | `""` | A pathname prefix removed when deriving stored paths, such as a version segment. |

The engine fetches the index, keeps the same-origin `https` links that pass the filter, and fetches each one. It never follows links found inside the fetched pages.

```json
{
  "type": "llms-txt",
  "url": "https://modelcontextprotocol.io/llms.txt",
  "include": ["/specification/2026-07-28/**"],
  "stripPrefix": "/specification/2026-07-28",
  "transforms": ["strip-mintlify-banner"]
}
```

### `local`

| Key | Type | Default | Constraints |
|---|---|---|---|
| `path` | string | required | A project-relative directory or file that stays inside the project. |

A path that resolves under the operating system's temp directory (`os.tmpdir()`, and `/tmp` and `/var/tmp` outside Windows) is rejected, because the OS may delete it and the manifest would pin a lost origin. `LLM_DOCS_ALLOW_TEMP_SOURCES=1` lifts that rule for tests and throwaway experiments. The recorded origin is the project-relative path plus, in a git repository, the host repository's commit and whether its working tree was dirty.

```json
{ "type": "local", "path": "docs/manuals", "convert": { "tool": "docling" } }
```

### `convert`

| Key | Type | Default | Constraints |
|---|---|---|---|
| `tool` | string | required | `docling`, `markitdown`, `command`, or `agent`. |
| `include` | string array | `**/*.{pdf,docx,pptx,epub,html,htm}` for `docling` and `markitdown` | Required for `command` and `agent`. Spreadsheets (`.xlsx`) convert only when listed here, since they are passthrough by default. |
| `command` | string array | none | Required for `command`: the argv, with `{input}` (required) and optionally `{output}`. For `docling` and `markitdown`, the executable and leading arguments to run instead of the tool name. Not allowed for `agent`. |
| `timeoutSeconds` | integer | `300` | 1 to 3600. Per document; the child process is killed when it runs over. |

- `docling` runs `docling --to md --image-export-mode placeholder --output <dir> <input>` and reads `<dir>/<stem>.md`.
- `markitdown` runs `markitdown <input>` and reads stdout.
- `command` runs the argv with no shell and reads `{output}` when the argv names it, else stdout.
- `agent` runs nothing. Each included document `X` needs a Markdown sibling `X.md` that an agent wrote. The manifest records the hashes of both, and `verify` fails the `conversion` check when `X` changes after `X.md` was written.

A `command` converter runs a program from your config on your machine; treat it as trusted local configuration. [Security](security.md#converters) has the rest of the converter policy.

```json
{ "type": "local", "path": "specs", "convert": { "tool": "command", "include": ["**/*.org"], "command": ["pandoc", "--from", "org", "--to", "gfm", "{input}"] } }
```

### Transforms

Transforms are deterministic, opt in per source, and recorded in the manifest with the number of pages each one changed.

| Name | Effect |
|---|---|
| `strip-mintlify-banner` | Removes the leading "Documentation Index" block that Mintlify prepends to raw `.md` pages. Exact marker match only. |
| `strip-html-comments` | Removes HTML comments outside code. |
| `drop-frontmatter-description` | Leaves out the paragraph the converter makes from a frontmatter `description`. |

## Placeholders

`{version}`, `{major}`, `{minor}`, and `{patch}` are replaced from the pack's resolved version in these keys:

- `ref` and `paths` of a `git` source.
- `url` of an `llms-txt` source.
- `urls` of a `urls` source, in both the URL and an explicit `path`.
- `include` and `exclude` of any source.
- `readFirst`.

`{major}`, `{minor}`, and `{patch}` come from the leading numbers of the version, with an optional `v` prefix: `v8.2.0-beta.1` gives `8`, `2`, and `0`. A placeholder with no value for the version (`{minor}` of the version `2026-07-28`, for example) is a config error, never an empty string. A placeholder in `repo`, `mount`, `passthrough`, `stripPrefix`, a local `path`, `convert.include`, or `convert.command` is a config error. Other keys are taken literally.

A ref of `v{version}` on a pack bound to a dependency follows the lockfile: when the lockfile moves, the next `sync` builds the pack at the new tag.

## `readFirst`

`readFirst` marks up to five targets an agent should read before writing code against the library, usually the pages that describe what changed. The pack index lists them under "Read first", `status` reports them, and the session-start note names the first two.

A target is a pack-relative POSIX path that starts with `pages/` or `files/`, optionally followed by `#<heading slug>`:

- No `..` segment, no backslash, no trailing slash, and already normalized (no `./` and no doubled slashes).
- The fragment has no whitespace and no second `#`.
- Targets are distinct, checked again after placeholders are substituted.

At sync, each target must name a page or passthrough file of the pack being built, and a fragment must match a heading slug on that Markdown page. An unresolved target fails that pack's build as a config error (exit 2) that names the target, why it did not resolve, up to five nearby paths or slugs, and the fix. The previous pack stays in place.

## `covers`

One docs set often describes several packages of a family: the Model Context Protocol TypeScript SDK docs cover both `@modelcontextprotocol/server` and `@modelcontextprotocol/client`, and the same goes for `@tanstack/*`, `@sveltejs/*`, and the `effect` packages. Bind the pack to the main package with `dependency`, and list the others under `covers`:

```json
"mcp-sdk": {
  "title": "MCP TypeScript SDK",
  "dependency": { "ecosystem": "npm", "name": "@modelcontextprotocol/server" },
  "covers": [{ "ecosystem": "npm", "name": "@modelcontextprotocol/client" }],
  "sources": [{ "type": "local", "path": "vendor-docs/mcp-sdk" }]
}
```

`covers` says these docs also describe those packages. It does not bind a version: the pack's version still comes from `dependency` or `version` alone, and the `lockfile` check of `verify` never fails because of a covered package.

- `status` and the session-start note treat a covered package as having a pack, so it is never listed among the dependencies with no pinned docs.
- A pack is listed among the pinned docs newer than the cutoff when its own version or any covered package the lockfiles resolve was released after or near the cutoff. Its row names the pack once, with the most recent of those release dates.
- When a covered package resolves to a version whose major number differs from the pack's version, `status` adds a note under the pack's row and `verify` warns under `lockfile` that the pack may not describe that package's version. Versions without a leading `<number>.`, such as `2026-07-28`, are never compared.
- `covers` is recorded in the manifest's recipe, and a pack that sets none keeps the `recipeHash` it had before the key existed.

## Escaping

Text that reaches an agent file (pack titles, versions, descriptions, and top-level page directory names) is escaped before the managed block uses it: control characters become spaces; Unicode format characters (zero-width and bidirectional controls), backticks, and `@` are removed; `<` and `>` become `&lt;` and `&gt;`; whitespace collapses to one line; the result is capped at 80 characters. `@` goes because Claude Code expands `@path` in `CLAUDE.md` into that file's contents.

## Limits

| Limit | Value | Set by |
|---|---|---|
| Files per pack | 5,000 | fixed |
| Bytes per pack | 524,288,000 (500 MiB) | fixed |
| Bytes per downloaded or checked-out file | 20 MiB by default | `limits.maxFileBytes`, up to 200 MiB |
| Bytes per converter input | 200 MiB | fixed |
| Bytes per converter output | 100 MiB | fixed |
| Converter time per document | 300 s by default | `convert.timeoutSeconds`, 1 to 3600 |
| Managed block size | 4096 bytes by default | `block.maxBytes`, 1024 to 65536 |
| Read-first targets per pack | 5 | fixed |
| Covered packages per pack | 20 | fixed |

`llm-docs capabilities --json` reports the pack limits of the installed build under `limits`.

## A complete example

```json
{
  "$schema": "https://raw.githubusercontent.com/Zyepher/llm-docs-generator/v3.0.0/schema/llm-docs.schema.json",
  "schemaVersion": 3,
  "packsDir": "agent-docs",
  "agentFiles": "auto",
  "block": { "maxBytes": 4096 },
  "hook": { "enabled": true, "nearCutoffDays": 90 },
  "packs": {
    "vite": {
      "title": "Vite",
      "description": "Build tool and dev server",
      "dependency": { "ecosystem": "npm", "name": "vite" },
      "sources": [
        { "type": "git", "repo": "https://github.com/vitejs/vite", "ref": "v{version}", "paths": ["docs"] }
      ],
      "site": { "baseUrl": "https://vite.dev" },
      "readFirst": ["pages/guide/migration.md"]
    },
    "mcp": {
      "title": "MCP spec",
      "version": "2026-07-28",
      "sources": [
        {
          "type": "llms-txt",
          "url": "https://modelcontextprotocol.io/llms.txt",
          "include": ["/specification/{version}/**"],
          "stripPrefix": "/specification/2026-07-28",
          "transforms": ["strip-mintlify-banner"]
        }
      ],
      "license": "MIT"
    }
  }
}
```
