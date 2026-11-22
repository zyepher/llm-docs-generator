# llm-docs documentation

Reference pages for `llm-docs` 3. For what the tool is and how to start, read the [project README](../README.md).

`llm-docs` 3 is released on GitHub only, and the npm package is not published yet. Agents get the CLI with the [plugin](../plugin/README.md), and CI jobs download it from a GitHub Release (see [Running in CI](commands.md#running-in-ci)).

| Page | What it covers |
|---|---|
| [Commands](commands.md) | Every command, its exit codes and `--json` output, every `verify` check with its fix, and the managed block. |
| [`llm-docs.json`](config.md) | Every config key with its type, default, and constraints; source types, converters, transforms, placeholders, `readFirst`, and limits. |
| [Pack manifest](manifest.md) | Every field of a pack's `manifest.json`, what each hash covers, and the determinism rules. |
| [Security](security.md) | The threat model and every control, with the file that implements it, and how to report a vulnerability. |
| [Plugin](plugin.md) | The Claude Code and Cursor plugin: the session-start hook's behavior and budgets, which agent files each harness reads, and troubleshooting. |
| [Design spec](design/v3-spec.md) | The v3 design record: what was decided and why, amended to match what shipped in 3.0.0. |

The agent-facing guides live with the plugin: [`add-docs`](../plugin/skills/add-docs/SKILL.md), [`write-docs-guide`](../plugin/skills/write-docs-guide/SKILL.md), and [`llm-docs`](../plugin/skills/llm-docs/SKILL.md). The evaluation suite is described in [`evals/README.md`](../evals/README.md).
