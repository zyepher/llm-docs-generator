# llm-docs evals

This suite measures one question: does a pinned docs pack help a fully equipped coding agent
write correct code against library APIs, or a language version, released after its training
cutoff, and does it stay out of the way on libraries the agent already knows?

The agent under test is Claude Code running Claude Opus 5.5 (`claude-opus-5-5`, training cutoff
June 2026) in headless mode (`claude -p`). Every library case is a small TypeScript project pinned
to an exact library version; every language case (see **Language cases**) is a small Python, Go,
Dart, Rust, or Swift project run with the toolchain installed on the machine. Each has a task
prompt written the way a developer would ask, and hidden mechanical checks that run after the
agent finishes.

## Arms

Each case runs in five arms. The workspaces are identical except for the treatment, and every
workspace starts from the fixture project with its dependencies installed (a language case has
none to install).

| Arm | Plugin loaded | Workspace gets | Meaning |
|---|---|---|---|
| `baseline` | no | the fixture only | no treatment |
| `note` | yes | an initialized llm-docs project with no packs | the note and the skill, no saved docs |
| `changes` | yes | a pack holding only the case's read-first pages | the note, the skill, and the what-changed pages |
| `pack` | no | the full pack | the saved docs without the plugin |
| `plugin` | yes | the full pack | the note, the skills, and the saved docs |

"The plugin loaded" means the llm-docs plugin passed with `--plugin-dir`: its session-start hook
and its skills, `check-installed` among them. "An initialized project with no packs" is what
`llm-docs init` and `llm-docs sync` leave for an `llm-docs.json` whose `packs` is empty: that file,
an `agent-docs/` holding only its `.gitignore`, and an `AGENTS.md` holding only the empty managed
block. The `changes`,
`pack`, and `plugin` workspaces hold their pack in `agent-docs/`, `llm-docs.json`, and an
`AGENTS.md` holding only the managed block that `llm-docs sync` writes. A case with no read-first
pages (`hono-4-13`) gives the `changes` arm no pack, the same workspace as `note`.

The arms add one layer at a time, so neighbours isolate a layer:

- `note` against `baseline`: the session-start note and the skills alone. The note tells the agent
  to read the installed version's own types and source and to test the behaviour it relies on,
  and lists the case's library when it is newer than the model's training data. Nothing is saved
  to read.
- `changes` against `note`: the pages that say what changed, the cheapest docs a pack can hold.
- `plugin` against `changes`: the rest of the pack.
- `pack` against `baseline`: the full pack with no note and no skills, and `plugin` against `pack`:
  the note and the skills on top of the full pack.

The fixture has no `CLAUDE.md`, so Claude Code reads `AGENTS.md` as project instructions in every
arm but the baseline.

## Fairness rules

- Same model, prompt, fixture files, installed `node_modules`, turn cap, budget cap, and wall
  timeout in every arm.
- Same tools in every arm, including WebSearch and WebFetch. Allowed without a prompt: Read,
  Glob, Grep, Edit, Write, WebSearch, WebFetch, and Bash limited to `npx tsc`, `npx vitest`,
  `npm test`, `ls`, and `cat`; a language case gets its toolchain's programs in place of the npm
  ones (see **Language cases**). Anything else is denied automatically
  (`--permission-prompts none`), so no run can hang on a prompt.
- Isolated settings: `--setting-sources project` keeps the operator's user settings, user
  `CLAUDE.md`, rules, hooks, and installed plugins out of the run; `--strict-mcp-config` with no
  MCP config means no MCP servers in any arm; `--no-session-persistence` keeps runs out of the
  operator's session history. The runner also strips the parent session's `CLAUDE_CODE_*`
  variables from the child environment.
- Every session, in all five arms alike, runs with `ANTHROPIC_MODEL` set to the evaluated model
  id (the same string as `--model`) in its environment. The plugin's hook needs it: in a headless
  session the SessionStart payload carries no `model` field, so without the variable the hook
  falls back to the `model` key of the operator's own `~/.claude/settings.json`, which is the
  operator's default and not the evaluated model, and would state the wrong training cutoff, or
  none. Claude Code's model configuration page ranks `--model` above `ANTHROPIC_MODEL`, and its
  hooks page says a hook process inherits Claude Code's environment and "can read
  `$ANTHROPIC_MODEL` if you set it in your shell". Measured on 2026-11-22 with Claude Code
  2.1.330, in one headless session started with the runner's flags and environment and a probe
  plugin: the hook's stdin was `{session_id, transcript_path, cwd, hook_event_name, source}` (no
  `model`), the hook's environment had `ANTHROPIC_MODEL=claude-opus-5-5`, and the `init` event
  and the result's model usage both reported `claude-opus-5-5`, so setting the variable to the
  requested id does not change the model the session runs.
- The graders are hidden: `checks/` is copied into the workspace only after the agent exits.
- The prompt never names the API to use and never hints that a version changed. Every library
  case's prompt ends with the same ground rules: keep it fully typed (no `any` casts or ts-ignore
  comments), do not change `package.json` or install packages, run the type checker. A language
  case's prompt is the task alone.
- Runs are ordered repeat first, then case, then arm, so drift in the model service during a
  long run touches all arms alike.

### Why web tools are allowed in every arm

The realistic alternative to a pinned pack is not an agent with no information, it is an agent
that can search the web and read the vendor's site. A pack only earns its place if it beats
that. Blocking the web in the baseline would inflate the pack's advantage and answer a question
nobody asks. The results record how often each arm used the web, so a pack that merely replaces
browsing (same pass rate, fewer fetches, lower cost) is visible as such.

## Cases

Post-cutoff cases use libraries, or language versions, whose relevant API or behaviour shipped
after June 2026. Each one has a `naive/` solution written the way a model coding from memory would
write it, and the selftest proves the checks reject it.

### Strata

Every case records in `case.json` how visible its change is to an agent that never reads
documentation, and the selftest enforces the label against what `naive/` actually does:

| Stratum | What the from-memory solution does | What the agent's own loop tells it |
|---|---|---|
| `type-visible` | Fails `typecheck` (and usually `behaviour`). | The compiler points at the change, so a careful agent goes looking even without a pack. |
| `type-invisible` | Passes `typecheck`, fails only `behaviour`. | Nothing: the code compiles, and nothing says anything changed. This is where pinned docs and the session-start hook should matter most. |
| `language` | Fails `behaviour` (a language case has no `typecheck` check). | Depends on the case: see the kind of change in **Language cases**. There is no `node_modules` copy of the answer to read. |
| `control` | Is simply correct: a library version the model has known for years. | Measures that the pack does not hurt. |

Each case also records `packageDocumentsAnswer`: whether the installed package itself states the
answer an agent needs, in its `.d.ts` or JSDoc (`types`), in prose or agent files it ships such as
a README, CHANGELOG, `AGENTS.md`, or `ai-docs/` (`docs`), or not at all (`none`), with the file and
line cited in `notes`. For a language case the installed toolchain takes the package's place:
`types` when its own source or interface files state the new behaviour in code, `docs` when a
docstring, doc comment, or shipped document states it, with the path and line on the machine
where the case was built cited in `notes`. Every arm can read `node_modules`, so a baseline pass on a case marked
`types` or `docs` may come from the package rather than from memory or the web. The field is shown
in the results; it is never used for grading.

| Case | Stratum | Library (release) | What changed after the cutoff | What the checks prove | Package documents it |
|---|---|---|---|---|---|
| `stripe-23` | type-visible | `stripe` 23.1.0 (2026-10-29) | v23 removed `payment_method_types` from Checkout `SessionCreateParams` (now `allowed_payment_method_types`) and added `subscriptions.pause()`. | Type check rejects `payment_method_types`. A fake fetch client captures the HTTP requests: `allowed_payment_method_types` is exactly card and PayPay in any order, `mode=payment`, and a POST to `/v1/subscriptions/sub_123/pause` whose `invoicing_behavior` is `pending_invoice_item` or left out (it is the documented default). The old `pause_collection` idiom compiles but hits the wrong endpoint. | types |
| `mcp-sdk-v2` | type-visible | `@modelcontextprotocol/server` and `client` 2.4.0 (2026-10-23; 2.0.0 was 2026-07-27) | v2 split the SDK into server and client packages and replaced the flat `extra` argument with a request context (`ctx.mcpReq.notify`, `ctx.mcpReq.signal`, `ctx.mcpReq._meta`). | Client and server connected in memory: three progress notifications for `n=3` and the right result text. Cancellation is timed by an identical uncancelled call on the same server, not by sleeps: once that call has made 20 steps, the cancelled one must have sent at most 3 notifications (counted on the server transport). The v1 `extra.sendNotification` idiom fails to type check and sends no progress. | types (the context's members, not how to report progress) |
| `sveltekit-3` | type-visible | `@sveltejs/kit` 3.1.1 (2026-10-29; 3.0.0 was 2026-10-01) | v3 moved `Handle` and `HandleServerError` to `@sveltejs/kit/hooks` and changed `handleError` to receive `{ kind, error, event }` for every error, including framework errors. | Hooks must satisfy the v3 types from `@sveltejs/kit/hooks` and `App.Error` must carry `errorId`. A fake event and resolve prove the headers; `handleError` keeps the status and message of app and framework errors, and hides unknown ones behind an `errorId` that the `console.error` call carries in any shape (a string, format arguments, or a structured object). | types |
| `zod-4-6` | type-visible | `zod` 4.6.7 (2026-10-12; IBAN support arrived in 4.6.0, 2026-09-09) | `z.iban()` and the `z.ZodIBAN` type are new; `.validate()` arrived in 4.5.0. | Type test pins `const s: z.ZodIBAN = ibanSchema` and the type guard's narrowed type. Behaviour covers valid IBANs, a bad checksum, spaces, lowercase, and the transfer guard. A hand-written regex plus mod-97 gets every runtime answer right and is still rejected, because the task asks for zod's own IBAN validation. | types |
| `effect-4` | type-visible | `effect` 4.1.2 (2026-11-02; 4.0.0 was 2026-10-01) | v4 renamed `Either` to `Result`, `catchAll` to `catch`, `either` to `result`, and changed retry options. | Type test pins `Effect<Result<RateQuote, RateUnavailable>, never, never>`. `Effect.runPromise` proves laziness, success after transient failures, the cached fallback, the failure with the attempt count, and the exact call count. The v3 idiom fails to type check and throws at runtime. | types (and the package ships `AGENTS.md` and `ai-docs/`) |
| `hono-4-13` | type-invisible | `hono` 4.13.16 (2026-11-01; 4.13.0 was 2026-08-03) | 4.13 added `app.query()` for the HTTP QUERY method and the `methodNotAllowed` middleware in `hono/method-not-allowed`. | QUERY `/search` works; a wrong method on a known path returns a JSON 405 whose `Allow` header lists exactly what the router knows (including the HEAD Hono derives from GET). The check wraps the real middleware (a `vi.mock` that calls through) and requires every 405 to be one it turned from the router's 404, so a hand-rolled 405, even beside an unused import of the middleware, does not pass. | types (a JSDoc example close to the answer) |
| `zod-4-6-datetime` | type-invisible | `zod` 4.6.7 (2026-10-12; the change is in 4.5.0, 2026-08-28) | `z.iso.datetime()` and `z.string().datetime()` now require seconds, so minute-precision input such as `2026-12-01T09:30Z`, accepted by 4.4.3, is rejected. | A booking schema must accept UTC start times to the minute, second, and millisecond, keep them as sent, and reject local times, offsets, dates, and text. The from-memory `z.iso.datetime()` compiles and rejects the minute form. A hand-written pattern is also correct (`solution-regex/`). | docs (a source comment only) |
| `sveltekit-3-redirect` | type-invisible | `@sveltejs/kit` 3.1.1 (2026-10-29; 3.0.0 was 2026-10-01) | `redirect()` to another origin now throws a plain error unless it is given `{ external: true }` or an allowlist. | The `/login` server `load`, called with a fake event for two origins, must end in a 302, 303, or 307 to GitHub's authorization URL with the client id and the origin's `/auth/callback`. The SvelteKit 2 `redirect(302, url)` compiles and throws a non-redirect error. A `route-types` check runs `svelte-kit sync` first, so an idiomatic `./$types` import resolves. | types |
| `effect-4-partition` | type-invisible | `effect` 4.1.2 (2026-11-02; the change merged 2026-09-29 for 4.0.0) | `Effect.partition` now returns `[passes, fails]`; Effect 3 returned `[failures, successes]`. | `syncAll` over a fake accounting system must report `{ synced, failed }` correctly, never fail, run every invoice once, and run at most 4 at a time. The v3 destructuring compiles (only counts are returned) and reports them swapped. Unlike `effect-4`, the v4 betas before the cutoff still had the old order. | types (states the order, not that it changed) |
| `mcp-sdk-v2-tools` | type-invisible | `@modelcontextprotocol/client` 2.4.0 (2026-10-23; 2.0.0 was 2026-07-27) | Calling a tool the server does not have now rejects with a protocol error instead of resolving with `isError: true`. | Over an in-memory transport, `runTool` must return the text of a normal result, and `Tool failed: ...` for a tool error, rejected arguments, and an unknown tool, never rejecting. The 1.x idiom of branching on `result.isError` compiles and rejects on the unknown tool. | none |
| `markdown-it-15` | type-invisible | `markdown-it` 15.0.3 (2026-10-16; 15.0.0 was 2026-07-30) | `linkify: true` no longer links addresses without a protocol (`www.example.com`), because linkify-it 6 turned `fuzzyLink` off by default. | Rendered comments must link bare domains, full URLs, and emails, render standard Markdown, and escape raw HTML. The from-memory `new MarkdownIt({ linkify: true })` compiles and leaves bare domains as text. | types (linkify-it's `.d.ts` states the default) |
| `i18next-27` | type-invisible | `i18next` 27.2.3 (2026-11-21; 27.0.0 was 2026-11-07) | `returnEmptyString` now defaults to `false`: an empty translation falls back to the fallback language like a missing one. | The cart header is `Warenkorb` in German (note blank on purpose), the English note in English, and falls back to the English note in French (not translated). The i18next 26 setup compiles and leaks the English note into the German header. | types |

The six `type-invisible` cases after `hono-4-13` were found by the search described under
**Known limitations**; in each one the selftest proves `naive/` type-checks and fails only
`behaviour`, and the same `naive/` passes every check against the library's last release before
the cutoff (zod 4.4.3, SvelteKit 2.68.0, effect 3.21.4, markdown-it 14.2.0, i18next 26.3.4, and
`@modelcontextprotocol/sdk` 1.29.0 for the equivalent 1.x code).

Notes on fairness of individual prompts: the `zod-4-6`, `hono-4-13`, and `effect-4` prompts ask
the agent to use the library's own built-in support (IBAN validation, 405 handling, the built-in
success-or-failure data type) without naming it, because otherwise a careful hand-written solution
would be a legitimate answer and the case would stop measuring API knowledge. The `stripe-23`
prompt describes the pause outcome (paused status, nothing invoiced until the next invoice) in
product terms.

Controls use the same task shapes on library versions the model has known for years. They also
get packs (docs from the matching tag), so the pack arm is a real test of "does not hurt".

| Case | Library (release) | Task shape | Package documents it |
|---|---|---|---|
| `ctrl-stripe-14` | `stripe` 14.0.0 (2023-10-16) | The same Checkout task, where `payment_method_types` is correct (card and Link, in any order), plus cancel at period end, graded through the same fake fetch client. | types |
| `ctrl-zod-3` | `zod` 3.22.4 (2023-10-04) | A signup schema with `refine` for password confirmation, `safeParse` field errors, and `z.infer`. | docs |
| `ctrl-markdown-it-13` | `markdown-it` 13.0.2 (2023-09-26) | The `markdown-it-15` task and checks unchanged, in the type-invisible shape: on 13.x the from-memory `linkify: true` already links bare domains, so the obvious answer is simply correct and nothing pushes the agent anywhere. | docs |
| `ctrl-date-fns-2` | `date-fns` 2.30.0 (2023-04-30) | Stay range formatting and calendar-night counting with `format`, `addDays`, and `differenceInCalendarDays`. The behaviour check runs in `Europe/London` whatever the grading host's zone, so a stay across the switch to summer time counts the same everywhere. | docs (JSDoc in the shipped source) |

### Language cases

The library cases all pin npm packages, whose installed `.d.ts` files and source sit in
`node_modules` where an agent can read the answer off the disk. A **language case** is about a
programming language version instead: Python 3.15, Go 1.27, Dart 3.13, Rust 1.100, or Swift 6.4,
each a feature release after the cutoff. There is no `node_modules` copy of the language to read,
only the toolchain installed on the machine (`python3` 3.15.2, `go` 1.27.4, `dart` 3.13.7,
`rustc` and `cargo` 1.100.0, `swift` and `swiftc` 6.4.2 when the cases were built). `llm-docs`
tracks language versions as the `toolchain` ecosystem, so every arm applies unchanged.

A case is a language case when its `case.json` has two more fields:

- `toolchain`: `python`, `go`, `rust`, `dart`, or `swift`.
- `versionFiles`: the fixture files that state the toolchain version for `llm-docs`, such as
  `[".python-version"]` or `["go.mod"]`. Each must exist in `fixture/`.

Its `stratum` is `language` (and a case has that stratum exactly when it has a `toolchain`), its
`kind` is `post-cutoff`, and its `library` is the toolchain: `{ "name": "python", "version":
"3.15", "released": "2026-10-09" }`, the version as `llm-docs` tracks it (the feature release).
It has no `package.json`: nothing is installed, its template is a copy of the fixture, and
`prepare-packs` copies the version files into each prepared directory in place of the npm
manifest and lockfile, so the pack's `toolchain` binding resolves and the session-start note sees
the language version. Its expected notes are checked the same way, with the toolchain as the
library and no other dependencies: the `plugin` arm's note must list the pack as pinned docs after
the cutoff, and the `note` arm's must list the toolchain (`` - `python` ``) with no pinned docs.

Its only check is a command named `behaviour`, which runs the hidden check against the workspace
with the installed toolchain (resolved on `PATH`, since there is no `node_modules/.bin`). There is
no `typecheck`, no `deps-unchanged`, and no suppression scan. The prompt is the task alone, without
the npm ground rules; the leak lint scans it and the fixture's `.md`, `.py`, `.go`, `.mod`, `.rs`,
`.toml`, `.dart`, `.yaml`, `.swift`, and `.json` files.

Every arm of a language case gets Read, Glob, Grep, Edit, Write, WebSearch, WebFetch, `Bash(ls)`,
`Bash(ls *)`, and `Bash(cat *)`, plus its toolchain's programs in place of the npm ones:

| Toolchain | Also allowed |
|---|---|
| python | `Bash(python3 *)` |
| go | `Bash(go *)` |
| rust | `Bash(cargo *)`, `Bash(rustc *)` |
| dart | `Bash(dart *)` |
| swift | `Bash(swift *)`, `Bash(swiftc *)` |

The selftest proves, for each language case, that the fixture alone fails `behaviour`, every
`solution*/` passes every check three times in a row (the Swift check is timing-based), `naive/`
fails `behaviour`, and every `wrong-*/` fails. The read-first rule does not apply: it starts from
`discover --package`, which takes no toolchain, so `read-first-rule` and the selftest skip
language cases and print one line saying so. A language case's `readFirst` is written by hand, and
is the page that says what changed.

The eight cases were found and proved by running each toolchain on the machine that built them:
`naive/` fails on the post-cutoff toolchain, and for the three Python cases and
`lang-go-json-field` the same `naive/` passes on the release before (Python 3.14, Go 1.26.0). The
two new-feature cases fail on any version by design. For Dart, Rust, and Swift no older toolchain
was installed, so the old behaviour rests on the release notes (and, for Rust, on the source at tag
1.99.0).

| Case | Language (release) | Kind of change | What `naive/` does | Package documents it |
|---|---|---|---|---|
| `lang-py-strptime` | Python 3.15 (2026-10-09) | A break that shows only when the code runs: `strptime` with `%d` and no year now raises `ValueError` (a hidden `DeprecationWarning` before). | Parses the syslog timestamp with `datetime.strptime(ts, "%b %d %H:%M:%S").replace(year=year)`, which raises on every line. | types |
| `lang-py-argparse` | Python 3.15 (2026-10-09) | A break that shows only when the code runs: `add_argument('-o', '-output')` now stores to `output`, not `o`. | Reads `a.i`, `a.o`, `a.q`, and `a.s`, which raises `AttributeError`. | types |
| `lang-py-base64url` | Python 3.15 (2026-10-09) | A silent behaviour change: `urlsafe_b64decode` no longer requires padding. | Validates by catching the decoder's exception, so unpadded signatures are now accepted. | docs |
| `lang-go-json-field` | Go 1.27 (2026-08-19) | A silent behaviour change: `encoding/json` is backed by v2, and `UnmarshalTypeError.Field` now includes array indexes and map keys (`servers.1.port`, `limits.mem`). The release notes do not mention it. | Looks up `Help[te.Field]`, which misses, so the error has no help text. | none |
| `lang-go-generic-method` | Go 1.27 (2026-08-19) | A new feature the natural solution needs: methods may declare their own type parameters. | Writes a package-level `Map` function because methods could not have type parameters, so a chained `.Map(...)` does not compile. | types |
| `lang-dart-mtime` | Dart 3.13 (2026-08-12) | A silent behaviour change: file timestamps keep microseconds. | Stores milliseconds in the manifest and compares with `isAfter`, so every file is reported changed on every run. | types |
| `lang-rust-escape-debug` | Rust 1.100 (2026-11-12) | A silent behaviour change: `str::escape_debug` escapes every grapheme extender, not only a leading one. | Uses `value.escape_debug()`, which now escapes combining marks and viramas inside names. | types |
| `lang-swift-cancel-cleanup` | Swift 6.4 (2026-09-14) | A new feature the natural solution needs: task cancellation shields, and `await` in `defer`. | Closes the connection in a do/catch; `close()` gives up when the task is cancelled, so the connection stays open. | types |

How each check runs (the hidden files are under `checks/`, copied in after the agent exits):

- Python: `python3 __eval__/check.py <module>` loads the agent's module by path and compares
  results exactly.
- Go: the hidden `check_test.go` is copied into the package under test and run with
  `go test -count=1 -run '^<its test>$'`, so the agent's own tests are not run (they are still
  compiled with the package).
- Dart: the hidden `check.dart` is copied beside `sync.dart` and run with `dart run check.dart`.
- Rust: `__eval__/check.sh` copies `src/logfmt.rs` beside the hidden `check.rs`, compiles it with
  `rustc --edition 2024`, and runs it.
- Swift: `__eval__/check.sh` compiles every source of the package's `Transfer` target with the
  hidden `main.swift` (`swiftc -swift-version 6`) and runs it.

Their packs bind `{ "ecosystem": "toolchain", "name": <toolchain> }` with no version, so the
fixture's version file decides it:

| Pack | Cases | Sources | `readFirst` | Pages (full, changes) |
|---|---|---|---|---|
| `python` | the three `lang-py-*` | `python/cpython` at `v{version}.0`: `Doc/whatsnew/{version}.rst` and the `datetime`, `argparse`, `base64`, `re`, `json`, `pathlib`, `logging`, and `unicodedata` library pages | `pages/whatsnew/3.15.md` | 9, 1 |
| `go` | the two `lang-go-*` | `golang/website` at commit `0eef789c9f9a` (the repository has no tags): `_content/doc/go{version}.md`; `golang/go` at `go{version}.0`: `doc/go_spec.html` | `pages/go1.27.md` | 2, 1 |
| `dart` | `lang-dart-mtime` | `dart-lang/sdk` at `{version}.0`: `CHANGELOG.md` | `pages/CHANGELOG.md` | 1, 1 |
| `rust` | `lang-rust-escape-debug` | `rust-lang/rust` at `{version}.0`: `RELEASES.md` | `pages/RELEASES.md` | 1, 1 |
| `swift` | `lang-swift-cancel-cleanup` | `swiftlang/swift` at `swift-{version}.0-RELEASE`: `CHANGELOG.md`; `swiftlang/swift-book` at `swift-{version}-fcs`: the `Concurrency`, `Statements`, and `RevisionHistory` pages; `swiftlang/swift-evolution` at commit `58a97fabc723`: SE-0504 and SE-0493 | `pages/CHANGELOG.md` | 6, 1 |

`readFirst` was set by hand from the built manifest, to the page that says what changed. Each
change the cases rest on is stated on that page, except `lang-go-json-field`'s: the Go 1.27 notes
say only that `encoding/json` is now backed by v2 and that error text may differ, not that
`UnmarshalTypeError.Field` changed, so no page in the pack states the answer. The Swift book at
`swift-6.4-fcs` documents neither feature the Swift case needs; the changelog and the two
proposals do.

Every library case pins TypeScript 6.0.3, Vitest 4.1.12, and `@types/node` 24.19.2 (SvelteKit 3
needs TypeScript 6; one version everywhere keeps the toolchain out of the comparison).

Each library case's `pack.json` takes the docs from the library's own repository at the tag
matching the pinned version, bound to the dependency so the lockfile decides the version, with two
exceptions: the Hono website has no tags, so its pack is pinned to a commit (and to version
4.13.16, next to its dependency binding), and `stripe-23` adds three `docs.stripe.com` API
reference pages that serve Markdown but are not versioned (they matched 23.1.0's API version when
the case was written). Every library case pack's `readFirst`, and the change documents added to its
taken paths, come from one mechanical rule, described next.

## Read-first pages

A recipe can mark up to five pages to read first (`packs.<id>.readFirst`). The pack index lists
them at the top, and the session-start hook names the first two for a library newer than the
model's training data. The plugin's `add-docs` skill tells a planner to always find the page that
says what changed and mark it. An eval whose packs skip that step under-measures the product; an
eval whose read-first pages were picked by someone who had read the tasks over-measures it. So
every library case's `readFirst` is the output of one rule, applied the same way to every case,
controls included, and fixed without looking at any task. The rule does not apply to a language
case (see **Language cases**).

### The rule

1. **Evidence.** Run `llm-docs discover --package npm:<name>@<version>` for the case's library at
   its pinned version and take its `changeDocuments` at the matched tag. When the recipe takes no
   source from that repository, list the change documents in the source the recipe does take, at
   its pinned ref, with the same name patterns discover uses (`findChangeDocuments` in
   `src/core/package-discovery.ts`). Only `hono-4-13` needs this: its pack reads the untagged
   `honojs/website` at a commit, while discover's evidence is about `honojs/hono`.
2. **Additions.** A change document outside every path the recipe takes from that repository is
   added to the first such source's `paths`, as a single file, because a planner following the
   skill includes it. Nothing that is not a change document by those name patterns is added.
3. **Candidates** are the change documents that are pages in the built pack. One that a source's
   `include` globs leave out is not a candidate.
4. **Major versions.** A path names a major version as `v<N>` with no letter or digit before it
   (so also inside a segment such as `docs-v3`), `<N>.x`, `-<N>`, or a range `v<A>-to-v<B>` or
   `<A>-to-<B>` (naming both), each number with no digit after it; a `YYYY-MM-DD` date names
   none. A candidate whose repository path names one or more majors, none of them the pinned
   version's major, is dropped: a guide written for another major is not the page that says what
   changed on the way to the pinned version. A candidate that names no major stays. This step
   looks at version numbers only, never at a task, and it drops a candidate, not an addition
   from step 2.
5. **Order.** Migration and upgrade guides first (patterns `migration`, `migrating`, `migrate`,
   `upgrade`, `upgrading`), then `breaking`, then `whats-new`, then release notes
   (`release-notes`, `releases`), then changelogs and history (`changelog`, `changes`, `history`).
   The pattern is the one discover reports for the file. Within a group, a path that names the
   pinned major version (as in step 4) comes first, then shallower paths before deeper ones, then
   code-unit order. Paths are repository paths.
6. **Choice.** The first three candidates become `readFirst`, each a whole page.
7. A case with no candidate gets no `readFirst`.

**One refinement, before any arm ran.** The rule was refined once, on 2026-11-22, before any arm
had been run: step 4 was added because the first version selected guides written for other major
versions (the Hono 4.13.16 pack's only read-first page was `migrating-to-v5.md`, and both Zod
4.6.7 packs led with the Zod 3 migration guide under `docs-v3/`). The refinement does not consult
the tasks: it compares the version numbers in a path with the pinned version's major, the same
way for every case, controls included.

**Why no fragments.** A read-first target may name one heading with `#fragment`. A fragment is the
one part of a target that could be aimed at a task's answer, such as the `Linkification` section of
a migration guide, so the eval never uses one. A whole page is what a planner who has not seen the
task would mark.

### The check

The rule is code, `evals/lib/read-first-rule.ts`, run as `npm run eval -- read-first-rule`. It
computes every case's output from discover's JSON and the prepared pack's manifest, prints the
table below, and exits 1 when a `pack.json` differs from it. With `--write` it updates each
`pack.json`. Writing an addition removes `readFirst`, because a new path can move every page (the
source's common root changes): prepare those packs again, then run `--write` once more. The
committed values are its output, and the selftest runs the same check, so a `readFirst` edited by
hand, a fragment, or a change document dropped from `paths` fails the selftest. The check reads
the prepared packs' page lists, so run `prepare-packs` before `selftest`.

The evidence is cached per case in `evals/.cache/read-first/<case>.json`: discover's JSON exactly
as `llm-docs discover --package` prints it, and for `hono-4-13` the source listing. An entry is
reused while the case's library and version (and, for a listing, the source's repository and ref)
are unchanged, and fetched again otherwise. `npm run eval -- read-first-rule --refresh` refetches
every entry; deleting the directory does the same on the next run. Like the rest of
`evals/.cache/`, it is git-ignored, so a fresh clone fetches the evidence once (registry and git,
no model quota).

### What the rule chose

The answer page is the page that states what the task needs: the one the case's `notes` cite, or,
where the notes cite only `node_modules`, the pack page that states the change (marked "found by
search"). Where several pages state it, each is listed. (a) means it is a read-first page, (b) in
the pack but not read-first, (c) not in the pack.

| Case | `readFirst`, in order | Added to taken paths | Answer page |
|---|---|---|---|
| `stripe-23` | `pages/CHANGELOG.md` | none | `pages/CHANGELOG.md` (a); `pages/api/checkout/sessions/create.md`, `pages/api/subscriptions/pause.md` (b, found by search) |
| `mcp-sdk-v2` | `pages/docs/migration/upgrade-to-v2.md`, `pages/skills/mcp-typescript-sdk-upgrade-to-v2/SKILL.md`, `pages/upgrade-to-v2-references/auth.md` | `packages/{client,codemod,core,core-internal,server,server-legacy}/CHANGELOG.md`, `packages/middleware/{express,fastify,hono,node}/CHANGELOG.md`, `test/{conformance,e2e,helpers,integration}/CHANGELOG.md`, `skills/mcp-typescript-sdk-upgrade-to-v2/SKILL.md` | `pages/docs/servers/logging-progress-cancellation.md`, `pages/upgrade-to-v2-references/protocol-ctx.md` (b, found by search; the read-first `SKILL.md` maps `extra.*` to `ctx.mcpReq.*` in one table row but does not say how to report progress) |
| `sveltekit-3` | `pages/documentation/docs/60-appendix/35-migrating-to-sveltekit-3.md`, `.../40-migrating.md`, `pages/packages/adapter-auto/CHANGELOG.md` | `packages/adapter-{auto,bun,cloudflare,netlify,node,static,vercel}/CHANGELOG.md`, `packages/{enhanced-img,package}/CHANGELOG.md`, `packages/kit/CHANGELOG.md`, `packages/kit/CHANGELOG-pre-1.md` | `.../35-migrating-to-sveltekit-3.md` (a); `pages/documentation/docs/30-advanced/20-hooks.md` (b); both found by search |
| `zod-4-6` | `pages/docs/content/v4/changelog.md` | `packages/docs-v3/CHANGELOG.md`, `packages/docs-v3/MIGRATION.md` | `pages/docs/content/blog/zod-4-6.md`, `pages/docs/content/api.md` (b, found by search) |
| `effect-4` | `pages/migration/v3-to-v4.md`, `pages/MIGRATION.md`, `pages/migration/cause.md` | `packages/{effect,opentelemetry,vitest}/CHANGELOG.md`, `packages/ai/anthropic/CHANGELOG.md` | `pages/migration/v3-to-v4.md` (a); `pages/migration/error-handling.md` (b); both found by search |
| `hono-4-13` | none | `docs/guides/migrating-to-v5.md` | `pages/middleware/builtin/method-not-allowed.md`, `pages/api/routing.md` (b, found by search) |
| `zod-4-6-datetime` | as `zod-4-6` | as `zod-4-6` | `pages/docs/content/blog/zod-4-5.md`, `pages/docs/content/api.md` (b) |
| `sveltekit-3-redirect` | as `sveltekit-3` | as `sveltekit-3` | `.../35-migrating-to-sveltekit-3.md` (a); `pages/packages/kit/CHANGELOG.md` (b, in the pack only because the rule added it) |
| `effect-4-partition` | as `effect-4` | as `effect-4` | `pages/migration/v3-to-v4.md` (a); `pages/packages/effect/CHANGELOG.md` (b, in the pack only because the rule added it) |
| `mcp-sdk-v2-tools` | as `mcp-sdk-v2` | as `mcp-sdk-v2` | `pages/upgrade-to-v2-references/behavioral-changes.md`, `pages/docs/clients/calling.md` (b); `pages/packages/server/CHANGELOG.md` (b, in the pack only because the rule added it) |
| `markdown-it-15` | `pages/docs/migration/migration_v15.md`, `pages/CHANGELOG.md` | none | `pages/docs/migration/migration_v15.md`, `pages/CHANGELOG.md` (a) |
| `i18next-27` | `pages/CHANGELOG.md` | none | `pages/CHANGELOG.md` (a) |
| `ctrl-stripe-14` | `pages/CHANGELOG.md` | none | control |
| `ctrl-zod-3` | `pages/MIGRATION.md`, `pages/CHANGELOG.md` | `CHANGELOG.md`, `MIGRATION.md` | control |
| `ctrl-markdown-it-13` | `pages/docs/4.0_migration.md`, `pages/docs/5.0_migration.md`, `pages/CHANGELOG.md` | none | control |
| `ctrl-date-fns-2` | `pages/docs/upgradeGuide.md`, `pages/CHANGELOG.md` | `CHANGELOG.md` | control |

`...` stands for `pages/documentation/docs/60-appendix`. Every case but `hono-4-13` got read-first
pages, and no answer page is outside its pack. Seven of the twelve post-cutoff cases have an answer
page among
the read-first pages (`stripe-23`, `sveltekit-3`, `effect-4`, `sveltekit-3-redirect`,
`effect-4-partition`, `markdown-it-15`, `i18next-27`), four of them `type-invisible`. In the other
five (`mcp-sdk-v2`, `zod-4-6`, `hono-4-13`, `zod-4-6-datetime`, `mcp-sdk-v2-tools`) every answer
page is in the pack but not read-first.

Read this table as an upper bound on what read-first can explain: in a case marked (b) or (c) for
every answer page, any pack advantage cannot come from the read-first list pointing at the answer.

### What applying the rule exactly does

These are consequences of the rule, kept because adjusting them case by case is exactly the
tuning the rule exists to prevent:

- **No read-first page for Hono.** The only change document in the Hono website at the pinned
  commit is `docs/guides/migrating-to-v5.md`, the guide to Hono v5's breaking changes (a release
  candidate when the commit was made). Step 4 drops it, so the Hono 4.13.16 pack marks no
  read-first page; the guide is still a page in the pack, because step 2 added it.
- **Zod 4's guide alone.** In `zod-4-6` and `zod-4-6-datetime` step 4 drops the Zod 3 migration
  guide and changelog (`packages/docs-v3/`), leaving Zod 4's own migration guide, which is named
  `changelog.mdx` and is about the move from Zod 3, not about 4.5 or 4.6.
- **A version written another way.** Step 4 reads only the forms it lists. `ctrl-markdown-it-13`
  still marks the 4.0 and 5.0 migration guides (`docs/4.0_migration.md`), because `4.0_` is none
  of those forms.
- **Other packages' changelogs.** In monorepos every listed changelog outside the taken folders is
  added: the SvelteKit adapters' and `@sveltejs/package`'s, the MCP SDK's test helpers' and
  middleware packages', and Effect's OpenTelemetry, Vitest, and Anthropic packages'. They are
  pages in the pack arms only. With step 4 dropping the SvelteKit 2 guide and
  `CHANGELOG-pre-1.md`, the third SvelteKit read-first page is `@sveltejs/adapter-auto`'s
  changelog: changelogs at one depth are ordered by path, and `adapter-auto` sorts before `kit`.
- **discover lists at most 20.** Effect has 49 change documents at `effect@4.1.2` and the MCP SDK
  29 at `v2.4.0`; the rest are not seen, so not added. A full listing of both trees, ordered by the
  same rule, chooses the same three pages.
- **Paths moved.** Adding a file outside a source's folder moves that source's common root, so the
  SvelteKit pages now sit under `pages/documentation/docs/`, Zod 4's under `pages/docs/content/`,
  and the MCP SDK's `docs/` under `pages/docs/`.

## Layout of a case

```
evals/cases/<id>/
  case.json        id, title, kind, stratum, packageDocumentsAnswer, library and release date,
                   notes (with the node_modules file:line evidence), maxTurns, timeoutSeconds;
                   a language case adds toolchain and versionFiles
  task.md          the prompt
  fixture/         the starting project (exact versions, committed package-lock.json; a language
                   case's version files and whatever the prompt says already exists)
  checks/          hidden graders: checks.json, tsconfig.eval.json, vitest.eval.config.mts, __eval__/
                   (a language case: checks.json and its hidden check files)
  solution/        reference solution overlaid on the fixture; must pass every check
  solution-<why>/  more correct answers, each one a shape a check once rejected; must pass
  wrong-<why>/     wrong answers a check must keep rejecting (often one it once let through)
  naive/           coding-from-memory solution (post-cutoff cases only); must fail as the stratum says
  pack.json        the llm-docs.json pack entry for this case
```

`checks/checks.json` lists the checks in order. A run passes only when every check passes:

- `deps-unchanged`: `package.json` and `package-lock.json` are byte-identical to the fixture.
- `no-type-suppressions`: no `as any`, `: any`, `as unknown as`, or `@ts-` directive in the
  TypeScript and Svelte files under `src/`. Only code counts: the scan tokenizes each file with the
  TypeScript compiler the fixture pins and blanks comments and string, template, regex, and JSX
  text first, so prose such as "callers may pass any value: any string" is not a suppression, and
  a `@ts-` directive counts only inside a comment. In a Svelte file it reads the `<script>` blocks
  and the `{...}` expressions in the markup.
- `typecheck`: `tsc --noEmit -p tsconfig.eval.json`, a self-contained config over `src/` and the
  hidden type tests, so editing the project's `tsconfig.json` cannot loosen it.
- `behaviour`: Vitest over the hidden `__eval__/*.check.ts` files (a language case: its hidden
  check, run with the installed toolchain).

Test files the agent writes for itself (`*.test.ts`, `*.spec.ts`, `*.test-d.ts`, `__tests__/`
under `src/`) are not graded unless the task says so: the suppression scan skips them and every
`tsconfig.eval.json` excludes them (the selftest's lint checks the exclude list), and the hidden
Vitest config runs only `__eval__/`.

Check programs resolve from the workspace's `node_modules/.bin` only, so a global tool can never
stand in for the pinned one. A language case has no `node_modules`: its check program (the
toolchain, or `sh` for a check script) is resolved on `PATH`.

## Running

All commands run from the repository root. `npm run eval -- <command>` is the same as
`npx tsx evals/run.ts <command>`.

```sh
# 1. Build what each arm's workspace gets with the llm-docs CLI (v3: init, sync, verify, status),
#    and store each case's expected hook note per arm from the plugin (needed for the note,
#    changes, and plugin arms; pass the same --model as the run, default claude-opus-5-5).
npm run eval -- prepare-packs --llm-docs dist/cli.js --plugin-dir plugin

# 2. Prove every case is gradable: fixture alone fails, every solution*/ passes, every wrong-*/
#    fails, naive/ fails the way the case's stratum says (type-visible: typecheck fails;
#    type-invisible: typecheck passes and behaviour fails; language: behaviour fails; nothing
#    else may fail), a language case's solutions pass three times in a row, the suppression scan
#    flags exactly what tests/fixtures/evals/suppressions/expected.json lists, and every library
#    case's pack.json follows the read-first rule (against the packs from step 1). Needs network
#    for npm, and for the read-first evidence until it is cached; templates are cached per
#    lockfile (a language case's per fixture). Language cases need their toolchains installed.
npm run eval -- selftest

# The read-first rule on its own: print its table, or --write it into every pack.json.
npm run eval -- read-first-rule

# 3. See the run matrix and an estimated cost before spending anything.
npm run eval -- plan --runs 5

# 4. Prove the pipeline end to end on one case, once per arm. Note your usage meter before
#    and after. Results land in evals/results/smoke-<timestamp>/.
npm run eval -- smoke --plugin-dir plugin

# 5. Run. Results land in evals/results/<timestamp>/.
npm run eval -- run --runs 5 --plugin-dir plugin \
  --max-budget-usd-per-run 3 --max-total-usd 150
```

### What prepare-packs builds

For each case, `prepare-packs` builds three directories under `evals/.cache/`, each from the
fixture's `package.json` and `package-lock.json`, or a language case's `versionFiles` (so a
`dependency` binding resolves the pinned version), and an `llm-docs.json` with `packsDir`
`agent-docs` and `agentFiles` `["AGENTS.md"]`:

| Directory | Arms | `packs` in `llm-docs.json` | Commands |
|---|---|---|---|
| `packs/<case>/` | `pack`, `plugin` | the case's `pack.json` entry | `init`, `sync`, `verify`, `status --json` |
| `packs-note/<case>/` | `note` | `{}` | `init`, `sync`, `status --json` |
| `packs-changes/<case>/` | `changes` | the case's recipe narrowed to its read-first pages | `init`, `sync`, `verify`, `status --json` |

`status --json` warms the release-date cache the hook reads. Every directory must end with an
`AGENTS.md` holding both managed block markers, and each pack's `index.md` must exist.

The changes pack is derived from the full pack, never guessed. Its pages are the case's
`readFirst` targets with any `#fragment` dropped. For each of them, the full pack's
`manifest.json` says which source produced it and under which stored path: a page's first
`outputs[].sources` entry is `<source index>:<stored path>` ([the manifest
reference](../docs/manifest.md#outputs)). The derived recipe is the case's recipe with each
source's `include` set to exactly those stored paths, the sources that produce no read-first page
removed, and every other field (title, description, dependency, site, license, readFirst, and the
source's own `paths`, so stored paths and page paths do not move) kept. After the build, the set
of `pages/` outputs in the derived manifest must equal the set of read-first pages; when it does
not, or when the full manifest does not name a read-first page's source and stored path,
prepare-packs fails that case and names the pages. A case with no read-first pages gets a
`packs-changes/<case>/` built exactly like `packs-note/<case>/`, with no pack.

With `--plugin-dir`, each directory also gets its expected hook note (see **Expected hook note**
below), and each gets its own `.prepared.json` stamp. `run` and `smoke` check the stamps of the
directories the selected arms need, and refuse to start when one is missing or was prepared from
another `pack.json`.

Options for `run`: `--cases <globs>` (comma-separated, `*` wildcards), `--arms
baseline,note,changes,pack,plugin` (any of them; they always run in this order), `--runs N`,
`--model <id>` (default `claude-opus-5-5`; pass a full model id, because every arm asserts that
the session's `system/init` event reports exactly this string, and the note, changes, and plugin
arms need expected hook notes prepared for it), `--concurrency N` (default 2),
`--max-budget-usd-per-run X` (passed to `claude --max-budget-usd`, default 3), `--max-total-usd Y`
(no new run starts once spent plus the in-flight caps would pass it), `--plugin-dir <path>`
(required for the note, changes, and plugin arms), `--effort <level>`, `--resume <results dir>`
(see below), `--keep-workspaces`.

`smoke` takes the same options except `--cases`, `--runs`, and `--concurrency`: it runs one case
(`--case <id>`, default `zod-4-6`) once per selected arm, in the order above, with exactly the
`run` invocation, one session at a time. For every session it prints the outcome, cost, turns,
wall time, whether docs were consulted, the SessionStart hook output (arms with the plugin), and
every arm assertion with pass or fail.
It exits 1 if any session could not run or any assertion failed, so a green smoke check is the
proof that a full run will measure what its arms claim. `plan` describes it too.

### Running out of quota, and resuming

On a subscription with extra usage off, a long run can hit the plan's usage limit partway. The
runner never grades such a session (see **Could not run** below), and on the first session that
ends with a usage limit, an authentication failure, or a billing error it stops:

- no new run starts; runs already in flight finish and are recorded (usually as infra errors for
  the same reason);
- `results.json` and `summary.md` are written;
- it prints what happened, how many planned runs have a graded result, the reset time when Claude
  Code reported one, and the exact command to continue (the same options plus
  `--resume <results dir>`);
- it exits with code 4 (0 is done, 1 is a failed smoke check, 2 a usage error, 3 a crash, 130 an
  interrupt).

A rate limit (a short throttle, not the plan quota), an overload, or a plugin hook that gave the
agent nothing does not stop the run: the affected run is retried in place after 30 seconds and
again after 120 seconds, and only then recorded as an infra error. `attempts` in the row says how many sessions it took.

`--resume <results dir>` reruns exactly the runs that have no row or an infra-error row there, in
the original order (repeat first, then case, then arm). Pass the same `--cases`, `--arms`,
`--runs`, and `--model` as the first segment, which the printed command does for you.

Each run gets a fresh workspace under the OS temp directory
(`llm-docs-evals/<timestamp>/<case>-<arm>-<n>`), a copy of the cached `node_modules`, and what
prepare-packs built for its arm: `.cache/packs/<case>` for `pack` and `plugin`,
`.cache/packs-note/<case>` for `note`, `.cache/packs-changes/<case>` for `changes`, and nothing
for `baseline` (its `agent-docs/`, `AGENTS.md`, and `llm-docs.json`; never the stored note or the
stamp). The agent's stream is saved as `transcript.jsonl`,
then the checks are copied in and run. Ctrl-C stops every child process group; rerun with
`--resume` to finish.

The exact agent invocation is:

```sh
claude -p "<task.md>" --model claude-opus-5-5 --setting-sources project --strict-mcp-config \
  --no-session-persistence --max-turns <case maxTurns> --max-budget-usd <cap> \
  --output-format stream-json --verbose --include-hook-events \
  --permission-mode acceptEdits --permission-prompts none \
  [--plugin-dir <plugin>]  # note, changes, and plugin arms only
  --allowedTools Read Glob Grep Edit Write WebSearch WebFetch "Bash(npx tsc)" "Bash(npx tsc *)" \
    "Bash(npx vitest)" "Bash(npx vitest *)" "Bash(npm test)" "Bash(npm test *)" "Bash(ls)" \
    "Bash(ls *)" "Bash(cat *)"
```

(for a language case, the `--allowedTools` list in **Language cases**) with `ANTHROPIC_MODEL` set to the `--model` value, stdin from `/dev/null`, its own process group,
and the case's wall timeout.

## Reading results

`evals/results/<timestamp>/` holds:

- `summary.md`: pass rate per arm overall, per case kind, per stratum, and per case (with each
  case's stratum and whether the installed package documents the answer); mean and total cost,
  mean turns, docs-consulted rate, the share of runs that read installed code and that ran their
  own test, and web-use rate per arm; one line per run, with whether it read installed code and
  how many times it ran its own test; and, when the run
  was resumed or stopped, a table of segments with each one's wall-clock window. Read the
  `type-invisible` row first: it is where a pack has the most room to matter, and the
  `type-visible` and `control` rows show what happens where it has less.
- `results.json`: the same aggregates (`overall`, `byKind`, `byStratum`, `byCase`), each case's
  stratum and `packageDocumentsAnswer` in `meta.cases`, the segments, and one row per run (with its
  case's `stratum`) with the session
  outcome, attempts, every arm assertion with its evidence, every check's result and output tail,
  cost, turns, duration, tool call counts, the `agent-docs/` paths the agent touched,
  `installedCodeRead`, `ownTestRuns`, and `typeCheckRuns` (below), web searches and fetches,
  permission denials, each SessionStart hook's outcome and output, and the
  session's model, tools, MCP servers, and plugins as reported by Claude Code. `meta.allowedTools`
  is the library cases' tool list (left out when the run has none), and
  `meta.languageAllowedTools` maps each selected language case's toolchain to its list.
- `runs/<run id>/`: `transcript.jsonl`, `stderr.log`, `run.json`, and `files.json` mapping every
  file the agent created or changed to its content (a map, not loose copies, so test files the
  agent wrote never reach the repository's own test runner). Build output a toolchain writes into
  the project (directories named `target`, `.build`, `.dart_tool`, or `__pycache__`, at any
  depth) is left out.

Definitions:

- **Pass**: every check passed, in a run that is not an infra error.
- **Outcome**: how the session ended, decided in one place (`classifyOutcome` in
  `lib/transcript.ts`) from the stream's structured fields (`result.subtype`, `terminal_reason`,
  `is_error`, `api_error_status`, the error code on Claude Code's API-error message, and
  `rate_limit_event`), falling back to Claude Code's documented message text only where those
  cannot tell two cases apart (a 429 is both the plan quota and a short throttle). These are
  graded as they stand: `completed`, `turn-cap`, `budget-cap`, `timeout` (the case's wall
  timeout), and `ended-early` (Claude Code stopped the turn for a reason of the session's own
  making, such as an overflowing context; the reason is recorded, and excluding it would hide a
  treatment that causes it).
- **Could not run**: the service or the account ended the session, not the agent: `usage-limit`,
  `rate-limit`, `overloaded`, `auth`, `billing`, `network`, `model-unavailable`,
  `startup-failure`, `no-result` (the process ended without a result), or `api-error` (any other
  API error). Any session that ended on an API error counts, whatever it did before, so a session
  with no turns and no changes is never a fail. A session killed at the wall timeout while Claude
  Code was still retrying the API counts too. These are never graded.
- **Arm assertions**: before grading, every run proves it ran its arm, from the workspace as it
  was handed to the agent and from the session's `system/init` and hook events:
  - `baseline`: no `agent-docs/`, no `llm-docs.json`, no `AGENTS.md`;
  - `note`: `llm-docs.json` exists and there is no `agent-docs/<pack>` directory;
  - `changes`: `llm-docs.json` exists; for a case with read-first pages
    `agent-docs/<pack>/index.md` exists, and for a case without any there is no
    `agent-docs/<pack>` directory;
  - `pack` and `plugin`: `agent-docs/<pack>/index.md` and `manifest.json` exist and `AGENTS.md`
    holds both managed block markers;
  - `baseline` and `pack`: no plugin loaded besides Claude Code's built-in ones (reported with
    `path: "builtin"`), and no SessionStart hook ran;
  - `note`, `changes`, and `plugin`: exactly the plugin named in
    `<plugin-dir>/.claude-plugin/plugin.json` loaded, at least one SessionStart hook started and
    finished with outcome `success`, and the `additionalContext` the hooks gave the agent equals
    the case's expected hook note for that arm (below). Hook events do not name their plugin;
    since the other arms prove no SessionStart hook runs without the plugin, every SessionStart
    hook in these arms is the plugin's. A hook that never started, or started and never reported
    back, fails; so does one that gave nothing (it missed its 1.5 second deadline) or a different
    note (for example another model's cutoff), because either way the run would be graded as a
    run with the plugin without the plugin's treatment. The `note` and `changes` arms may expect
    an empty note: then a hook that gave nothing is exactly right, passes, and is never retried,
    and a hook that gave any text fails;
  - every arm: the session reports the requested model and no MCP servers.

  A failed assertion makes the run an infra error named after it, for example
  `arm-invalid: plugin hook did not run` or `arm-invalid: plugin hook gave the agent nothing, not
  the expected 842-character note` (the `zod-4-6` note). The row's `hookNote` holds the verdict (`match`, `empty`,
  `different`), the expected note, and what the hooks actually gave. A hook that gave nothing,
  when nothing else was wrong, is a transient condition of the machine and is retried in place
  like a rate limit (after 30 seconds, then 120 seconds); a different note is not retried.
- **Expected hook note**: what the plugin's session-start hook must inject for a case in one arm
  that loads the plugin. `prepare-packs --plugin-dir <plugin>` computes it once the arm's
  directory is built and its release-date cache is warm: it lays out the arm's workspace under
  the OS temp directory (the fixture's `package.json` and lockfile, or a language case's version
  files, and the arm's `agent-docs/`,
  `llm-docs.json`, and `AGENTS.md`), runs `node <plugin>/bin/llm-docs.mjs hook session-start`
  there with the headless payload on stdin, `CLAUDECODE=1`, `ANTHROPIC_MODEL`, and
  `LLM_DOCS_CACHE_DIR` as a session gets them, and repeats it (at most 5 times) until two
  consecutive runs print the same note. The plugin arm's note must be non-empty. The note and
  changes arms' note may be empty, stored as `""`: a control case whose dependencies all predate
  the cutoff gives the hook nothing to say. Each note is stored as `expected-hook-note.json` in the
  arm's directory (`.cache/packs/<case>/` for `plugin`, `.cache/packs-note/<case>/` for `note`,
  `.cache/packs-changes/<case>/` for `changes`) with the model and a hash of the plugin's
  `bin/llm-docs.mjs`; `run` and `smoke` refuse an arm when a case has no note for it, or one for
  another model or another build of the plugin. The note holds only project-relative paths, and
  with a known cutoff its release windows do not depend on the date (the hook uses "recent" only
  when it knows no cutoff), so nothing in it is normalized; prepare-packs fails a case whose note
  names the temporary workspace path. Where the workspace holds the case's pack (`plugin`, and
  `changes` for a case with read-first pages), it also fails a case whose note does not list the
  case's pack as pinned docs for a library released after the cutoff (post-cutoff cases), or
  lists the case's library or the pack's bound dependency among the dependencies with no pinned
  docs, because either means the pack recipe is bound to the wrong thing. A listed dependency
  whose installed `package.json` names one of the pack's source repositories, other than the
  dependency the pack binds, is a warning instead: a pack binds a single dependency today, so both
  MCP cases list `@modelcontextprotocol/client` without pinned docs although the MCP pack covers
  it. Where the workspace holds no pack (`note`, and `changes` for a case without read-first
  pages), a post-cutoff case's note must list the case's library among the dependencies with no
  pinned docs and have no pinned docs section; a control case's note may say anything, or
  nothing.
- **Docs consulted**: a Read, Grep, Glob, or Bash call named a path under `agent-docs/`.
- **Read installed code** (`installedCodeRead`): any Read, Grep, or Glob call's path or pattern,
  or any Bash command, named a path under `node_modules/` that is not a `package.json` file and is
  not under `node_modules/.bin/`. Reading only a version number from `package.json` does not
  count. `summary.md` shows the share of graded runs where it is true.
- **Ran its own test** (`ownTestRuns`): the number of Bash calls whose command runs `vitest` or
  `npm test`, directly, through `npx`, or by a path to it, at the start of the command or after
  `;`, `&`, `|`, or `(`. `summary.md` shows the share of graded runs with at least one.
- **Type-check runs** (`typeCheckRuns`): the number of Bash calls whose command runs `tsc` in the
  same sense. It is in `results.json` only.
- These three measurements see tool calls, not what the agent understood: a Read of a `.d.ts`
  file says nothing about whether the agent used what it read, and a Vitest run says nothing about
  whether the test it ran checks the behaviour that changed. `installedCodeRead` only knows
  `node_modules`: a library installed anywhere else, or code the agent reached another way, is not
  seen, and a path named for another reason (a Grep pattern that mentions `node_modules/`, an
  `ls`) counts as a read. A test or type check started through a package script that the command
  does not name (`npm run check`) is not counted. A row written by an earlier version of the
  harness has none of these fields and reads as `false` and `0`.
- **In a language case** the same three fields are heuristics over the same tool inputs (a Read,
  Grep, or Glob call's path or pattern, or a Bash command, for `installedCodeRead`; Bash commands,
  in the same sense of "runs", for the two counts), matched per toolchain instead:

  | Toolchain | `installedCodeRead` matches | `ownTestRuns` counts commands that run | `typeCheckRuns` counts |
  |---|---|---|---|
  | python | `/lib/python3.<N>/`, `pydoc`, `help(`, `inspect.getsource`, `inspect.signature`, `__doc__` | `python3` (but not `python3 -m py_compile`) or `pytest` | `python3 -m py_compile`, `mypy`, `pyright` |
  | go | `/libexec/src/`, `/go/src/`, `go doc`, `GOROOT` | `go test`, `go run` | `go build`, `go vet` |
  | rust | `/rustlib/src/`, `rustc --explain`, `cargo doc`, `rustup doc` | `cargo test`, `cargo run`, `rustc` | `cargo check`, `cargo build` |
  | dart | `dart-sdk/lib/`, `dart doc` | `dart run`, `dart test`, `dart <file>.dart` | `dart analyze` |
  | swift | `.swiftinterface`, `.swiftmodule`, `/usr/lib/swift` | `swift run`, `swift test`, `swiftc` | `swift build` |

  They are coarser than the npm ones. Running a scratch script with `python3 -c` counts as a test
  run whatever it does, and a `help(...)` in it also counts as reading installed code; a
  `rustc --explain` counts both as reading the toolchain's docs and as a `rustc` run; a mention of
  `GOROOT` counts as a read. They see tool calls, not what the agent learned.
- **Web used**: at least one WebSearch or WebFetch call. Claude Code 2.1 reads pages through its
  `web-fetch` subagent rather than a top-level WebFetch tool, so launching that subagent counts as
  a fetch (its own nested fetch is not counted twice).
- **Infra error**: the run could not be carried out or did not measure its arm (workspace setup
  failed, `claude` did not start, the session could not run, an arm assertion failed,
  interrupted). These rows are never graded, are excluded from every rate, and are retried by
  `--resume`.

`evals/results/` is git-ignored. Published numbers go into the project README by hand, with the
date, model, Claude Code version, and run count.

## Known limitations

- **Nondeterminism.** The same prompt can pass and fail on consecutive runs. One run per cell is
  a smoke test, not a measurement; use at least five runs per case and arm and read differences
  of one or two runs as noise.
- **Few cases.** Twelve post-cutoff library cases over eight libraries (five `type-visible`, seven
  `type-invisible`), eight language cases over five language releases (three Python 3.15, two Go
  1.27, one each for Dart 3.13, Rust 1.100, and Swift 6.4), and four controls cover common shapes
  (a renamed parameter, a new endpoint, a new subpath export, a new schema type, renamed
  combinators, a new middleware, a changed default, a reversed tuple, a new opt-in, a changed
  error path, a language behaviour change, a new language feature), not the whole space. Several
  cases share a library or a language release, so their results are not independent.
- **How the cases were selected.** The first six post-cutoff cases each exercise the headline
  change of a release, and in five of them code written from memory fails the type check, so the
  compiler itself tells a baseline agent where to look. The suite now deliberately holds both
  strata, so a reader can see where packs do and do not matter instead of one average. The
  `type-invisible` cases were chosen before any arm ran, by criteria fixed in advance: a widely
  used npm library with a release after 2026-06-30 (registry date checked), a change that compiles
  from memory and behaves differently at runtime (shown by running the from-memory code against
  the new release and the last release before the cutoff), a deterministic hermetic check, the
  change stated in the library's own repository at the release tag (so the pack holds it), a task
  that can be asked in product terms, and a task whose natural from-memory answer actually uses
  the changed behaviour. The search read the post-cutoff release notes of the six libraries
  already pinned and of the popular libraries a registry sweep found with a post-cutoff major or
  minor release; the commit that added these cases lists every candidate and its verdict. Every
  qualifying candidate from the libraries the suite already pinned was built (zod, SvelteKit,
  Effect, MCP SDK); from other libraries the two most downloaded qualifying ones were built
  (markdown-it, i18next), to bound the cost of a run. Qualifying candidates left out for that
  reason: envalid 9 (empty values count as missing), toml 5 (unsafe integers throw), and, where
  only some natural answers touch the change, p-queue 10, keyv 6, and rou3. Rejected for a
  criterion: a Hono 4.13 cache-key change (documented only in the untagged website repository),
  msw 3, path-to-regexp 9, and happy-dom 21 (not documented in the repository at the tag),
  solid-js 2 (the behaviour shipped in betas before the cutoff), and he 2 (needs stale type
  definitions pinned to compile).
- **How the language cases were selected.** A separate search read the post-cutoff release notes
  of Python 3.15, Go 1.27, Dart 3.13, Rust 1.100, Swift 6.4, and Node.js 26.x, and proved each
  candidate by running it on the installed toolchain. Twelve qualified and eight were built. Not
  built: a Python 3.15 grapheme-truncation case (rated usable), and three rated weak, a Python 3.15
  email change (the error names the fix), an `await` in `defer` case for Swift, and an
  `int.oneBitCount` case for Dart (in the last two, any correct pre-release answer passes). Swift
  6.4 has no silent or run-time-only change that the search found, so its case is a new feature.
  Node.js 26 had no candidate: every semver-major change shipped in 26.0.0 (2026-05-05), before the
  cutoff, and the search went no further.
- **The language releases are after the cutoff, but most of the changes are not.** Every release
  date is after June 2026, but most of the code landed on development branches before it, and was
  public on GitHub, in betas, or in draft release notes, so a model trained through June 2026 may
  know it. Python 3.15 entered feature freeze at beta 1 in May 2026, so every Python 3.15 change
  predates the cutoff on main. When each change became public (commit dates read with the GitHub
  API when the cases were built):

  | Case | Change became public | Exposure risk |
  |---|---|---|
  | `lang-rust-escape-debug` | PR 158303 merged 2026-08-31 | none |
  | `lang-dart-mtime` | dart-lang/sdk issue 42444 fix referenced 2026-06-18, closed 2026-06-22 | very low |
  | `lang-go-json-field` | `internal/buildcfg: enable JSONv2 as baseline` 2026-05-18 (v2 existed behind GOEXPERIMENT since 2025-04) | low: the `Field` change is not described anywhere the search found |
  | `lang-go-generic-method` | `$GOROOT/doc/go_spec.html` subtitle: "Language version go1.27 (May 26, 2026)" | moderate |
  | `lang-py-strptime` | GH-144570 merged 2026-04-15; the 3.13 `DeprecationWarning` already said "The default behavior will change in Python 3.15" (in models' data since 2024) | moderate to high |
  | `lang-py-argparse` | gh-138697 merged 2025-11-20 | moderate |
  | `lang-py-base64url` | gh-73613 merged 2026-04-04 | moderate |
  | `lang-swift-cancel-cleanup` | SE-0493 accepted 2025-11-04; SE-0504 accepted 2026-02-11 | moderate to high |

  A pass on a case with moderate or high exposure says less than one on `lang-rust-escape-debug`,
  `lang-dart-mtime`, or `lang-go-json-field`.
- **The Swift check is timing-based.** It cancels the upload after 30 ms and relies on sleeps of 5
  to 30 ms inside the fixture's `Connection`. The selftest runs the reference solution three times
  in a row, but a heavily loaded grading machine could still fail a correct answer, or pass a
  wrong one.
- **The Dart and Rust packs hold only the change page.** Their recipes take one file (the SDK
  `CHANGELOG.md`, the Rust `RELEASES.md`), which is also the read-first page, so their `changes`,
  `pack`, and `plugin` arms hold the same page; only the note and the skills differ between them.
- **A blocked type check decides some outcomes.** The agent may run `npx tsc`, but not every
  command a project needs first. `sveltekit-3` type-checks only after `svelte-kit sync`, which is
  not on the allowed list, so in most of its sessions the agent could not type-check and said so.
  In the Sonnet run of 23 November 2026, the sessions that could not check their work passed 2 of
  7 without pinned docs and 8 of 8 with them, and the sessions that could check passed every
  time in every arm. Read a pass-rate difference on that case as a difference under "the agent
  cannot verify its work", not as a difference on the task in general.
- **`lang-py-base64url` was corrected after its first run.** Its hidden check also required an
  empty signature to decode to empty bytes, which the task does not ask for. All 13 failures on
  the case in the first Sonnet and Opus runs were that assertion, and none was the change the
  case measures. The assertion was removed and the case run again on both models (every session
  passed). The first run's rows for this case are not comparable and are left out of published
  numbers.
- **Web contamination.** Every answer is on the public web, which is the point of allowing web
  tools, but it also means the baseline can sometimes find the answer; that is a real competitor,
  not a flaw. Once these cases are published they can also leak into future training data, so
  rotate cases when evaluating later models.
- **effect-4 is weaker evidence.** Effect 4 was in public beta from February 2026, before the
  model's cutoff, so the model may have seen beta-era APIs. A pass there says less than a pass
  on the other post-cutoff cases. `effect-4-partition` is not affected: its change merged on
  2026-09-29, so the betas had the old order.
- **Docs consulted is a heuristic.** It counts explicit tool calls on `agent-docs/` paths. The
  managed block in `AGENTS.md` is always in context in every arm but the baseline (empty in the
  note arm, and in the changes arm of a case with no read-first pages) and is not counted.
- **Cost** is Claude Code's `total_cost_usd`, which is computed at list prices regardless of how
  the account is billed.
- **The plugin hook** reads release dates from a cache that `prepare-packs` warms (via
  `llm-docs status`) and that every arm shares through `LLM_DOCS_CACHE_DIR`; with a cold cache
  the hook could say less. The hook always exits 0 and logs its own errors to `hook.log` in that
  cache, so a hook that failed inside and printed nothing looks the same in the stream as one
  that had nothing to say; check `hook.log` when an arm's hook output is empty. A busy
  machine is enough to cause that: the hook's 1.5 second deadline counts from process start,
  including loading the bundled CLI. With a load average near 100, runs of the hook on prepared
  `hono-4-13` and `mcp-sdk-v2-tools` workspaces took 1.0 to 1.7 seconds, and two of them printed
  nothing (`hook.log`: "stdin did not end within 0 ms", then "missed its 1500 ms deadline"). The
  assertion of every arm with the plugin catches this (the hook's note must equal the expected
  one), and the run is retried in place, but each retry is another session: run on a quiet
  machine. Where the expected note is empty (possible in the note and changes arms only), a hook
  that missed its deadline cannot be told from one with nothing to say, during the run or when
  prepare-packs computes the note.
- **Resumed runs are later in time.** A run stopped by a usage limit and continued with `--resume`
  executes its remaining cells hours or days after the first part, so service drift no longer
  touches all arms alike for those cells. Ordering keeps the damage small (the remaining cells
  run in plan order, so every arm of a repeat is usually in the same segment), and `summary.md`
  lists the wall-clock window of each segment so a reader can see it. When it matters, rerun the
  whole matrix in one sitting.
- **Usage limits are classified from documentation, not observation.** The outcome tests use
  transcripts recorded from real sessions for a completed run, an unknown model, and a rejected
  credential; the usage-limit, rate-limit, overload, billing, and network cases follow the shapes
  in the Agent SDK types and https://code.claude.com/docs/en/errors.md, because they cannot be
  triggered on purpose. A usage limit is recognized by a `rate_limit_event` with status
  `rejected` or by the documented "You've hit your ... limit" wording. If Claude Code changes
  both, the first real usage limit would be classified as `rate-limit` or `api-error`: still
  never graded, but retried and recorded as an infra error instead of stopping the run. The
  smoke check prints each session's outcome, so read the first stopped run's `transcript.jsonl`
  when in doubt.
