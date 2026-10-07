import { parseCapture, validateEvents } from '../../shared/validate.mjs';

export const IMPORT_LIMITS = Object.freeze({ maxFileBytes: 16 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024, maxEvents: 100000 });
const unknownActor = () => ({ owner: 'unknown', component: 'Not recorded', method: null });
const spanId = (e) => `${e.context.trace_id}/${e.context.span_id}`;
const sessionId = (e) => JSON.stringify([e.session_namespace, e.session_id]);
const nsToMs = (ns) => ns == null ? null : Number(BigInt(ns) / 1000n) / 1000;
const deltaNs = (a, b) => a && b ? (BigInt(b.monotonic_ns) - BigInt(a.monotonic_ns)).toString() : null;
const urls = (e) => [e.data.request?.url, e.data.response?.url, e.data.transaction?.request?.url, e.data.transaction?.response?.url].filter(Boolean);
const originOf = (url) => { try { return new URL(url).origin; } catch { return null; } };
const unique = (values) => [...new Set(values)];

/** All imported values remain data; no URL is fetched and no markup is evaluated. */
export function importFiles(inputFiles, limits = IMPORT_LIMITS) {
  const caps = { ...IMPORT_LIMITS, ...limits };
  const files = [], events = [], diagnostics = [], sourceLines = Object.create(null), locations = new Map();
  let totalBytes = 0;
  for (let index = 0; index < inputFiles.length; index++) {
    const input = inputFiles[index];
    const text = typeof input.text === 'string' ? input.text : '';
    const file = { id: `file-${index}`, name: input.name || `capture-${index + 1}.ndjson`, bytes: new TextEncoder().encode(text).length, lines: null, events: 0, sessions: 0, diagnostics: [] };
    files.push(file);
    totalBytes += file.bytes;
    const note = (severity, message, line = null) => {
      const item = { severity, message, fileName: file.name, fileId: file.id, line, eventId: null, recordingId: null };
      diagnostics.push(item); file.diagnostics.push(item);
    };
    if (file.bytes > caps.maxFileBytes) { note('error', `File exceeds the ${caps.maxFileBytes} byte import limit; file skipped.`); continue; }
    if (totalBytes > caps.maxTotalBytes) { note('error', `Import exceeds the ${caps.maxTotalBytes} byte total limit; file skipped.`); continue; }
    const rawLines = text.split('\n');
    file.lines = rawLines.length - (text.endsWith('\n') ? 1 : 0);
    let parsed;
    try { parsed = parseCapture(text); } catch (error) { note('error', `Unable to parse file safely: ${error.message}`); continue; }
    for (const [severity, messages] of [['error', parsed.errors], ['warning', parsed.warnings]]) {
      for (const message of messages) note(severity, message, Number(message.match(/line (\d+)/)?.[1]) || null);
    }
    if (!parsed.events.length && !parsed.errors.length) note('error', 'File contains no valid events.');
    if (events.length + parsed.events.length > caps.maxEvents) { note('error', `Import exceeds the ${caps.maxEvents} event limit; file skipped.`); continue; }
    file.events = parsed.events.length;
    file.sessions = new Set(parsed.events.map(sessionId)).size;
    for (let i = 0; i < parsed.events.length; i++) {
      const e = parsed.events[i], line = parsed.locations[i].line;
      const source = { fileName: file.name, fileId: file.id, line, text: rawLines[line - 1] };
      if (!sourceLines[e.event_id]) sourceLines[e.event_id] = [];
      sourceLines[e.event_id].push(source);
      if (!locations.has(e.event_id)) locations.set(e.event_id, source);
      events.push(e);
    }
  }
  let validation;
  try { validation = validateEvents(events); } catch (error) {
    diagnostics.push({ severity: 'error', message: `Unable to validate capture safely: ${error.message}`, fileName: null, line: null, eventId: null, recordingId: null });
    return { valid: false, files, events: [], sessions: [], summary: {}, diagnostics, sourceLines };
  }
  const eventById = new Map(validation.events.map(e => [e.event_id, e]));
  for (const [severity, messages] of [['error', validation.errors], ['warning', validation.warnings]]) {
    for (const message of messages) {
      const id = message.slice(0, message.indexOf(':'));
      const source = locations.get(id), event = eventById.get(id);
      const diagnostic = { severity, message, fileName: source?.fileName ?? null, fileId: source?.fileId ?? null, line: source?.line ?? null, eventId: event?.event_id ?? null, recordingId: event?.recording_id ?? null };
      diagnostics.push(diagnostic);
      if (source) files.find(f => f.id === source.fileId).diagnostics.push(diagnostic);
    }
  }
  const sessions = reconstruct(validation.events, sourceLines, diagnostics);
  connectDistributedSessions(sessions);
  return { valid: !diagnostics.some(d => d.severity === 'error'), sessions, diagnostics, summary: validation.summary, events: validation.events, files, sourceLines };
}

function reconstruct(events, sources, diagnostics) {
  const sessionMap = new Map();
  for (const event of events) {
    const key = sessionId(event);
    if (!sessionMap.has(key)) sessionMap.set(key, { id: key, namespace: event.session_namespace, sessionId: event.session_id, name: null, startedAt: null, recordings: [], operations: [], exchanges: [], origins: [], summary: {}, events: [] });
    const session = sessionMap.get(key);
    session.events.push(event);
    let recording = session.recordings.find(r => r.id === event.recording_id);
    if (!recording) {
      recording = { id: event.recording_id, sessionId: key, name: null, schemaVersion: event.schema_version, producer: null, start: null, end: null, events: [], operations: [], exchanges: [], origins: [], incomplete: true };
      session.recordings.push(recording);
    }
    recording.events.push(event);
  }
  for (const session of sessionMap.values()) {
    for (const recording of session.recordings) {
      recording.events.sort((a, b) => a.sequence - b.sequence);
      recording.start = recording.events.find(e => e.event_type === 'session.started') ?? null;
      recording.end = recording.events.find(e => e.event_type === 'session.ended') ?? null;
      recording.name = recording.start?.data.name ?? 'Recording metadata not recorded';
      recording.producer = recording.start?.data.producer ?? null;
      recording.incomplete = !recording.start || !recording.end;
      recording.startedAt = recording.start?.timestamp ?? recording.events[0]?.timestamp ?? null;
      recording.origins = unique(recording.events.flatMap(urls).map(originOf).filter(Boolean));
      recording.diagnostics = diagnostics.filter(d => d.recordingId === recording.id);
      recording.invalid = recording.diagnostics.some(d => d.severity === 'error');
      const spans = new Map();
      for (const e of recording.events.filter(e => e.context || e.event_type === 'log.message')) {
        const id = e.context ? spanId(e) : `log/${e.event_id}`;
        if (!spans.has(id)) spans.set(id, []);
        spans.get(id).push(e);
      }
      for (const [id, observations] of spans) {
        const start = observations.find(e => ['operation.started', 'http.request.started'].includes(e.event_type)) ?? null;
        const end = observations.find(e => ['operation.ended', 'http.ended'].includes(e.event_type)) ?? null;
        const first = start ?? observations[0];
        const context = first.context || {};
        const observedDurationNs = end?.data.duration_ns ?? null;
        const stopped = end?.data.completion === 'observation_stopped' || end?.data.end_reason === 'observation_stopped';
        const durationNs = stopped ? null : observedDurationNs;
        const serviceName = recording.producer?.service_name ?? recording.start?.extensions?.['server.service_name'] ?? first.extensions?.['source.service_name'] ?? (['server', 'node', 'cloudflare'].includes(recording.producer?.platform) ? recording.producer?.app_id : null);
        const base = { serviceName, spanRole: first.data.span_kind ?? first.extensions?.['span.kind'] ?? null, provenance: first.extensions?.['source.reference'] ?? null, contextSpanKey: context.trace_id && context.span_id ? `${context.trace_id}/${context.span_id}` : null, clockUncertain: context.parent_scope === 'remote' || first.extensions?.['source.clock'] === 'monotonic_unavailable', id, spanId: context.span_id, traceId: context.trace_id ?? first.data.trace_id, recordingId: recording.id, sessionId: session.id, parentId: context.parent_span_id ? `${context.trace_id}/${context.parent_span_id}` : null, parentScope: context.parent_scope, start, end, rawEvents: observations, rawSources: observations.map(e => sources[e.event_id]?.[0] ?? null), outcome: end?.data.outcome ?? 'unfinished', error: end?.data.error ?? null, durationNs, durationMs: nsToMs(durationNs), observedDurationNs, observedDurationMs: nsToMs(observedDurationNs), stopped, incomplete: !end, orphan: !start, invalid: recording.invalid, depth: 0, childIds: [], childRequestIds: [], ancestorIds: [] };
        if (observations.some(e => e.event_type.startsWith('http.'))) {
          const responseEvent = observations.find(e => e.event_type === 'http.response.headers' && e.data.phase === 'final') ?? null;
          const request = start?.data.request ?? null;
          const response = responseEvent?.data.response ?? null;
          const initiator = start?.data.origin.initiator ?? unknownActor();
          const executor = start?.data.origin.executor ?? unknownActor();
          const url = request?.url ?? response?.url ?? null;
          let path = 'Request not recorded', query = [];
          try { const parsed = new URL(url); path = `${parsed.pathname}${parsed.search}`; query = [...parsed.searchParams].map(([name, value]) => ({ name, value })); } catch { /* Orphan data does not invent a URL. */ }
          const timeToHeadersNs = deltaNs(start, responseEvent);
          const exchange = { ...base, messages: observations.filter(e => e.event_type === 'log.message'), kind: 'http', request, response, responseEvent, requestBody: observations.find(e => e.event_type === 'http.body.captured' && e.data.direction === 'request')?.data.body ?? null, responseBody: observations.find(e => e.event_type === 'http.body.captured' && e.data.direction === 'response')?.data.body ?? null, trailers: observations.filter(e => e.event_type === 'http.trailers'), metrics: observations.filter(e => e.event_type === 'http.metrics'), informational: observations.filter(e => e.event_type === 'http.response.headers' && e.data.phase === 'informational'), initiator, executor, owner: executor.owner, component: executor.component, method: request?.method ?? 'Not recorded', url, origin: originOf(url), path, query, status: end?.data.status_code ?? response?.status_code ?? null, applicationOutcome: end?.data.application_outcome ?? 'unknown', timeToHeadersNs, timeToHeadersMs: nsToMs(timeToHeadersNs), returnedEarly: false, attempt: start?.data.attempt ?? null, adapter: start?.data.adapter ?? null, manual: start?.data.adapter?.name === 'customer.manual', operationId: base.parentId };
          exchange.classification = classifyOutcome(exchange);
          recording.exchanges.push(exchange);
        } else {
          const origin = start?.data.origin ?? unknownActor();
          const isHandler = Boolean(start?.data.invocation || end?.data.completion);
          const messages = observations.filter(e => e.event_type === 'log.message');
          const operation = { ...base, id: !start && messages.length ? `log/${messages[0].event_id}` : base.id, messages, kind: !start && messages.length ? 'log' : isHandler ? 'handler' : 'operation', name: start?.data.name ?? messages[0]?.data.message ?? 'Operation start not recorded', origin, owner: origin.owner, component: origin.component, method: origin.method, invocation: start?.data.invocation ?? null, isHandler, completion: end?.data.completion ?? null, repeatIndex: 1, repeatCount: 1 };
          operation.classification = classifyOutcome(operation);
          recording.operations.push(operation);
        }
      }
      const all = [...recording.operations, ...recording.exchanges], byId = new Map(all.map(s => [s.id, s]));
      for (const item of all) {
        const visited = new Set([item.id]);
        let parent = item.parentScope === 'local' ? byId.get(item.parentId) : null;
        if (parent) parent.childIds.push(item.id);
        while (parent && !visited.has(parent.id)) {
          visited.add(parent.id); item.ancestorIds.push(parent.id);
          if (item.kind === 'http') parent.childRequestIds.push(item.id);
          parent = parent.parentScope === 'local' ? byId.get(parent.parentId) : null;
        }
        item.depth = item.ancestorIds.length;
        if (item.kind === 'http') {
          const operation = item.ancestorIds.map(id => byId.get(id)).find(s => s.kind !== 'http');
          item.operationId = operation?.id ?? null;
          item.parentOperationKind = operation?.kind ?? null;
          item.parentOperationName = operation?.name ?? null;
          item.parentEndedAt = operation?.end ?? null;
          item.returnedEarly = Boolean(operation?.recordingId === item.recordingId && operation?.end && item.rawEvents.at(-1).sequence > operation.end.sequence);
          item.completedAfterParentReturn = Boolean(operation?.recordingId === item.recordingId && operation?.end && item.end && !item.stopped && item.end.sequence > operation.end.sequence);
          const handler = item.ancestorIds.map(id => byId.get(id)).find(s => s.isHandler);
          item.handlerId = handler?.id ?? null;
          item.completedAfterHandlerReturn = Boolean(handler?.recordingId === item.recordingId && handler?.completion === 'returned' && item.end && !item.stopped && item.end.sequence > handler.end.sequence);
        }
      }
      const repeats = new Map();
      for (const op of recording.operations) {
        const key = JSON.stringify([op.owner, op.component, op.method, op.name]);
        if (!repeats.has(key)) repeats.set(key, []);
        repeats.get(key).push(op);
      }
      for (const group of repeats.values()) group.forEach((op, i) => { op.repeatIndex = i + 1; op.repeatCount = group.length; });
      recording.operations.sort(orderItems); recording.exchanges.sort(orderItems);
    }
    // Preserve first file appearance between independent recording periods.
    // Wall timestamps and independent monotonic origins do not establish a shared timeline.
    session.name = session.recordings.find(r => r.start)?.name ?? 'Session metadata not recorded';
    session.startedAt = session.recordings[0]?.startedAt ?? null;
    session.operations = session.recordings.flatMap(r => r.operations);
    session.exchanges = session.recordings.flatMap(r => r.exchanges);
    session.origins = unique(session.recordings.flatMap(r => r.origins));
    session.handlers = session.operations.filter(o => o.isHandler);
    session.incomplete = session.recordings.some(r => r.incomplete) || [...session.operations, ...session.exchanges].some(s => s.incomplete);
    session.invalid = session.recordings.some(r => r.invalid);
    session.summary = { requests: session.exchanges.filter(e => !e.orphan).length, handler_calls: session.handlers.length, failed_requests: session.exchanges.filter(e => e.classification === 'failed').length, cancelled_requests: session.exchanges.filter(e => e.outcome === 'cancelled').length, unknown_outcomes: session.exchanges.filter(e => e.outcome === 'unknown').length, unfinished_requests: session.exchanges.filter(e => e.incomplete && !e.orphan).length, unfinished_handler_calls: session.handlers.filter(e => e.incomplete).length, unknown_handler_outcomes: session.handlers.filter(e => e.stopped).length, recordings: session.recordings.length, origins: session.origins.length };
  }
  return [...sessionMap.values()];
}

/** Resolve causality by trace/span identity, while preserving every producer's own clock and session. */
function connectDistributedSessions(sessions) {
  const originalItems = sessions.flatMap(s => [...s.operations, ...s.exchanges]);
  for (const log of originalItems.filter(i => i.kind === 'log' && i.traceId && i.spanId)) {
    const targets = originalItems.filter(i => i.kind !== 'log' && i.id === log.contextSpanKey);
    if (targets.length !== 1) continue;
    targets[0].messages = [...(targets[0].messages || []), ...log.messages];
    targets[0].rawEvents.push(...log.rawEvents);targets[0].rawSources.push(...log.rawSources);
    for (const session of sessions) { session.operations = session.operations.filter(i => i !== log); for (const r of session.recordings) r.operations = r.operations.filter(i => i !== log); }
  }
  const all = sessions.flatMap(s => [...s.operations, ...s.exchanges]);
  const candidates = new Map();
  for (const item of all) { const list = candidates.get(item.id) || []; list.push(item); candidates.set(item.id, list); }
  const parentOf = item => {
    const list = candidates.get(item.parentId) || [];
    const matches = list.filter(p => item.parentScope === 'local' ? p.recordingId === item.recordingId : item.parentScope === 'remote' && p.recordingId !== item.recordingId);
    return matches.length === 1 ? matches[0] : null; // Ambiguous IDs do not establish a connection.
  };
  for (const item of all) { item.childIds = []; item.childRequestIds = []; item.ancestorIds = []; }
  for (const item of all) {
    const direct = parentOf(item); item.parentResolved = Boolean(direct);
    if (direct) direct.childIds.push(item.id);
    const seen = new Set([item.id]); let parent = direct;
    while (parent && !seen.has(parent.id)) {
      seen.add(parent.id); item.ancestorIds.push(parent.id);
      if (item.kind === 'http') parent.childRequestIds.push(item.id);
      parent = parentOf(parent);
    }
    item.depth = item.ancestorIds.length;
  }
  // Each selectable session is an entry point into a trace graph, not a rewritten session.
  const originals = sessions.map(s => ({ session: s, recordings: s.recordings, items: [...s.operations, ...s.exchanges] }));
  for (const { session, recordings, items } of originals) {
    const traces = new Set(items.map(i => i.traceId).filter(Boolean));
    const related = originals.filter(s => s.session !== session).flatMap(s => s.recordings).filter(r => [...r.operations, ...r.exchanges].some(i => traces.has(i.traceId)));
    if (!related.length) continue;
    session.recordings = [...recordings, ...related.map(r => ({ ...r, related: true, operations: r.operations.filter(i => traces.has(i.traceId)), exchanges: r.exchanges.filter(i => traces.has(i.traceId)) }))];
    session.operations = session.recordings.flatMap(r => r.operations);
    session.exchanges = session.recordings.flatMap(r => r.exchanges);
    session.handlers = session.operations.filter(i => i.isHandler);
    session.origins = unique(session.exchanges.map(i => i.origin).filter(Boolean));
    session.relatedRecordings = related.length;
    session.summary = { ...session.summary, requests: session.exchanges.filter(i => !i.orphan).length, failed_requests: session.exchanges.filter(i => i.classification === 'failed').length, unknown_outcomes: session.exchanges.filter(i => i.outcome === 'unknown').length, unfinished_requests: session.exchanges.filter(i => i.incomplete && !i.orphan).length, handler_calls: session.handlers.length, recordings: session.recordings.length, origins: session.origins.length };
  }
}

function orderItems(a, b) { return (a.start?.sequence ?? a.rawEvents[0].sequence) - (b.start?.sequence ?? b.rawEvents[0].sequence); }

export function classifyOutcome(item) {
  if (item.status >= 400 || ['http_error', 'transport_error', 'timeout', 'error'].includes(item.outcome) || item.applicationOutcome === 'error') return 'failed';
  if (item.incomplete || item.orphan || item.outcome === 'unknown' || item.outcome === 'unfinished') return 'incomplete';
  if (item.outcome === 'cancelled') return 'cancelled';
  return item.outcome === 'success' ? 'success' : 'incomplete';
}

export function formatDuration(ns) {
  if (ns == null) return '—';
  const value = BigInt(ns);
  if (value < 1000n) return `${value} ns`;
  if (value < 1000000n) return `${(Number(value) / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })} µs`;
  const ms = nsToMs(ns);
  return ms < 1000 ? `${ms.toLocaleString('en-US', { maximumFractionDigits: 1 })} ms` : `${(ms / 1000).toLocaleString('en-US', { maximumFractionDigits: 2 })} s`;
}

/** A projection keeps causal method ancestry even when owner/kind filters hide that method's own row. */
export function filterSessionItems(session, options = {}) {
  const { search = '', owner = 'all', outcome = 'any', recordingId = null } = options;
  const kind = ({ 'http-only': 'http', 'local-only': 'local' })[options.kind] ?? options.kind ?? 'all';
  const origins = new Set(options.origins ?? []);
  const normalizedOwner = owner === 'app' ? 'integrator' : owner;
  const needle = search.toLowerCase().trim();
  const all = [...session.operations, ...session.exchanges];
  const matches = (item) => {
    if (recordingId && item.recordingId !== recordingId) return false;
    if (normalizedOwner !== 'all' && item.owner !== normalizedOwner) return false;
    if (outcome !== 'any' && outcome !== 'all' && classifyOutcome(item) !== outcome) return false;
    if (item.kind === 'http' && origins.size && !origins.has(item.origin)) return false;
    if (needle && ![item.spanId, item.traceId, item.id, item.name, item.method, item.url, item.component, item.invocation?.caller?.component, item.invocation?.caller?.method, item.invocation?.kind, item.completion, item.outcome].filter(Boolean).join(' ').toLowerCase().includes(needle)) return false;
    return true;
  };
  const exchanges = kind === 'local' ? [] : session.exchanges.filter(matches);
  const handlers = kind === 'http' ? [] : session.operations.filter(o => o.isHandler && matches(o));
  const directlyVisible = new Set([...exchanges, ...handlers].map(i => i.id));
  if (kind === 'all' || kind === 'local') session.operations.filter(matches).forEach(o => directlyVisible.add(o.id));
  if (kind === 'http') session.operations.filter(o => o.isHandler && matches(o) && !o.childRequestIds.length).forEach(o => directlyVisible.add(o.id));
  const visibleIds = new Set(directlyVisible);
  for (const item of all) if (directlyVisible.has(item.id)) item.ancestorIds.forEach(id => visibleIds.add(id));
  const operations = session.operations.filter(o => visibleIds.has(o.id));
  return { exchanges, operations, handlers, visibleIds, directIds: directlyVisible, hidden: new Set(all.filter(i => !visibleIds.has(i.id)).map(i => i.id)), filtersActive: Boolean(needle || normalizedOwner !== 'all' || !['any', 'all'].includes(outcome) || origins.size || kind !== 'all' || recordingId) };
}
