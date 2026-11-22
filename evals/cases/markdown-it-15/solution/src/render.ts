import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({ html: false, linkify: true });
// Since markdown-it 15 (linkify-it 6), addresses without a protocol are only linked on request.
md.linkify.set({ fuzzyLink: true });

export function renderComment(markdown: string): string {
  return md.render(markdown);
}
