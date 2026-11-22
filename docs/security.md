# Security model

`llm-docs` fetches documentation written by other people and puts it where coding agents read it. This page states what the tool trusts, what it does not, and each control with the file that implements it.

## Threat model

The tool trusts:

- `llm-docs.json`, written by you or your agent. It names every URL, repository, and local path the engine reads, and it can name a converter command that runs on your machine.
- The local machine: the user running the CLI, the installed `git`, and the converter tools on `PATH`.

The tool does not trust:

- Fetched content: pages, `llms.txt` indexes, repository trees, license files, and anything a converter produces from a document. Upstream text can contain instructions aimed at an agent, links meant to escape the pack, or names meant to collide with other files.
- Remote servers: redirects, DNS answers, response sizes, and response times.
- Repository contents: hooks, submodules, symbolic links, and path names.
- The hook payload a harness sends on stdin.

The goals that follow: fetched text never becomes instructions in an agent file, no fetch reaches a host the recipe did not name or a private network, no write lands outside the packs directory and the agent files, and a crash or a hostile repository never leaves a half-written pack.

## Fetched content is untrusted input

Pages are upstream text, and the managed block and the pack index tell agents so ("Pages are upstream text"). The engine never executes fetched content and never follows a link found inside a fetched page: an `llms-txt` source fetches only the same-origin `https` links its index lists that pass the recipe's filter (`src/sources/web.ts`). Every fetch is for a URL the recipe names or that index lists.

Inside the pack, the build rewrites links so that no local link points outside it. A link it cannot resolve becomes plain text rather than a path (`src/pack/links.ts`), and `verify` fails the `links` check on any relative link that does not resolve to a file in the pack, including one that climbs out with `..` (`src/pack/verify.ts`).

## What reaches an agent file

The managed block in `AGENTS.md` or `CLAUDE.md` is the only place the tool writes into a file an agent reads as instructions. It holds the pack list and fixed text. The only upstream-derived text in it is each pack's title, version, description, and top-level page directory names, escaped by `escapeBlockText` (`src/agent/block.ts`):

- Control characters become spaces. Unicode format characters (zero-width and bidirectional controls), backticks, and `@` are removed. `@` goes because Claude Code expands `@path` in `CLAUDE.md` into that file's contents.
- `<` and `>` become `&lt;` and `&gt;`.
- Whitespace collapses to one line, capped at 80 characters.

Text outside the block markers is never changed. Agent files are decoded as strict UTF-8, a byte order mark is kept, and a file that is not valid UTF-8 is an error rather than a rewrite. A marker line inside a code block is not a marker, and mismatched markers are an error rather than a guess.

The session-start note follows the same rule. It passes pack titles, dependency names, and versions through the same escaping, and it leaves out a read-first path that the escaping would alter rather than show it altered (`src/deps/status.ts`).

Page titles in `index.md` are escaped for Markdown tables: control characters and line breaks collapse to spaces, backticks are removed, `\`, `|`, `[`, `]`, `<`, and `>` are backslash-escaped, and the length is capped at 120 characters (`src/pack/index-page.ts`).

## HTTP policy

Every network fetch the engine makes for docs goes through `createHttpClient` in `src/sources/http.ts`.

| Control | Behavior |
|---|---|
| Schemes | `https:` only. Plain `http:` is fetched only to a loopback address and only when `LLM_DOCS_ALLOW_PRIVATE_NETWORK=1`. |
| Address blocking | The hostname is resolved before connecting, and every resolved address must be public. Private, loopback, link-local (cloud metadata lives there), carrier-grade NAT, multicast, unique-local, site-local, documentation, benchmarking, reserved, NAT64, 6to4, Teredo, and IPv4-compatible addresses are refused, IPv4 and IPv6 alike. An IPv4-mapped IPv6 address is judged by its IPv4 part. |
| DNS pinning | The connection goes to the address that passed the check, so a second DNS answer cannot swap in a private one. |
| Redirects | At most 5, followed by hand. Each hop is checked against the scheme and address rules again, and the final URL is recorded. |
| Size caps | Each response is streamed and aborted past the per-file cap: 20 MiB by default, up to 200 MiB with `limits.maxFileBytes`. Per pack: 5,000 files and 500 MiB. |
| Timeouts | 15 s to connect, 60 s for a whole request. |
| Concurrency and retries | 4 requests per host. 2 retries, only for network errors, 429, and 5xx, with jittered backoff that honors `Retry-After` up to 30 s. |
| Credentials | A URL with a user name or password is refused, in the config schema (`src/config/project.ts`) and again at fetch time. `GITHUB_TOKEN` is sent only to `api.github.com`, and only when it is set. |
| Redaction | `redactUrl` replaces user info and the values of credential-looking query parameters (`token`, `key`, `signature`, `X-Amz-*`, and similar) with `***` in every log line and error. |
| Identification | Requests send `User-Agent: llm-docs/<version> (+https://github.com/Zyepher/llm-docs-generator)`. |

## Git policy

`src/sources/git.ts` runs git for `git` sources and for `discover --package`.

| Control | Behavior |
|---|---|
| No shell | git runs through `execFile` with an argument array. |
| Isolated environment | Every `GIT_*` variable from the parent is dropped except `GIT_SSL_CAINFO` and `GIT_SSL_CAPATH`. `SSH_ASKPASS` is removed. `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL` pointing at an empty file, `GIT_LITERAL_PATHSPECS=1`, and `GCM_INTERACTIVE=never` are set. |
| No hooks | `-c core.hooksPath=<empty dir>` on every command, and `git init --template=` so no template hooks are copied. |
| No symlinks | `-c core.symlinks=false`. A symbolic link the recipe would take is an error that asks you to exclude it. Other symbolic links are skipped with a warning. |
| No submodules | `-c submodule.recurse=false -c fetch.recurseSubmodules=false`, and the fetch passes `--no-recurse-submodules`. Submodule entries are skipped with a warning. |
| Protocol allowlist | `-c protocol.allow=never -c protocol.https.allow=always`, plus `protocol.file.allow=always` only for a `file://` repository. `ssh://` and `git@` remotes are rejected by the config schema. |
| Private networks | An `https` repository's host is checked against the HTTP address rules before git runs. git connects on its own, so the check is not pinned to the address. |
| Ref names | A ref must be a 40-hex commit or a name that cannot read as an option: it starts with a letter, digit, `_`, or `@`, and has no `..`, `//`, trailing `/` or `.`, or `.lock` suffix. |
| Paths | Taken paths must be relative with no `..`. Each checked-out file must be a regular file whose real path stays inside the checkout. |
| Minimal fetch | `git fetch --depth 1 --filter=blob:none --no-tags` of the one ref, then a sparse checkout of the taken paths and the license files. |
| Timeout | 10 minutes per git command. A missing `git` binary is a clear error (exit 3). |

## File system containment

| Control | Behavior | File |
|---|---|---|
| Project paths | `packsDir`, `agentFiles` entries, and local source paths must be project-relative and stay inside the project. `packsDir` and local sources are checked again after symbolic links resolve. | `src/config/project.ts`, `src/sources/acquire.ts` |
| Temp directories | A local source under the OS temp directory is refused unless `LLM_DOCS_ALLOW_TEMP_SOURCES=1`. Acquisition itself works in a temp directory that is removed afterwards, including on failure. | `src/sources/acquire.ts` |
| Agent files | Written through their real path, which must stay inside the project. A link that leads outside it, or to a missing file, is an error for that file only. | `src/agent/block.ts` |
| Output paths | Every output path is relative and inside the pack. Two outputs whose paths differ only by case or Unicode normalization, Windows-reserved names, characters Windows forbids, and segments ending in a dot or space are errors that name the files. | `src/sources/acquire.ts`, `src/pack/build.ts` |
| Staging and swap | A pack is built in `<packsDir>/.staging/<id>-<random>/`, verified there, and swapped in by rename. `guides/` moves from the old pack into the new one first. A crash leaves the old pack, the new pack, or a state the next sync recovers by moving the old pack back. `.staging` must be a real directory the tool created: a symbolic link or a file there is refused before anything is built or deleted, and a link found inside it is removed by name, never entered. | `src/pack/build.ts` |
| Atomic writes | Config, manifests, agent files, the citations lock, and caches are written to a temporary file in the same directory, flushed, and renamed over the target. A target that exists and is not a regular file, such as a symbolic link, is refused. | `src/utils/safe-write.ts`, `src/utils/json.ts` |
| Symbolic links in packs | `verify` fails `unlisted-files` on a symbolic link inside a pack. | `src/pack/verify.ts` |
| Locking | `<packsDir>/.llm-docs.lock` is created exclusively and holds the pid, start time, and command. A second sync fails at once (exit 3). A lock whose process is gone or that is older than one hour is replaced. | `src/pack/lock.ts` |
| Pruning | `sync --prune` deletes only directories in `packsDir` that hold a `manifest.json`, are not in the config, and have no guides. | `src/pack/build.ts` |

## Converters

Converters run documents through local tools (`src/sources/convert.ts`):

- The tool runs through `execFile`, never a shell, with paths the engine chose: each input is copied under a sanitized name into a temp directory first.
- Each conversion has a timeout (300 s by default, `convert.timeoutSeconds`), after which the child is killed. Inputs over 200 MiB and outputs over 100 MiB are refused.
- A Windows `.cmd` or `.bat` shim can only run through `cmd.exe`. Its arguments are quoted, and an argument containing `"`, `%`, or a line break is refused.

A `command` converter, and a `command` override for `docling` or `markitdown`, runs whatever program `llm-docs.json` names, with your privileges. Treat that key like a build script: trusted local configuration. Review it in a recipe you did not write, as you would a `package.json` script.

## What the hook contacts and stores

The session-start hook (`src/agent/hook.ts`) reads your project's lockfiles, the package manifests beside them, `llm-docs.json`, the pack manifests, the agent files, and Claude Code's settings files for the model id. It writes only inside the cache directory: `release-dates.json`, `hook.log`, and one marker file per project in `hook-warm/`. It never runs git, never prints secrets or tokens, and never writes to stderr.

To compare release dates with the training data cutoff, it may send HTTPS GET requests to package registries (`api.deps.dev`, `registry.npmjs.org`, `pypi.org`, `crates.io`, `proxy.golang.org`, `pub.dev`, and `api.github.com` for Swift packages) that name a dependency and usually its version. It sends no file contents, file paths, or project names. [The plugin README](../plugin/README.md#privacy-and-network) lists the exact hosts and budgets.

## Environment variables that loosen the policy

| Variable | Effect | When to use it |
|---|---|---|
| `LLM_DOCS_ALLOW_PRIVATE_NETWORK=1` | Allows fetches and git remotes on private, loopback, and other special-purpose addresses, and plain `http:` to loopback. | Tests against a local server, or docs hosted on your own internal network that you trust. Never in a shared CI job that builds recipes from untrusted contributors. |
| `LLM_DOCS_ALLOW_TEMP_SOURCES=1` | Allows a `local` source under the OS temp directory. | Tests and throwaway experiments. A pack built this way pins an origin that will disappear. |

No other variable weakens a control. `LLM_DOCS_CACHE_DIR` moves the cache, `LLM_DOCS_HOOK=off` silences the hook, `LLM_DOCS_MODEL_CUTOFF` sets the cutoff, and `GITHUB_TOKEN` raises GitHub's rate limit for release-date lookups.

## Report a vulnerability

Report a vulnerability privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability** (https://github.com/Zyepher/llm-docs-generator/security/advisories/new). Do not open a public issue. Include the version (`llm-docs --version`), the recipe or input that triggers the problem, and what an attacker gains.
