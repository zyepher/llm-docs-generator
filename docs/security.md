# Security model

`llm-docs` fetches documentation written by other people and puts it where coding agents read it. This page states what the tool trusts, what it does not, the risks it accepts, and each control with the file that implements it.

## Threat model

The tool trusts:

- The `llm-docs.json` it finds, when you or another user you trust owns it. It names every URL, repository, and local path the engine reads, and it can name a converter command that runs on your machine.
- The local machine: the user running the CLI, the installed `git`, and the converter tools on `PATH`.

The tool does not trust:

- Fetched content: pages, `llms.txt` indexes, repository trees and objects, license files, and anything a converter produces from a document. Upstream text can contain instructions aimed at an agent, links meant to escape the pack, or names meant to collide with other files.
- Remote servers: redirects, DNS answers, response sizes, and response times.
- Repository contents: hooks, submodules, symbolic links, path names, and malformed git objects.
- Files at the names the tool reads and rewrites, which may be links, named pipes, or devices.
- Lockfiles and the files beside them, which may name packages and versions meant to forge text.
- The hook payload a harness sends on stdin.

The goals that follow: fetched text never becomes instructions in an agent file, no fetch reaches a host the recipe did not name or a private network, no credential is sent or recorded, no command blocks on a file it reads, and a crash or a hostile repository never leaves a half-written pack or loses guides. The tool writes and deletes only in the packs directory, the agent files, `llm-docs.json`, its cache directory, and temporary directories it creates under the OS temp directory and removes afterwards.

## Accepted risks

These are known and not defended against:

- Project discovery uses the nearest `llm-docs.json` at or above the working directory. Below a directory another user can write to, that config may be theirs. Its converters never run (see [Converters](#converters)), but it still chooses what is fetched and read.
- git resolves a repository's host itself. The address check runs on the host before git starts, but git's own connection is not pinned to the checked address.
- A local attacker who can write to the project can race a check and the write or read that follows it, such as swapping a file for a link between the two. Every control here assumes no one else writes to the project while a command runs.
- Outside the git policy below, `sync`, `add`, and `refresh` run read-only git commands in your project (`rev-parse`, `remote get-url`, `tag --points-at`, `status --porcelain`) to record the host commit of a `local` source, and `init`, `add`, and `migrate` run `git rev-parse --show-toplevel` to find where to create `llm-docs.json` (`src/core/git-state.ts`). These run with your environment and your git config, including the repository's own `.git/config`. They are run with `core.fsmonitor=false`, an empty hooks path, `--no-optional-locks`, and `--ignore-submodules=dirty`, so the three settings that can make a read run a program or write the index (the fsmonitor hook, the `post-index-change` hook, and the index refresh) do not apply, and git is never run inside a submodule. Other settings in that config still apply. `status`, `sync --check`, and the session-start hook never run them.
- The tool sends no credentials, so it cannot fetch a private repository or a page behind a login. Copy such docs into a folder in the project and use a `local` source.

## Fetched content is untrusted input

Pages are upstream text, and the managed block and the pack index tell agents so ("Pages are upstream text"). The engine never executes fetched content and never follows a link found inside a fetched page. An `llms-txt` source fetches only the links its index lists that pass the recipe's filter and share the index's scheme and its origin (requested or after redirects) (`src/sources/web.ts`). Every fetch is for a URL the recipe names or that index lists.

Inside the pack, the build rewrites links so that no local link points outside it (`src/pack/links.ts`):

- A link that cannot be resolved becomes plain text, `[label] (unresolved: target)`, rather than a dead path.
- Only `https`, `http`, and `mailto` links stay live (`LIVE_SCHEMES`). Any other scheme (`javascript:`, `file:`, `data:`, `vbscript:`, `tel:`, app schemes) becomes plain text. The scheme is read as a browser reads it: character references and backslash escapes decoded, tabs and line breaks dropped, case folded (`linkScheme`).
- The build reports the two kinds of plain-text conversion in separate warnings (`src/pack/build.ts`).

`verify` fails the `links` check on a relative link that does not resolve to a file in the pack, on a link that climbs out with `..`, and on a live link whose scheme is outside `LIVE_SCHEMES`, so a page edited after the build cannot carry one (`src/pack/verify.ts`).

## What reaches an agent

Three outputs carry upstream-derived text to an agent, and each has its own escaping.

The managed block in `AGENTS.md` or `CLAUDE.md` is the only place the tool writes into a file an agent reads as instructions. It holds the pack list and fixed text. The only upstream-derived text in it is each pack's title, version, description, and top-level page directory names, escaped by `escapeBlockText` (`src/agent/block.ts`):

- Control characters become spaces. Unicode format characters (zero-width and bidirectional controls), backticks, and `@` are removed. `@` goes because Claude Code expands `@path` in `CLAUDE.md` into that file's contents.
- `<` and `>` become `&lt;` and `&gt;`.
- Whitespace collapses to one line, capped at 80 characters.

Text outside the block markers is never changed. Agent files are decoded as strict UTF-8, a byte order mark is kept, and a file that is not valid UTF-8 is an error rather than a rewrite. A marker line inside a code block is not a marker, and mismatched markers are an error rather than a guess.

The session-start note is context, not an agent file, so its escape is lighter (`messageText` and `codeSpan` in `src/deps/status.ts`). Every value from a lockfile, a manifest, a registry, or the config becomes one line: control, format, and line-separator characters become spaces, backticks are removed, `<` and `>` become `&lt;` and `&gt;`, and the text is capped at 200 characters. `@` stays, because nothing expands `@path` in injected context. A dependency name is shown inside a code span. The note leaves out a read-first path that the block escaping would alter rather than show it altered. `status` prints the same escaped text.

Page titles in `index.md` are escaped for Markdown tables: control characters and line breaks collapse to spaces, backticks are removed, the length is capped at 120 UTF-16 code units, and then `\`, `|`, `[`, `]`, `<`, and `>` are backslash-escaped (`src/pack/index-page.ts`). An origin URL in `index.md` goes through `redactUrl`.

## Files the tool reads and writes

| Control | Behavior | File |
|---|---|---|
| Regular files only | Every file read at a fixed or user-controlled name in the project or the home directory goes through `readRegularFile` or `openRegularFile`: `llm-docs.json`, `manifest.json`, agent files, the packs lock, `citations.lock.json`, `<packsDir>/.gitignore`, lockfiles and the files beside them (`package.json`, `.npmrc`, `.yarnrc.yml`, and the rest), Claude Code's settings files, the release-date and conversion caches, the hook's warm-up marker, and source and pack files. The open is non-blocking and the type is checked on the opened descriptor, so a named pipe, a socket, a device, or a directory is refused instead of blocking the command. Where a link would be wrong, the open also refuses a symbolic link, including one swapped in after the check. | `src/utils/safe-write.ts` |
| Refusals on read | A refused `llm-docs.json` is a config error that names it (exit `2`), never a reason to look for a config further up. A refused manifest makes the pack invalid. A refused lockfile, or a refused file beside one, leaves that lockfile unread, so its dependencies' versions are unknown. A refused Claude Code settings file is skipped and named in a warning. | `src/config/project.ts`, `src/pack/manifest.ts`, `src/deps/lockfiles.ts`, `src/deps/cutoffs.ts` |
| Atomic writes | `llm-docs.json`, manifests, agent files, the citations lock, `<packsDir>/.gitignore`, and the caches are written to a temporary file in the same directory, flushed, and renamed over the target. The replaced file's permission bits carry over. A target that is not a regular file, is read-only (your protection is kept), or has other hard links (a rename would leave them on the old text) is refused and nothing is written. A refused `llm-docs.json` is a config error that says what to do. | `src/utils/safe-write.ts`, `src/config/project.ts` |
| Project paths | `packsDir`, `agentFiles` entries, and local source paths must be project-relative and stay inside the project. `packsDir` and local sources are checked again after symbolic links resolve. | `src/config/project.ts`, `src/sources/acquire.ts` |
| Temp directories | A local source under the OS temp directory is refused unless `LLM_DOCS_ALLOW_TEMP_SOURCES=1`. Acquisition works in a temp directory that is removed afterwards, including on failure. | `src/sources/acquire.ts`, `src/pack/build.ts` |
| Real pack directories | The pack directory and its `guides/` must each be a real directory. A symbolic link at either fails that pack with a config error in `sync`, `guides stamp`, and recovery, and nothing is built into, moved through, or deleted through it. `status` reports such a pack as `unusable`, and `verify` fails it. | `src/pack/guides.ts` |
| Staging | A pack is built in `<packsDir>/.staging/<id>-<random>/` and verified there before it is swapped in. `.staging` must be a real directory the tool created: a symbolic link or a file there is refused before anything is built or deleted, and a link found inside it is removed by name, never entered. | `src/pack/build.ts` |
| Swap order | The old pack is renamed into `.staging`, the new pack is renamed into place, and then `guides/` moves from the old pack into the new one. Guides only ever move between two pack directories, never into a staging pack, so no cleanup path can delete them. A swap that fails part-way is put back before the sync ends, and one interrupted by a crash is put back by the next sync. A leftover that holds guides is never deleted: when its guides cannot be put back, it stays in `.staging` and fails its pack until they can. | `src/pack/build.ts` |
| Locking | `<packsDir>/.llm-docs.lock` is created exclusively and holds the pid, start time, command, and a random token per run. A second writer fails at once (exit `3`). A lock is stale when its process is gone, its start time is more than an hour away, a field is missing, or it cannot be read and is older than 5 seconds. A run takes over a stale lock by renaming it to a name only that run uses, goes on only if what it moved is the lock it judged stale, and checks that the lock on disk carries its own token before any work. It removes the lock on release only while it is still its own. A lock path that is not a regular file is a config error, never read through or deleted. `sync --check` takes no lock. | `src/pack/lock.ts` |
| Agent files | Written through their real path, which must stay inside the project and must not be inside `.git`, `.hg`, `.svn`, or the packs directory, nor be `llm-docs.json` or a lockfile. A link that leads outside the project or to a missing file, and an agent file that is not a regular file, is read-only, or has other hard links, is an error for that file only. | `src/agent/block.ts` |
| Output paths | Every output path is relative and inside the pack. Two outputs whose paths name one file under NFKC and full case folding (`pathCollisionKey`), Windows-reserved names, characters Windows forbids, and segments ending in a dot or a space are errors that name the files. The same key applies to OpenAPI tag pages and to the stored paths of `urls` and `llms-txt` sources. | `src/utils/fs-path.ts`, `src/sources/acquire.ts`, `src/pack/build.ts` |
| Symbolic links in packs | `verify` opens every pack file segment by segment and refuses any symbolic link on the way. `unlisted-files` fails on a link inside the pack. A link at `manifest.json`, `index.md`, or a page makes the pack stale, and `sync` rebuilds it in place without following the link. | `src/pack/verify.ts`, `src/pack/build.ts` |
| Pruning | `sync --prune` deletes only directories in `packsDir` that hold a `manifest.json`, are not in the config, and have no guides. | `src/pack/build.ts` |

## Manifest integrity and `verify`

A manifest is read only from a regular `manifest.json` in a real pack directory (`readPackManifest` in `src/pack/manifest.ts`). It must agree with its own recipe: `recipeHash` is the hash of `recipe`, the pack's title, version, and dependency equal the recipe's, there is one origin per recipe source of the same type, and every source entry names a recipe source. Every path it records is a contained relative POSIX path (`isContainedRelativePath`): no empty, `.`, or `..` segment, no backslash, and no control character. Each output path fits its kind: pages under `pages/`, passthrough files under `files/`, `index.md`, and `<id>.full.md`. `citations.lock.json` applies the same predicate to its guide keys and citation targets (`src/pack/guides.ts`).

`verify` is read-only and offline (`src/pack/verify.ts`). It checks the config, the managed blocks, and for each pack the manifest, every listed output by hash, every file the manifest does not list, every link, the recipe, the lockfile binding, the guide citations, agent conversions, and the license. It fails, and never passes silently, on anything it could not examine: a file it could not open, a directory it could not read, a walk cut off at 64 levels or 200,000 entries, a check that threw. A check reports `skipped` only beside a failing one: the other checks of a pack whose manifest fails, the checks of a pack whose directory is a symbolic link (`unlisted-files` fails), and `citations` when `guides/` is a symbolic link.

`guides stamp` refuses, writing nothing, unless every output of the pack is a regular file whose bytes match the manifest, so a citations lock only ever attests to a verified pack.

## HTTP policy

Every network fetch the engine makes for docs goes through `createHttpClient` in `src/sources/http.ts`.

| Control | Behavior |
|---|---|
| Schemes | `https:` only. Plain `http:` is fetched only to a loopback address and only when `LLM_DOCS_ALLOW_PRIVATE_NETWORK=1`. |
| Address blocking | The hostname is resolved before connecting, and every resolved address must pass. `SPECIAL_ADDRESS_BLOCKS` holds every block the IANA IPv4 and IPv6 Special-Purpose Address Registries mark as not globally reachable, plus multicast, the deprecated site-local range, and the IPv6 forms that carry an IPv4 address: IPv4-compatible, IPv4-translated, 6to4, Teredo, and the local-use NAT64 prefix `64:ff9b:1::/48`. Those forms are refused whole, and the error names a special IPv4 address they carry. |
| IPv4-carrying forms judged by their IPv4 | An IPv4-mapped address (`::ffff:a.b.c.d`) and an address in NAT64's well-known prefix `64:ff9b::/96` (how a DNS64 resolver returns an IPv4-only host on an IPv6-only network) are judged by the IPv4 address in their last 32 bits (`IPV4_TRANSLATION_PREFIXES`). A public one passes. A special one is refused, naming it. |
| DNS pinning | The connection goes to the address that passed the check, so a second DNS answer cannot swap in another one. |
| Redirects | At most 5, followed by hand. Each hop is checked against the scheme and address rules again. |
| Size caps | Each response is streamed and aborted past the per-file cap: 20 MiB by default, up to 200 MiB with `limits.maxFileBytes`. Per pack: 5,000 files and 500 MiB. |
| Timeouts | 15 s to connect, 60 s for a whole request. |
| Concurrency and retries | 4 requests per host. 2 retries, only for network errors, 429, and 5xx, with jittered backoff that honors `Retry-After` up to 30 s. |
| Credentials | The tool sends none. A requested URL that carries a credential is refused: user info, or a parameter in the query, the fragment, or the path whose name looks like a token, key, signature, password, session, or similar (`urlCredentials` in `src/utils/url-credentials.ts`). A redirect may still lead to such a URL, since servers presign download URLs. The config schema applies the same predicate to every URL-valued key (`urls` entries, the `llms-txt` url, a git `repo`, `site.baseUrl`), so `add` fails before it writes `llm-docs.json` (`src/config/project.ts`). `GITHUB_TOKEN` is sent only to `api.github.com`, only when set, and only for release-date lookups. |
| Redaction | `redactUrl` (`src/utils/url-credentials.ts`) replaces user info and the value of every credential-looking parameter with `***`. Every URL in a log line, an error, a warning, a page's provenance line, `index.md`, and the refresh and discover output goes through it. A redirect's final URL, an `llms-txt` origin's `finalUrl`, and a git origin's `finalRepo` are stored redacted. The URLs a recipe names are stored as written, which is safe only because the config refuses one that carries a credential. |
| Identification | Requests send `User-Agent: llm-docs/<version> (+https://github.com/Zyepher/llm-docs-generator)`. |

## Git policy

`src/sources/git.ts` runs git for `git` sources and for `discover --package`.

| Control | Behavior |
|---|---|
| No shell | git runs through `execFile` with an argument array. |
| Isolated environment | Every `GIT_*` variable from the parent is dropped except `GIT_SSL_CAINFO` and `GIT_SSL_CAPATH`. `SSH_ASKPASS` is removed. `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL` pointing at an empty file, `GIT_LITERAL_PATHSPECS=1`, and `GCM_INTERACTIVE=never` are set. `GIT_CEILING_DIRECTORIES` is the work directory's parent, so no repository that encloses it can lend its config. |
| No hooks | `-c core.hooksPath=<empty dir>` on every command, and `git init --template=` so no template hooks are copied. |
| No credentials | `-c credential.helper=` clears every helper, so a `401` from a remote never reaches stored credentials. |
| No redirects git follows | `-c http.followRedirects=false`. Before git runs, the repository's discovery URL is requested through the HTTP client, which checks every hop. A redirect to another repository URL is used for the fetch and recorded, redacted, as `finalRepo`, with a warning. A redirect to anything else is an error. |
| Object checks | `-c transfer.fsckObjects=true` refuses malformed objects on arrival. Only the ids git-config(1) documents for legacy data in old repositories are ignored for fetches: `badTimezone`, `badDate`, `badDateOverflow`, `zeroPaddedDate`, `missingSpaceBeforeDate`, and `zeroPaddedFilemode`. They concern how a date or a file mode is spelled. Every other id, the `.gitmodules`, tree-entry, and path ones included, stays an error. git ignores `fetch.fsck.<id>` on a blob-filtered fetch, so a fetch that fails only on one of those ids is redone without the filter. |
| No symlinks | `-c core.symlinks=false`. A symbolic link the recipe would take is an error that asks you to exclude it. Other symbolic links are skipped with a warning. |
| No submodules | `-c submodule.recurse=false -c fetch.recurseSubmodules=false`, and the fetch passes `--no-recurse-submodules`. Submodule entries are skipped with a warning. |
| Protocol allowlist | `-c protocol.allow=never -c protocol.https.allow=always`, plus `protocol.file.allow=always` only for a `file://` repository. `ssh://` and `git@` remotes, and a repository URL that carries a credential, are rejected by the config schema. |
| Private networks | An `https` repository's host is checked against the HTTP address rules before git runs. git connects on its own, so the check is not pinned to the address (an accepted risk). |
| Ref names | A ref must be a 40-hex commit or a name that cannot read as an option: it starts with a letter, digit, `_`, or `@`, and has no `..`, `//`, trailing `/` or `.`, or `.lock` suffix. |
| Paths | Taken paths must be relative with no `..`. Each checked-out file must be a regular file whose real path stays inside the checkout. |
| Minimal fetch | `git fetch --depth 1 --filter=blob:none --no-tags` of the one ref, then a sparse checkout of the taken paths and the license files. |
| Timeout | 10 minutes per git command. A missing `git` binary is a clear error (exit `3`). |

## Dependency scan

`src/deps/lockfiles.ts` reads lockfiles as data and never runs project code.

- A lockfile over 64 MiB is skipped with a warning naming it and its size. The hook reads at most 4 MiB per lockfile, because a synchronous parse cannot be stopped by its deadline. A skipped lockfile, and one that is not a regular file, is listed as unread, and a lookup in its ecosystem answers "unknown" instead of guessing from the other lockfiles.
- Every dependency must have a version that is one line of printable characters without whitespace, at most 128 characters, and a name that follows its registry's rule. Any other entry is skipped with a warning, so a lockfile cannot forge text in the note or in `status`.
- A dependency that a lockfile records from a registry other than the ecosystem's public one is kept apart (`otherRegistry`) and never enters a release-date lookup: the public registry's date for a package of the same name says nothing about a private one. A pack bound to such a dependency is `other-registry` in `status`, and `sync` asks for an explicit `version`.
- The project's language and toolchain version files (`.python-version`, `go.mod`, `.nvmrc`, `.tool-versions`, and the rest; `src/deps/toolchains.ts`) are read under the same rules: never through a symbolic link, never over the same size cap, and at most 200 of them per scan. Reading them runs nothing: no version manager, no interpreter, no build tool. A refused or oversized version file is listed as unread, and a toolchain lookup answers "unknown".

## Converters

Converters run documents through local tools (`src/sources/convert.ts`):

- The tool runs through `spawn` with an argument array, never a shell, with paths the engine chose: each input is copied under a sanitized name into a temp directory first.
- Each conversion has a timeout (300 s by default, `convert.timeoutSeconds`), after which the child is killed. Inputs over 200 MiB and outputs over 100 MiB are refused.
- A Windows `.cmd` or `.bat` shim can only run through `cmd.exe`. Its arguments are quoted, and an argument containing `"`, `%`, or a line break is refused.

A `command` converter, and a `command` override for `docling` or `markitdown`, runs whatever program `llm-docs.json` names, with your privileges. Treat that key like a build script: review it in a recipe you did not write, as you would a `package.json` script.

On macOS and Linux, a converter whose executable `llm-docs.json` names never runs when that file, or the directory holding it, belongs to another user (by `lstat` owner against the running user; root counts as another user unless you run as root). `sync`, `add`, and `refresh` fail that pack with a config error that says whose file it is and that the converter did not run. Fetching and reading packs per such a config stay allowed, since neither runs code. Windows has no user ids, so the check does not apply there (`projectConfigOwner` in `src/config/project.ts`).

## What the hook reads, contacts, and stores

The session-start hook (`src/agent/hook.ts`) reads your project's lockfiles and the files beside them, `llm-docs.json`, the packs' manifests and files, the local folders packs are built from (for at most 400 ms), the agent files, and Claude Code's settings files for the model id. Every one of those reads is asynchronous and goes through the regular-file rule, so its deadline always holds. It ignores an `llm-docs.json` that is not a regular file, is invalid, or belongs to another user (or sits in a directory that does), logs why, and continues with the dependency analysis only.

It writes files only inside the cache directory:

- `hook.log`, appended only when it is a regular file with one link, opened without following a link and without blocking, and rotated to `hook.log.1` at 1 MiB.
- `release-dates.json`, written atomically.
- One marker file per project in `hook-warm/`, written only into a real directory, that limits the background `llm-docs status` run to one per project every 6 hours.

Checking a pack against its local sources also creates a temporary directory under the OS temp directory, writes no file into it, and removes it. The hook never runs git, never prints secrets or tokens, and never writes to stderr. To compare release dates with the training data cutoff, it may send HTTPS GET requests to package registries (`api.deps.dev`, `registry.npmjs.org`, `pypi.org`, `crates.io`, `proxy.golang.org`, `pub.dev`, and `api.github.com` for Swift packages) and, for the project's language versions, the vendors' release feeds (`go.dev`, `www.python.org`, `static.rust-lang.org`, `www.swift.org`, `storage.googleapis.com`, and `nodejs.org`) that name a dependency and usually its version. It sends no file contents, file paths, or project names. [The plugin README](../plugin/README.md#privacy-and-network) lists the exact hosts and budgets.

## Environment variables that loosen the policy

| Variable | Effect | When to use it |
|---|---|---|
| `LLM_DOCS_ALLOW_PRIVATE_NETWORK=1` | Allows fetches and git remotes on private, loopback, and other special-purpose addresses, and plain `http:` to loopback. | Tests against a local server, or docs hosted on your own internal network that you trust. Never in a shared CI job that builds recipes from untrusted contributors. |
| `LLM_DOCS_ALLOW_TEMP_SOURCES=1` | Allows a `local` source under the OS temp directory. | Tests and throwaway experiments. A pack built this way pins an origin that will disappear. |

No other variable weakens a control. `LLM_DOCS_CACHE_DIR` moves the cache, `LLM_DOCS_HOOK=off` silences the hook, `LLM_DOCS_MODEL_CUTOFF` sets the cutoff, `GITHUB_TOKEN` raises GitHub's rate limit for release-date lookups, and `LLM_DOCS_DEBUG=1` adds stack traces to errors. `GIT_SSL_CAINFO` and `GIT_SSL_CAPATH` pass through to git, to set the TLS trust a corporate network needs.

## Reporting a vulnerability

Report a vulnerability privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability** (https://github.com/Zyepher/llm-docs-generator/security/advisories/new). Do not open a public issue. Include the version (`llm-docs --version`), the recipe or input that triggers the problem, and what an attacker gains.
