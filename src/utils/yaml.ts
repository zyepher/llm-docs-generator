import {
  binaryTag,
  CORE_SCHEMA,
  legacyMapTag,
  loadAll,
  mergeTag,
  omapTag,
  pairsTag,
  type Schema,
  timestampTag,
  YAMLException,
} from 'js-yaml';

/**
 * What js-yaml 4's `load()` used by default: the YAML 1.2 core schema plus
 * merge keys (`<<`, common in OpenAPI files), timestamps, and the other YAML
 * 1.1 extras, with complex mapping keys stringified rather than rejected.
 * js-yaml 5 defaults to the bare core schema, which would silently stop
 * merging anchors and turn dates into strings.
 */
const LEGACY_DEFAULT_SCHEMA = CORE_SCHEMA.withTags(
  mergeTag,
  timestampTag,
  binaryTag,
  omapTag,
  pairsTag,
  legacyMapTag
);

/**
 * Parse a single YAML document. A stream with no document (empty or
 * comment-only text) yields `undefined`, as js-yaml 4 did, instead of
 * throwing; a stream with more than one document still throws.
 */
export function loadYaml(text: string, schema: Schema = LEGACY_DEFAULT_SCHEMA): unknown {
  const documents = loadAll(text, { schema });
  if (documents.length > 1) {
    throw new YAMLException('expected a single document in the stream, but found more');
  }
  return documents[0];
}
