# External Audit Findings — llm-docs-generator

From the owner-commissioned thirteen-repository audit of 2026-08-20 (register formerly in the incorpus repo, full text in incorpus git history at `123de2bc`). Relocated here 2026-08-29 after re-verification.

## 1. [VERIFIED, unchanged 2026-08-29] Package is unpublished

`npm view llm-docs-generator` returns 404. If publishing is intended, do it (and claim the name before someone else does — see what happened to `pageforge`); if not, the README should not read as if the package is installable.

## 2. [VERIFIED, unchanged 2026-08-29] Provenance manifests pin ephemeral absolute paths

`~/Developer/agent-docs/typescript-7/manifest.json` pins its source to `/private/tmp/claude-501/...scratchpad/ts7-src` — a session-scoped scratch directory that no longer exists — so `refresh` fails permanently and `verify`'s source tier can never pass again for that pack. Other manifests reportedly bake in `/Users/Zyepher/Developer/cloned/...`, leaking local filesystem layout into any shared pack.

The entire product thesis of this tool is provenance; a provenance system that permanently loses provenance for one of its artefacts has a design gap, not a bug. **Fix:** warn (or refuse) at generate time when a source path is under a temp/scratch directory, and store sources repo-relative or as remote references where possible. The typescript-7 pack needs its manifest re-pointed at a durable source.
