import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import standaloneCode from 'ajv/dist/standalone/index.js';

const base = new URL('../sequence-diff/', import.meta.url);
mkdirSync(new URL('schema/', base), { recursive: true });
mkdirSync(new URL('generated/', base), { recursive: true });
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const array = items => ({ type: 'array', items });
const text = { type: 'string' };
const id = { type: 'string', minLength: 1 };
const count = { type: 'integer', minimum: 0 };
const bool = { type: 'boolean' };
const nullable = value => ({ anyOf: [value, { type: 'null' }] });
const choice = (...values) => ({ enum: values });
const ref = name => ({ $ref: '#/$defs/' + name });
const pointer = { type: 'string', pattern: '^(|(/([^~]|~[01])*))$' };
const session = object({ namespace: id, id });
const match = object({ primary: id, secondary: id });
const options = object({
  ignore_paths: { ...array(pointer), uniqueItems: true },
  ignore_headers: { ...array(id), uniqueItems: true },
  compare_timing: bool,
  json_fields: bool,
  matches: array(match),
  recording_matches: array(match)
});
const source = object({
  recording_id: id, node_id: id, kind: choice('recording', 'operation', 'handler', 'http'),
  label: text, position: count, parent_node_id: nullable(id),
  event_ids: array(id), event_pointers: array(pointer)
});
const evidence = object({ present: bool, value: true });
const change = object({
  path: pointer, dimension: choice('structure', 'content', 'outcome', 'timing', 'metadata', 'capture'),
  primary: evidence, secondary: evidence
});
const uncertainty = object({ path: pointer, reason: id });
const pairing = object({
  id, parent_pair_id: nullable(id), primary: nullable(ref('source')), secondary: nullable(ref('source')),
  presence: choice('both', 'primary_only', 'secondary_only', 'unresolved'),
  matching: object({
    basis: choice('source_identity', 'signature', 'explicit', 'unmatched', 'ambiguous', 'unpaired_parent'),
    confidence: choice('exact', 'explicit', 'none'),
    candidate_node_ids: array(id)
  }),
  equivalence: choice('equal', 'different', 'unknown'),
  changes: array(ref('change')), uncertainties: array(ref('uncertainty')),
  ignored_paths: array(pointer)
});
pairing.allOf = [
  { if: { properties: { presence: { const: 'both' } } }, then: { properties: { primary: ref('source'), secondary: ref('source') } } },
  { if: { properties: { presence: { const: 'primary_only' } } }, then: { properties: { primary: ref('source'), secondary: { type: 'null' } } } },
  { if: { properties: { presence: { const: 'secondary_only' } } }, then: { properties: { primary: { type: 'null' }, secondary: ref('source') } } },
  { if: { properties: { presence: { const: 'unresolved' } } }, then: {
    properties: { equivalence: { const: 'unknown' } },
    oneOf: [
      { properties: { primary: ref('source'), secondary: { type: 'null' } } },
      { properties: { primary: { type: 'null' }, secondary: ref('source') } }
    ]
  } }
];
const sequenceSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:http-sequence:document:1.0',
  title: 'Canonical single-session sequence document',
  ...object({
    format: { const: 'http-sequence' }, schema_version: { const: '1.0' },
    session,
    events: { ...array({ $ref: '#/$defs/event' }), minItems: 1, maxItems: 20000 }
  }),
  $defs: { event: JSON.parse(readFileSync(new URL('../schema/event.schema.json', import.meta.url))) }
};
const diffSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:http-sequence:diff:1.0',
  title: 'Canonical sequence diff',
  ...object({
    format: { const: 'http-sequence-diff' }, schema_version: { const: '1.0' },
    engine: object({ name: { const: '@http-sequence-logger/sequence-diff' }, version: { const: '0.1.0' }, algorithm: { const: 'conservative-tree-v1' } }),
    inputs: object({ primary: object({ session, event_count: count, recording_count: count }), secondary: object({ session, event_count: count, recording_count: count }) }),
    profile: options,
    scope: object({ included: array(id), excluded: array(id) }),
    result: choice('equal', 'different', 'inconclusive'),
    summary: object({ matched: count, primary_only: count, secondary_only: count, unresolved: count, changed_pairs: count, equal_pairs: count, uncertain_pairs: count, order_changes: count, field_changes: count }),
    pairs: array(ref('pair')),
    order_changes: array(object({
      parent_pair_id: id, first_pair_id: id, second_pair_id: id,
      primary_relation: choice('before', 'after', 'overlap', 'unknown'),
      secondary_relation: choice('before', 'after', 'overlap', 'unknown'),
      interpretation: choice('reordered', 'concurrency_changed', 'observed_order_only')
    })),
    diagnostics: array(object({ side: choice('primary', 'secondary'), severity: choice('warning'), message: text }))
  }),
  $defs: { source, change, uncertainty, pair: pairing }
};
for (const [name, schema] of [['sequence', sequenceSchema], ['diff', diffSchema]]) {
  writeFileSync(new URL('schema/' + name + '.schema.json', base), JSON.stringify(schema, null, 2) + '\n');
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, strictRequired: false, code: { source: true, esm: true } });
  addFormats(ajv);
  let code = standaloneCode(ajv, ajv.compile(schema));
  const imports = new Map();
  code = code.replace(/require\("([^"]+)"\)/g, (_, specifier) => {
    if (!imports.has(specifier)) imports.set(specifier, 'runtime' + imports.size);
    return imports.get(specifier);
  });
  const header = [...imports].map(([specifier, variable]) => 'import ' + variable + ' from ' + JSON.stringify(specifier + '.js') + ';').join('\n');
  writeFileSync(new URL('generated/' + name + '-validator.mjs', base), '// Generated by scripts/build-diff-schema.mjs. Do not edit.\n' + header + '\n' + code + '\n');
}
// Package a generated copy of the authoritative capture validation, not a fork.
// This keeps npm pack self-contained without importing viewer or collector code.
for (const [from, to] of [['validate.mjs', 'capture-validation.mjs'], ['event-validator.mjs', 'event-validator.mjs']]) {
  const code = readFileSync(new URL('../shared/' + from, import.meta.url), 'utf8');
  writeFileSync(new URL('generated/' + to, base), '// Copied by scripts/build-diff-schema.mjs from shared/' + from + '. Do not edit.\n' + code);
}
