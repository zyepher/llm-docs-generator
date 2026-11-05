import { describe, expect, it } from 'vitest';

import {
  ContentBlockSchema,
  ContentBlockType,
  DocNodeSchema,
  DocNodeType,
  createContentBlock,
  createDocNode,
} from '../../src/core/models.js';

describe('DocNode IR builders', () => {
  it('fills defaults and leaves unset optional block fields absent', () => {
    const block = createContentBlock(ContentBlockType.PROSE, 'Text.');
    expect(block).toEqual({ type: ContentBlockType.PROSE, content: 'Text.' });
    expect('language' in block).toBe(false);

    const node = createDocNode(DocNodeType.SECTION, 'intro', 'Intro');
    expect(node).toEqual({
      type: DocNodeType.SECTION,
      id: 'intro',
      title: 'Intro',
      description: '',
      content: [],
      children: [],
      metadata: new Map(),
    });
  });
});

describe('DocNode IR schemas', () => {
  it('validates a nested tree built with the builders', () => {
    const tree = createDocNode(DocNodeType.ROOT, 'root', 'Docs', {
      children: [
        createDocNode(DocNodeType.CATEGORY, 'guide', 'Guide', {
          content: [createContentBlock(ContentBlockType.CODE, 'npm i x', { language: 'bash' })],
        }),
      ],
    });

    expect(DocNodeSchema.parse(tree)).toEqual(tree);
  });

  it('fills defaults with a fresh array and Map per parsed node', () => {
    const first = DocNodeSchema.parse({ type: 'section', id: 'a', title: 'A' });
    const second = DocNodeSchema.parse({ type: 'section', id: 'b', title: 'B' });

    expect(first).toMatchObject({ description: '', content: [], children: [] });
    expect(first.metadata).toBeInstanceOf(Map);
    expect(first.metadata).not.toBe(second.metadata);
    expect(first.children).not.toBe(second.children);
  });

  it('rejects unknown node and block types', () => {
    expect(DocNodeSchema.safeParse({ type: 'chapter', id: 'a', title: 'A' }).success).toBe(false);
    expect(ContentBlockSchema.safeParse({ type: 'table', content: 'x' }).success).toBe(false);
  });
});
