import { describe, expect, it } from 'vitest';

import { renderComment } from '../src/render.js';

/** The anchor for `shown`, whatever scheme the renderer chose for an address typed without one. */
function linkTo(hostAndPath: string): RegExp {
  const escaped = hostAndPath.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return new RegExp(`<a href="(https?://)?${escaped}/?"[^>]*>${escaped}</a>`);
}

describe('renderComment', () => {
  it('renders standard Markdown', () => {
    const html = renderComment('Some *emphasis*, `code`, and [the docs](https://example.org/docs).');
    expect(html).toContain('<em>emphasis</em>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<a href="https://example.org/docs">the docs</a>');
  });

  it('links addresses pasted without a protocol', () => {
    expect(renderComment('Visit www.example.com for more.')).toMatch(linkTo('www.example.com'));
    expect(renderComment('Docs live at example.com/docs today.')).toMatch(
      linkTo('example.com/docs')
    );
    expect(renderComment('Our API: api.example.io/v1/users')).toMatch(
      linkTo('api.example.io/v1/users')
    );
  });

  it('links full addresses and email addresses', () => {
    expect(renderComment('Full link https://example.com/a works.')).toContain(
      '<a href="https://example.com/a">https://example.com/a</a>'
    );
    expect(renderComment('Write to bob@example.com please.')).toContain(
      '<a href="mailto:bob@example.com">bob@example.com</a>'
    );
  });

  it('never lets raw HTML through', () => {
    const html = renderComment('Hello <script>alert(1)</script> <img src=x onerror=alert(2)>');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
  });
});
