---
name: write-docs-guide
description: Write a project-specific guide for a pinned llm-docs pack, citing the pack's pages, fact-checked and stamped so verify reports it when the cited text changes. Use when the user asks for a summary, digest, cheat sheet, or how-we-use-it note for a library that has a pack, or when verify, sync, or refresh lists a guide to re-review.
---

# Write a guide for a docs pack

A guide is a short digest that lives next to a pack, in `agent-docs/<id>/guides/` (the packs directory is configurable). It records what upstream pages cannot: which parts of the library this project uses, the decisions the project made about them, and the traps the team already hit. Every claim in it cites the page that supports it.

Pages outrank guides. A page is upstream text at a pinned version, and `llm-docs verify` proves it unchanged. A guide is a summary someone wrote. When the two disagree, the page is right and the guide needs fixing.

Run the CLI as `llm-docs`, or as `npx llm-docs` if that command is not found.

## Decide whether a guide earns its place

Write one when the project uses a small, specific part of a large library, or when it has made choices an agent cannot infer from the pages (which router, which auth flow, which deprecated API to avoid). Do not write one that restates the library's own getting-started page. The pages are already in the pack.

## Write it

1. Read the pack's `index.md`, then the pages for each API the project uses. Search the code for its imports to find them.
2. Create `guides/<topic>.md` in the pack. Use a short kebab-case name. A pack can hold several guides.
3. Start with one sentence naming the library version the guide covers and the parts of the library it is about.
4. Write each claim as a sentence followed by a citation. A citation is a relative Markdown link from the guide to a page or file in the pack, with a fragment when it supports one section:

   ```markdown
   Middleware runs before route matching ([Middleware](../pages/guide/middleware.md#execution-order)).
   ```

   The fragment is the heading's GitHub-style slug, with `-1`, `-2` suffixes for repeated headings. A citation without a fragment covers the whole page, so changing any line of that page flags the guide. Cite the section whenever one section is enough.
5. Cite only what you read on the cited page. A claim you cannot cite is either a project decision (say so: "This project uses X because Y.") or something to cut.
6. Do not copy long passages. Link to the page and state the point in one or two sentences.

## Fact-check it

Hand the finished guide to the `docs-fact-checker` agent that this plugin ships, with the guide's path and the pack's path. It checks every claim against the pages the claim cites and reports each one as supported, unsupported, or contradicted, quoting the page text. It never edits the guide.

Fix every claim it marks unsupported or contradicted: correct the claim, cite a page that supports it, mark it as a project decision, or delete it. Run the check again until every cited claim is supported.

## Stamp it

```sh
llm-docs guides stamp <id> guides/<topic>.md
```

Stamping records the hash of every section the guide cites in `guides/citations.lock.json`. It fails on a citation that does not resolve, and the message names the link to fix. Leave out the guide argument to stamp every guide in the pack.

Then run `llm-docs sync`. It adds `guides` to the pack's line in the managed block, so sessions know the guide exists, and it acquires nothing.

Commit the guide and `citations.lock.json` together.

## Re-review a guide

`llm-docs verify` fails the `citations` check when a cited section changed after stamping or a citation no longer resolves. It warns when a guide was edited after stamping or was never stamped. `llm-docs sync` and `llm-docs refresh` print a "guides to re-review" list when a rebuild changes the text a guide cites, with each guide, the cited target, and what happened to it.

For each guide on the list:

1. Open the cited section as it reads now, and compare it with the claim that cites it.
2. Rewrite the claims the new text no longer supports, and fix links to sections that moved or disappeared.
3. Run the fact-check again on the changed claims.
4. Stamp the guide with the command the report prints, `llm-docs guides stamp <id> <guide>...`.

Never stamp a guide only to silence the check. The stamp says that someone confirmed the guide against the cited text as it reads now.
