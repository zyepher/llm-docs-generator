import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ContentBlockType,
  createSpecData,
  type Example,
  type Operation,
  type SpecInfo,
} from '../../src/core/models.js';
import { openRefToDocNode } from '../../src/parsers/openref/adapter.js';
import { OpenRefParser } from '../../src/parsers/openref/parser.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const INFO: SpecInfo = {
  id: 'swift',
  title: 'Test SDK',
  description: 'Test spec',
  slugPrefix: '/',
  libraries: [],
};

function makeOperation(): Operation {
  const example: Example = {
    id: 'select-basic',
    name: 'Basic select',
    code: 'let rows = try await client.from("todos").select()',
    description: '',
    dataSql: 'create table todos (id int);',
    response: '{ "data": [] }',
    isSpotlight: false,
  };

  return {
    id: 'select',
    title: 'Select data',
    description: 'Read rows',
    notes: '',
    examples: [example],
    overwriteParams: [],
  };
}

describe('openRefToDocNode language handling', () => {
  it('tags code blocks with the declared language recorded on the SpecData', () => {
    const specData = createSpecData(INFO, [makeOperation()], 'swift');

    const root = openRefToDocNode(specData);
    const codeBlock = root.children[0]?.children[0]?.content.find(
      (block) => block.type === ContentBlockType.CODE
    );

    expect(codeBlock?.language).toBe('swift');
  });

  it('threads the declared language through category grouping', () => {
    const specData = createSpecData(INFO, [makeOperation()], 'swift');
    const categoryMap = new Map([['database', ['select']]]);

    const root = openRefToDocNode(specData, categoryMap);
    const codeBlock = root.children[0]?.children[0]?.children[0]?.content.find(
      (block) => block.type === ContentBlockType.CODE
    );

    expect(codeBlock?.language).toBe('swift');
  });

  it('emits an untagged code block when no language is declared', () => {
    const specData = createSpecData(INFO, [makeOperation()]);

    const root = openRefToDocNode(specData);
    const codeBlock = root.children[0]?.children[0]?.content.find(
      (block) => block.type === ContentBlockType.CODE
    );

    // Empty string means a genuinely bare fence; the language is never guessed.
    expect(codeBlock?.language).toBe('');
  });

  it('keeps the spec-declared sql and json tags on data blocks', () => {
    const specData = createSpecData(INFO, [makeOperation()]);

    const root = openRefToDocNode(specData);
    const dataBlocks = root.children[0]?.children[0]?.content.filter(
      (block) => block.type === ContentBlockType.DATA
    );

    expect(dataBlocks?.map((block) => block.language)).toEqual(['sql', 'json']);
  });
});

describe('OpenRefParser declared language threading', () => {
  const SPEC_YAML = [
    'openref: 0.1',
    'info:',
    '  id: swift',
    '  title: Test SDK',
    '  description: Test spec',
    'functions:',
    '  - id: select',
    '    title: Select data',
    '    examples:',
    '      - id: select-basic',
    '        name: Basic select',
    '        code: let rows = try await client.select()',
    '',
  ].join('\n');

  it('records a caller-declared language on the parsed SpecData only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-openref-parser-'));
    tempDirs.push(dir);
    const specPath = join(dir, 'spec.yml');
    await writeFile(specPath, SPEC_YAML, 'utf-8');

    const parser = new OpenRefParser(specPath, { declaredLanguage: 'swift' });
    const specData = await parser.parse();
    expect(specData.declaredLanguage).toBe('swift');

    // The declared language is configuration, not spec content: it must not
    // leak into the parsed-spec JSON, which refresh reproduces config-free.
    const jsonPath = join(dir, 'parsed', 'spec.json');
    await parser.saveJSON(specData, jsonPath);
    const serialized = await readFile(jsonPath, 'utf-8');
    expect(serialized).not.toContain('declaredLanguage');
  });

  it('leaves declaredLanguage absent when the caller declares none', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-openref-parser-none-'));
    tempDirs.push(dir);
    const specPath = join(dir, 'spec.yml');
    await writeFile(specPath, SPEC_YAML, 'utf-8');

    const specData = await new OpenRefParser(specPath).parse();
    expect(specData.declaredLanguage).toBeUndefined();
  });
});
