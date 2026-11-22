Add a `src/render.ts` module that renders a comment's Markdown to HTML for the discussion page, using markdown-it (already installed). It must export `renderComment(markdown: string): string`.

Requirements:

- Standard Markdown (emphasis, lists, code, links written as `[text](url)`) renders as usual.
- People often paste addresses without typing the protocol, like `www.example.com` or `example.com/docs`. Those must become clickable links, the same as full `https://` addresses and email addresses typed into the text.
- Raw HTML in a comment must never reach the page: it is shown as text, not rendered.

Keep it fully typed: no `any` casts or ts-ignore comments. Do not change package.json or install packages. Run the type checker when you are done.
