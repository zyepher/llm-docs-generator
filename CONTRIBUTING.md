# Contributing to llm-docs

This guide covers setting up the repository, the checks a change must pass, where each kind of extension goes, and the conventions reviewers hold every change to. Read [the design spec](docs/design/v3-spec.md) before changing behavior: the CLI is the engine that executes recipes, records provenance, and refuses to guess, and the agent is the planner that chooses sources. A change that makes the engine choose a source, crawl, or guess a version will not be accepted.

## Set up

You need Node.js 22.19 or newer and git.

```sh
git clone https://github.com/Zyepher/llm-docs-generator.git
cd llm-docs-generator
npm ci
npm run build
node dist/cli.js --help
```

To try a change against a project, run `node dist/cli.js` in a throwaway directory, never against real data. A `local` source in a temp directory needs `LLM_DOCS_ALLOW_TEMP_SOURCES=1`, and a local HTTP server needs `LLM_DOCS_ALLOW_PRIVATE_NETWORK=1`.

## Pass the gate

CI runs these on Linux, macOS, and Windows with Node 22 and 24. Run all of them before you open a pull request:

```sh
npm run type-check
npm run lint
npm run format:check
npm run build
npm run check:plugin
npm test
```

- `npm test` is slow: the CLI suite builds the CLI and spawns real subprocesses against temp projects. Let it finish; a run killed partway can leave temp state behind. Never run two copies at once in one checkout.
- `npm run format` and `npm run lint:fix` fix most formatting and lint findings.

Two generated artifacts are committed, and a check fails when they are stale:

- After any change under `src/`, run `npm run build:plugin` to regenerate `plugin/bin/llm-docs.mjs`, the CLI bundled into the plugin. The build is byte-identical across runs, and `npm run check:plugin` fails CI when the committed bundle or the plugin versions are out of date. It also fails when the skills or the plugin README name a command or flag the CLI does not have.
- After a change to the config or manifest zod schemas, run `npm run schema` to regenerate `schema/llm-docs.schema.json` and `schema/manifest.schema.json`. A test fails when they are out of date.

## Write tests

Tests are Vitest files in `tests/unit/`, one or more per module, named after the area they cover (`sources-git.test.ts`, `pack-sync.test.ts`, `deps-lockfiles.test.ts`). Fixtures live in `tests/fixtures/`, and shared helpers in `tests/helpers/`: `fake-converters.ts` provides `docling` and `markitdown` stand-ins that follow the real tools' command-line contracts, and `symlinks.ts` skips symbolic link cases where the platform cannot create them.

- No test touches the real network. Network tests start a local HTTP server and set `LLM_DOCS_ALLOW_PRIVATE_NETWORK=1`. Git tests create repositories in temp directories and use them over `file://`.
- Test what a user of the code can observe: command output, exit codes, files written, returned values. A test that passes while the behavior is broken, or breaks when only the internals change, is not worth keeping.
- End-to-end cases run the built `dist/cli.js` against temp projects and belong in `tests/unit/cli-v3.test.ts`. Group scenarios so that one subprocess covers several assertions, to keep the suite fast.

## Extend the tool

Each extension point is a table in one file. Add to the table and to the code next to it, then update the reference page that describes it.

### Add a source type

1. In `src/config/project.ts`, add the type to `SOURCE_TYPES`, add its strict zod schema to `sourceConfigSchema`, add its resolved shape to `resolvedSourceSchema`, and fill its defaults and placeholders in `resolveSource`.
2. In `src/pack/manifest.ts`, add its origin to `originSchema`.
3. Write the acquirer in `src/sources/` and register it in `ACQUIRERS` in `src/sources/acquire.ts`, marking whether it uses the network. A network acquirer fetches through `createHttpClient` in `src/sources/http.ts` and nothing else.
4. If `add` should create it, add its flags to the `add` entry of the `COMMANDS` table in `src/cli.ts`. `capabilities --json` is generated from that table and from `SOURCE_TYPES`.
5. Run `npm run schema`, and document it in [`docs/config.md`](docs/config.md) and [`docs/manifest.md`](docs/manifest.md).

### Add a converter

1. Add the tool name to `CONVERTER_TOOLS` in `src/config/project.ts`, and its default `include` if it has one.
2. In `src/sources/convert.ts`, add its install command to `CONVERTER_INSTALL_HINTS` and its argument list to `invocationTemplate`. The converter runs through `execFile`, never a shell.
3. Add a fake executable for it to `tests/helpers/fake-converters.ts` that follows the real tool's documented contract, and test conversion, failure, timeout, and caching against it.
4. Run `npm run schema`, and document it in [`docs/config.md`](docs/config.md#convert).

### Add a lockfile parser or an ecosystem

- A lockfile format for an existing ecosystem: write the parser in `src/deps/lockfiles.ts` (npm formats live in `src/deps/lockfiles-npm.ts`) and register its file name in `LOCKFILE_PARSERS`. A format that cannot be read goes in `UNSUPPORTED_LOCKFILES` with a message that names the fix. Parsers never execute project code.
- A new ecosystem: also add it to `ECOSYSTEMS` in `src/deps/lockfiles.ts`, add its release-date lookup to `LOOKUPS` and its registry metadata to `PACKAGE_METADATA` in `src/deps/registries.ts`, and handle its name format in `src/core/package-discovery.ts` when `discover --package` needs it.
- Put real-shaped lockfiles in `tests/fixtures/deps/` and test the resolved versions, directness, and skipped entries.

### Add a verify check

1. Add the name to `PACK_CHECK_NAMES` or `PROJECT_CHECK_NAMES` in `src/pack/verify.ts`, and add the check function to `PACK_CHECKS` in report order. Each finding says what is wrong and the command or config key that fixes it.
2. Add a row to the `Check` table in `plugin/skills/llm-docs/SKILL.md`. `npm run check:plugin` fails until that table lists exactly the checks the CLI reports.
3. Document it under [Verify checks](docs/commands.md#verify-checks), then run `npm run build:plugin`.

## Run the evaluation selftest

The evaluation suite in `evals/` measures whether packs help an agent; [its README](evals/README.md) describes it. After a change to `evals/` or to anything a case depends on, run:

```sh
npm run eval -- selftest
```

It proves every case is gradable without running a model: the fixture alone fails, every reference solution passes, every known wrong answer fails, and the from-memory solution fails the way its stratum says. It needs the network for npm installs, which it caches per lockfile. Full runs call a model and cost money; do not start one without the maintainer's agreement.

## Follow the conventions

- **Strict TypeScript.** Strict mode with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` stays green. No `as any`, no `as unknown as`, no `@ts-ignore` or `@ts-expect-error`. A non-null assertion is allowed only next to the bounds check that proves it.
- **Locality of behaviour.** Keep one unit of behavior in one place. Do not add a layer, a wrapper with one caller, or an option nobody uses. Reuse the shared helpers instead of writing new ones: `errorMessage`, `isRecord`, and `isFileNotFoundError` in `src/utils/guards.ts`; `writeJsonFileSafely` and `readJsonFile` in `src/utils/json.ts`; `writeTextFileSafely` in `src/utils/safe-write.ts`; `sha256Prefixed` and `sha256File` in `src/utils/hash.ts`; `isSameOrDescendant` in `src/utils/fs-path.ts`; and `walkBoundedDirectoryTree` in `src/utils/traversal.ts`.
- **Everything added is used.** Anything you remove must be dead across `src/`, `tests/`, `evals/`, and `scripts/`.
- **Comments explain a non-obvious why.** Do not narrate the change or address the reviewer.
- **Errors say what to do.** Every message a user or agent can see names what went wrong and the command or config key that fixes it. Use the exit codes in [Commands](docs/commands.md#exit-codes).
- **No em dashes** anywhere: code comments, docs, test names, commit messages. Use commas, colons, periods, or parentheses.
- **Commit messages** use a conventional subject (`feat(scope):`, `fix(scope):`, `refactor:`, `test:`, `docs:`, `build:`, `chore:`) and a body that explains what changed and why. Write them as the engineer who made the change, with no tool or assistant attribution and no `Co-Authored-By` trailers for tools.

## Report a security problem

Do not open a public issue. Follow [Report a vulnerability](docs/security.md#report-a-vulnerability).
