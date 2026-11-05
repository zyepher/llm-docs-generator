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

Post-cutoff cases use libraries whose relevant API shipped after June 2026. Each one has a
`naive/` solution written the way a model coding from memory would write it, and the selftest
proves the checks reject it.

| Case | Library (release) | What changed after the cutoff | What the checks prove |
|---|---|---|---|
| `stripe-23` | `stripe` 23.1.0 (2026-10-29) | v23 removed `payment_method_types` from Checkout `SessionCreateParams` (now `allowed_payment_method_types`) and added `subscriptions.pause()` with `invoicing_behavior`. | Type check rejects `payment_method_types`. A fake fetch client captures the HTTP requests: `allowed_payment_method_types[0]=card`, `[1]=paypay`, `mode=payment`, and a POST to `/v1/subscriptions/sub_123/pause` with `invoicing_behavior=pending_invoice_item`. The old `pause_collection` idiom compiles but hits the wrong endpoint. |
| `mcp-sdk-v2` | `@modelcontextprotocol/server` and `client` 2.4.0 (2026-10-23; 2.0.0 was 2026-07-27) | v2 split the SDK into server and client packages and replaced the flat `extra` argument with a request context (`ctx.mcpReq.notify`, `ctx.mcpReq.signal`, `ctx.mcpReq._meta`). | Client and server connected in memory: three progress notifications for `n=3` and the right result text; cancelling after the first progress event stops the server (counted on the server transport, not the client). The v1 `extra.sendNotification` idiom fails to type check and sends no progress. |
| `sveltekit-3` | `@sveltejs/kit` 3.1.1 (2026-10-29; 3.0.0 was 2026-10-01) | v3 moved `Handle` and `HandleServerError` to `@sveltejs/kit/hooks` and changed `handleError` to receive `{ kind, error, event }` for every error, including framework errors. | Hooks must satisfy the v3 types from `@sveltejs/kit/hooks` and `App.Error` must carry `errorId`. A fake event and resolve prove the headers; `handleError` keeps the status and message of app and framework errors, and hides unknown ones behind a logged `errorId`. |
| `zod-4-6` | `zod` 4.6.7 (2026-10-12; IBAN support arrived in 4.6.0, 2026-09-09) | `z.iban()` and the `z.ZodIBAN` type are new; `.validate()` arrived in 4.5.0. | Type test pins `const s: z.ZodIBAN = ibanSchema` and the type guard's narrowed type. Behaviour covers valid IBANs, a bad checksum, spaces, lowercase, and the transfer guard. A hand-written regex plus mod-97 gets every runtime answer right and is still rejected, because the task asks for zod's own IBAN validation. |
| `effect-4` | `effect` 4.1.2 (2026-11-02; 4.0.0 was 2026-10-01) | v4 renamed `Either` to `Result`, `catchAll` to `catch`, `either` to `result`, and changed retry options. | Type test pins `Effect<Result<RateQuote, RateUnavailable>, never, never>`. `Effect.runPromise` proves laziness, success after transient failures, the cached fallback, the failure with the attempt count, and the exact call count. The v3 idiom fails to type check and throws at runtime. |
| `hono-4-13` | `hono` 4.13.16 (2026-11-01; 4.13.0 was 2026-08-03) | 4.13 added `app.query()` for the HTTP QUERY method and the `methodNotAllowed` middleware in `hono/method-not-allowed`. | QUERY `/search` works; a wrong method on a known path returns a JSON 405 whose `Allow` header lists exactly what the router knows (including the HEAD Hono derives from GET), and the source imports `hono/method-not-allowed`, so a hand-rolled 405 does not pass. |

Notes on fairness of individual prompts: the `zod-4-6` and `hono-4-13` prompts ask the agent to
use the library's own built-in support (IBAN validation, 405 handling) without naming it, because
otherwise a careful hand-written solution would be a legitimate answer and the case would stop
measuring API knowledge. The `stripe-23` prompt describes the pause outcome (paused status,
pending invoice items) in product terms.

Controls use the same task shapes on library versions the model has known for years. They also
get packs (docs from the matching tag), so the pack arm is a real test of "does not hurt".

| Case | Library (release) | Task shape |
|---|---|---|
| `ctrl-stripe-14` | `stripe` 14.0.0 (2023-10-16) | The same Checkout task, where `payment_method_types` is correct (card and Link), plus cancel at period end, graded through the same fake fetch client. |
| `ctrl-zod-3` | `zod` 3.22.4 (2023-10-04) | A signup schema with `refine` for password confirmation, `safeParse` field errors, and `z.infer`. |
| `ctrl-date-fns-2` | `date-fns` 2.30.0 (2023-04-30) | Stay range formatting and calendar-night counting with `format`, `addDays`, and `differenceInCalendarDays`. |

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
  case.json        id, title, kind, library and release date, notes, maxTurns, timeoutSeconds
  task.md          the prompt
  fixture/         the starting project (exact versions, committed package-lock.json)
  checks/          hidden graders: checks.json, tsconfig.eval.json, vitest.eval.config.mts, __eval__/
  solution/        reference solution overlaid on the fixture; must pass every check
  naive/           coding-from-memory solution (post-cutoff cases); must fail
  pack.json        the llm-docs.json pack entry for this case
```

`checks/checks.json` lists the checks in order. A run passes only when every check passes:

- `deps-unchanged`: `package.json` and `package-lock.json` are byte-identical to the fixture.
- `no-type-suppressions`: no `as any`, `: any`, `as unknown as`, or `@ts-` directives in `src/`.
- `typecheck`: `tsc --noEmit -p tsconfig.eval.json`, a self-contained config over `src/` and the
  hidden type tests, so editing the project's `tsconfig.json` cannot loosen it.
- `behaviour`: Vitest over the hidden `__eval__/*.check.ts` files.

Check programs resolve from the workspace's `node_modules/.bin` only, so a global tool can never
stand in for the pinned one.

## Running

All commands run from the repository root. `npm run eval -- <command>` is the same as
`npx tsx evals/run.ts <command>`.

```sh
# 1. Prove every case is gradable: fixture alone fails, fixture + solution passes,
#    fixture + naive fails. Needs network for npm only; templates are cached per lockfile.
npm run eval -- selftest

# 2. Build the packs with the llm-docs CLI (v3: init, sync, verify, status).
npm run eval -- prepare-packs --llm-docs dist/cli.js

# 3. See the run matrix and an estimated cost before spending anything.
npm run eval -- plan --runs 5

# 4. Run. Results land in evals/results/<timestamp>/.
npm run eval -- run --runs 5 --plugin-dir plugin \
  --max-budget-usd-per-run 3 --max-total-usd 150
```

Options for `run`: `--cases <globs>` (comma-separated, `*` wildcards), `--arms
baseline,pack,plugin`, `--runs N`, `--model <id>` (default `claude-opus-5-5`), `--concurrency N`
(default 2), `--max-budget-usd-per-run X` (passed to `claude --max-budget-usd`, default 3),
`--max-total-usd Y` (no new run starts once spent plus the in-flight caps would pass it),
`--plugin-dir <path>` (required for the plugin arm), `--effort <level>`, `--resume <results dir>`
(skips runs already recorded there, retries infrastructure errors), `--keep-workspaces`.

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

- `summary.md`: pass rate per arm overall, per case kind, and per case; mean and total cost, mean
  turns, docs-consulted rate, and web-use rate per arm; one line per run.
- `results.json`: the same aggregates plus one row per run with every check's result and output
  tail, cost, turns, duration, tool call counts, the `agent-docs/` paths the agent touched, web
  searches and fetches, permission denials, the SessionStart hook output, and the session's
  model, tools, MCP servers, and plugins as reported by Claude Code (use these to confirm the
  arms really differed only in the treatment).
- `runs/<run id>/`: `transcript.jsonl`, `stderr.log`, `run.json`, and `files.json` mapping every
  file the agent created or changed to its content (a map, not loose copies, so test files the
  agent wrote never reach the repository's own test runner).

Definitions:

- **Pass**: every check passed. Agent outcomes such as hitting the turn cap or the budget cap are
  graded as they stand, not excluded.
- **Docs consulted**: a Read, Grep, Glob, or Bash call named a path under `agent-docs/`.
- **Web used**: at least one WebSearch or WebFetch call. Claude Code 2.1 reads pages through its
  `web-fetch` subagent rather than a top-level WebFetch tool, so launching that subagent counts as
  a fetch (its own nested fetch is not counted twice).
- **Infra error**: the run could not be carried out (workspace setup failed, `claude` did not
  start, interrupted). These rows are excluded from rates and retried by `--resume`.

`evals/results/` is git-ignored. Published numbers go into the project README by hand, with the
date, model, Claude Code version, and run count.

## Known limitations

- **Nondeterminism.** The same prompt can pass and fail on consecutive runs. One run per cell is
  a smoke test, not a measurement; use at least five runs per case and arm and read differences
  of one or two runs as noise.
- **Few cases.** Six post-cutoff libraries and three controls cover common shapes (a renamed
  parameter, a new endpoint, a new subpath export, a new schema type, renamed combinators, a new
  middleware), not the whole space.
- **Web contamination.** Every answer is on the public web, which is the point of allowing web
  tools, but it also means the baseline can sometimes find the answer; that is a real competitor,
  not a flaw. Once these cases are published they can also leak into future training data, so
  rotate cases when evaluating later models.
- **effect-4 is weaker evidence.** Effect 4 was in public beta from February 2026, before the
  model's cutoff, so the model may have seen beta-era APIs. A pass there says less than a pass
  on the other post-cutoff cases.
- **Docs consulted is a heuristic.** It counts explicit tool calls on `agent-docs/` paths. The
  managed block in `AGENTS.md` is always in context in the pack and plugin arms and is not
  counted.
- **Cost** is Claude Code's `total_cost_usd`, which is computed at list prices regardless of how
  the account is billed.
- **The plugin hook** reads release dates from a cache that `prepare-packs` warms (via
  `llm-docs status`) and that every arm shares through `LLM_DOCS_CACHE_DIR`; with a cold cache
  the hook could say less.
