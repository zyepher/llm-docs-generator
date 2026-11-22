# llm-docs evals

This suite measures one question: does a pinned docs pack help a fully equipped coding agent
write correct code against library APIs that were released after its training cutoff, and does
it stay out of the way on libraries the agent already knows?

The agent under test is Claude Code running Claude Opus 5.5 (`claude-opus-5-5`, training cutoff
June 2026) in headless mode (`claude -p`). Every case is a small TypeScript project pinned to an
exact library version, a task prompt written the way a developer would ask, and hidden
mechanical checks that run after the agent finishes.

## Arms

Each case runs in three arms. The workspaces are identical except for the treatment.

| Arm | What the workspace contains |
|---|---|
| `baseline` | The fixture project with dependencies installed. No pack, no plugin. |
| `pack` | The same, plus the case's pack in `agent-docs/`, `llm-docs.json`, and an `AGENTS.md` holding only the managed block that `llm-docs sync` writes. |
| `plugin` | The same as `pack`, plus the llm-docs plugin loaded with `--plugin-dir` (session-start hook and skills). |

The fixture has no `CLAUDE.md`, so Claude Code reads `AGENTS.md` as project instructions in the
pack and plugin arms.

## Fairness rules

- Same model, prompt, fixture files, installed `node_modules`, turn cap, budget cap, and wall
  timeout in every arm.
- Same tools in every arm, including WebSearch and WebFetch. Allowed without a prompt: Read,
  Glob, Grep, Edit, Write, WebSearch, WebFetch, and Bash limited to `npx tsc`, `npx vitest`,
  `npm test`, `ls`, and `cat`. Anything else is denied automatically
  (`--permission-prompts none`), so no run can hang on a prompt.
- Isolated settings: `--setting-sources project` keeps the operator's user settings, user
  `CLAUDE.md`, rules, hooks, and installed plugins out of the run; `--strict-mcp-config` with no
  MCP config means no MCP servers in any arm; `--no-session-persistence` keeps runs out of the
  operator's session history. The runner also strips the parent session's `CLAUDE_CODE_*`
  variables from the child environment.
- The graders are hidden: `checks/` is copied into the workspace only after the agent exits.
- The prompt never names the API to use and never hints that a version changed. Every prompt
  ends with the same ground rules: keep it fully typed (no `any` casts or ts-ignore comments), do
  not change `package.json` or install packages, run the type checker.
- Runs are ordered repeat first, then case, then arm, so drift in the model service during a
  long run touches all arms alike.

### Why web tools are allowed in every arm

The realistic alternative to a pinned pack is not an agent with no information, it is an agent
that can search the web and read the vendor's site. A pack only earns its place if it beats
that. Blocking the web in the baseline would inflate the pack's advantage and answer a question
nobody asks. The results record how often each arm used the web, so a pack that merely replaces
browsing (same pass rate, fewer fetches, lower cost) is visible as such.

## Cases

Post-cutoff cases use libraries whose relevant API or behaviour shipped after June 2026. Each one
has a `naive/` solution written the way a model coding from memory would write it, and the
selftest proves the checks reject it.

### Strata

Every case records in `case.json` how visible its change is to an agent that never reads
documentation, and the selftest enforces the label against what `naive/` actually does:

| Stratum | What the from-memory solution does | What the agent's own loop tells it |
|---|---|---|
| `type-visible` | Fails `typecheck` (and usually `behaviour`). | The compiler points at the change, so a careful agent goes looking even without a pack. |
| `type-invisible` | Passes `typecheck`, fails only `behaviour`. | Nothing: the code compiles, and nothing says anything changed. This is where pinned docs and the session-start hook should matter most. |
| `control` | Is simply correct: a library version the model has known for years. | Measures that the pack does not hurt. |

Each case also records `packageDocumentsAnswer`: whether the installed package itself states the
answer an agent needs, in its `.d.ts` or JSDoc (`types`), in prose or agent files it ships such as
a README, CHANGELOG, `AGENTS.md`, or `ai-docs/` (`docs`), or not at all (`none`), with the file and
line cited in `notes`. Every arm can read `node_modules`, so a baseline pass on a case marked
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

Every case pins TypeScript 6.0.3, Vitest 4.1.12, and `@types/node` 24.19.2 (SvelteKit 3 needs
TypeScript 6; one version everywhere keeps the toolchain out of the comparison).

Each `pack.json` takes the docs from the library's own repository at the tag matching the pinned
version, bound to the dependency so the lockfile decides the version, with two exceptions: the Hono
website has no tags, so its pack is pinned to a commit, and `stripe-23` adds three
`docs.stripe.com` API reference pages that serve Markdown but are not versioned (they matched
23.1.0's API version when the case was written).

## Layout of a case

```
evals/cases/<id>/
  case.json        id, title, kind, stratum, packageDocumentsAnswer, library and release date,
                   notes (with the node_modules file:line evidence), maxTurns, timeoutSeconds
  task.md          the prompt
  fixture/         the starting project (exact versions, committed package-lock.json)
  checks/          hidden graders: checks.json, tsconfig.eval.json, vitest.eval.config.mts, __eval__/
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
- `behaviour`: Vitest over the hidden `__eval__/*.check.ts` files.

Test files the agent writes for itself (`*.test.ts`, `*.spec.ts`, `*.test-d.ts`, `__tests__/`
under `src/`) are not graded unless the task says so: the suppression scan skips them and every
`tsconfig.eval.json` excludes them (the selftest's lint checks the exclude list), and the hidden
Vitest config runs only `__eval__/`.

Check programs resolve from the workspace's `node_modules/.bin` only, so a global tool can never
stand in for the pinned one.

## Running

All commands run from the repository root. `npm run eval -- <command>` is the same as
`npx tsx evals/run.ts <command>`.

```sh
# 1. Prove every case is gradable: fixture alone fails, every solution*/ passes, every wrong-*/
#    fails, naive/ fails the way the case's stratum says (type-visible: typecheck fails;
#    type-invisible: typecheck passes and behaviour fails; nothing else may fail), and the
#    suppression scan flags exactly what tests/fixtures/evals/suppressions/expected.json lists.
#    Needs network for npm only; templates are cached per lockfile.
npm run eval -- selftest

# 2. Build the packs with the llm-docs CLI (v3: init, sync, verify, status).
npm run eval -- prepare-packs --llm-docs dist/cli.js

# 3. See the run matrix and an estimated cost before spending anything.
npm run eval -- plan --runs 5

# 4. Prove the pipeline end to end on one case, once per arm. Note your usage meter before
#    and after. Results land in evals/results/smoke-<timestamp>/.
npm run eval -- smoke --plugin-dir plugin

# 5. Run. Results land in evals/results/<timestamp>/.
npm run eval -- run --runs 5 --plugin-dir plugin \
  --max-budget-usd-per-run 3 --max-total-usd 150
```

Options for `run`: `--cases <globs>` (comma-separated, `*` wildcards), `--arms
baseline,pack,plugin`, `--runs N`, `--model <id>` (default `claude-opus-5-5`; pass a full model
id, because every arm asserts that the session's `system/init` event reports exactly this
string), `--concurrency N` (default 2),
`--max-budget-usd-per-run X` (passed to `claude --max-budget-usd`, default 3), `--max-total-usd Y`
(no new run starts once spent plus the in-flight caps would pass it), `--plugin-dir <path>`
(required for the plugin arm), `--effort <level>`, `--resume <results dir>` (see below),
`--keep-workspaces`.

`smoke` takes the same options except `--cases`, `--runs`, and `--concurrency`: it runs one case
(`--case <id>`, default `zod-4-6`) once per arm with exactly the `run` invocation, one session at
a time. For every session it prints the outcome, cost, turns, wall time, whether docs were
consulted, the SessionStart hook output (plugin arm), and every arm assertion with pass or fail.
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

A rate limit (a short throttle, not the plan quota) or an overload does not stop the run: the
affected run is retried in place after 30 seconds and again after 120 seconds, and only then
recorded as an infra error. `attempts` in the row says how many sessions it took.

`--resume <results dir>` reruns exactly the runs that have no row or an infra-error row there, in
the original order (repeat first, then case, then arm). Pass the same `--cases`, `--arms`,
`--runs`, and `--model` as the first segment, which the printed command does for you.

Each run gets a fresh workspace under the OS temp directory
(`llm-docs-evals/<timestamp>/<case>-<arm>-<n>`), a copy of the cached `node_modules`, and, for
the pack and plugin arms, the prepared pack. The agent's stream is saved as `transcript.jsonl`,
then the checks are copied in and run. Ctrl-C stops every child process group; rerun with
`--resume` to finish.

The exact agent invocation is:

```sh
claude -p "<task.md>" --model claude-opus-5-5 --setting-sources project --strict-mcp-config \
  --no-session-persistence --max-turns <case maxTurns> --max-budget-usd <cap> \
  --output-format stream-json --verbose --include-hook-events \
  --permission-mode acceptEdits --permission-prompts none \
  [--plugin-dir <plugin>]  # plugin arm only
  --allowedTools Read Glob Grep Edit Write WebSearch WebFetch "Bash(npx tsc)" "Bash(npx tsc *)" \
    "Bash(npx vitest)" "Bash(npx vitest *)" "Bash(npm test)" "Bash(npm test *)" "Bash(ls)" \
    "Bash(ls *)" "Bash(cat *)"
```

with stdin from `/dev/null`, its own process group, and the case's wall timeout.

## Reading results

`evals/results/<timestamp>/` holds:

- `summary.md`: pass rate per arm overall, per case kind, per stratum, and per case (with each
  case's stratum and whether the installed package documents the answer); mean and total cost,
  mean turns, docs-consulted rate, and web-use rate per arm; one line per run; and, when the run
  was resumed or stopped, a table of segments with each one's wall-clock window. Read the
  `type-invisible` row first: it is where a pack has the most room to matter, and the
  `type-visible` and `control` rows show what happens where it has less.
- `results.json`: the same aggregates (`overall`, `byKind`, `byStratum`, `byCase`), each case's
  stratum and `packageDocumentsAnswer` in `meta.cases`, the segments, and one row per run (with its
  case's `stratum`) with the session
  outcome, attempts, every arm assertion with its evidence, every check's result and output tail,
  cost, turns, duration, tool call counts, the `agent-docs/` paths the agent touched, web
  searches and fetches, permission denials, each SessionStart hook's outcome and output, and the
  session's model, tools, MCP servers, and plugins as reported by Claude Code.
- `runs/<run id>/`: `transcript.jsonl`, `stderr.log`, `run.json`, and `files.json` mapping every
  file the agent created or changed to its content (a map, not loose copies, so test files the
  agent wrote never reach the repository's own test runner).

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
  - `pack` and `plugin`: `agent-docs/<pack>/index.md` and `manifest.json` exist and `AGENTS.md`
    holds both managed block markers;
  - `baseline` and `pack`: no plugin loaded besides Claude Code's built-in ones (reported with
    `path: "builtin"`), and no SessionStart hook ran;
  - `plugin`: exactly the plugin named in `<plugin-dir>/.claude-plugin/plugin.json` loaded, and at
    least one SessionStart hook started and finished with outcome `success`. Hook events do not
    name their plugin; since the other arms prove no SessionStart hook runs without the plugin,
    every SessionStart hook in this arm is the plugin's. A hook that ran and printed nothing (the
    llm-docs hook says nothing when it has nothing to say) passes and is shown as "ran, no
    output"; a hook that never started, or started and never reported back, fails;
  - every arm: the session reports the requested model and no MCP servers.

  A failed assertion makes the run an infra error named after it, for example
  `arm-invalid: plugin hook did not run`.
- **Docs consulted**: a Read, Grep, Glob, or Bash call named a path under `agent-docs/`.
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
- **Few cases.** Twelve post-cutoff cases over eight libraries (five `type-visible`, seven
  `type-invisible`) and four controls cover common shapes (a renamed parameter, a new endpoint, a
  new subpath export, a new schema type, renamed combinators, a new middleware, a changed default,
  a reversed tuple, a new opt-in, a changed error path), not the whole space. Several cases share
  a library, so their results are not independent.
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
- **Web contamination.** Every answer is on the public web, which is the point of allowing web
  tools, but it also means the baseline can sometimes find the answer; that is a real competitor,
  not a flaw. Once these cases are published they can also leak into future training data, so
  rotate cases when evaluating later models.
- **effect-4 is weaker evidence.** Effect 4 was in public beta from February 2026, before the
  model's cutoff, so the model may have seen beta-era APIs. A pass there says less than a pass
  on the other post-cutoff cases. `effect-4-partition` is not affected: its change merged on
  2026-09-29, so the betas had the old order.
- **Docs consulted is a heuristic.** It counts explicit tool calls on `agent-docs/` paths. The
  managed block in `AGENTS.md` is always in context in the pack and plugin arms and is not
  counted.
- **Cost** is Claude Code's `total_cost_usd`, which is computed at list prices regardless of how
  the account is billed.
- **The plugin hook** reads release dates from a cache that `prepare-packs` warms (via
  `llm-docs status`) and that every arm shares through `LLM_DOCS_CACHE_DIR`; with a cold cache
  the hook could say less. The hook always exits 0 and logs its own errors to `hook.log` in that
  cache, so a hook that failed inside and printed nothing looks the same in the stream as one
  that had nothing to say; check `hook.log` when the plugin arm's hook output is empty.
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
