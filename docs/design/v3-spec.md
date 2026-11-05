# llm-docs v3 specification

Status: approved direction, implementation in progress on branch `v3/redesign`.
Owner decisions (2026-11-05): package and command `llm-docs`; remove source-truth mode, the
Supabase `--sdk` catalog with the OpenRef parser, and the semantic chunks export; keep a
combined single-file layout as an opt-in; build and run an eval suite; ship converter
adapters for documents.

Read `AGENTS.md` before implementing anything here. Its quality bar binds every line.

## 1. What v3 is

`llm-docs` keeps version-pinned, verified reference docs inside a repository and makes coding
agents actually read them.

1. **Pin.** Acquire the docs for an exact version from a recorded origin (a git repository at
   a tag or commit, an explicit URL list, an `llms.txt` index with an explicit filter, or a
   folder inside the project), convert them to one Markdown file per upstream page, and record
   provenance in a manifest.
2. **Keep honest.** `verify` proves a pack still matches its manifest, its recipe, and the
   project's lockfiles, and that every local link resolves. `sync` rebuilds packs when a
   lockfile moves. `refresh` re-acquires the same version and reports what changed upstream.
3. **Get read.** A tool-managed block in `AGENTS.md` / `CLAUDE.md` lists the packs (passive
   context, the approach Vercel measured at 100% versus 79% for skills). A session-start hook,
   shipped as a Claude Code and Cursor plugin, tells the agent which of the project's
   dependencies are newer than its training data and where their pinned docs are.
4. **Documents.** PDFs and office files enter a pack through converter adapters (Docling,
   MarkItDown, a custom command, or an agent conversion recorded as such).
5. **Guides.** Agent-written digests live next to a pack; `guides stamp` records the hash of
   every section they cite, and `verify` reports guides whose cited text changed.

### Non-goals

Crawling or following links to find pages. JavaScript rendering. Choosing which source is
authoritative (the planner's job). Judging whether a claim is true. Hosting packs. Search or
RAG. Turning a codebase into docs. Turning spreadsheets into prose (CSV and XLSX can be
carried byte-identical as passthrough files so an agent can query them).

### The planner and engine split (unchanged from v2)

The agent (planner) decides the source, the version binding, the page filter, and the guide
content. The CLI (engine) executes recipes deterministically, records provenance, and refuses
to guess. Every network fetch the engine performs is for a URL the recipe names or that an
explicitly named index (`llms.txt`) lists after an explicit planner-written filter.

## 2. Project model

### 2.1 Files in a project

```
<project root>/
  llm-docs.json                 project config: the recipes (intent, edited by agent or human)
  AGENTS.md / CLAUDE.md         contain the managed block (tool-written between markers)
  agent-docs/                   packsDir (configurable)
    .llm-docs.lock              advisory lock while a sync runs (never committed; see 2.6)
    vite/                       one pack
      manifest.json             tool-written, verified
      index.md                  tool-written, verified
      pages/**.md               tool-written, verified: one file per upstream page
      files/**                  tool-written, verified: passthrough files, byte-identical
      vite.full.md              optional combined layout, tool-written, verified
      guides/                   agent-owned; never written or deleted by the tool
        *.md
        citations.lock.json     tool-written by `guides stamp`, verified
```

The project root is the nearest ancestor of the working directory containing `llm-docs.json`.
Commands that create config (`init`, `add`) use the git top-level directory when inside a git
repository, else the working directory. `--project <dir>` overrides discovery everywhere.

### 2.2 `llm-docs.json`

Validated with zod v4. The JSON Schema is generated from the zod schema with
`z.toJSONSchema()` into `schema/llm-docs.schema.json` and published in the package; a test fails
when the committed schema is out of date. Unknown keys are errors (strict objects) so typos
never silently disable behavior.

```jsonc
{
  "$schema": "./node_modules/llm-docs/schema/llm-docs.schema.json",
  "schemaVersion": 3,
  "packsDir": "agent-docs",               // project-relative, default "agent-docs"
  "agentFiles": "auto",                    // "auto" | string[] of project-relative paths | []
  "block": { "maxBytes": 4096 },          // managed block budget
  "hook": { "enabled": true, "nearCutoffDays": 90 },
  "model": { "cutoff": "2026-06" },       // optional override for status and hook
  "packs": {
    "vite": {
      "title": "Vite",
      "description": "Build tool and dev server",   // optional, one line, escaped into the block
      "dependency": { "ecosystem": "npm", "name": "vite" },  // optional
      "version": "8.2.0",                  // required unless dependency is set; then optional,
                                           // and when omitted the lockfile version is used
      "sources": [
        {
          "type": "git",
          "repo": "https://github.com/vitejs/vite",
          "ref": "v{version}",
          "paths": ["docs"],
          "include": ["**/*.md"],
          "exclude": ["**/node_modules/**"],
          "mount": "",                     // subdirectory under pages/ (and files/)
          "passthrough": [],               // globs copied byte-identical to files/<mount>/
          "convert": null,                 // see 4.6
          "transforms": []                 // see 4.4
        }
      ],
      "site": {                            // optional: how the docs website maps to pages
        "baseUrl": "https://vite.dev",
        "aliases": { "/guide/latest": "/guide" }
      },
      "layout": { "combined": false },
      "license": null                      // optional declared SPDX id, "proprietary", or null
    }
  }
}
```

Rules:

- Pack ids match `^[a-z0-9][a-z0-9._-]{0,63}$`.
- `{version}`, `{major}`, `{minor}`, `{patch}` placeholders are allowed in `ref`, `paths`,
  `url`, `urls`, `include`, and `exclude`, substituted from the resolved version. A
  placeholder with no resolvable value is an error, never an empty string.
- `version` must be a non-empty string without whitespace. It need not be semver (`2026-07-28`
  is a valid version for a protocol revision).
- `dependency.ecosystem` is one of `npm`, `pypi`, `cargo`, `go`, `pub`, `swiftpm`.
- `packsDir`, `agentFiles` entries, and local `path`s must be project-relative and stay inside
  the project after resolution (`isSameOrDescendant`). Absolute paths are rejected.

### 2.3 Source types

Common fields on every source: `mount` (default `""`, a relative POSIX path, no `..`),
`include` / `exclude` (globs over the source-relative path; default include depends on type),
`passthrough` (globs, default none), `convert` (default null), `transforms` (default none).

1. **`git`**: `repo` (an `https://` URL; `file://` accepted with a "non-portable origin"
   warning; `ssh` and `git@` rejected in v3.0), `ref` (tag, branch, or 40-hex commit),
   `paths` (repository-relative directories or files to take; default the whole repo).
   The engine resolves `ref` to a commit and records both. A ref that resolves to a branch is
   accepted with a warning that the pin floats until the next sync records a new commit.
2. **`urls`**: `urls`: an array of `"https://..."` strings or `{ "url": ..., "path": ... }`
   objects. The stored path defaults to the URL pathname (percent-decoded, `.md` appended when
   the name has no extension, `index.md` for a trailing slash). Duplicate stored paths are an
   error naming both URLs.
3. **`llms-txt`**: `url` of an `llms.txt` file, `include` / `exclude` as globs over the listed
   URLs' pathnames (required: at least one include, so the planner states the filter),
   optional `stripPrefix` (pathname prefix removed when deriving stored paths). The engine
   fetches the index, extracts Markdown link targets, keeps same-origin `https` links that pass
   the filter, and fetches each. It records the index URL and its hash. It never follows links
   found inside fetched pages.
4. **`local`**: `path` (project-relative directory or file). Paths resolving under the OS temp
   directory are rejected with a message naming the fix; this closes the v2 audit finding
   where a manifest pinned a deleted scratch directory. `LLM_DOCS_ALLOW_TEMP_SOURCES=1` lifts the rule
   (tests and throwaway experiments only), on the same pattern as `LLM_DOCS_ALLOW_PRIVATE_NETWORK`. The origin identity is the
   project-relative path plus, when the project is a git repository, the host repository
   commit and a dirty flag.

### 2.4 Version resolution

For a pack with `dependency` and no `version`: the version is the one the project's lockfiles
resolve for that dependency (section 6). No lockfile entry is an error naming the lockfiles
searched. Two different resolved versions in one project (for example two workspaces) is an
error listing each lockfile and version; the planner resolves it by setting `version`
explicitly. For a pack with both `dependency` and `version`, the explicit version wins and
`verify` reports a mismatch with the lockfile as a failure (`stale-pack`), because the point
of binding a dependency is that they agree.

### 2.5 Determinism

Given the same recipe and the same upstream bytes, `sync` produces byte-identical pack files
including `manifest.json`. Consequences:

- `manifest.acquiredAt` is carried over from the previous manifest when no source hash changed.
- All arrays in the manifest are sorted by a stable key; objects are written with sorted keys.
- Generated text uses `\n` line endings and ends with exactly one newline.
- Nothing machine-specific is recorded: no absolute paths, no hostnames, no usernames. Paths
  are POSIX and relative (to the project root, the pack, or the origin root).

### 2.6 Atomic builds and locking

A pack is built in `<packsDir>/.staging/<id>-<random>/`, verified in place, and swapped in:
`guides/` is moved from the old pack into the staging pack, the old pack is renamed to
`<packsDir>/.staging/<id>-old-<random>`, the staging pack is renamed into place, and the old
pack is removed. Windows `EPERM`/`EBUSY` on rename is retried with backoff (bounded). A crash at
any point leaves either the old pack or the new pack in place, never a mix; leftover staging
directories are removed by the next sync. `.staging/` and `.llm-docs.lock` are created with a
`.gitignore` in `packsDir` that ignores them.

`.llm-docs.lock` is created with exclusive create, holds `{pid, startedAt, command}`, and is
considered stale when the pid is not alive or it is older than 1 hour. A second sync fails fast
with a clear message instead of waiting.

## 3. Manifest v3

`manifest.json` (zod schema, JSON Schema generated to `schema/manifest.schema.json`):

```jsonc
{
  "schemaVersion": 3,
  "tool": { "name": "llm-docs", "version": "3.0.0" },
  "pack": { "id": "vite", "title": "Vite", "version": "8.2.0" },
  "dependency": { "ecosystem": "npm", "name": "vite" },          // or null
  "recipe": { /* the resolved pack recipe: placeholders substituted, defaults filled */ },
  "recipeHash": "sha256:...",          // hash of the canonical JSON of `recipe`
  "acquiredAt": "2026-11-05T10:00:00.000Z",
  "origins": [                          // one per source, same order as recipe.sources
    { "type": "git", "repo": "https://github.com/vitejs/vite", "ref": "v8.2.0",
      "commit": "<40 hex>", "refKind": "tag" },
    { "type": "llms-txt", "url": "https://x.dev/llms.txt", "sha256": "sha256:..." },
    { "type": "urls" },
    { "type": "local", "path": "manuals", "hostCommit": "<hex>|null", "hostDirty": false }
  ],
  "license": {
    "declared": null,
    "detected": { "spdx": "MIT", "evidence": "LICENSE" } ,       // or null
    "status": "permissive" | "copyleft" | "attribution" | "unknown" | "proprietary"
  },
  "sources": [                          // every acquired upstream file
    { "source": 0, "path": "guide/index.md",          // origin-relative
      "url": "https://github.com/vitejs/vite/blob/<commit>/docs/guide/index.md",
      "sha256": "sha256:...", "bytes": 1234,
      "fetch": { "finalUrl": "...", "status": 200, "etag": "...", "lastModified": "..." },  // http only
      "converter": { "tool": "markitdown", "version": "markitdown 0.1.9",                 // converted only
                     "outputSha256": "sha256:..." } }                     // agent: also inputSha256
  ],
  "outputs": [
    { "path": "pages/guide/index.md", "kind": "page", "sha256": "sha256:...", "bytes": 2345,
      "tokens": 600, "title": "Getting Started", "sources": ["0:guide/index.md"] },
    { "path": "index.md", "kind": "index", ... },
    { "path": "files/schema/schema.ts", "kind": "passthrough", ... },
    { "path": "vite.full.md", "kind": "combined", ... }
  ],
  "links": {
    "rewritten": 120, "external": 40,
    "unresolved": [ { "page": "pages/x.md", "target": "../missing.md", "reason": "not-in-pack" } ]
  },
  "transforms": [ { "name": "strip-mintlify-banner", "pages": 122 } ],
  "warnings": [ "..." ]                 // sorted, deduplicated, human-readable
}
```

- Hashes use the `sha256:<hex>` form via `sha256Prefixed`.
- `tokens` uses the existing `estimateTokenCount`.
- `outputs` covers every tool-written file in the pack except `manifest.json` itself and
  `guides/**` (guides are covered by `guides/citations.lock.json`, which is itself listed with
  kind `citations` once it exists).
- Reading a manifest whose `schemaVersion` is not 3 fails with a message pointing to
  `llm-docs migrate`.

## 4. Building a pack

### 4.1 Acquisition

All acquisition writes into a temporary working directory under the OS temp dir (a cache, never
an identity) that is removed afterwards, including on failure.

**Network policy (shared HTTP client, `src/sources/http.ts`):** `https:` only (plus `http:` to
loopback when `LLM_DOCS_ALLOW_PRIVATE_NETWORK=1`, which tests use). Before connecting, resolve
the hostname and reject private, loopback, link-local, CGNAT, multicast, and unique-local
addresses (IPv4 and IPv6, including IPv4-mapped IPv6), unless the same env flag is set; pin the
connection to the resolved address so DNS rebinding cannot swap it. Follow at most 5 redirects,
re-applying the policy to each hop and recording the final URL. Timeouts: 15 s connect, 60 s
total per request. Per-response cap 20 MB (configurable per pack up to 200 MB with
`limits.maxFileBytes`), streamed and aborted when exceeded. Per-pack caps: 5,000 files and
500 MB total. Concurrency 4 per host. Retries: 2, only for network errors, 429, and 5xx, with
jittered backoff honoring `Retry-After` up to 30 s. User-Agent:
`llm-docs/<version> (+https://github.com/Zyepher/llm-docs-generator)`. Credentials in URLs are
rejected; URLs are redacted (`redactUrl`) in every log and error. `GITHUB_TOKEN` is sent only
to `api.github.com` and only when set.

**Git policy (`src/sources/git.ts`):** run git with `execFile`, never a shell. Environment:
`GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL` pointed at an empty
file, `GIT_ASKPASS` unset. Config flags on every invocation: `-c core.hooksPath=<empty dir>`,
`-c core.symlinks=false`, `-c protocol.allow=never -c protocol.https.allow=always`
(`protocol.file.allow=always` only for `file://` repos), `-c submodule.recurse=false`. Fetch
strategy: `git init`, `git remote add origin <repo>`, `git fetch --depth 1 --filter=blob:none
origin <ref>` (for tags use `refs/tags/<ref>`), then a sparse, non-cone checkout of `paths`.
Resolve and record the commit; resolve the ref kind with `git ls-remote` (tag, branch, or
commit). Reject any checked-out symlink and any path escaping the checkout. Timeout 10 minutes
per git command. A missing `git` binary is a clear error.

### 4.2 Selecting files

Files are enumerated with `walkBoundedDirectoryTree` (the shared walker) from each source's
root after acquisition. Default include for `git` and `local`: `**/*.{md,mdx,markdown,rst,html,htm}`
plus OpenAPI files detected by content (`openapi:` / `swagger:` key in JSON or YAML) when
listed by an explicit include. Default skip directories come from `SKIPPED_DIRECTORY_NAMES`.
Files that match no handler and no passthrough glob are skipped and counted in one aggregated
warning per extension. Output paths are checked for collisions (case-insensitive, because
macOS and Windows file systems are) and for Windows-reserved names; either is an error naming
the files.

### 4.3 Converting to pages

Each selected file becomes exactly one page at `pages/<mount>/<path with its extension
replaced by .md>`, except OpenAPI (below). Every page starts with one provenance comment line:

```
<!-- llm-docs: vite@8.2.0 | source: https://github.com/vitejs/vite/blob/<commit>/docs/guide/index.md -->
```

(`source:` is the origin URL for git and http sources and the project-relative path for local
sources.) Then a blank line, then the content.

- **Markdown (`.md`, `.markdown`) and MDX (`.mdx`)**: source-preserving. The text is kept
  as written except for these deterministic steps, each skipped inside fenced code, indented
  code, and inline code: YAML or TOML frontmatter is removed, and its `title` becomes an H1 when
  the document has no H1, and its `description` becomes the first paragraph when present; MDX
  `import`/`export` lines are removed; MDX/JSX components: a known set of layout wrappers
  (`Tabs`, `Tab`, `TabItem`, `Steps`, `Step`, `Callout`, `Note`, `Tip`, `Warning`, `Info`,
  `Card`, `CardGroup`, `Accordion`, `AccordionGroup`, `CodeGroup`, `Frame`, `Details`) are
  unwrapped keeping their children and, for `Tab`/`TabItem`/`Accordion`/`Card`/`Step`, turning the
  `title`/`label` prop into a bold line (and a `Card` `href` into a link on that line); other capitalized components are left as written and
  counted; DocC directives keep the existing handling (`@Metadata`, `@Options`, etc. removed;
  `@Tutorial` content kept); the comment-directive tab dialect keeps working; then transforms
  (4.4), then link rewriting (4.5).
- **reStructuredText, HTML**: parsed with the existing parsers into the `DocNode` IR and
  rendered by a new IR-to-Markdown renderer that keeps the source heading levels (no
  renumbering), renders code blocks as fenced code with the language, and renders `DATA`
  blocks as fenced `json` or `yaml`. HTML pages drop navigation chrome as v2 does.
- **OpenAPI 3.x / Swagger 2.0**: one page per tag at `pages/<mount>/<spec stem>/<tag slug>.md`
  plus `pages/<mount>/<spec stem>/index.md` with info, servers, auth schemes, and the tag list.
  Operations render method, path, summary, description, deprecation, auth, parameters, request
  body, and responses with dereferenced schema shapes (existing parser output). Untagged
  operations go to `untagged.md`.
- **Converted documents**: see 4.6; the converter's Markdown output then goes through the
  Markdown path.

Headings are never renumbered. Page titles (for the index) come from the first H1, else the
frontmatter title, else the file name.

### 4.4 Transforms

Named, deterministic, opt-in per source, recorded in the manifest with the count of pages they
changed. v3.0 ships:

- `strip-mintlify-banner`: removes the leading "Documentation Index" block Mintlify prepends to
  raw `.md` pages (exact marker match; no fuzzy matching).
- `strip-html-comments`: removes HTML comments outside code.
- `drop-frontmatter-description`: suppresses the description paragraph from 4.3.

Unknown transform names are config errors.

### 4.5 Links in pages

Rewriting runs on Markdown text outside fenced code, indented code, and inline code, covering
inline links, images, reference definitions, autolinks, and `href`/`src` attributes in raw
HTML. For each target:

1. Fragment-only (`#x`): unchanged.
2. Relative path that resolves (after stripping a `.md`, `.mdx`, `.html` extension or a trailing
   `/index`, the same normalization v2 uses for extensionless routes) to another acquired page
   of the same pack: rewritten to the relative path from this page to that page, fragment kept.
3. Site-absolute (`/x/y`) or absolute URL on `site.baseUrl`'s origin: aliases applied first,
   then matched against the acquired pages' site paths. Site path for an http-acquired page is
   its URL pathname; for a git or local page it is its source path with the extension and a
   trailing `index` removed, relative to the source root. A match rewrites to the relative page
   path; no match rewrites to the absolute URL `baseUrl + path`.
4. Relative path inside a git source's repository but outside the pack: rewritten to a pinned
   blob URL at the recorded commit for GitHub remotes (existing `pinOutOfPackTarget` logic);
   other hosts leave it unchanged and count it.
5. Anything else: unchanged and recorded in `links.unresolved` with a reason.

`verify` fails on a relative link in a page or index that does not resolve on disk, so
step 5 entries must not be relative paths: an unresolvable relative target is rewritten to the
absolute upstream URL when the origin is http or a GitHub git remote, and otherwise recorded
and, as a last resort, converted to plain text `[label] (unresolved: target)` so the pack never
contains a dead local link. The count of such conversions is a manifest warning.

### 4.6 Converters

`convert` on a source: `{ "tool": "docling" | "markitdown" | "command" | "agent", "include":
[globs], "command": [argv], "timeoutSeconds": 300 }`. `include` defaults to
`**/*.{pdf,docx,pptx,xlsx,epub,html,htm}` for docling and markitdown (xlsx only if explicitly
listed, because spreadsheets are passthrough by default) and is required for `command` and
`agent`. A file matched by both `passthrough` and the converter's `include` is passthrough.

- `docling`: runs `docling --to md --image-export-mode placeholder --output <tmp> <input>` and
  reads `<tmp>/<stem>.md` (placeholder images keep base64 data out of pages).
- `markitdown`: runs `markitdown <input>` and reads stdout.
- `command`: argv array with `{input}` (required) and optional `{output}` placeholders; reads
  `{output}` if present, else stdout. Never run through a shell.
- `agent`: no process runs. For every included original `X`, a sibling `X.md` written by an
  agent must exist; the pack uses it and records both hashes (`X.md` is a source entry, not a
  page of its own). The original's entry records `converter.inputSha256`, the hash of the
  original `X.md` was written from, carried over while `X.md` is unchanged. A conversion is
  stale when that differs from the original's hash: `sync` still builds and warns, and
  `verify` fails `conversion` until an agent rewrites `X.md`. For local sources `verify` also
  compares the original on disk with the recorded hash.

Tool resolution: for docling and markitdown, `command` (when set) is the executable and any
leading arguments, used instead of the tool name, with the tool's own arguments appended; else
the tool name on `PATH` (on Windows also with `.exe`, `.cmd`, `.bat`, `.com`). The version is
captured with `--version` (first line, trimmed; for `command`, `command[0] --version`) and
recorded; when it cannot be read it is recorded as null with a warning. Failure to resolve the
tool is an error naming the install command (`pipx install docling`, `pipx install
'markitdown[all]'`). Inputs are copied under a sanitized name into the temp working directory
and passed as paths there; per-file timeout (the child is killed); inputs over 200 MB are
refused; non-zero exit or empty output is an error naming the file and the tool's stderr tail.
A Windows `.cmd`/`.bat` shim can only run through `cmd.exe`: its arguments are quoted, and an
argument containing `"`, `%`, or a line break is refused. Converter output is not assumed
deterministic: successful conversions are cached in `<cache dir>/conversions/`, keyed by the
input hash, tool, version, and argv template, so an unchanged document is not reconverted when
its pack rebuilds for another reason; `refresh` reports changed pages caused by a converter
version change separately.

### 4.7 Passthrough files

Files matching `passthrough` globs are copied byte-identical to `files/<mount>/<path>` and
listed as `passthrough` outputs. Links from pages to passthrough files resolve normally.

### 4.8 `index.md`

Generated, deterministic, verified. Contents:

1. `# <title> <version>` and a provenance paragraph: the origins in plain words (repository and
   commit with a link, or the index URL, or the project path), the acquisition date, and the
   license line (SPDX id and attribution with a link to the license file when known).
2. A short "How to read this pack" paragraph: open the page for the API you need; grep
   `pages/` for exact symbol names; pages are upstream text, guides are digests and never
   outrank pages.
3. If `guides/` exists: a "Guides" list with each guide's title and path.
4. "Pages": grouped by top-level directory under `pages/` (in sorted order), one table per
   group with columns page link, title, approximate tokens.

Titles from upstream are escaped for Markdown tables (`|`, backticks, newlines, control
characters removed, 120 character cap).

### 4.9 Combined layout

With `layout.combined: true`, `<id>.full.md` concatenates the index and every page in index
order, each page preceded by `<!-- page: pages/... -->`, with relative links rewritten to
in-file anchors where the target is in the file and to the page path otherwise. Intended for
hosts without file access.

### 4.10 License detection

For git sources: license files at the repository root and at each taken path's root
(`LICENSE*`, `LICENCE*`, `COPYING*`, case-insensitive) at the recorded commit, fetched even
when outside `paths`. Detection matches normalized text against fingerprints for MIT,
Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, MPL-2.0, CC-BY-4.0, CC-BY-SA-4.0, CC0-1.0,
Unlicense, GPL-2.0, GPL-3.0, LGPL-2.1, LGPL-3.0, AGPL-3.0, and a `SPDX-License-Identifier:`
line. Status: MIT/Apache/BSD/ISC/CC0/Unlicense are `permissive`; CC-BY is `attribution`;
GPL/LGPL/AGPL/MPL/CC-BY-SA are `copyleft`; nothing found is `unknown`; a declared
`proprietary` is `proprietary`. `sync` prints a warning for `unknown` and `proprietary`;
`verify --strict` fails on them. A declared license is recorded alongside the detected one and
wins for status; a mismatch is a warning.

## 5. Commands

Exit codes everywhere: 0 success, 1 a check failed (verify, `--check` modes), 2 usage or config
error, 3 runtime failure (network, git, converter). Every command accepts `--project <dir>`
and `--json` (machine output on stdout, human output on stderr, never mixed). Colors only on a
TTY and never when `NO_COLOR` is set.

- `llm-docs init [--packs-dir <dir>]`: create `llm-docs.json` and `packsDir` with its
  `.gitignore`; insert empty managed blocks per 7.1. Idempotent; never overwrites config.
- `llm-docs add <id> (--git <repo> --ref <ref> [--path <p>]... | --url <u>... | --urls-file
  <f> | --llms-txt <u> --include <glob>... | --local <path>) [--dependency <eco>:<name>]
  [--version <v>] [--mount <m>] [--title <t>] [--convert <tool>] [--site <baseUrl>]
  [--recipe <json>] [--dry-run]`: write the recipe into config (creating config if absent),
  then `sync <id>`. Refuses to overwrite an existing id unless `--replace`. `--dry-run` prints
  the recipe and the file list that would be acquired, writing nothing.
- `llm-docs sync [ids...] [--check] [--offline] [--prune]`: bring packs in line with config
  and lockfiles. Skips a pack when its manifest's `recipeHash` matches and its outputs verify.
  `--check`: write nothing, exit 1 if any pack or managed block would change (CI gate).
  `--offline`: fail rather than acquire. `--prune`: delete pack directories not in config
  (without it, they are reported). Always updates managed blocks last.
- `llm-docs refresh [ids...] [--check]`: re-acquire each pack at its recorded recipe and
  report per page: unchanged, changed, added, removed; for git, whether the ref now resolves to
  a different commit. Writes the new pack unless `--check`.
- `llm-docs verify [ids...] [--strict]`: run every check in 5.1. Read-only, offline.
- `llm-docs status [--model <id>] [--cutoff <YYYY-MM>] [--offline] [--brief]`: section 6.
- `llm-docs guides stamp <id> [guide...]`: section 8.
- `llm-docs migrate <v2-pack-dir> [--id <id>]`: section 9.
- `llm-docs discover --url <site> | --package <eco>:<name>[@<version>]`: section 10.
- `llm-docs hook session-start`: section 7.2. Undocumented in `--help` output except as
  "used by the plugin".
- `llm-docs capabilities --json`: machine-readable list of commands, options, source types,
  converters, ecosystems, transforms, and limits, generated from the same tables the code
  uses (never a hand-maintained list that can drift).

Removed in v3 with a one-line error pointing to the replacement when invoked: `generate`
(use `add`), `validate`, `list-sdks`, `source-truth`, `verify-docs`, `plugins`, `agent`.

### 5.1 `verify` checks

Per pack, each a named check with pass, fail, or warn:

| Check | Fails when |
|---|---|
| `manifest-schema` | manifest missing, unparsable, or not schema v3 |
| `outputs` | a listed output is missing or its hash differs |
| `unlisted-files` | a file in the pack is not listed (ignoring `guides/**` and OS junk like `.DS_Store`, which are reported as info) |
| `links` | a relative link in a page, index, or combined file does not resolve inside the pack (fragments are checked against heading slugs only in `--strict`) |
| `recipe` | the config recipe for this id resolves to a different `recipeHash` (warn when the config has no such pack: orphan) |
| `lockfile` | `dependency` is set and the lockfile version differs from `pack.version` |
| `citations` | a guide citation does not resolve, or its cited section hash changed since stamping; an unstamped guide or a guide edited after stamping is a warning |
| `conversion` | an `agent` conversion's original changed since the last sync |
| `license` | warn for `unknown` and `proprietary`; fail under `--strict` |

Plus project-level checks: `config-schema`, and `agent-block` (each managed block matches what
`sync` would write). Output lists one line per problem with the pack id, check name, and path.

## 6. Dependencies, release dates, and model cutoffs

### 6.1 Lockfile scanning (`src/deps/`)

`scanDependencies(projectRoot)` walks the project with the shared walker (max depth 6, skip
`node_modules`, `.git`, build and vendor dirs, and `packsDir`), finds lockfiles, and returns
resolved dependencies:

```ts
type Ecosystem = 'npm' | 'pypi' | 'cargo' | 'go' | 'pub' | 'swiftpm'
interface ResolvedDependency {
  ecosystem: Ecosystem
  name: string                 // registry name; npm scoped names kept as @scope/name
  version: string              // exact resolved version
  direct: boolean              // declared by the project manifest next to the lockfile
  dev: boolean
  lockfile: string             // project-relative POSIX path
  repositoryUrl?: string       // known for swiftpm and go
}
interface DependencyScan {
  dependencies: ResolvedDependency[]  // sorted by ecosystem, name, version, lockfile
  lockfiles: string[]
  warnings: string[]
}
```

Supported inputs and how directness is decided:

| Ecosystem | Lockfiles | Direct deps from |
|---|---|---|
| npm | `package-lock.json` (v1, v2, v3), `npm-shrinkwrap.json`, `pnpm-lock.yaml` (v6 to v9), `yarn.lock` (classic and berry), `bun.lock` (text) | `package.json` `dependencies`, `devDependencies`, `optionalDependencies`, `peerDependencies` of the same directory (and workspace packages listed in the lockfile) |
| pypi | `uv.lock`, `poetry.lock`, `pdm.lock`, `Pipfile.lock`, `requirements*.txt` with `==` pins | `pyproject.toml` (`project.dependencies`, optional groups, `tool.poetry.dependencies`), `Pipfile`; requirements pins are direct |
| cargo | `Cargo.lock` | `Cargo.toml` `[dependencies]`, `[dev-dependencies]`, workspace members |
| go | `go.mod` (`require` lines; `// indirect` marks indirect) | same |
| pub | `pubspec.lock` | its own `dependency: direct main / direct dev` field |
| swiftpm | `Package.resolved` (v1, v2, v3) | `Package.swift` `.package(url:` entries when parsable; otherwise all pins are treated as direct with a warning |

Non-registry dependencies (git, path, workspace, `file:`, npm aliases to other names, `link:`)
are skipped with one aggregated warning. `bun.lockb` (binary) is reported as unsupported.
Name normalization: PyPI names are PEP 503 normalized; others exact. Parsers never execute
project code. TOML is parsed with `smol-toml`.

### 6.2 Release dates

`lookupReleaseDates(deps, { offline, budgetMs })` returns publish timestamps, cached in the user
cache directory (`LLM_DOCS_CACHE_DIR`, else `$XDG_CACHE_HOME/llm-docs`, else
`~/Library/Caches/llm-docs` on macOS, `%LOCALAPPDATA%\llm-docs\Cache` on Windows,
`~/.cache/llm-docs` elsewhere) in `release-dates.json`. Positive entries never expire (a
version's publish date is immutable); negative entries expire after 24 hours. Writes are
atomic; a corrupt cache file is discarded with a warning.

| Ecosystem | Source |
|---|---|
| npm | `https://api.deps.dev/v3/systems/npm/packages/<name>/versions/<version>` `publishedAt`; fallback: registry packument `time[<version>]` with a 25 MB cap |
| pypi | `https://pypi.org/pypi/<name>/<version>/json`, earliest `urls[].upload_time_iso_8601` |
| cargo | `https://crates.io/api/v1/crates/<name>/<version>` `version.created_at` |
| go | `https://proxy.golang.org/<escaped module>/@v/<version>.info` `Time` |
| pub | `https://pub.dev/api/packages/<name>` `versions[].published` |
| swiftpm | GitHub repositories only: tag commit date via `api.github.com` (uses `GITHUB_TOKEN` when set); others unknown |

`budgetMs` bounds total wall time; unfinished lookups return `null` and are retried next time.

### 6.3 Model cutoffs

`data/model-cutoffs.json` ships with the package: an ordered list of `{ "pattern": regex over
the normalized model id, "label": "Claude Opus 5.5", "cutoff": "2026-06", "source": "<url>" }`.
Normalization lowercases, strips bracketed suffixes like `[1m]`, and strips provider prefixes
(`us.anthropic.`, `anthropic/`). Only entries backed by a published source are included; the
source URL is recorded per entry. Resolution order: `--cutoff`, config `model.cutoff`,
`LLM_DOCS_MODEL_CUTOFF`, the table match for `--model` or the hook's model id. No match means
no cutoff and the after-cutoff analysis is skipped (never guessed).

### 6.4 `status`

Joins the dependency scan, the packs, release dates, and the cutoff:

- Packs: id, version, dependency, state (`ok`, `stale-pack` when the lockfile moved,
  `recipe-changed`, `missing` when configured but never synced, `orphan`).
- Direct dependencies released after the cutoff, or within `nearCutoffDays` before it, that
  have no pack: name, version, release date, and a suggested next step.
- `--brief`: the text the hook injects (7.2). `--json`: the full structure.

## 7. Agent integration

### 7.1 Managed block

Written by `sync` and `init` into each agent file. `agentFiles: "auto"` means: `AGENTS.md` if
it exists; `CLAUDE.md` if it exists and does not contain an `@AGENTS.md` import line (Claude
Code reads AGENTS.md only when no CLAUDE.md exists, unless imported); if neither exists,
create `AGENTS.md`. Markers:

```
<!-- BEGIN llm-docs: generated from llm-docs.json, do not edit by hand -->
...
<!-- END llm-docs -->
```

Block content (deterministic, within `block.maxBytes`, default 4096 bytes):

```
## Pinned reference docs

This repository pins docs for these libraries at the versions it uses. Before writing code
against one of them, open its index and the page for the API you need, and prefer those pages
over memory. Pages are upstream text; guides are summaries that never outrank pages.

- Vite 8.2.0: `agent-docs/vite/index.md` (guide, config, api, plugins)
- MCP spec 2026-07-28: `agent-docs/mcp/index.md` (specification, schema, guides)
```

The parenthesized topics are the pack's top-level page directories plus `guides` when present,
dropped (whole pack lines first keep, topics drop first, from the last pack backwards) when
over budget; if even the bare lines exceed the budget the block lists the first packs and ends
with `- ...and N more: see agent-docs/`. Upstream-derived text (titles, descriptions,
directory names) is escaped: control characters and backticks removed, `<`/`>` replaced, single
line, 80 character cap. Blocks are inserted at the end of the file when absent, with one blank
line before. Text outside the markers is never touched. A file with mismatched markers is an
error, never a guess.

### 7.2 Session-start hook

`llm-docs hook session-start` reads the hook payload from stdin (1 s read budget) and prints
context for the agent. Behavior:

- Harness detection: `CURSOR_VERSION` or `CURSOR_PLUGIN_ROOT` set means Cursor, which gets
  `{"additional_context": "..."}`; otherwise Claude Code and Codex shape
  `{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "..."}}`.
- Project: `cwd` from the payload, else `CLAUDE_PROJECT_DIR`, else Cursor `workspace_roots[0]`,
  else the process cwd; then project discovery (2.1). With no `llm-docs.json`, the hook still
  runs the dependency analysis (so it is useful before a project adopts packs).
- Model: payload `model` (Claude Code sends it only in some sessions; headless `-p` runs omit
  it), Cursor `model_id`/`model`, Codex `model`; then `ANTHROPIC_MODEL`; then `model` from
  `<project>/.claude/settings.local.json`, `<project>/.claude/settings.json`,
  `~/.claude/settings.json`. Claude Code aliases (`opus`, `sonnet`, `haiku`, `fable`, with
  optional `[1m]`-style suffixes) resolve through the cutoff table to the family's current
  model. Cutoff resolution per 6.3. When no cutoff resolves, the hook lists direct dependencies
  without a pack released in the last 180 days under a neutral heading ("Recently released
  dependencies (your training data may predate them)"): a fact from release dates, not a guess
  about the model.
- Content (at most 2,000 characters; nothing at all when there is nothing to say):
  1. Packs whose lockfile moved (stale) with the fix command.
  2. Direct dependencies newer than the model's training cutoff (or within the near-cutoff
     window) without a pack, most recent first, at most 8, with their release dates, and the
     suggestion to read their docs or create a pack with the `add-docs` skill.
  3. When packs exist and the managed block is missing from the agent file the harness reads,
     the pack list itself (so the hook covers projects that gitignore AGENTS.md).
- Performance: total wall time under 1.5 s. Release dates come from the cache; missing entries
  get at most a 1,000 ms network budget, and anything still missing is fetched by a detached
  background `status` process (at most one per project per 6 hours, tracked in the cache dir)
  so the next session has it.
- Failure policy: always exit 0. Errors go to `<cache dir>/hook.log` (rotated at 1 MB), never
  to stdout. `LLM_DOCS_HOOK=off` or config `hook.enabled: false` disables output.

### 7.3 Plugin (`plugin/`)

One tree serving Claude Code and Cursor, and installable in Codex through its Claude-compatible
marketplace support:

```
plugin/
  .claude-plugin/plugin.json      name "llm-docs", version = package version
  .cursor-plugin/plugin.json      name "llm-docs", skills, agents, hooks: "./hooks/cursor-hooks.json"
  hooks/hooks.json                Claude Code format: SessionStart -> node "${CLAUDE_PLUGIN_ROOT}/bin/llm-docs.mjs" hook session-start
  hooks/cursor-hooks.json         Cursor format: {"version":1,"hooks":{"sessionStart":[{"command":"node \"${CURSOR_PLUGIN_ROOT}/bin/llm-docs.mjs\" hook session-start"}]}}
  bin/llm-docs                    POSIX sh wrapper (exec node "$(dirname "$0")/llm-docs.mjs" "$@")
  bin/llm-docs.cmd                Windows wrapper
  bin/llm-docs.mjs                the whole CLI bundled into one file (generated, committed)
  skills/add-docs/SKILL.md        planner playbook: decide source and version, write the recipe, sync, verify
  skills/write-docs-guide/SKILL.md  write a digest, fact-check it with the agent, stamp citations
  skills/llm-docs/SKILL.md        command reference and when to use which command
  agents/docs-fact-checker.md     checks every claim in a guide against the cited pages
  README.md
```

Root `.claude-plugin/marketplace.json` and `.cursor-plugin/marketplace.json` list the plugin at
`./plugin`. `npm run build:plugin` regenerates `bin/llm-docs.mjs` (tsup, all dependencies
bundled, Node 22 target) and stamps plugin versions from `package.json`; `npm run
check:plugin` fails CI when the committed bundle or versions are out of date. Skill folder
names equal their frontmatter `name`. Skills are written harness-neutral (no tool names that
exist in only one harness). If Node is not on PATH the hook command fails and both harnesses
treat that as a non-blocking error; the README documents Node 22 as a requirement.

## 8. Guides and citations

Guides are Markdown files under `<pack>/guides/` written by agents. A citation is any Markdown
link in a guide whose target resolves into the pack's `pages/` or `files/` (relative path),
optionally with a fragment. `llm-docs guides stamp <id> [guide...]` writes
`guides/citations.lock.json`:

```jsonc
{ "schemaVersion": 1,
  "guides": {
    "guides/01-overview.md": {
      "sha256": "sha256:...",
      "citations": [
        { "target": "pages/specification/basic-transports.md#session-management",
          "sectionSha256": "sha256:..." }
      ] } } }
```

A fragment resolves to the heading whose slug (the existing Unicode-aware slugger, GitHub
rules, with `-1`, `-2` suffixes for duplicates) equals it; the section is the text from that
heading to the next heading of the same or higher level. No fragment means the whole page.
Stamping fails on a citation that does not resolve. `verify` recomputes everything (5.1).
After a `refresh`, the report lists guides whose cited sections changed, which is the
re-review list for the planner.

## 9. Migration from v2

`llm-docs migrate <v2-pack-dir> [--id <id>]` reads a v2 manifest (`schemaVersion` "0.1.0",
`mode: local-source-docs`) and writes a v3 recipe into the project config:

- Source with `git` state (`remoteUrl`, `commit`, `sourceRootFromRepo`): a `git` source with
  `repo` normalized to https, `ref` = the commit, `paths` = [the source root]. Exclude globs
  carry over.
- Source under the OS temp directory or missing: exit 2 explaining that the origin is lost and
  that the pack must be re-added from a durable source.
- Source inside the project: a `local` source.
- Other v2 modes: exit 2 naming the mode as unsupported in v3.

It prints the next command (`llm-docs sync <id>`) and never deletes the v2 pack.

## 10. Discover

Read-only evidence for the planner, printed as JSON (and a human summary on stderr). Never
writes files.

- `--url <site>`: reuses the v2 website discovery (llms.txt, sitemap, robots-free bounded
  fetch) with the 4.1 network policy; adds whether page URLs serve raw Markdown when `.md` is
  appended (probing at most 3 listed pages) and the version-looking path segments found in
  `llms.txt` (for example `2026-07-28`, `v8`), so the planner can write a filter.
- `--package <eco>:<name>[@<version>]`: registry metadata (repository URL and directory,
  homepage, documentation URL, license, the version's publish date), the git tags matching the
  version (via `git ls-remote`), and, when a tag matches, the top documentation-looking
  directories at that tag (blobless shallow fetch and `git ls-tree`, ranked by Markdown file
  count). Ecosystems: npm, pypi, cargo, pub, go (swiftpm: repository URL is the identity).

## 11. Security summary

- Fetched docs are untrusted input that ends up in an agent's context. The engine never copies
  upstream text into agent files beyond escaped titles and directory names (7.1), never executes
  fetched content, and never follows links inside fetched pages.
- Network: section 4.1 policy (scheme allowlist, private-address blocking with DNS pinning,
  redirect re-validation, size and count caps, timeouts, credential rejection, redaction).
- Git: section 4.1 policy (no hooks, no submodules, no symlinks, protocol allowlist, isolated
  config, no shell).
- File system: every write is inside the pack staging directory or an agent file the config
  names; paths are checked with `isSameOrDescendant`; collisions and reserved names are errors;
  writes are atomic (`writeTextFileSafely`, `writeJsonFileSafely`).
- Converters run with `execFile`, a timeout, and paths the engine chose; `command` converters
  are trusted local configuration, documented as such.
- The hook never writes outside the cache directory and never prints secrets or tokens.

## 12. Quality bar and delivery

- TypeScript strict as configured; no `any`, no casts to `unknown as`, no ts-ignore.
- Each module ships with Vitest unit tests next to its peers in `tests/unit/`; network tests use
  a local HTTP server with `LLM_DOCS_ALLOW_PRIVATE_NETWORK=1`; git tests use local repositories
  created in temp dirs via `file://`. No test touches the real network.
- CLI end-to-end tests run the built CLI against temp projects (one subprocess per scenario,
  grouped to keep the suite fast).
- CI: Linux, macOS, Windows on Node 22 and 24; `npm ci` with a committed `package-lock.json`;
  lint, format check, type-check, build, plugin bundle check, schema check, tests.
- Release: a tag `v*` publishes to npm with provenance from GitHub Actions (owner adds the
  `NPM_TOKEN` secret).
- Docs: README (user-facing, crafted, no em-dashes), `docs/` reference pages for config,
  manifest, commands, security, and the plugin; `CHANGELOG.md` with the v3 breaking changes and
  the migration path; skills in `plugin/skills/` replace `AGENT_CONTEXT.md` and `skills/`.

## 13. Evals

`evals/` holds cases and a runner (`npm run eval`). Each case is a small project pinned to a
library version released after the evaluated model's training cutoff (plus negative controls
the model already knows), a task prompt, a pack recipe, and mechanical checks (`tsc --noEmit`,
`node --test`) the runner executes after the agent finishes. Arms: `baseline` (no pack, no
plugin), `pack` (pack and managed block, no plugin), `plugin` (pack, block, and plugin hook and
skills). The runner prepares workspaces with dependencies installed before the agent starts,
runs `claude -p` with a pinned model, turn and budget caps, and `--setting-sources project` so user
settings and plugins stay out of every arm (measured 2026-11-05 on Claude Code 2.1.318: an
isolated `CLAUDE_CONFIG_DIR` loses the OAuth login, and `--safe-mode` also disables hooks from
`--plugin-dir`, so neither can be used for the plugin arm), grades with the checks, and writes `evals/results/<timestamp>/results.json` and `summary.md` (pass rate per
arm and case, runs, cost). The README publishes the numbers with the date, model, and run count.

## 14. Acceptance

v3.0 is done when all of these hold:

1. Full CI green on all platforms; coverage of every module listed above.
2. The six packs in `~/Developer/agent-docs` can be migrated (five via git recipes; the
   typescript-7 pack reports its lost origin) and synced, and verify passes.
3. The incorpus MCP 2026-07-28 mirror can be reproduced by a recipe (an `llms-txt` source with
   a revision filter and `strip-mintlify-banner`, plus a `git` source for the schema files as
   passthrough), generated into a scratch directory, and its differences from the hand-built
   mirror are explained; a link check over the output finds zero broken local links.
4. The plugin installs in Claude Code from the repository marketplace and its hook injects the
   expected text in a real session; `claude plugin validate` passes.
5. The eval suite has run with the owner's approval and its results are in the README.
6. An independent review of provenance, manifest integrity, the network and git policy, and
   atomic writes finds no open defects.
