import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ContentBlockType, createContentBlock } from '../../src/core/models.js';
import { parseHtmlFile } from '../../src/parsers/html/index.js';
import { parseOpenApiFile } from '../../src/parsers/openapi/index.js';
import { parseRstFile } from '../../src/parsers/rst/index.js';
import { renderDocumentMarkdown, renderOpenApiPages } from '../../src/pack/render-ir.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function writeTemp(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'llm-docs-render-'));
  tempDirs.push(dir);
  const path = join(dir, name);
  await writeFile(path, content);
  return path;
}

const RST = [
  'Quickstart',
  '==========',
  '',
  'Install the package with pip and import it. See `the API <api.html>`_ and',
  ':doc:`usage`.',
  '',
  'Installation',
  '------------',
  '',
  'Run this command:',
  '',
  '.. code-block:: console',
  '',
  '   $ pip install widgets',
  '',
  'Then check it::',
  '',
  '   >>> import widgets',
  '   >>> widgets.__version__',
  '',
  'Configuration',
  '~~~~~~~~~~~~~',
  '',
  '- ``timeout``: seconds before giving up.',
  '- ``retries``: how many times to retry.',
  '',
  'Advanced',
  '--------',
  '',
  'Nothing here yet.',
  '',
].join('\n');

const HTML = [
  '<!doctype html>',
  '<html><head><title>Client | Widgets Docs</title></head>',
  '<body>',
  '<nav><a href="/">Home</a> <a href="/api/">API</a></nav>',
  '<main>',
  '<h1>Client<a class="headerlink" href="#client">¶</a></h1>',
  '<p>The <code>Client</code> talks to the server. See <a href="pool.html">Pool</a> and <a href="https://example.com/spec">the spec</a>.</p>',
  '<h2 id="options">Options</h2>',
  '<table><tr><th>Name</th><th>Type</th></tr><tr><td>timeout</td><td>number | null</td></tr></table>',
  '<pre><code class="language-js">const c = new Client(`http://localhost`);',
  '```',
  '</code></pre>',
  '<blockquote>Close clients you open.</blockquote>',
  '<h3>Methods</h3>',
  '<ul><li>close()<ul><li>returns a promise</li></ul></li><li>destroy()</li></ul>',
  '</main>',
  '<footer>Copyright</footer>',
  '</body></html>',
].join('\n');

const OPENAPI = [
  'openapi: 3.0.3',
  'info:',
  '  title: Petstore',
  '  version: 1.2.0',
  '  description: A sample API for pets.',
  'servers:',
  '  - url: https://api.example.com/v1',
  '    description: Production',
  'tags:',
  '  - name: pets',
  '    description: Everything about pets',
  'components:',
  '  securitySchemes:',
  '    apiKey:',
  '      type: apiKey',
  '      in: header',
  '      name: X-API-Key',
  '  schemas:',
  '    Pet:',
  '      type: object',
  '      required: [id, name]',
  '      properties:',
  '        id: { type: integer, format: int64 }',
  '        name: { type: string }',
  'security:',
  '  - apiKey: []',
  'paths:',
  '  /pets:',
  '    get:',
  '      tags: [pets]',
  '      summary: List pets',
  '      description: |',
  '        Returns pets in the order they were added.',
  '',
  '        Use `limit` to page.',
  '      operationId: listPets',
  '      parameters:',
  '        - name: limit',
  '          in: query',
  '          schema: { type: integer }',
  '          description: How many items to return',
  '      responses:',
  "        '200':",
  '          description: A list of pets',
  '          content:',
  '            application/json:',
  '              schema:',
  '                type: array',
  "                items: { $ref: '#/components/schemas/Pet' }",
  '    post:',
  '      tags: [pets]',
  '      summary: Create a pet',
  '      deprecated: true',
  '      requestBody:',
  '        required: true',
  '        content:',
  '          application/json:',
  "            schema: { $ref: '#/components/schemas/Pet' }",
  '      responses:',
  "        '201': { description: Created }",
  '  /health:',
  '    get:',
  '      summary: Health check',
  '      security: []',
  '      responses:',
  "        '200': { description: OK }",
  '',
].join('\n');

describe('renderDocumentMarkdown', () => {
  it('renders reStructuredText with its own heading levels, fenced code, and lists', async () => {
    const markdown = renderDocumentMarkdown(await parseRstFile(await writeTemp('guide.rst', RST)));
    expect(markdown).toMatchInlineSnapshot(`
      "# Quickstart

      Install the package with pip and import it. See [the API](api.html) and usage.

      ## Installation

      Run this command:

      \`\`\`console
      $ pip install widgets
      \`\`\`

      Then check it:

      \`\`\`text
      >>> import widgets
      >>> widgets.__version__
      \`\`\`

      ### Configuration

      - \`\`timeout\`\`: seconds before giving up.
      - \`\`retries\`\`: how many times to retry.

      ## Advanced

      Nothing here yet.
      "
    `);
  });

  it('renders HTML without chrome: links, tables, code, quotes, nested lists', async () => {
    const markdown = renderDocumentMarkdown(
      await parseHtmlFile(await writeTemp('client.html', HTML)),
      {
        titleFromSections: true,
      }
    );
    expect(markdown).toMatchInlineSnapshot(`
      "# Client

      The \`Client\` talks to the server. See [Pool](pool.html) and [the spec](https://example.com/spec).

      ## Options

      | Name | Type |
      | --- | --- |
      | timeout | number \\| null |

      \`\`\`\`js
      const c = new Client(\`http://localhost\`);
      \`\`\`
      \`\`\`\`

      > Close clients you open.

      ### Methods

      - close()
        - returns a promise
      - destroy()
      "
    `);
  });

  it('writes the HTML title as the H1 when the page has no H1 of its own', async () => {
    const markdown = renderDocumentMarkdown(
      await parseHtmlFile(
        await writeTemp('x.html', '<title>Only Title</title><h2>Part</h2><p>Body.</p>')
      ),
      { titleFromSections: true }
    );
    expect(markdown).toBe('# Only Title\n\n## Part\n\nBody.\n');
  });

  it('renders data blocks as fenced data and widens fences around backticks', () => {
    const markdown = renderDocumentMarkdown({
      title: 'Data',
      content: [
        createContentBlock(ContentBlockType.DATA, '{"a": 1}', { language: 'json' }),
        createContentBlock(ContentBlockType.DATA, 'a: 1', { language: 'yaml' }),
        createContentBlock(ContentBlockType.CODE, 'echo ```', { language: 'sh' }),
      ],
      children: [],
    });
    expect(markdown).toBe(
      '# Data\n\n```json\n{"a": 1}\n```\n\n```yaml\na: 1\n```\n\n````sh\necho ```\n````\n'
    );
  });
});

describe('renderOpenApiPages', () => {
  it('renders an index page and one page per tag, with untagged operations apart', async () => {
    const pages = renderOpenApiPages(
      await parseOpenApiFile(await writeTemp('petstore.yaml', OPENAPI)),
      'pages/api/petstore'
    );
    expect(pages.map((page) => page.outputPath)).toEqual([
      'pages/api/petstore/index.md',
      'pages/api/petstore/pets.md',
      'pages/api/petstore/untagged.md',
    ]);
    expect(pages[0]?.text).toMatchInlineSnapshot(`
      "# Petstore

      Version 1.2.0, described by an OpenAPI 3.0.3 document.

      A sample API for pets.

      ## Servers

      - https://api.example.com/v1 (Production)

      ## Authentication

      ### Security schemes

      - apiKey: apiKey (in header, name: X-API-Key)

      ### Default security

      - apiKey

      ## Tags

      - [pets](pets.md): 2 operations. Everything about pets
      - [Untagged](untagged.md): 1 operation
      "
    `);
    expect(pages[1]?.text).toMatchInlineSnapshot(`
      "# pets

      Everything about pets

      Operations of [Petstore](index.md) tagged pets.

      ## GET /pets

      **List pets**

      Returns pets in the order they were added.

      Use \`limit\` to page.

      Operation ID: \`listPets\`

      ### Authentication

      - apiKey

      ### Parameters

      - limit (query, optional); schema integer; How many items to return

      ### Responses

      - 200: A list of pets; application/json: array<Pet{id: integer(int64), name: string}>

      ## POST /pets

      **Create a pet**

      Deprecated: this operation is marked deprecated.

      ### Authentication

      - apiKey

      ### Request body

      - required: true
      - application/json: Pet{id: integer(int64), name: string}

      ### Responses

      - 201: Created
      "
    `);
    expect(pages[2]?.text).toMatchInlineSnapshot(`
      "# Untagged

      Operations of [Petstore](index.md) without a tag.

      ## GET /health

      **Health check**

      ### Authentication

      - none (no authentication required)

      ### Responses

      - 200: OK
      "
    `);
  });

  it('renders Swagger 2.0 servers from host, basePath, and schemes', async () => {
    const swagger = JSON.stringify({
      swagger: '2.0',
      info: { title: 'Legacy', version: '1' },
      host: 'legacy.example.com',
      basePath: '/api',
      schemes: ['https'],
      paths: { '/items': { get: { tags: ['index'], responses: { 200: { description: 'ok' } } } } },
    });
    const pages = renderOpenApiPages(
      await parseOpenApiFile(await writeTemp('legacy.json', swagger)),
      'pages/legacy'
    );
    expect(pages.map((page) => page.outputPath)).toEqual([
      'pages/legacy/index.md',
      'pages/legacy/index-tag.md',
    ]);
    expect(pages[0]?.text).toContain('## Servers\n\n- https://legacy.example.com/api');
    expect(pages[0]?.text).toContain('- [index](index-tag.md): 1 operation');
  });
});
