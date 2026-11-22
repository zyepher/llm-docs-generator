# llm-docs v3 specification

Status: implemented in 3.0.0. This document is the design record: it says what v3 does and
why, and it was amended during the build so that it matches what shipped. The reference pages
in `docs/` (config, manifest, commands, security, plugin) are the user-facing source for exact
behavior.
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
        citations.lock.json     written only by `guides stamp`; not a manifest output, verified
                                by the `citations` check through recomputation (section 8)
```

The project root is the nearest ancestor of the working directory containing an entry named
`llm-docs.json`. The entry must be a regular file (a link to one is followed); anything else is
a config error naming it, never a reason to look further up. A command that rewrites it refuses
a read-only or hard-linked file with a config error. Discovery does not ask who owns the
config, so below a directory another user can write to (a shared `/tmp`) it may be theirs. On
POSIX systems, when `llm-docs.json` or its directory belongs to another user (by `lstat` uid
against `process.getuid()`; root is another user unless running as root), no converter whose
executable the config names runs: `sync`, `add`, and `refresh` fail that pack with a config
error saying whose file it is, and the hook ignores the config (7.2). Fetching per its recipe
and reading packs stay allowed, since neither runs code. Windows has no uids and skips the
check. Commands that create config (`init`, `add`, `migrate`) use that project when one exists, else
the git top-level directory when inside a git repository, else the working directory.
`--project <dir>` names the root, as given, on every command that reads a project (section 5),
`status` included: with no `llm-docs.json` there, `status` analyses that directory's
dependencies.

### 2.2 `llm-docs.json`

Validated with zod v4. The JSON Schema is generated from the zod schema with
`z.toJSONSchema()` into `schema/llm-docs.schema.json` and published in the package; a test fails
when the committed schema is out of date. Unknown keys are errors (strict objects) so typos
never silently disable behavior. `init` writes `$schema` as the schema's raw GitHub URL at the
release tag of the running version, so editors resolve it without the npm package, which is not
published yet.

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/Zyepher/llm-docs-generator/v3.0.0/schema/llm-docs.schema.json",
  "schemaVersion": 3,
  "packsDir": "agent-docs",               // project-relative, default "agent-docs"
  "agentFiles": "auto",                    // "auto" | string[] of project-relative paths | []
  "block": { "maxBytes": 4096 },          // managed block budget, 1024 to 65536 bytes
  "hook": { "enabled": true, "nearCutoffDays": 90 },
  "model": { "cutoff": "2026-06" },       // optional override for status and hook
  "packs": {
    "vite": {
      "title": "Vite",
      "description": "Build tool and dev server",   // optional, one line, escaped into the block
      "dependency": { "ecosystem": "npm", "name": "vite" },  // optional
      "covers": [{ "ecosystem": "npm", "name": "create-vite" }],  // optional, 1 to 20: see rules
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
      "license": null,                     // optional declared SPDX id, "proprietary", or null
      "limits": { "maxFileBytes": 20971520 },  // optional per-file cap, 1 to 200 MiB
      "readFirst": ["pages/guide/migration.md"]  // optional, 1 to 5 targets: see 4.8
    }
  }
}
```

Rules:

- Pack ids match `^[a-z0-9][a-z0-9._-]{0,63}$`.
- `{version}`, `{major}`, `{minor}`, `{patch}` placeholders are allowed in `ref`, `paths`,
  `url`, `urls` (the URL and an explicit `path`), `include`, `exclude`, `readFirst`, and the
  targets (values) of `site.aliases` (`"/specification/latest": "/specification/{version}"`:
  "latest" on a versioned site means the pinned version), substituted from the resolved
  version. A placeholder with no resolvable value is an error, never an empty string. A
  placeholder in `repo`, `mount`, `passthrough`, `stripPrefix`, a local `path`,
  `convert.include`, `convert.command`, `site.baseUrl`, or a `site.aliases` key is an error.
- Defaults: `packsDir` `agent-docs`, `agentFiles` `"auto"`, `block.maxBytes` 4096,
  `hook.enabled` true, `hook.nearCutoffDays` 90 (0 to 3650), pack `title` the pack id,
  `limits.maxFileBytes` 20 MiB.
- `readFirst` entries are pack-relative POSIX paths starting with `pages/` or `files/` (no
  absolute paths, no `..` segments, no backslashes, normalized), each optionally followed by
  `#<heading slug>`, the target form guide citations use (section 8). Duplicates are an error,
  checked again after placeholder substitution. The planner decides which pages these are; the
  engine records, validates, and shows them, and never guesses which page describes a change.
- `version` must be a non-empty string without whitespace, `<`, `>`, or control characters. It
  need not be semver (`2026-07-28`
  is a valid version for a protocol revision).
- `dependency.ecosystem` is one of `npm`, `pypi`, `cargo`, `go`, `pub`, `swiftpm`.
- `covers` lists 1 to 20 more dependencies, in the shape of `dependency` and under its rules,
  that the pack's docs also describe (one docs set for a family: `@modelcontextprotocol/server`
  and `@modelcontextprotocol/client`, `@tanstack/*`, the `effect` packages). No two may name the
  same package (PyPI names compared after PEP 503 normalization), and none may equal the pack's
  own `dependency`. It binds no version: the pack's version still comes from `dependency` or
  `version` alone, and the `lockfile` check ignores `covers` for that. Like `readFirst`, it is
  absent from the resolved recipe when the pack sets none, so no existing recipeHash changes; it
  is recorded in the manifest's recipe, so `status` and the hook read it without config. Its
  effects are in 5.1, 6.4, and 7.2.
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
- Unordered arrays in the manifest are sorted by a stable key (`sources` by source index and
  path, `outputs` by path, `links.unresolved` by page, target, and reason, `transforms` by
  name, `warnings` sorted and deduplicated); `origins` and everything inside `recipe` keep
  recipe order, because both are indexed by source. Objects are written with sorted keys.
- Generated text uses `\n` line endings and ends with exactly one newline.
- Nothing machine-specific is recorded: no absolute paths, no hostnames, no usernames. Paths
  are POSIX and relative (to the project root, the pack, or the origin root). The one
  exception is opt-in: a `file://` git repository is recorded as its URL, with a warning that
  the origin is not portable.

### 2.6 Atomic builds and locking

A pack is built in `<packsDir>/.staging/<id>-<random>/`, verified in place, and swapped in:
the old pack is renamed to `<packsDir>/.staging/<id>-old-<random>`, the staging pack is renamed
into place, `guides/` is moved from the old pack into the new one, and the old pack is removed.
Guides only ever move between two pack directories, never into a staging pack, so no cleanup
path can delete them. `EPERM`, `EBUSY`, and `EACCES` on rename (Windows holds files open) are
retried with exponential backoff, at most 7 times. A crash never leaves a mix of old and new
files: between the two renames no pack is at the target path. Sync reconciles `.staging` before
it builds (after a crash) and again before it writes the agent blocks (after a swap that failed
part-way): an old pack with no pack in its place is renamed back, and `guides/` in a leftover is
moved into its pack when the pack has none. A leftover that holds guides is never deleted; when
its guides cannot be put back it stays, and the end-of-run pass fails its pack with the path.
Other leftovers are removed. The pack directory and its `guides/` must be real directories: a
symbolic link at either fails that pack with a config error naming it, in `sync`, `guides
stamp`, and this recovery, and nothing is followed or deleted through it. `.staging/` and
`.llm-docs.lock` are created with a `.gitignore` in `packsDir` that ignores them.

`.llm-docs.lock` is created with exclusive create, holds `{pid, startedAt, command, token}`
(`token` is random per run, so a run can tell its own lock from another's), and is considered
stale when the pid is not alive, `startedAt` is more than 1 hour from now in either direction,
`pid` or `startedAt` is missing, or it cannot be read and is older than 5 seconds. A run takes
over a stale lock by renaming it to a name only that run uses, and goes on only when what it
moved is still the stale lock it judged; anything else is renamed back. It then checks that the
lock on disk is the one it wrote before doing any work, and on release removes the lock only
when it is still its own. A lock path that is not a regular file (a link, a directory, a named
pipe) is a config error, never read through or deleted. A second sync fails fast (exit 3) with a
clear message instead of waiting. `sync --check` takes no lock.

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
                                       // (`recipe.readFirst` is absent, never [], when the
                                       // pack marks no pages, so packs built before the field
                                       // existed keep their recipeHash; `recipe.covers` likewise)
  "acquiredAt": "2026-11-05T10:00:00.000Z",
  "origins": [                          // one per source, same order as recipe.sources
    { "type": "git", "repo": "https://github.com/vitejs/vite", "ref": "v8.2.0",
      "commit": "<40 hex>", "refKind": "tag" },   // + "finalRepo" after a redirect
    { "type": "llms-txt", "url": "https://x.dev/llms.txt", "sha256": "sha256:..." },  // + "finalUrl" after a redirect
    { "type": "urls" },
    { "type": "local", "path": "manuals", "hostCommit": "<hex>|null", "hostDirty": false }  // both null outside git
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
  `guides/**`. Guides are covered by `guides/citations.lock.json`, which `guides stamp` writes
  and only it. The lock is not a manifest output: sync never reads or writes it, so the
  manifest stays a function of the recipe and the upstream bytes, and the `citations` check
  verifies it by recomputing every hash it records (section 8).
- Reading a manifest whose `schemaVersion` is not 3 fails with a message pointing to
  `llm-docs migrate`.
- A manifest is read only from a regular `manifest.json` in a real pack directory, never
  through a symbolic link, and it must agree with its own recipe: `recipeHash` is the hash of
  `recipe`; `pack.title`, `pack.version`, and `dependency` equal the recipe's; there is one origin
  per recipe source, of the same type; every `sources[].source` names a recipe source. A manifest
  that fails any of these is invalid: `verify` fails `manifest-schema` and `sync` rebuilds.
- Every path a manifest records (`sources[].path`, `outputs[].path`, the paths inside
  `outputs[].sources`, `links.unresolved[].page`, a local origin's `path`) is a contained
  relative POSIX path: no empty, `.`, or `..` segment, no backslash, no control character.
  Output paths also fit their kind: pages under `pages/`, passthrough files under `files/`,
  `index.md`, and `<id>.full.md`. `guides/citations.lock.json` applies the same predicate
  (`isContainedRelativePath`) to its guide keys and citation targets.
- `fetch.finalUrl`, an `llms-txt` origin's `finalUrl`, and a git origin's `finalRepo` are
  stored redacted (`redactUrl`), since a redirect may lead to a presigned URL. URLs the recipe
  names are stored as written: the config refuses one that carries a credential (section 4.1).

## 4. Building a pack

### 4.1 Acquisition

All acquisition writes into a temporary working directory under the OS temp dir (a cache, never
an identity) that is removed afterwards, including on failure.

**Network policy (shared HTTP client, `src/sources/http.ts`):** `https:` only (plus `http:` to
loopback when `LLM_DOCS_ALLOW_PRIVATE_NETWORK=1`, which tests use). Before connecting, resolve
the hostname and reject every address in a block the IANA IPv4 and IPv6 Special-Purpose
Address Registries mark not globally reachable (private, loopback, link-local, CGNAT,
documentation, benchmarking, reserved, discard, and the rest), plus multicast, site-local, and
the IPv6 forms that carry an IPv4 address (IPv4-compatible, IPv4-translated, 6to4, Teredo, and
the local-use NAT64 prefix `64:ff9b:1::/48`), unless the same env flag is set. Two forms are
judged by the IPv4 address in their last 32 bits instead: an IPv4-mapped address and NAT64's
well-known prefix `64:ff9b::/96`, which is how a DNS64 resolver returns IPv4-only hosts on an
IPv6-only network (RFC 6052). One that carries a special IPv4 address is refused, naming it.
Every resolved address must pass. Pin the connection to the vetted address so DNS rebinding
cannot swap it. Follow at most 5 redirects,
re-applying the policy to each hop and recording the final URL. Timeouts: 15 s connect, 60 s
total per request. Per-response cap 20 MB (configurable per pack up to 200 MB with
`limits.maxFileBytes`), streamed and aborted when exceeded. Per-pack caps: 5,000 files and
500 MB total. Concurrency 4 per host. Retries: 2, only for network errors, 429, and 5xx, with
jittered backoff honoring `Retry-After` up to 30 s. User-Agent:
`llm-docs/<version> (+https://github.com/Zyepher/llm-docs-generator)`. A requested URL that
carries a credential (user info, or a parameter whose name looks like a token, key, signature,
password, session, or similar, as `urlCredentials` decides) is refused; a redirect may still
lead to one, since servers presign download URLs. The config schema applies the same
predicate to every URL-valued key, so `add` fails before writing `llm-docs.json`. Every URL in
a log line, error, warning, page provenance line, or `index.md` goes through `redactUrl`.
The engine sends no credentials, so a private repository or a page behind a login cannot be
fetched; copy such docs into the project and use a `local` source. `GITHUB_TOKEN` is sent only
to `api.github.com`, only when set, and only for release-date lookups.

**Git policy (`src/sources/git.ts`):** run git with `execFile`, never a shell. Environment:
every `GIT_*` variable from the parent is dropped except `GIT_SSL_CAINFO` and `GIT_SSL_CAPATH`
(TLS trust a corporate network needs), `SSH_ASKPASS` is removed, and `GIT_TERMINAL_PROMPT=0`,
`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL` pointed at an empty file, `GIT_LITERAL_PATHSPECS=1`,
`GIT_CEILING_DIRECTORIES` set to the work directory's parent (so no enclosing repository's config
applies), and `GCM_INTERACTIVE=never` are set. Config flags on every invocation:
`-c core.hooksPath=<empty dir>`, `-c core.symlinks=false`, `-c core.fsmonitor=false`,
`-c protocol.allow=never -c protocol.https.allow=always` (`protocol.file.allow=always` only for
`file://` repos), `-c http.followRedirects=false`, `-c credential.helper=` (no helper),
`-c transfer.fsckObjects=true`, `-c fetch.fsck.<id>=ignore` for the legacy ids git-config(1)
documents for old repositories (`badTimezone`, `badDate`, `badDateOverflow`, `zeroPaddedDate`,
`missingSpaceBeforeDate`, `zeroPaddedFilemode`), `-c submodule.recurse=false`,
`-c fetch.recurseSubmodules=false`. git applies no `fetch.fsck.<id>` to a filtered fetch, so a
fetch that fails only on one of those ids is redone without `--filter=blob:none`, where they
apply; every other fsck id stays an error.
A repository URL with a query or fragment is refused. Before git runs, an `https` repository's
discovery URL (`<repo>/info/refs?service=git-upload-pack`) is requested through the HTTP client,
which applies the address rules above to every redirect hop; when it redirects to another
repository URL, git runs against that URL, and the origin records it as `finalRepo` with a
warning; a redirect to anything else is an error. git resolves the host on its own, so its
connection is not pinned. Fetch strategy: `git ls-remote` first resolves the ref
kind (a tag wins over a branch of the same name; a 40-hex name is a commit only when no tag or
branch has it), then `git init --template=`, `git remote add origin <repo>`, `git fetch --depth
1 --filter=blob:none --no-tags --no-recurse-submodules origin <refspec>` (`refs/tags/<ref>`,
`refs/heads/<ref>`, or the commit), then a sparse, non-cone checkout of `paths` plus the license
files (4.10). Record the fetched commit. A symlink the recipe would take is an error naming it;
other symlinks are skipped with one warning; submodule entries are skipped with a warning; a
path escaping the checkout is an error. Ref names must be a 40-hex commit or a name that cannot
read as an option and follows git's ref rules. Timeout 10 minutes per git command. A missing
`git` binary is a clear error (exit 3).

### 4.2 Selecting files

A `local` source is enumerated with `walkBoundedDirectoryTree` (the shared walker), skipping
the directories in `SKIPPED_DIRECTORY_NAMES` and the packs directory; a local source inside the
packs directory is an error. A `git` source is listed with `git ls-tree` at the fetched commit
and has no skip list (exclude `node_modules` and similar with `exclude`). HTTP sources list the
files of their fetch plan. Default include for `git` and `local`:
`**/*.{md,mdx,markdown,rst,html,htm}` plus OpenAPI files detected by content (`openapi:` /
`swagger:` key in JSON or YAML) when listed by an explicit include. Files that an include
matched but no handler, converter, or passthrough glob takes are skipped and reported in one
warning with a count per extension; files no include matched are not reported. Output paths
are checked for collisions, of whole paths and of every directory on the way (under one key:
NFKC, then full Unicode case folding, then NFKC, because macOS and Windows file systems are
case-insensitive and APFS is normalization-insensitive; the key is deliberately coarser than
any one file system, so it may refuse a pair, such as `ﬀ` and `ff`, that some file system
keeps apart; `pathCollisionKey` in `src/utils/fs-path.ts`; again after rendering, for
OpenAPI tag pages, whose names the parser already makes unique under the same key; and for the
stored paths of `urls` entries and of `llms-txt` pages before anything is fetched), for
Windows-reserved names, for characters Windows forbids, and for segments ending in a dot or a
space; each is an error naming the files.

### 4.3 Converting to pages

Each selected file becomes exactly one page at `pages/<mount>/<path with its extension
replaced by .md>`, except OpenAPI (below). Every page starts with one provenance comment line:

```
<!-- llm-docs: vite@8.2.0 | source: https://github.com/vitejs/vite/blob/<commit>/docs/guide/index.md -->
```

(`source:` is the pinned blob URL for git sources on `github.com`, `<repo>@<commit>:<path>` for
other git remotes, the fetched URL for http sources, and the project-relative path for local
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
  blocks as a Markdown table for tabular data, else as fenced code in the block's own language
  (`text` when it has none). HTML pages drop navigation chrome as v2 does.
- **OpenAPI 3.x / Swagger 2.0**: one page per tag at `pages/<mount>/<spec path>/<tag slug>.md`
  plus `pages/<mount>/<spec path>/index.md` with info, servers, auth schemes, and the tag list,
  where `<spec path>` is the spec's source path without its extension. A tag whose slug is
  `index` gets `index-tag.md`. Operations render method, path, operation id, summary,
  description, deprecation, auth, parameters, request body, and responses with dereferenced
  schema shapes (existing parser output). Untagged operations go to `untagged.md`.
- **Converted documents**: see 4.6; the converter's Markdown output then goes through the
  Markdown path.

Headings are never renumbered. Page titles (for the index) come from the first H1, else the
frontmatter title, else the file name without its extension.

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
inline links, images, reference definitions, autolinks, and the URL attributes in raw HTML
(`href`, `src`, each `srcset` candidate, `action`, `formaction`, `poster`, `data`,
`xlink:href`). For each target:

1. Fragment-only (`#x`): unchanged. A target with a scheme other than `https`, `http`, or
   `mailto` (`file:`, `javascript:`, `data:`, `tel:`, app schemes) goes to step 5 with reason
   `disallowed-scheme`; the scheme is read as a browser reads it (case folded, character
   references and backslash escapes decoded, tabs and line breaks dropped, leading spaces and
   control characters skipped; a percent-encoded colon is not a scheme).
2. Relative path that resolves (after stripping a `.md`, `.mdx`, `.markdown`, `.html`, `.htm`,
   or `.rst` extension or a trailing `/index`, the same normalization v2 uses for extensionless
   routes) to another acquired page of the same pack: rewritten to the relative path from this
   page to that page, fragment kept.
3. Site-absolute (`/x/y`) or absolute URL on `site.baseUrl`'s origin: aliases applied first,
   then matched against the acquired pages' site paths. Aliases match on segment boundaries,
   with a trailing slash and a `.md`, `.mdx`, `.markdown`, `.html`, `.htm`, or `.rst` extension
   dropped from both the alias and the path before a page is looked up, so the alias
   `/guide/latest` also catches `/guide/latest.md`. Site path for an http-acquired page is
   its URL pathname; for a git or local page it is its source path with the extension and a
   trailing `index` removed, relative to the source root. A match rewrites to the relative page
   path; no match rewrites to the absolute URL `baseUrl + path` (the path as written). A
   site-absolute link in a pack without `site.baseUrl` goes to step 5. A link from a local
   source to a page that exists but was not selected goes to `baseUrl` plus its route.
4. Relative path inside a git source's repository but outside the pack: rewritten to a pinned
   blob URL at the recorded commit for GitHub remotes (existing `pinOutOfPackTarget` logic).
   For other hosts it goes to step 5.
5. Anything else: converted to plain text `[label] (unresolved: target)` and recorded in
   `links.unresolved` with a reason (`not-found`, `not-in-pack`, `outside-source`,
   `outside-repository`, `outside-pack-non-github-remote`, `site-absolute-without-base-url`,
   `malformed`, or `disallowed-scheme`). In raw HTML the attribute is renamed to
   `data-unresolved-<name>` (`data-unresolved-href`, `data-unresolved-src`, ...) instead.

`verify` fails on a relative link in a page or index that does not resolve on disk, and on a
link whose scheme is outside the same allowlist (`LIVE_SCHEMES`, read by the same `linkScheme`),
so a page edited after the build cannot carry one. The build never leaves either: a relative
target is rewritten to a pack page or an absolute upstream URL when it can be, and otherwise
made plain text by step 5. The manifest records two warnings with counts: one for links made
plain text because they did not resolve, and one for links made plain text because of their
scheme.

### 4.6 Converters

`convert` on a source: `{ "tool": "docling" | "markitdown" | "command" | "agent", "include":
[globs], "command": [argv], "timeoutSeconds": 300 }`. `include` defaults to
`**/*.{pdf,docx,pptx,epub,html,htm}` for docling and markitdown (xlsx converts only when listed
explicitly, because spreadsheets are passthrough by default) and is required for `command` and
`agent`. `command` is required for `command`, optional for docling and markitdown (without
`{input}` or `{output}` there), and not allowed for `agent`. `timeoutSeconds` is 1 to 3600,
default 300. A file matched by both `passthrough` and the converter's `include` is passthrough.

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
the tool name on `PATH` (on Windows also with `.exe`, `.cmd`, `.bat`, `.com`); a relative
`command[0]` resolves against the project root. The version is captured with `--version`
(first line, trimmed, 60 s timeout; for `command`, `command[0] --version`) and recorded; when
it cannot be read it is recorded as null with a warning, and those conversions are not cached.
Failure to resolve the tool is a runtime error (exit 3) naming the install command (`pipx
install docling`, `pipx install 'markitdown[all]'`). Inputs are copied under a sanitized name
into the temp working directory and passed as paths there; per-file timeout (the child is
killed); inputs over 200 MiB and outputs over 100 MiB are refused (every acquired file is also
under `limits.maxFileBytes` first); non-zero exit, empty output, a missing output file, or
output that is not UTF-8 is an error naming the file and the tool's stderr tail.
A Windows `.cmd`/`.bat` shim can only run through `cmd.exe`: its arguments are quoted, and an
argument containing `"`, `%`, or a line break is refused. Converter output is not assumed
deterministic: successful conversions are cached in `<cache dir>/conversions/<key>.md` (the
cache dir of 6.2), keyed by the sha256 of the input hash, tool, version, argv template, and a
cache format number, so an unchanged document is not reconverted when
its pack rebuilds for another reason; `refresh` reports changed pages caused by a converter
version change separately.

### 4.7 Passthrough files

Files matching `passthrough` globs are copied byte-identical to `files/<mount>/<path>` and
listed as `passthrough` outputs. Links from pages to passthrough files resolve normally.

### 4.8 `index.md`

Generated, deterministic, verified. Contents:

1. `# <title> <version>` and a provenance paragraph: the origins in plain words (repository and
   commit, linked for `github.com` repositories; the index URL; the number of listed URLs; or
   the project folder with the host repository commit and whether it had uncommitted changes),
   the acquisition date (`YYYY-MM-DD`), and the license line: the SPDX id and the file it was
   detected from, or the declared license, or a note that the license is proprietary or unknown
   and the terms should be checked before redistributing.
2. A short "How to read this pack" section: open the page for the API you need; search
   `pages/` for exact symbol names; pages are upstream text at the pinned version; guides, when
   the pack has any, are the digests in `guides/` and never outrank pages.
3. "Read first", only when `recipe.readFirst` is non-empty: one sentence ("Start with these
   pages before writing code against <Title> <version>. They were marked as the ones to read
   first for this version, usually because they describe what changed.") and one link per
   target in recipe order, labeled with the page title (the path for a passthrough file) and,
   for a target with a fragment, `: <heading text>`. Labels are escaped like page titles.
   When a library is newer than the model's training data, the page that says what changed is
   what keeps the agent from writing the API it remembers.
4. "Pages": grouped by top-level directory under `pages/` (in sorted order, with pages directly
   under `pages/` in a "Top level" group), one table per group with columns page link, title,
   approximate tokens.
5. "Files", only when the pack has passthrough outputs: one sentence saying these files are
   byte-identical copies of the upstream files, then one list line per file in path order with
   its link labeled by the path under `files/` and its size (`(<bytes> bytes)`). Over 20 files,
   the lines are grouped by top-level directory under `files/` as the pages are. A pack without
   passthrough outputs has no such section, so its index is unchanged. Passthrough files are often
   the most authoritative thing in a pack (a protocol's schema), and an agent reads the index to
   learn what the pack holds.

At sync every `readFirst` target must name a page or passthrough output of the pack being
built, and a fragment must be the slug of a heading on that Markdown file. An unresolved target
fails that pack's build as a config error (exit 2) naming the target, why it did not resolve,
up to five nearest output paths or heading slugs, and the fix (edit `packs.<id>.readFirst`);
the previous pack stays in place. The links verify under `--strict`, fragments included.

The index never enumerates guides. It is a function of the manifest and, for read-first
headings, the pages the manifest lists, so adding,
editing, removing, or stamping a guide changes neither `index.md`, the combined file, nor
`manifest.json`, and `sync` never re-acquires a source for one. What a guide change does
change is the managed block's `guides` topic (7.1), which `sync` rewrites without acquiring
anything and which `sync --check` and `verify agent-block` report until then.

Titles from upstream are escaped for Markdown tables: control characters and line breaks
become spaces and whitespace collapses, backticks are removed, `\`, `|`, `[`, `]`, `<`, and `>`
are backslash-escaped, and the result is capped at 120 characters (117 plus `...`).

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
GPL/LGPL/AGPL/MPL/CC-BY-SA are `copyleft`; nothing found, or an id outside these lists, is
`unknown`; a declared `proprietary` is `proprietary`. SPDX expressions are evaluated: `OR`
takes the most permissive choice, `AND` the most restrictive term, and `-only`, `-or-later`,
and `WITH` exceptions keep the base status. An `SPDX-License-Identifier:` line wins over
fingerprints. When several license files are found, one at a taken path outranks the
repository root, a file whose name mentions docs outranks its siblings, and `LICENSE` outranks
`COPYING`; files that disagree are a warning. License files over 1 MiB or that are symlinks are
skipped. `sync` prints a warning for `unknown` and `proprietary` (in its output, not in
`manifest.warnings`); `verify --strict` fails on them. A declared license is recorded alongside
the detected one and wins for status; a mismatch is a manifest warning.

## 5. Commands

Exit codes everywhere: 0 success, 1 a check failed (verify, `--check` modes), 2 usage or config
error, 3 runtime failure (network, git, converter, I/O, a held lock); when one run has both, 3
wins. An invalid `llm-docs.json` under `verify` is a failing `config-schema` check, so exit 1.
`init`, `add`, `sync`, `refresh`, `verify`, `status`, `guides stamp`, and `migrate` accept
`--project <dir>`; `discover`, `capabilities`, and `hook session-start` read no project and do
not. `--json` puts machine output on stdout and human output on stderr, never mixed. Under
`--json`, a command that runs prints exactly one JSON document on stdout, even when it reports a
failed pack or check; a command that cannot run prints nothing on stdout and its error on
stderr, with the exit code naming the class. Three commands write to stdout without `--json`
by design: `discover` always prints JSON (its `--json` is accepted and changes nothing),
`status --brief` prints the note (`--brief` and `--json` together are a usage error), and
`capabilities` without `--json` prints its command list. A hint in a message that names a
command carries `--project <dir>` when the user passed it. The CLI prints no color.
`LLM_DOCS_DEBUG=1` adds stack traces to errors.

- `llm-docs init [--packs-dir <dir>]`: create `llm-docs.json` and `packsDir` with its
  `.gitignore`; write the managed blocks per 7.1 (empty until a pack is built, the full block on
  a project that has packs). Idempotent; never overwrites config.
- `llm-docs add <id> (--git <repo> --ref <ref> [--path <p>]... | --url <u>... | --urls-file
  <f> | --llms-txt <u> --include <glob>... [--strip-prefix <prefix>] | --local <path>)
  [--include <glob>]... [--dependency <eco>:<name>] [--covers <eco>:<name>]... [--version <v>]
  [--mount <m>] [--title <t>]
  [--convert docling|markitdown|agent] [--convert-include <glob>...] [--site <baseUrl>]
  [--alias <from>=<to>]... [--license <license>]
  [--recipe <json>] [--read-first <target>]... [--replace] [--dry-run]`: write the recipe into
  config (creating config if absent), then `sync <id>`. `--version` or `--dependency` is
  required. `--include` applies to every source type (file paths, or URL paths for
  `--llms-txt`). `--recipe` adds source fields as JSON, a `command` converter among them, and
  can name the whole source by itself. `--license` writes the pack's declared `license`, and
  each `--alias` (which needs `--site`) one `site.aliases` entry; both are validated by the
  config schema and shown by `--dry-run`. Refuses to overwrite an existing id unless `--replace`.
  When the build rejects the recipe as a config error (exit 2, an unresolved read-first target
  among them), `llm-docs.json` is put back as it was; after a runtime failure (exit 3) the
  recipe stays so that `sync <id>` can retry. `--dry-run` prints the recipe and the file list
  that would be acquired, writing nothing, and says for each `--read-first` target whether a
  file the recipe takes lands at its path; a heading fragment can only be checked once pages
  are built, and the output says so.
- `llm-docs sync [ids...] [--check] [--offline] [--prune]`: bring packs in line with config
  and lockfiles. Skips a pack when its manifest's `recipeHash` matches and its files pass the
  `outputs` and `unlisted-files` checks; `local` sources are read again on every sync, and a
  changed local file rebuilds the pack. Each stale pack carries a `reason` code (`not-built`,
  `manifest-unreadable`, `recipe-edited`, `lockfile-moved`, `files-differ`, `sources-changed`;
  `refresh` adds `upstream-changed` and `converter-changed`) and a `detail` naming the versions
  or files involved. After a rebuild it prints the guides whose cited sections changed or no
  longer resolve (8), with the `guides stamp` command to run once they are re-reviewed.
  `--check`: write nothing, exit 1 if any pack, orphan, or managed block would change (CI gate;
  takes no lock). `--offline`: a pack that needs a rebuild from a network source fails (exit 2)
  rather than acquire. `--prune`: delete pack directories not in config (without it, they are
  reported); it keeps a directory without `manifest.json` and a pack that holds guides, and
  handles orphans only when no ids are given. Always updates managed blocks last.
- `llm-docs refresh [ids...] [--check]`: re-acquire each pack at its recorded recipe and
  report per page: unchanged, changed, added, removed; for git, whether the ref now resolves to
  a different commit; and converted pages whose converter version changed. Writes the new pack
  unless `--check`. A pack that was never built, or whose recipe changed since the last sync,
  is refused (exit 2). `--check` lists the guides whose cited pages changed upstream, at page
  level, since sections can only be compared once rebuilt.
- `llm-docs verify [ids...] [--strict]`: run every check in 5.1. Read-only, offline.
- `llm-docs status [--model <id>] [--cutoff <YYYY-MM>] [--offline] [--brief]`: section 6.
- `llm-docs guides stamp <id> [guide...]`: section 8.
- `llm-docs migrate <v2-pack-dir> --version <version> [--id <id>]`: section 9.
- `llm-docs discover --url <site> | --package <eco>:<name>[@<version>]`: section 10.
- `llm-docs hook session-start`: section 7.2. Undocumented in `--help` output except as
  "used by the plugin".
- `llm-docs capabilities --json`: machine-readable name, version, commands (with summary,
  status, options, and help examples), checks, exit codes, the status and reason codes `--json`
  reports carry, source types, converters with install commands, ecosystems, transforms, and
  limits, generated from the same tables the code uses (never a hand-maintained list that can
  drift).

Removed in v3 with a one-line error (exit 2) pointing to the replacement when invoked:
`generate` (use `add`), `validate` and `list-sdks` (add the SDK's docs with `add`),
`source-truth` and `verify-docs` (no replacement), `plugins` (a `command` converter), `agent`
(the plugin).

### 5.1 `verify` checks

Per pack, each a named check with pass, fail, warn, info, or skipped (when `manifest-schema`
fails, the other pack checks are skipped):

| Check | Fails when |
|---|---|
| `manifest-schema` | manifest missing, unparsable, not a regular file, not schema v3, for another pack id, inconsistent with its own recipe (`recipeHash`, `pack.title`, `pack.version`, `dependency`, origins, source indexes), or recording a path that is not a contained relative POSIX path under the directory its kind allows; a pack directory or `manifest.json` that is a symbolic link is never read |
| `outputs` | a listed output is missing or its hash differs |
| `unlisted-files` | a file in the pack is not listed, the pack holds a symlink or is one, or the walk could not examine part of it (depth, entry count, or an unreadable directory, named where it stopped) (`guides/**` and OS junk, `.DS_Store`, `Thumbs.db`, `desktop.ini`, are reported as info). Every file verify opens resolves inside the pack directory with no link on the way; an I/O error on one file is a failing finding for that file, and every other check still runs |
| `links` | a link in a page, index, or combined file has a scheme outside `LIVE_SCHEMES` (`https`, `http`, `mailto`), or a relative link does not resolve inside the pack, or is site-absolute. Fragments are checked only in `--strict`, and never into `guides/`: a fragment matches the target's heading slugs and HTML ids exactly, or once both sides drop punctuation and case (site generators keep other punctuation than GitHub's rule, so Mintlify's `#$ref-resolution` names the heading `` `$ref` Resolution ``). A fragment in a page that still matches nothing is a warning, because the link is upstream text the user cannot change and its target page exists; one in the index or combined file, which the build writes, fails |
| `recipe` | the config recipe for this id, resolved at the version the manifest records, has a different `recipeHash` (the config was edited) or cannot be resolved (warn when the config has no such pack: orphan); a lockfile that moved while the config stayed the same passes here, since `lockfile` reports it: one cause, one finding |
| `lockfile` | `dependency` is set and the lockfile version differs from `pack.version`, no lockfile resolves it, or the lockfiles install it only from another registry while the recipe sets no `version`; when lockfiles disagree, warn if one matches and fail otherwise. A `covers` entry never fails it: warn when the lockfiles resolve it to a version whose major (the leading `<number>.`) differs from `pack.version`'s, since the pack may not describe that package's version (no finer comparison: a family's packages do not always share versions) |
| `citations` | a guide citation does not resolve, its cited section hash changed since stamping, or the lock is invalid; an unstamped guide, a guide edited after stamping, or a lock entry for a deleted guide is a warning |
| `conversion` | an `agent` conversion's original changed since the last sync (warn when a local original no longer exists) |
| `license` | warn for `unknown` and `proprietary`; fail under `--strict` |

Plus project-level checks: `config-schema` (verify stops after it fails), and `agent-block`
(each managed block matches what `sync` would write; an agent file that does not exist yet is a
warning, so a project that gitignores it can still run `verify` in CI). Output lists one line
per problem with the pack id, check name, and path.

## 6. Dependencies, release dates, and model cutoffs

### 6.1 Lockfile scanning (`src/deps/`)

`scanDependencies(projectRoot)` walks the project with the shared walker (max depth 6, at most
200,000 entries, skip `node_modules`, `.git`, build, vendor, virtualenv, and tool cache dirs,
and `packsDir`), finds lockfiles, and returns resolved dependencies. Directories below the
depth limit are named in one warning. A lockfile larger than `maxLockfileBytes` (64 MiB for
commands; 4 MiB for the hook, whose deadline cannot interrupt a synchronous parse) is skipped
with a warning naming it and its size. The hook's deadline can stop the scan early, with a
warning. Every lockfile, and every file read beside one (`package.json`, `.npmrc`,
`.yarnrc.yml`, `pyproject.toml`, `Cargo.toml`, `go.work`, `go.mod`, `Package.swift`, and the
rest), is read only when it is a regular file (`readRegularFile`), so a named pipe can never
block the scan or the hook. A lockfile that is not one, or whose neighbor is not one, is
skipped with a warning naming the file. A lockfile skipped in any of these ways is listed in
`unread`, and a lookup in its ecosystem answers `unread` rather than guessing from the other
lockfiles. Every entry a parser returns
must have a version that is one line of printable characters without whitespace, at most 128
characters, and a name that follows its registry's rule; any other entry is skipped with a
warning naming the lockfile and the package:

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
  unread: UnreadLockfile[]
  otherRegistry: { ecosystem: Ecosystem; name: string; lockfile: string }[]
  warnings: string[]
}
```

Supported inputs and how directness is decided:

| Ecosystem | Lockfiles | Direct deps from |
|---|---|---|
| npm | `package-lock.json` (v1, v2, v3), `npm-shrinkwrap.json`, `pnpm-lock.yaml` (v6 to v9), `yarn.lock` (classic and berry), `bun.lock` (text) | `package-lock.json` v2 and v3: the lockfile's root and workspace package entries; other formats: `package.json` `dependencies`, `devDependencies`, `optionalDependencies`, `peerDependencies` of the same directory (and workspace packages listed in the lockfile) |
| pypi | `uv.lock`, `poetry.lock`, `pdm.lock`, `Pipfile.lock`, `requirements*.txt` with `==` pins | `pyproject.toml` (`project.dependencies`, optional groups, `tool.poetry.dependencies`), `Pipfile`; requirements pins are direct |
| cargo | `Cargo.lock` | each workspace member's `dependencies` list in `Cargo.lock`; `Cargo.toml` names the members and marks `[dev-dependencies]` |
| go | `go.mod` (`require` lines; `// indirect` marks indirect) | same |
| pub | `pubspec.lock` | its own `dependency: direct main / direct dev` field |
| swiftpm | `Package.resolved` (v1, v2, v3) | `Package.swift` `.package(url:` entries when parsable; otherwise all pins are treated as direct with a warning |

Non-registry dependencies (git, path, workspace, `file:`, npm aliases to other names, `link:`,
URLs, alternate registries, Go modules replaced by a `replace` directive, and SwiftPM pins with
only a revision) are skipped with one aggregated warning. A dependency is from an alternate
registry when the source its lockfile records is not the ecosystem's public registry
(`registry.npmjs.org` and its yarn and npmmirror mirrors; `pypi.org` and
`files.pythonhosted.org`; crates.io; pub.dev), or, for an npm entry that records no URL, when
the project's `.npmrc` (`.yarnrc.yml` for yarn berry), read as data, sends its scope or the
default elsewhere. A dependency with no recorded source is taken as the public registry's.
An alternate-registry dependency is kept in `otherRegistry`, never in `dependencies`, so no
release date is ever looked up for it: the public registry's date for a package of the same
name says nothing about a private one. A lookup that finds a dependency only there answers
`other-registry` rather than `missing`; `sync` then asks for an explicit `version`, and
`status` reports the `other-registry` state (6.4). `bun.lockb` (binary) is reported as unsupported.
Name normalization: PyPI names are PEP 503 normalized; others exact. Parsers never execute
project code. TOML is parsed with `smol-toml`.

### 6.2 Release dates

`lookupReleaseDates(deps, { offline, budgetMs })` returns publish timestamps, cached in the user
cache directory (`LLM_DOCS_CACHE_DIR`, else `$XDG_CACHE_HOME/llm-docs`, else
`~/Library/Caches/llm-docs` on macOS, `%LOCALAPPDATA%\llm-docs\Cache` on Windows,
`~/.cache/llm-docs` elsewhere) in `release-dates.json`. Positive entries never expire (a
version's publish date is immutable); negative entries expire after 24 hours. Writes are
atomic and merged with what is on disk; a corrupt cache file is discarded with a warning.
Transport errors, budget timeouts, and unsupported lookups (SwiftPM outside GitHub) are not
cached. Lookups run 4 at a time with a 5 s timeout each.

| Ecosystem | Source |
|---|---|
| npm | `https://api.deps.dev/v3/systems/npm/packages/<name>/versions/<version>` `publishedAt`; fallback: registry packument `time[<version>]` with a 25 MB cap |
| pypi | `https://pypi.org/pypi/<name>/<version>/json`, earliest `urls[].upload_time_iso_8601` |
| cargo | `https://crates.io/api/v1/crates/<name>/<version>` `version.created_at` |
| go | `https://proxy.golang.org/<escaped module>/@v/<version>.info` `Time` |
| pub | `https://pub.dev/api/packages/<name>` `versions[].published` |
| swiftpm | GitHub repositories only: the commit date of the tag (as written, then with a `v` prefix; annotated tags dereferenced) via `api.github.com` (uses `GITHUB_TOKEN` when set); others unknown |

`budgetMs` bounds total wall time; unfinished lookups return `null` and are retried next time.
Only the hook passes a budget; `status` waits for every lookup.

### 6.3 Model cutoffs

`data/model-cutoffs.json` ships with the package: an object with `schemaVersion`, an ordered
`models` list of `{ "pattern": regex over the normalized model id, "label": "Claude Opus 5.5",
"cutoff": "2026-06", "source": "<url>" }`, and `claudeCodeAliases`, the model each Claude Code
alias selects per provider (7.2). Normalization lowercases, strips bracketed suffixes like
`[1m]` and parenthesized ones like `(fast mode)`, strips provider and region prefixes
(`us.anthropic.`, `eu.`, `global.`, `anthropic/`, `bedrock/`, `vertex_ai/`, `models/`, and
similar), and strips Bedrock `-v1:0` suffixes and snapshot dates (`-20250929`, `@20250929`,
`-2025-04-14`). Only entries backed by a published source are included; the source URL is
recorded per entry. Resolution order: `--cutoff`, config `model.cutoff`,
`LLM_DOCS_MODEL_CUTOFF`, the table match for `--model` or the hook's model id. Each of the first
three must be `YYYY-MM`; a malformed one is an error (exit 2 in `status`, where a person can fix
it), while the hook logs it and goes on with the next source (7.2). No match means no cutoff and
the after-cutoff analysis is skipped (never guessed).

When a vendor gives two dates for one model (Anthropic's reliable knowledge cutoff and training
data cutoff; a Google model card's general date and an earlier date some domains stop at), the
entry uses the earlier one. The table also maps each Claude Code alias (`opus`, `sonnet`,
`haiku`, `fable`, `best`, `opusplan` as its execution model) to a model per provider, the
provider being chosen by the `CLAUDE_CODE_USE_*` variables in Claude Code's order.

Maintenance: refresh the table whenever a vendor ships a model, and at least every 90 days
(`npm run check:plugin` prints a warning, never a failure, once `reviewed` is older). Read the
cutoff from each source page as it stands that day, keep a more specific pattern before a less
specific one, set `reviewed` to the day you checked, add a test case for each new id form, and
run `npm run build:plugin` (the table ships inside the bundle). A model whose vendor publishes
no cutoff stays out. Sources: Anthropic's models overview, per-model overview pages, and model
deprecations (`platform.claude.com/docs/en/models/...`), and the Claude Code model
configuration page with its provider pages (`code.claude.com/docs/en/model-config`); OpenAI's
model pages (`developers.openai.com/api/docs/models/<id>`); Google's Agent Platform model pages
and DeepMind model cards (`docs.cloud.google.com/gemini-enterprise-agent-platform/models`,
`deepmind.google/models/model-cards`) and AI Studio model pages; xAI's model pages
(`docs.x.ai/developers/models`).

### 6.4 `status`

Joins the dependency scan, the packs, release dates, and the cutoff:

- Packs: id, version, dependency, state (`ok`; `unusable` when `sync` would refuse the pack
  as it is, such as a pack directory or `guides/` that is a symbolic link, with the refusal's
  first sentence as the next step; `missing` when configured but never synced or its manifest
  cannot be read; `stale-pack` when the lockfile moved or lockfiles disagree with none
  matching; `lockfile-conflict` when the lockfiles disagree and one matches;
  `not-in-lockfile` when no lockfile resolves the bound dependency; `other-registry` when the
  lockfiles install it only from another registry and the recipe sets no `version`;
  `lockfile-unread` when a lockfile of its ecosystem was skipped (too large, not a regular
  file, or past the hook's deadline), so its version is unknown; these win over the rest;
  `recipe-changed`; `sources-changed` when a `local` source's files changed; `pack-changed`
  when the pack's files no longer match its manifest; `orphan`), the release date of
  the pack's version of its bound dependency and whether it falls after or near the cutoff,
  the built pack's read-first targets (4.8) as project-relative paths (the full list in
  `--json`, a count in the human table), and the step that brings the pack back to `ok`
  (`llm-docs sync <id>`; for a stale pack whose config pins `version`, editing that version
  first; for an orphan, `sync --prune` or adding it back to config). Each package the pack
  `covers` (2.2) that the lockfiles resolve, at each resolved version, with its lockfiles,
  release date, window, and whether its major version differs from the pack's (`covered` in
  `--json`; a line under the pack's row in the human table, with a note when the major differs).
- The states after the lockfile ones come from `packOfflineStaleness` in
  `src/pack/build.ts`, the decision `sync --check` makes without the network (acquire the
  sources that need no network, then compare the recipe, the lockfiles, the pack's own files,
  and the local sources), so `status` never calls a pack `ok` that `sync --check` would
  rebuild or refuse for a reason it can see offline. An upstream change needs the network:
  `status` never reports one, and `refresh --check` is the command that asks. A pack that is
  `pack-changed` or `unusable` is never offered as pinned docs in the note.
- Direct dependencies released after the cutoff, or within `nearCutoffDays` before it, that
  have no pack bound to that name or covering it, at any version: name, version, release date,
  and a suggested next step (`llm-docs discover --package <eco>:<name>@<version>`, the evidence
  for writing a recipe; for SwiftPM the repository URL is the name, unless it carries a
  credential, when the package name is used). With no cutoff, the direct
  dependencies released in the last 180 days instead, as the hook does.
- Without `--model`, the model id comes from `ANTHROPIC_MODEL` and the Claude Code settings
  files, as in the hook (7.2). The report names the model and where its id came from (`--model`,
  `ANTHROPIC_MODEL`, or a settings file, named by path), and marks a cutoff reached through a
  settings-file default as assumed, in the human table and in `--json` (`model` and
  `cutoff.assumed`).
- Works in a directory with no `llm-docs.json` (dependency analysis only). Without
  `--project`, it finds the project as the hook does from its `cwd` (the nearest ancestor of the
  working directory holding `llm-docs.json`, else the working directory), so `status --brief` run
  there prints what a session there is told. `--project <dir>` is the project root as given, as
  on every other command: with no `llm-docs.json` in `<dir>`, the dependency analysis runs for
  `<dir>`. `--cutoff` must be `YYYY-MM` (exit 2 otherwise).
- `--brief`: the text the hook injects (7.2) for the harness detected from the environment,
  on stdout, and nothing when there is nothing to say. It takes precedence over `--json` and
  prints even when the hook is turned off. `--json`: the full structure.

## 7. Agent integration

### 7.1 Managed block

Written by `sync` and `init` into each agent file. `agentFiles: "auto"` means: `AGENTS.md` if
it exists; `CLAUDE.md` if it exists and does not contain an `@AGENTS.md` import line (Claude
Code reads AGENTS.md only when no CLAUDE.md exists, unless imported); if neither qualifies,
create `AGENTS.md` (which includes a `CLAUDE.md` that imports a not-yet-existing
`AGENTS.md`). Agent files are written through their real path, so a symlinked
`CLAUDE.md -> AGENTS.md` is one file written once; a link that leads outside the project is an
error naming the link. Markers:

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

- Vite 8.2.0: `agent-docs/vite/index.md` (api, config, guide, plugins). Build tool and dev server
- MCP spec 2026-07-28: `agent-docs/mcp/index.md` (docs, specification, files, guides)
```

Packs appear in `llm-docs.json` order. The parenthesized topics are the pack's top-level page
directories (sorted by code unit), then `files` when the pack has passthrough outputs and
`guides` when it has guides, followed by `. <description>`
when the pack has one. Over budget (measured in UTF-8 bytes, markers included), topics and descriptions drop
first, from the last pack backwards; if even the bare lines exceed the budget the block lists
the first packs and ends with `- ...and N more: see agent-docs/`. Upstream-derived text
(titles, versions, descriptions, directory names) is escaped: control characters become
spaces, Unicode format characters (zero-width and bidirectional controls) and backticks are
removed, `@` is removed (Claude Code expands `@path` in `CLAUDE.md`), `<`/`>` become `&lt;` and
`&gt;`, whitespace collapses to a single line, and the result is capped at 80 code points (77
plus `...`). The session note (7.2) escapes more lightly, since it is no agent file: it keeps
`@`, because nothing expands `@path` in injected context. Blocks
are inserted at the end of the file when absent, with one blank line before. The block uses
`\r\n` when every line feed outside it is part of a `\r\n` (judged by the whole file when
there is no line feed outside the block), else `\n`; bare `\r` line endings are kept as they
are, and one sync reaches a fixed point for every style. Text outside the markers is never touched: agent files are read as bytes and
decoded strictly, a byte order mark is kept, and a file that is not valid UTF-8 is an error
(exit 2), never rewritten. Marker lines inside fenced or indented code are not markers. A file
with mismatched markers is an error, never a guess; any `<!-- BEGIN llm-docs ... -->` line
counts as a begin marker, and writing always uses the exact text above. A block that would land
inside an unclosed code fence at the end of the file, a `block.maxBytes` too small for even the
heading and the `...and N more` line, an agent file that is not a regular file (a directory, a
named pipe, a socket, or a device: it is never opened), a read-only agent file (the user's
protection is kept), an agent file with other hard links (replacing it would leave them on the
old text), a symlinked agent file whose target is missing, and an agent file whose real path is
inside `.git` (or `.hg`, `.svn`), inside the packs directory, or is `llm-docs.json` or a
lockfile are errors too: an agent file must be a regular file outside tool-owned and VCS-owned
locations. A rewritten agent file keeps its permission bits. A problem with one agent file is reported for that
file and never stops the others or loses the sync's pack report.

### 7.2 Session-start hook

`llm-docs hook session-start` reads the hook payload from stdin (1 s read budget) and prints
context for the agent. Behavior:

- Harness detection: `CURSOR_VERSION` or `CURSOR_PLUGIN_ROOT` set means Cursor, which gets
  `{"additional_context": "..."}`; otherwise Claude Code and Codex shape
  `{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "..."}}`.
  `CLAUDECODE=1` identifies Claude Code; anything else (Codex included) is an unknown harness.
- Project: `cwd` from the payload, else `CLAUDE_PROJECT_DIR`, else Cursor `workspace_roots[0]`,
  else the process cwd; then project discovery (2.1). With no `llm-docs.json`, the hook still
  runs the dependency analysis (so it is useful before a project adopts packs). A payload that
  is malformed, over 1 MiB, or still arriving when the read budget ends is logged and ignored,
  and these fallbacks apply.
- Model: payload `model` (Claude Code sends it only in some sessions; headless `-p` runs omit
  it), Cursor `model_id`/`model`, Codex `model`; then `ANTHROPIC_MODEL`; then `model` from
  `<project>/.claude/settings.local.json`, `<project>/.claude/settings.json`,
  `~/.claude/settings.json`, each read asynchronously and only when it is a regular file (one
  that is not is skipped and logged, so a named pipe cannot block the hook past its deadline).
  The payload's `model` wins over `model_id`, and a `{ "id": ... }`
  object is accepted. Claude Code aliases (`opus`, `sonnet`, `haiku`, `fable`, `best`,
  `opusplan`, with optional `[1m]`-style suffixes) resolve through the cutoff table's
  `claudeCodeAliases` to the model the alias currently selects, per provider
  (`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY` select the
  provider's table); a pin variable such as `ANTHROPIC_DEFAULT_OPUS_MODEL` wins, and `default`
  is deliberately left unresolved. The model id carries its provenance as a typed value beside
  it: reported by the payload, set in the environment (`ANTHROPIC_MODEL`), or read from a
  settings file. A settings file holds only the user's or project's default, which a session
  started with `--model` overrides without telling the hook (measured on 2026-11-22: headless
  `claude -p --model ...` sends no `model` and sets no `ANTHROPIC_MODEL`), so a cutoff reached
  through it is an assumption, not a fact. Each heading that names such a cutoff states the
  assumption instead of asserting it ("Assuming your model is the configured default (Claude
  Opus 5.5, cutoff 2026-06): ..."), and the first one adds that a different model should judge by
  the release dates shown. A payload or environment model, and a cutoff set by `--cutoff`,
  `model.cutoff`, or `LLM_DOCS_MODEL_CUTOFF`, keep the assertive wording. Cutoff resolution per
  6.3. When no cutoff resolves, the hook lists direct dependencies
  without a pack released in the last 180 days under a neutral heading ("Recently released
  dependencies (your training data may predate them)"): a fact from release dates, not a guess
  about the model.
- Content (at most 2,000 characters; nothing at all when there is nothing to say):
  1. Packs to fix (any state but `ok`, `lockfile-unread`, and `orphan` in 6.4: the lockfile
     moved, no lockfile resolves the bound dependency, the lockfiles install it from another
     registry, the lockfiles disagree on it, the recipe changed, its local sources changed, its
     files no longer match its manifest, sync would refuse it as it is, or never built), each
     with its fix from `status`. A pack whose files no longer match its manifest, or that sync
     would refuse, is never listed in item 2. A dependency name is printed exactly, as a code span (`` `@types/node` ``).
     Every value from a lockfile, a manifest, a registry, or config passes through one escape
     where it is placed (one line, no backtick, `<` and `>` as `&lt;` and `&gt;`), here and in
     the human `status` report. A `lockfile-unread` pack gets no row: the note says nothing
     about a lockfile it did not read, and the warm-up `status` run, which reads lockfiles up
     to 64 MiB, is started for it.
  2. Built packs whose library version (the pack's version of its bound dependency), or any
     package it `covers` at the version the lockfiles resolve, was released after the model's
     training cutoff or within the near-cutoff window, most recent first, one line per pack with
     the title, version, the most recent of those release dates, whether it is after or near
     the cutoff, and the index path, under a heading that tells the agent its memory of these
     libraries predates these versions and that it must read the pinned pages before writing
     code against them. This is what a fully adopted project is told at every session start.
     When the pack has read-first pages (4.8) the line names them before the index:
     ``- Hono 4.13.16 (released 2026-11-01, after cutoff): read `agent-docs/hono/pages/guide/migration.md` first, then `agent-docs/hono/index.md` ``.
     At most two paths, the first two in recipe order with fragments dropped and repeats
     merged; the index links the rest. A path that the 7.1 escaping would alter is left out
     rather than shown altered.
  3. Direct dependencies newer than the model's training cutoff (or within the near-cutoff
     window) without a pack (a package a pack `covers` has one), most recent first, at most 8, with their release dates, and the
     suggestion to read their docs or create a pack with the `add-docs` skill.
  4. When packs exist and the managed block is missing from the agent file the harness reads,
     the pack list itself (so the hook covers projects that gitignore AGENTS.md). Codex and
     Cursor read `AGENTS.md`. Claude Code reads the project's `CLAUDE.md` and
     `CLAUDE.local.md`, and reads `AGENTS.md` only when no `CLAUDE.md` or `CLAUDE.local.md`
     exists in the project root or any directory above it, unless one of the project's own
     files imports `@AGENTS.md`; so an ancestor `CLAUDE.md` hides the block in `AGENTS.md`,
     and the hook injects the list instead (the `agentFiles: "auto"` writing rule in 7.1 is
     unchanged). A harness the hook cannot identify is assumed not to see the block.

  Over the budget, text goes from the bottom up: item 4 first, then the rows of the lowest
  remaining item from its last row, and a cut list ends with how many more there are and
  `llm-docs status`. In item 2 the read-first paths go before any row does, from the last row
  up. Items 2 and 3 use the neutral wording and the 180-day window when no
  cutoff resolves. `llm-docs status --brief` prints the same text.
- Performance: total wall time under 1.5 s, counted from process start. Release dates come from
  the cache; missing entries get at most a 1,000 ms network budget, and anything still missing
  (over budget or after a transport error) is fetched by a detached background
  `status --project <root> --json` process, started after the note is written, at most one per
  project per 6 hours, tracked by a marker file in `<cache dir>/hook-warm/`, so the next session
  has it. The stdin read gets at most 1,000 ms, and 150 ms are reserved at the end of the
  deadline for rendering and writing. The per-pack offline check of 6.4 gets 400 ms (about a
  thousand local pages, measured); a pack whose check does not finish is judged by its manifest
  and the lockfiles alone, and the hook logs it. The lockfile scan and the lookups stop when the deadline
  nears. A run that misses the deadline prints nothing.
- Failure policy: always exit 0. Errors go to `<cache dir>/hook.log` (rotated at 1 MB, one
  previous file kept), never to stdout or stderr. The log is only appended to a regular file
  with one link, and the warm-up marker only written in a real `hook-warm/` directory. An agent
  file that is not a regular file counts as absent for the block-visibility check, and is logged. An invalid `llm-docs.json`, one that is not a regular file, and one that another user owns or that sits in a directory another user owns (2.1) is logged and ignored, and the
  hook continues with the dependency analysis only. The hook never reads a file it did not
  create with a synchronous call, and never opens one at a fixed name except through
  `readRegularFile`. A malformed `LLM_DOCS_MODEL_CUTOFF` costs the
  override, not the note: it is logged, that source is ignored, and cutoff resolution goes on
  with the next source, ending at the neutral heading when none resolves. (A malformed
  `model.cutoff` makes `llm-docs.json` invalid, so the rule above applies to it.)
  `LLM_DOCS_HOOK=off` or config `hook.enabled: false` disables output.

### 7.3 Plugin (`plugin/`)

One tree serving Claude Code and Cursor (Codex support is unverified; see below):

```
plugin/
  .claude-plugin/plugin.json      name "llm-docs", version = package version
  .cursor-plugin/plugin.json      name "llm-docs", skills, agents, hooks: "./hooks/cursor-hooks.json"
  hooks/hooks.json                Claude Code format: SessionStart, matcher startup|resume|clear|compact|fork, timeout 5 -> node "${CLAUDE_PLUGIN_ROOT}/bin/llm-docs.mjs" hook session-start
  hooks/cursor-hooks.json         Cursor format: {"version":1,"hooks":{"sessionStart":[{"command":"node ./bin/llm-docs.mjs hook session-start","timeout":5}]}}
  bin/llm-docs                    POSIX sh wrapper (exec node "$(dirname "$0")/llm-docs.mjs" "$@")
  bin/llm-docs.cmd                Windows wrapper
  bin/llm-docs.mjs                the whole CLI bundled into one file (generated, committed)
  THIRD_PARTY_NOTICES.md          license notices of the packages bundled into it (generated, committed)
  skills/add-docs/SKILL.md        planner playbook: decide source and version, write the recipe, sync, verify
  skills/write-docs-guide/SKILL.md  write a digest, fact-check it with the agent, stamp citations
  skills/llm-docs/SKILL.md        command reference and when to use which command
  agents/docs-fact-checker.md     checks every claim in a guide against the cited pages
  README.md
```

Root `.claude-plugin/marketplace.json` lists the plugin at `./plugin` and
`.cursor-plugin/marketplace.json` at `plugin` (Cursor's documented form: a bare relative
directory). Cursor documents `${CURSOR_PLUGIN_ROOT}` as an environment variable and runs plugin
hooks from the plugin's install directory, but documents no substitution in hook commands, so
the Cursor hook uses a path relative to the plugin root, which also works in shells that do not
expand `${...}`. In Claude Code the matcher lists every session source because each of them
starts a context without the earlier note. `npm run build:plugin` regenerates
`bin/llm-docs.mjs` (tsdown, all dependencies bundled, minified ESM, Node 22 target,
byte-identical across builds, and refused if a machine-specific path appears in it), writes
`THIRD_PARTY_NOTICES.md` from the `package.json` and license files of every package the bundle's
module graph pulls code from (refusing a package with no license file or a license outside a
permissive allowlist: MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, 0BSD, BlueOak-1.0.0), and
stamps plugin and marketplace versions from `package.json`; `npm run check:plugin` fails CI when
the committed bundle, notices, or versions are out of date, when a skill folder or agent file name differs
from its frontmatter `name`, when a description is over 1024 characters, when the skills, the
agent, or the plugin README name (in code) a command or flag that `capabilities --json` does
not list, or when the `llm-docs` skill does not name every command or its `Check` table does
not list exactly the verify checks. It also fails when a file under `plugin/` or `docs/` tells
anyone to get the CLI from a package registry (an `npx` run of the package, an `npm install` of
it, or a path into `node_modules`): the package is not on npm yet and the name is unclaimed, so
such an instruction would run whatever a stranger publishes under it. Without a plugin, the CLI
is `bin/llm-docs.mjs` run with `node`, and CI downloads the same file from the GitHub Release.
When the `claude` CLI is on PATH it also runs
`claude plugin validate --strict` on the plugin and on the repository. Skills are written
harness-neutral (no tool names that exist in only one harness; frontmatter limited to `name`,
`description`, `license`, `metadata`; agent frontmatter to `name` and `description`). If Node
is not on PATH the hook command fails and both harnesses treat that as a non-blocking error;
the README documents Node 22.19 or newer as a requirement.
Codex installation is unverified: Codex documents `.codex-plugin/plugin.json` manifests and does
not document reading `.claude-plugin` marketplaces, so the plugin README does not claim it.

## 8. Guides and citations

Guides are Markdown files under `<pack>/guides/` written by agents. A citation is any Markdown
link in a guide whose target resolves into the pack's `pages/` or `files/` (relative path),
optionally with a fragment. `llm-docs guides stamp <id> [guide...]` writes
`guides/citations.lock.json`:

```jsonc
{ "guides": {
    "guides/01-overview.md": {
      "citations": [
        { "sectionSha256": "sha256:...",
          "target": "pages/specification/basic-transports.md#session-management" }
      ],
      "sha256": "sha256:..." } },
  "schemaVersion": 1 }
```

(Written with sorted keys at every depth.)

A fragment resolves to the heading whose slug (the existing Unicode-aware slugger, GitHub
rules, with `-1`, `-2` suffixes for duplicates) equals it; the section is the text from that
heading to the next heading of the same or higher level. No fragment means the whole page
without its provenance comment line, or the bytes of a file under `files/`; a fragment on a
non-Markdown file does not resolve. Stamping writes nothing and exits 2 when a citation does
not resolve, a link climbs out of the pack, a cited file differs from the manifest, a named
guide does not exist, the pack has no guides, or the pack is not built; it holds the packs
lock while it writes. Stamping named guides keeps the other entries; entries for deleted guides
are dropped and reported. `verify` recomputes everything (5.1). After a rebuild by `sync`,
`add`, or `refresh`, the report lists the guides whose cited sections changed or no longer
resolve, with the stamp command to run after review; `refresh --check` lists the guides whose
cited pages changed upstream. That is the re-review list for the planner.

## 9. Migration from v2

`llm-docs migrate <v2-pack-dir> --version <version> [--id <id>]` reads a v2 manifest
(`schemaVersion` "0.1.0", `mode: local-source-docs`) and writes a v3 recipe into the project
config, creating `llm-docs.json` by the 2.1 rule when absent. `--version` is required, because
v2 manifests record none; without it migrate refuses and shows the v2 label and tags as
evidence. `--id` defaults to the v2 pack directory name. The decision, in order:

- Source that still exists inside the project: a `local` source, even when git state was
  recorded.
- Source with `git` state and a remote (`remoteUrl`, `commit`, `sourceRootFromRepo`): a `git`
  source with `repo` normalized to https (with a warning when it was not https; `file://` is
  kept as is), `ref` = the commit, `paths` = [the source root] (`.` when empty). A dirty tree is
  a warning. The exclude globs (`excludeGlobs` and `excluded[].glob`, merged and sorted) carry
  over.
- Source under the OS temp directory or missing, with no usable remote: exit 2 explaining that
  the origin is lost and that the pack must be re-added from a durable source.
- Source outside the project with no usable remote: exit 2.
- Other v2 schema versions and modes: exit 2 naming them as unsupported in v3.

The recipe is resolved before it is written, and an invalid id, an existing id, or a recipe
that does not resolve is also exit 2. It prints the next command (`llm-docs sync <id>`), never
deletes the v2 pack, and creates neither `packsDir` nor managed blocks.

## 10. Discover

Read-only evidence for the planner, printed as JSON (and a human summary on stderr). Never
writes files.

- `--url <site>`: reuses the v2 website discovery with the 4.1 network policy, fetching
  exactly three resources (the given URL, and `/llms.txt` and `/sitemap.xml` at its origin;
  10 s timeout and 64 KiB per response, at most 200 candidates); adds whether page URLs serve
  raw Markdown when `.md` is appended (probing at most 3 listed same-origin pages, in sorted
  order, judged by a 2xx status with a Markdown or plain-text content type) and the
  version-looking path segments found in `llms.txt` (for example `2026-07-28`, `v8`), so the
  planner can write a filter. `llmsTxt.pathPrefixes` lists the distinct leading path prefixes of
  the same-origin URLs `llms.txt` lists, with counts: each URL's directories up to and including
  the first version segment among them, else its first directory, else `/` for a page at the
  root (`/specification/2026-07-28`, `/seps`), sorted by count then path, at most 40 with
  `morePathPrefixes` counting the rest. They are the prefixes an `--include` glob starts with;
  the stderr summary prints the top six.
- `--package <eco>:<name>[@<version>]`: registry metadata (repository URL and directory,
  homepage, documentation URL, license, the version's publish date), the git tags matching the
  version (via `git ls-remote`) with each tag commit's committer date and a warning when it is
  more than 14 days from the publish date (the tag may name another package's release; the tag
  is still reported), and, when a tag matches, the top 10 documentation-looking directories at
  that tag (blobless shallow fetch and `git ls-tree`, ranked by `.md` and `.mdx` file count).
  Without a version it uses the registry's latest (for swiftpm, the latest semver tag) and
  records which in `package.versionSource`. Ecosystems: npm, pypi, cargo, pub, go (swiftpm: the
  repository URL, `https://` or `file://`, is the identity). A package or version that does not
  exist is reported in the JSON with exit 0; an unreachable registry is exit 3.
  From the same tree, `changeDocuments`: files whose name or a directory on their path names a
  description of change (case-insensitive, by words: `CHANGELOG`, `CHANGES`, `HISTORY`,
  `RELEASES`, `RELEASE_NOTES`/`release-notes`, `MIGRATION`/`migrating`/`migrate`,
  `UPGRADE`/`upgrading`, `breaking`, `whats-new`/`what's-new`) with extension `.md`, `.mdx`,
  `.rst`, or `.txt`; hidden paths, vendored and build directories, and symlinks skipped; sorted
  by path depth then path; at most 20 with a count of the rest. Each entry is the path and the
  pattern that matched. This is evidence for choosing `readFirst` targets; the output never
  says which one to use.

## 11. Security summary

- Fetched docs are untrusted input that ends up in an agent's context. The engine never copies
  upstream text into agent files beyond escaped titles and directory names (7.1), never executes
  fetched content, and never follows links inside fetched pages.
- Network: section 4.1 policy (scheme allowlist, special-purpose address blocking from the
  IANA registries with DNS pinning, IPv4-carrying forms judged or refused, redirect
  re-validation, size and count caps, timeouts, refusal of credential-bearing URLs in config
  and requests, redaction by rule everywhere a URL is printed). The tool sends no credentials,
  so private sources are taken from a project folder.
- Git: section 4.1 policy (no hooks, no submodules, no symlinks, protocol allowlist, isolated
  config, no shell, no redirect git follows on its own, no credential helper, object checks
  with only the documented legacy ids ignored, a ceiling on repository discovery).
- File system: pack files are written only inside the pack staging directory; the other
  writes are `llm-docs.json` (init, add, migrate), `<packsDir>/.gitignore`, the packs lock,
  `guides/citations.lock.json` (stamp), the agent files `agentFiles` selects (7.1), deletes of
  pruned packs, and the user cache directory (release dates, conversions, `hook.log`,
  `hook-warm/`). Paths are checked with `isSameOrDescendant`, after resolving symlinks for
  `packsDir`, local sources, and agent files; collisions and reserved names are errors; writes
  are atomic (`writeTextFileSafely`, `writeJsonFileSafely`), keep the replaced file's permission
  bits, and refuse to replace anything but a regular, writable file with one link. Every file
  read by a fixed or user-controlled name in the project or the home directory (`llm-docs.json`,
  manifests, agent files, the packs lock, `citations.lock.json`, `<packsDir>/.gitignore`,
  lockfiles and the files beside them, Claude Code settings, the caches, the hook's warm-up
  marker, and source files) is read only when it is a regular file (`readRegularFile`,
  `openRegularFile`), so a named pipe can never block a command or the hook. The pack directory
  and its `guides/` must be real directories. `docs/security.md` lists every control with the
  file that implements it.
- Converters run with `execFile`, a timeout, and paths the engine chose; `command` converters
  are trusted local configuration, documented as such, and never run from a config another
  user owns (2.1).
- The hook never writes outside the cache directory and never prints secrets or tokens.
- Accepted risks: project discovery uses the nearest `llm-docs.json`; git resolves a host
  itself, so its connection is not pinned; a local attacker who can write to the project can
  race a check and a write, which is out of scope; `sync`, `add`, `refresh`, `init`, and
  `migrate` run read-only git commands in the project (`src/core/git-state.ts`: the host
  commit of a `local` source, the git top level) with the user's own git config, outside the
  4.1 policy but with fsmonitor and hooks disabled, no index refresh, and no look inside
  submodules, while `status`, `sync --check`, and the hook never run git there.

## 12. Quality bar and delivery

- TypeScript strict as configured; no `any`, no casts to `unknown as`, no ts-ignore.
- Each module ships with Vitest unit tests next to its peers in `tests/unit/`; network tests use
  a local HTTP server with `LLM_DOCS_ALLOW_PRIVATE_NETWORK=1`; git tests use local repositories
  created in temp dirs via `file://`. No test touches the real network.
- CLI end-to-end tests run the built CLI against temp projects (one subprocess per scenario,
  grouped to keep the suite fast).
- CI: Linux, macOS, Windows on Node 22, 24, and 26; `npm ci` with a committed
  `package-lock.json`; lint, format check, type-check, build, plugin bundle check, tests (the
  schema check is a test).
- Release: a tag `v*` that equals `v` plus the package version runs the CI gate and attaches the
  committed bundle as `llm-docs.mjs`, with `llm-docs.mjs.sha256` and `THIRD_PARTY_NOTICES.md`, to the GitHub Release for the
  tag (`.github/workflows/release.yml`). 3.0.0 is released on GitHub only. Publishing to npm with
  provenance is a separate, manually dispatched workflow (`publish-npm.yml`) that refuses to run
  until the owner adds the `NPM_TOKEN` secret.
- Docs: README (user-facing, crafted, no em-dashes), `docs/` reference pages for config,
  manifest, commands, security, and the plugin; `CHANGELOG.md` with the v3 breaking changes and
  the migration path; skills in `plugin/skills/` replace `AGENT_CONTEXT.md` and `skills/`.

## 13. Evals

`evals/` holds cases and a runner (`npm run eval`). Each case is a small project pinned to a
library version released after the evaluated model's training cutoff (plus negative controls
the model already knows), a task prompt, a pack recipe, and hidden mechanical checks the
runner executes after the agent finishes (`deps-unchanged`, `no-type-suppressions`,
`typecheck` with `tsc --noEmit -p tsconfig.eval.json`, and `behaviour` with Vitest over hidden
`__eval__/*.check.ts` files). Each case records its stratum, `type-visible` when code written
from memory fails the type check, `type-invisible` when it compiles and fails only at runtime,
and `control` for the negative controls, which the selftest enforces and the results report
pass rates by. Arms: `baseline` (no pack, no
plugin), `pack` (pack and managed block, no plugin), `plugin` (pack, block, and plugin hook and
skills). The runner prepares workspaces with dependencies installed before the agent starts,
runs `claude -p` with a pinned model, turn and budget caps, `--strict-mcp-config`,
`--no-session-persistence`, and `--setting-sources project` so user
settings and plugins stay out of every arm (measured 2026-11-05 on Claude Code 2.1.318: an
isolated `CLAUDE_CONFIG_DIR` loses the OAuth login, and `--safe-mode` also disables hooks from
`--plugin-dir`, so neither can be used for the plugin arm), grades with the checks, and writes `evals/results/<timestamp>/results.json` and `summary.md` (pass rate per
arm and case, runs, cost). A session the service or account ended (usage limit, rate limit,
overload, authentication, billing, network), or one that fails an arm assertion (the requested
model, no MCP servers, the pack and managed block, and for the plugin arm the loaded plugin and
its SessionStart hook), is an infra error that is never graded and that `--resume` retries; a
rate limit or overload is first retried in place after 30 s and 120 s, and a usage limit, an
authentication failure, or a billing error stops the run with exit 4. The runner's commands are
`selftest`, `prepare-packs`, `plan`, `run`, and `smoke`; `npm run eval -- smoke` runs one case
(default `zod-4-6`) once per arm to prove the pipeline before a full run. The README publishes
the numbers with the date, model, Claude Code version, and run count.

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
