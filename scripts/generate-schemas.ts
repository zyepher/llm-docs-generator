/**
 * Regenerate the committed JSON Schemas from the zod schemas (`npm run schema`).
 * tests/unit/schemas.test.ts fails when the committed files are stale.
 */

import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { projectConfigJsonSchemaText } from '../src/config/project.js';
import { manifestJsonSchemaText } from '../src/pack/manifest.js';

const schemaDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema');

await writeFile(join(schemaDir, 'llm-docs.schema.json'), projectConfigJsonSchemaText());
await writeFile(join(schemaDir, 'manifest.schema.json'), manifestJsonSchemaText());
process.stdout.write(`Wrote llm-docs.schema.json and manifest.schema.json to ${schemaDir}\n`);
