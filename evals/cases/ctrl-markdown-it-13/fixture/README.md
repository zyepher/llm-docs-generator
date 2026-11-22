# discussions

Server-side rendering for the discussion pages. Comments are written in Markdown and rendered to
HTML with markdown-it before they are stored in the page cache.

- `src/comment.ts`: the stored comment shape.

```sh
npm test          # vitest
npx tsc --noEmit  # type check
```
