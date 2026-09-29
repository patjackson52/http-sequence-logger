import { writeFileSync } from 'node:fs';

// Authoring source; generate the standalone schema for non-JavaScript consumers.
const ref = (name) => ({ $ref: `#/$defs/${name}` });
const text = { type: 'string', minLength: 1 };
const nullableText = { type: ['string', 'null'] };
const bool = { type: 'boolean' };
const count = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const nullableCount = { anyOf: [count, { type: 'null' }] };
const choices = (...values) => ({ enum: values });
const object = (properties, required = Object.keys(properties)) => ({
  type: 'object', properties, required, additionalProperties: false,
});
const array = (items) => ({ type: 'array', items });
const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const token = { type: 'string', pattern: "^[!#$%&'*+.^_`|~0-9A-Za-z-]+$" };
const url = { type: 'string', format: 'uri', pattern: '^https?://' };
const timestamp = {
  type: 'string', format: 'date-time',
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3,9}Z$',
};
const definitions = {
  id: { type: 'string', minLength: 1, maxLength: 512 },
  ns: { type: 'string', pattern: '^(0|[1-9][0-9]*)$', maxLength: 30 },
  traceId: { type: 'string', pattern: '^(?!0{32}$)[0-9a-f]{32}$' },
  spanId: { type: 'string', pattern: '^(?!0{16}$)[0-9a-f]{16}$' },
  context: object({
    trace_id: ref('traceId'), span_id: ref('spanId'),
    parent_span_id: nullable(ref('spanId')),
    parent_scope: choices('none', 'local', 'remote'),
  }),
  actor: object({
    owner: choices('integrator', 'sdk', 'system', 'unknown'),
    component: text, method: nullableText,
  }),
  callsite: object({
    source: choices('explicit', 'stack', 'inferred'),
    file: nullableText, line: nullable({ type: 'integer', minimum: 1 }),
    function: nullableText,
  }),
  origin: object({ initiator: ref('actor'), executor: ref('actor'), callsite: nullable(ref('callsite')) }),
  header: object({ name: token, value: { type: 'string' }, redacted: bool }),
  headers: object({
    availability: choices('captured', 'partial', 'unavailable'),
    representation: choices('library', 'raw'),
    order_preserved: bool, entries: array(ref('header')), reason: nullableText,
  }),
  body: object({
    availability: choices('captured', 'unavailable', 'not_applicable'),
    representation: choices('application', 'encoded'),
    media_type: nullableText, charset: nullableText, content_encoding: nullableText,
    observed_bytes: nullableCount, total_bytes: nullableCount, stored_bytes: count,
    truncated: bool, redacted: bool, reason: nullableText,
    content: nullable(object({ encoding: choices('utf-8', 'base64'), data: { type: 'string' } })),
  }),
  error: object({ type: text, message: { type: 'string' }, stage: choices('dns', 'connect', 'tls', 'write', 'read', 'unknown') }),
  request: object({
    method: token, url, url_redacted: bool, headers: ref('headers'),
    method_source: choices('observed', 'inferred', 'configured'),
    configured_method: nullable(token),
    request_target: nullable(object({ value: text, source: choices('observed', 'configured'), redacted: bool })),
  }, ['method', 'url', 'url_redacted', 'headers']),
  response: object({
    status_code: { type: 'integer', minimum: 100, maximum: 599 },
    status_text: nullableText, url: nullable(url), url_redacted: bool, headers: ref('headers'),
  }),
  adapter: object({ name: text, version: text }),
  capabilities: object({
    attempts: choices('individual', 'logical'),
    request_body: choices('supported', 'partial', 'unsupported'),
    response_body: choices('supported', 'partial', 'unsupported'),
    transaction_metrics: bool,
  }),
  sessionStart: object({
    name: text, id_source: choices('provided', 'generated'),
    producer: object({
      platform: choices('android', 'ios'), app_id: text, app_version: text,
      os_version: text, sdk_version: text,
    }),
    adapters: array(object({ adapter: ref('adapter'), capabilities: ref('capabilities') })),
    capture_policy: object({
      profile: { const: 'development' }, body_limit_bytes: count,
      redact_headers: array({ type: 'string', minLength: 1 }),
      redact_query_keys: array(text), redact_body_paths: array(text),
    }),
    trace_propagation: choices('disabled', 'allowlist'),
    propagation_origins: array(url),
  }),
  sessionEnd: object({ reason: choices('completed', 'stopped'), dropped_events: count }),
  operationStart: object({ name: text, origin: ref('actor') }),
  operationEnd: object({
    outcome: choices('success', 'error', 'cancelled'), duration_ns: ref('ns'), error: nullable(ref('error')),
  }),
  requestStart: object({
    name: text, origin: ref('origin'), adapter: ref('adapter'), request: ref('request'),
    attempt: object({
      index: count, visibility: choices('individual', 'logical'),
      reason: choices('initial', 'retry', 'redirect', 'auth_challenge'),
      previous_span_id: nullable(ref('spanId')),
    }),
  }),
  responseHeaders: object({ phase: choices('informational', 'final'), response: ref('response') }),
  bodyCaptured: object({ direction: choices('request', 'response'), body: ref('body') }),
  trailers: object({ direction: choices('request', 'response'), headers: ref('headers') }),
  httpEnd: object({
    outcome: choices('success', 'http_error', 'transport_error', 'timeout', 'cancelled', 'unknown'),
    application_outcome: choices('success', 'error', 'unknown'),
    status_code: nullable({ type: 'integer', minimum: 100, maximum: 599 }),
    duration_ns: ref('ns'),
    end_reason: choices('body_eof', 'body_closed', 'transport_failure', 'cancelled', 'observation_stopped'),
    error: nullable(ref('error')),
  }),
  metrics: object({
    source: text, protocol_version: nullableText,
    transaction: nullable(object({ index: count, request: nullable(ref('request')), response: nullable(ref('response')) })),
    remote_address: nullableText, remote_port: nullable({ type: 'integer', minimum: 1, maximum: 65535 }),
    connection_reused: nullable(bool), response_source: choices('network', 'cache', 'unknown'),
    phases: array({ ...object({
      name: choices('dns', 'connect', 'tls', 'request_write', 'response_read'),
      start_timestamp: nullable(timestamp), end_timestamp: nullable(timestamp),
    }), anyOf: [
      { properties: { start_timestamp: timestamp } },
      { properties: { end_timestamp: timestamp } },
    ] }),
  }),
  captureGap: object({ dropped_events: { type: 'integer', minimum: 1 }, reason: text }),
};

// Capture state constraints are deliberately structural, usable in any validator.
definitions.context.allOf = [{
  if: { properties: { parent_scope: { const: 'none' } } },
  then: { properties: { parent_span_id: { type: 'null' } } },
  else: { properties: { parent_span_id: ref('spanId') } },
}];
definitions.headers.allOf = [{
  if: { properties: { availability: { const: 'unavailable' } } },
  then: { properties: { entries: { maxItems: 0 }, reason: text } },
  else: {
    if: { properties: { availability: { const: 'partial' } } },
    then: { properties: { reason: text } },
    else: { properties: { reason: { type: 'null' } } },
  },
}];
definitions.body.allOf = [{
  if: { properties: { availability: { const: 'captured' } } },
  then: { properties: { content: { type: 'object' } } },
  else: { properties: {
    content: { type: 'null' }, stored_bytes: { const: 0 }, truncated: { const: false },
    redacted: { const: false }, reason: text,
  } },
}, {
  if: { properties: { truncated: { const: true } } },
  then: { properties: { reason: text } },
}];

const events = [
  ['session.started', 'sessionStart', false], ['session.ended', 'sessionEnd', false],
  ['operation.started', 'operationStart', true], ['operation.ended', 'operationEnd', true],
  ['http.request.started', 'requestStart', true], ['http.response.headers', 'responseHeaders', true],
  ['http.body.captured', 'bodyCaptured', true], ['http.ended', 'httpEnd', true],
  ['http.trailers', 'trailers', true],
  ['http.metrics', 'metrics', true], ['capture.gap', 'captureGap', false],
];
const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:mobile-network-log:event:1.0',
  title: 'Mobile network log event, draft contract 1.0',
  description: 'One NDJSON record. See CONTRACT.md for cross-event and capture semantics. Custom format, not OTLP JSON.',
  ...object({
    schema_version: { const: '1.0' },
    event_type: { enum: events.map(([name]) => name) },
    event_id: ref('id'), session_namespace: ref('id'), session_id: ref('id'), recording_id: ref('id'),
    sequence: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    timestamp, monotonic_ns: ref('ns'), context: ref('context'), data: { type: 'object' },
    extensions: { type: 'object', propertyNames: { pattern: '^[a-z][a-z0-9_-]*\\.[a-zA-Z0-9_.-]+$' } },
  }, ['schema_version', 'event_type', 'event_id', 'session_namespace', 'session_id', 'recording_id', 'sequence', 'timestamp', 'monotonic_ns', 'data']),
  oneOf: events.map(([name, data, span]) => ({
    properties: { event_type: { const: name }, data: ref(data), ...(!span ? { context: false } : {}) },
    ...(span ? { required: ['context'] } : {}),
  })),
  $defs: definitions,
};

writeFileSync(new URL('../schema/event.schema.json', import.meta.url), `${JSON.stringify(schema, null, 2)}\n`);
