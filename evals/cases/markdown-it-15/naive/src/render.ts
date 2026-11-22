import MarkdownIt from 'markdown-it';

// Written from markdown-it 14 knowledge, where linkify also turned bare domains into links.
const md = new MarkdownIt({ html: false, linkify: true });

export function renderComment(markdown: string): string {
  return md.render(markdown);
}
