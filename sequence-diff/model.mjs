import validateDocument from './generated/sequence-validator.mjs';
import validateEvent from './generated/event-validator.mjs';
import { parseCapture, validateEvents } from './generated/capture-validation.mjs';

export const LIMITS = Object.freeze({ events: 20000, nodes: 5000, orderComparisons: 1000000, changes: 20000 });
export const stable = value => JSON.stringify(canonical(value));
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export class SequenceDiffError extends Error {
  constructor(message, details = []) { super(message); this.name = 'SequenceDiffError'; this.details = details; }
}
const sessionKey = e => JSON.stringify([e.session_namespace, e.session_id]);
const spanKey = e => e.context.trace_id + '/' + e.context.span_id;

/** Convert canonical NDJSON or an event array into one document per session. */
export function sequencesFromCapture(input) {
  const parsed = typeof input === 'string' ? parseCapture(input) : { events: input, errors: [], warnings: [] };
  if (!Array.isArray(parsed.events) || parsed.events.length > LIMITS.events) throw new SequenceDiffError('Capture requires at most ' + LIMITS.events + ' events.');
  // Never silently discard malformed input or recover an incomplete final line.
  if (parsed.errors.length || parsed.warnings.length) throw new SequenceDiffError('Capture parse failed (canonical event schema 1.3 required).', [...parsed.errors, ...parsed.warnings].slice(0, 12));
  for (const e of parsed.events) if (!validateEvent(e)) throw new SequenceDiffError('Invalid canonical event.');
  // Validate before partitioning: IDs cannot acquire contradictory meanings
  // across sessions in a single capture.
  const capture = validateEvents(parsed.events);
  if (!capture.valid) throw new SequenceDiffError('Contradictory capture events.', capture.errors);
  const groups = new Map();
  for (const e of capture.events) {
    const key = sessionKey(e);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  if (!groups.size) throw new SequenceDiffError('Capture has no sessions.');
  return [...groups.values()].map(events => {
    const first = events[0];
    const document = { format: 'http-sequence', schema_version: '1.0', session: { namespace: first.session_namespace, id: first.session_id }, events };
    const validation = validateSequence(document);
    return { ...document, events: validation.events };
  });
}

export function validateSequence(document) {
  if (!validateDocument(document)) throw new SequenceDiffError('Invalid sequence document.', (validateDocument.errors ?? []).slice(0, 12).map(e => (e.instancePath || '/') + ' ' + e.message));
  const expected = JSON.stringify([document.session.namespace, document.session.id]);
  if (document.events.some(e => sessionKey(e) !== expected)) throw new SequenceDiffError('A sequence document must contain exactly its declared session.');
  const result = validateEvents(document.events);
  if (!result.valid) throw new SequenceDiffError('Contradictory sequence events.', result.errors);
  return result;
}

/** No browser or filesystem dependencies; raw event pointers address input JSON. */
export function modelOf(document) {
  const validation = validateSequence(document);
  const indices = new Map(document.events.map((e, i) => [e.event_id, i]));
  const recordings = new Map(), nodes = new Map();
  for (const event of validation.events) {
    if (!recordings.has(event.recording_id)) recordings.set(event.recording_id, { id: JSON.stringify(['recording', event.recording_id]), rawId: event.recording_id, kind: 'recording', events: [], children: [], position: recordings.size });
    recordings.get(event.recording_id).events.push(event);
  }
  for (const recording of recordings.values()) {
    recording.events.sort((a, b) => a.sequence - b.sequence);
    const start = recording.events.find(e => e.event_type === 'session.started');
    const end = recording.events.find(e => e.event_type === 'session.ended');
    recording.start = start; recording.end = end;
    recording.label = start?.data.name ?? 'Recording metadata not recorded';
    recording.identity = start ? stable([start.data.producer.platform, start.data.producer.app_id]) : null;
    recording.signature = start ? stable([recording.identity, start.data.name]) : null;
    recording.complete = Boolean(start && end && end.data.reason === 'completed' && end.data.dropped_events === 0 &&
      !recording.events.some((e, i, list) => e.event_type === 'capture.gap' || i > 0 && e.sequence !== list[i - 1].sequence + 1));
    recording.data = { start: start?.data ?? null, end: end?.data ?? null };
    recording.parent = null; recording.recording = recording;
    nodes.set(recording.id, recording);
    const spans = new Map();
    for (const e of recording.events.filter(e => e.context)) {
      const key = spanKey(e);
      if (!spans.has(key)) spans.set(key, []);
      spans.get(key).push(e);
    }
    const local = new Map();
    for (const [key, events] of spans) {
      const start = events.find(e => e.event_type === 'operation.started' || e.event_type === 'http.request.started');
      const end = events.find(e => e.event_type === 'operation.ended' || e.event_type === 'http.ended');
      const http = events.some(e => e.event_type.startsWith('http.'));
      const kind = http ? 'http' : start?.data.invocation || end?.data.completion ? 'handler' : 'operation';
      const context = (start ?? events[0]).context;
      const id = JSON.stringify(['span', recording.rawId, key]);
      const node = { id, kind, events, start, end, recording, context, children: [], parent: null,
        position: start?.sequence ?? events[0].sequence, complete: Boolean(start && end), signature: null,
        label: start?.data.name ?? (http ? 'HTTP start not recorded' : 'Operation start not recorded') };
      if (start) {
        if (http) {
          const u = new URL(start.data.request.url);
          node.signature = stable([kind, start.data.origin.executor, start.data.request.method, u.origin, u.pathname,
            start.data.attempt.index, start.data.attempt.reason, start.data.attempt.visibility]);
          node.label = start.data.request.method + ' ' + u.pathname;
        } else node.signature = stable([kind, start.data.origin, start.data.name, start.data.invocation ?? null]);
      }
      node.data = projectNode(node);
      local.set(key, node); nodes.set(id, node);
    }
    for (const node of local.values()) {
      const parent = node.context.parent_scope === 'local' ? local.get(node.context.trace_id + '/' + node.context.parent_span_id) : null;
      node.parent = parent ?? recording;
      node.parent.children.push(node);
      node.missingParent = node.context.parent_scope === 'local' && !parent;
    }
    // Orphans do not have start-order checks in the capture validator. Their
    // parent edges can still form cycles; never silently drop a disconnected cycle.
    for (const node of local.values()) {
      const seen = new Set();
      for (let current = node; current && current !== recording; current = current.parent) {
        if (seen.has(current.id)) throw new SequenceDiffError('Cyclic local parent relationships.');
        if (seen.size > 128) throw new SequenceDiffError('Sequence nesting exceeds 128 levels.');
        seen.add(current.id);
      }
    }
    const visit = (node, depth = 0) => {
      if (depth > 128) throw new SequenceDiffError('Sequence nesting exceeds 128 levels.');
      node.children.sort((a, b) => a.position - b.position);
      node.children.forEach(child => visit(child, depth + 1));
    };
    visit(recording);
  }
  if (nodes.size > LIMITS.nodes) throw new SequenceDiffError('Sequence exceeds ' + LIMITS.nodes + ' reconstructed nodes.');
  return { document, recordings: [...recordings.values()], nodes, warnings: validation.warnings, indices };
}

function projectNode(node) {
  const start = node.start?.data, end = node.end?.data;
  const terminal = end ? { ...end } : null;
  if (terminal) delete terminal.duration_ns;
  const context = { parent_scope: node.context.parent_scope };
  if (node.kind !== 'http') return { context, operation: start ?? null, result: terminal };
  const response = node.events.find(e => e.event_type === 'http.response.headers' && e.data.phase === 'final');
  const body = direction => node.events.find(e => e.event_type === 'http.body.captured' && e.data.direction === direction)?.data.body ?? null;
  const request = start ? { ...start.request } : null;
  if (request) request.query = [...new URL(request.url).searchParams].map(([name, value]) => ({ name, value }));
  const attempt = start ? { ...start.attempt } : null;
  if (attempt) delete attempt.previous_span_id;
  return {
    context, request, response: response?.data.response ?? null,
    request_body: body('request'), response_body: body('response'), result: terminal,
    origin: start?.origin ?? null, adapter: start?.adapter ?? null, attempt,
    informational: node.events.filter(e => e.event_type === 'http.response.headers' && e.data.phase === 'informational').map(e => e.data.response),
    trailers: node.events.filter(e => e.event_type === 'http.trailers').map(e => e.data)
  };
}

export function reference(node, model) {
  return {
    recording_id: node.recording.rawId, node_id: node.id, kind: node.kind, label: node.label,
    position: node.position, parent_node_id: node.parent?.id ?? null,
    event_ids: node.events.map(e => e.event_id),
    event_pointers: node.events.map(e => '/events/' + model.indices.get(e.event_id))
  };
}
