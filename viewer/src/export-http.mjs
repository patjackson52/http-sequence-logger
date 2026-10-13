// Common .http/.rest syntax: https://www.jetbrains.com/help/idea/exploring-http-syntax.html
// and https://github.com/Huachao/vscode-restclient. Captures never execute here.
const token = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const nonempty = value => typeof value === 'string' && value.length > 0;
const json = value => JSON.stringify(value ?? null).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const comment = (name, value) => `# ${name}: ${json(value)}`;
const filenamePart = value => String(value || 'session').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 100) || 'session';
const sequenceOf = exchange => exchange.start?.sequence ?? exchange.rawEvents?.[0]?.sequence ?? 0;

/** Source attribution is independent of SDK/app ownership and request origin. */
export function requestSources(session, { sources = [], recordingSources = {} } = {}) {
  if (!session) return [];
  const registry = new Map(sources.map(source => [source.source_id, source]));
  const groups = new Map();
  for (const [index, recording] of (session.recordings || []).entries()) {
    const sourceId = Object.hasOwn(recordingSources, recording.id) ? recordingSources[recording.id] : null;
    const source = registry.get(sourceId);
    const producer = recording.producer || recording.start?.data.producer || {};
    const kind = (source?.platform || producer.platform) === 'server' ? 'backend' : 'client';
    const service = producer.service_name || producer.app_id || source?.app_id;
    const app = source?.app_id || producer.app_id || 'Unknown app';
    let identity, label;
    if (sourceId) {
      const confirmedClient = kind === 'client' && [source?.environment_id, source?.app_id, source?.installation_id].every(nonempty);
      identity = confirmedClient ? ['client', source.environment_id, source.app_id, source.installation_id] : kind === 'backend' ? [kind, 'source', sourceId, service ?? null, producer.environment ?? null, producer.runtime ?? null] : [kind, 'source', sourceId];
      const environment = source?.environment_name || source?.environment_id || 'environment unavailable';
      const backendEnvironment = producer.environment && producer.environment !== environment ? `${environment} / ${producer.environment}` : environment;
      label = kind === 'backend' ? `Backend · ${service || 'Unknown service'} · ${backendEnvironment} · ${producer.runtime || 'runtime unavailable'} · ${sourceId}` : `App + SDK · ${app} · ${environment} · ${source?.installation_id || sourceId}`;
    } else if (kind === 'backend' && nonempty(service)) {
      // Server capture creates a recording for each inbound invocation. Its explicit
      // producer tuple identifies the imported service; unknown fields stay unknown.
      identity = ['backend', 'producer', service, producer.environment ?? null, producer.runtime ?? null];
      label = `Backend · ${service} · ${producer.environment || 'environment unavailable'} · ${producer.runtime || 'runtime unavailable'} (imported)`;
    } else {
      identity = [kind, 'recording', recording.id];
      label = `${kind === 'backend' ? 'Backend' : 'App + SDK'} · ${app} · ${producer.platform || 'platform unavailable'} · Recording ${index + 1} (source identity unavailable)`;
    }
    const id = JSON.stringify(identity);
    if (!groups.has(id)) groups.set(id, { id, label, kind, recordings: [], requestCount: 0, observationCount: 0 });
    const group = groups.get(id);
    group.recordings.push(recording);
    const exchanges = recording.exchanges || [];
    group.requestCount += exchanges.filter(exchange => exchange.request && !exchange.orphan).length;
    group.observationCount += exchanges.length;
  }
  return [...groups.values()];
}

// Prevent captured data from becoming client variables, file includes, scripts,
// request separators, comment directives or invalid HTTP start/header lines.
function unsafeRequest(request, body) {
  if (!nonempty(request?.method) || !nonempty(request?.url)) return 'Request method or URL unavailable; no request invented';
  if (!token.test(request.method) || request.method.startsWith('#') || !/^https?:\/\/[^\s\x00-\x1f\x7f]+$/i.test(request.url)) return 'Request method or URL cannot be represented safely';
  const values = [request.method, request.url];
  for (const header of request.headers?.entries || []) {
    if (!token.test(header.name) || header.name.startsWith('#') || typeof header.value !== 'string' || /[\x00-\x1f\x7f]/.test(header.value)) return 'Captured header cannot be represented safely';
    values.push(header.value);
  }
  if (body?.content?.encoding === 'utf-8' && typeof body.content.data === 'string') {
    const data = body.content.data;
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(data) || /(?:^|[\r\n])\s*(?:#|\/\/|<|>|@|\{%|%\})/.test(data)) return 'Captured body contains HTTP-client syntax or non-text bytes';
    values.push(data);
  }
  if (values.some(value => /\{\{|\}\}/.test(value))) return 'Captured data contains HTTP-client variable syntax';
  return null;
}

function exportExchange(exchange, number) {
  const request = exchange.request;
  const body = exchange.requestBody;
  const unsafe = unsafeRequest(request, body);
  const notes = [`### ${request ? `Request ${number}` : `Orphan HTTP observation ${number}`}`];
  notes.push(comment('Recording', exchange.recordingId), comment('Original session', exchange.sessionId), comment('Trace / span', [exchange.traceId, exchange.spanId]));
  notes.push(comment('Request event', exchange.start ? { event_id: exchange.start.event_id, sequence: exchange.start.sequence, timestamp: exchange.start.timestamp } : null));
  notes.push(comment('Capture', 'Observed data may be incomplete or redacted. Review before sending; capture order is not a replay dependency or cross-source timeline.'));
  if (request) notes.push(comment('Request metadata', { ...exchange.start?.data, request: { ...request, method: undefined, url: undefined, headers: { ...request.headers, entries: request.headers?.entries?.map(({ name, redacted }) => ({ name, redacted })) } } }));
  notes.push(comment('Request body capture', body ? { ...body, content: body.content ? { encoding: body.content.encoding } : null } : { availability: 'not recorded', reason: 'Absence of a body observation does not establish an empty body' }));
  if (body?.content && body.content.encoding !== 'utf-8') notes.push(comment('Request body content (not inline; encoded data retained)', body.content));
  // Responses/trailers and every event reference stay before the request, so none
  // become bytes appended to its body in clients that parse comments differently.
  for (const [index, event] of (exchange.rawEvents || []).entries()) {
    const source = exchange.rawSources?.[index];
    notes.push(comment('Evidence', { event_id: event.event_id, recording_id: event.recording_id, sequence: event.sequence, event_type: event.event_type, timestamp: event.timestamp, ...(source ? { file: source.fileName, line: source.line } : {}), ...(event.extensions ? { extensions: event.extensions } : {}) }));
    if (event.event_type !== 'http.request.started' && !(event.event_type === 'http.body.captured' && event.data.direction === 'request' && event.data.body === body)) notes.push(comment('Observation', event.data));
  }
  if (unsafe) {
    notes.push(comment('Request disabled', unsafe));
    // JSON escaping retains exact original strings without allowing multiline
    // capture data to break out of the comment or create client directives.
    notes.push(comment('Captured request (commented)', request), comment('Captured request body (commented)', body));
    return notes.join('\n');
  }
  notes.push(`${request.method} ${request.url}`);
  for (const header of request.headers?.entries || []) notes.push(`${header.name}: ${header.value}`);
  const inline = body?.content?.encoding === 'utf-8' && typeof body.content.data === 'string' ? body.content.data : '';
  return `${notes.join('\n')}\n\n${inline}`;
}

/** Export exactly one selected source; no network requests or Node APIs. */
export function exportHTTP(session, sourceId, options = {}) {
  const groups = requestSources(session, options);
  const source = groups.find(group => group.id === sourceId) || (sourceId == null && groups.length === 1 ? groups[0] : null);
  if (!source) throw new TypeError('Select an available HTTP request source.');
  const extension = options.extension === 'rest' ? 'rest' : 'http';
  const parts = [comment('HTTP Sequence Logger', 'Captured requests in common .http / .rest syntax'), comment('Selected source', source.label), comment('Session', { name: session.name, namespace: session.namespace, id: session.sessionId }), comment('Ordering', 'Recording first appearance, then local sequence. Independent source clocks are not aligned.')];
  let number = 0;
  for (const recording of source.recordings) {
    parts.push(`### Recording ${++number}`, comment('Recording ID', recording.id), comment('Producer', recording.producer), comment('Capture policy', recording.start?.data.capture_policy), comment('Recording completeness', { incomplete: recording.incomplete, invalid: recording.invalid }));
    for (const exchange of [...(recording.exchanges || [])].sort((a, b) => sequenceOf(a) - sequenceOf(b))) parts.push(exportExchange(exchange, ++number));
  }
  if (!source.observationCount) parts.push(comment('Requests', 'No HTTP observations recorded for this source.'));
  return { text: parts.join('\n\n') + '\n', filename: `${filenamePart(session.name || session.sessionId)}-${filenamePart(source.label)}.${extension}`, requestCount: source.requestCount, observationCount: source.observationCount, source, extension };
}
