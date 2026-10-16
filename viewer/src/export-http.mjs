// Common .http/.rest syntax: https://www.jetbrains.com/help/idea/exploring-http-syntax.html
// and https://github.com/Huachao/vscode-restclient. Captures never execute here.
const token = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const nonempty = value => typeof value === 'string' && value.length > 0;
const json = value => JSON.stringify(value ?? null).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
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
      const environment = source?.environment_name || source?.environment_id || '';
      const backendEnvironment = producer.environment && producer.environment !== environment ? [environment, producer.environment].filter(Boolean).join(' / ') : environment;
      label = kind === 'backend' ? ['Backend', service || 'Unknown service', backendEnvironment].filter(Boolean).join(' · ') : ['App + SDK', app, environment].filter(Boolean).join(' · ');
    } else if (kind === 'backend' && nonempty(service)) {
      // Server capture creates a recording for each inbound invocation. Its explicit
      // producer tuple identifies the imported service; unknown fields stay unknown.
      identity = ['backend', 'producer', service, producer.environment ?? null, producer.runtime ?? null];
      label = ['Backend', service, producer.environment].filter(Boolean).join(' · ');
    } else {
      identity = [kind, 'recording', recording.id];
      label = `${kind === 'backend' ? 'Backend' : 'App + SDK'} · ${app}${session.recordings.length > 1 ? ` · Recording ${index + 1}` : ''}`;
    }
    const id = JSON.stringify(identity);
    if (!groups.has(id)) groups.set(id, { id, label, kind, recordings: [], requestCount: 0, observationCount: 0 });
    const group = groups.get(id);
    group.recordings.push(recording);
    const exchanges = recording.exchanges || [];
    group.requestCount += exchanges.filter(exchange => exchange.request && !exchange.orphan).length;
    group.observationCount += exchanges.length;
  }
  const result = [...groups.values()];
  const counts = new Map();
  for (const group of result) counts.set(group.label, (counts.get(group.label) || 0) + 1);
  const ordinals = new Map();
  for (const group of result) if (counts.get(group.label) > 1) {
    const base = group.label, ordinal = (ordinals.get(base) || 0) + 1;
    ordinals.set(base, ordinal);group.label = `${base} · Source ${ordinal}`;
  }
  return result;
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
  if (values.some(value => /\{\{/.test(value))) return 'Captured data contains HTTP-client variable syntax';
  return null;
}

// Reindent valid JSON without reserializing numbers, duplicate keys or strings.
function formatBody(body, request) {
  const content = body?.content;
  if (content?.encoding !== 'utf-8' || typeof content.data !== 'string') return '';
  const text = content.data;
  const mediaType = body.media_type || request.headers?.entries?.find(h => h.name.toLowerCase() === 'content-type')?.value || '';
  if (text.length > 256 * 1024) return text;
  if (!/\b(?:application|text)\/(?:[\w.-]+\+)?json\b/i.test(mediaType)) return text;
  try { JSON.parse(text); } catch { return text; }
  if (!/^[\s]*[\[{]/.test(text)) return text;
  let result = '', depth = 0, quoted = false, escaped = false;
  const newline = () => { result += '\n' + '  '.repeat(depth); };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      result += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (/\s/.test(char)) continue;
    if (char === '"') { quoted = true;result += char; }
    else if (char === '{' || char === '[') {
      result += char;
      const closing = char === '{' ? '}' : ']';
      let next = index + 1;while (/\s/.test(text[next] || '') && next < text.length) next++;
      if (text[next] === closing) { result += closing;index = next; }
      else { if (++depth > 32) return text;newline(); }
    } else if (char === '}' || char === ']') { depth--;newline();result += char; }
    else if (char === ',') { result += char;newline(); }
    else if (char === ':') result += ': ';
    else result += char;
  }
  return result;
}

// All response/capture information is comments before the active request. Nothing
// can accidentally become request payload bytes or an HTTP-client directive.
const note = (label, value) => `# ${label}: ${json(value)}`;
const oneLine = value => String(value).replace(/[\x00-\x1f\x7f\u2028\u2029]/g, char => JSON.stringify(char).slice(1, -1));
function endpointNotes(label, url) {
  if (!url) return [`# ${label} URL: not recorded`];
  const notes = [`# ${label} URL: ${oneLine(url)}`];
  try {
    const parsed = new URL(url);
    notes.push(`# ${label} host: ${oneLine(parsed.hostname)}`, `# ${label} port: ${parsed.port || (parsed.protocol === 'https:' ? '443 (URL default)' : '80 (URL default)')}`);
  } catch { /* Preserve recorded URL; never invent an address. */ }
  return notes;
}
function headerNotes(label, headers, includeValues = true) {
  if (!headers) return [`# ${label}: not recorded`];
  const { entries, ...details } = headers;
  const notes = [note(label, { ...details, entries: (entries || []).map(({ name, redacted }) => ({ name, redacted })) })];
  if (includeValues) for (const header of entries || []) notes.push(`# ${oneLine(header.name)}: ${oneLine(header.value)}`);
  return notes;
}
function bodyNotes(label, body, inline = false, headers = null) {
  if (!body) return [`# ${label}: not recorded`];
  const { content, ...details } = body;
  const notes = [note(label, { ...details, encoding: content?.encoding ?? null })];
  if (content && !inline) {
    if (content.encoding === 'base64') notes.push(note(`${label} (base64)`, content.data));
    else if (/[\x00-\x08\x0b-\x1f\x7f\u2028\u2029]/.test(content.data)) notes.push(note(`${label} (escaped UTF-8)`, content.data));
    else notes.push(...formatBody(body, {headers}).split('\n').map(line => `# ${line.replace(/\r/g, '\\r')}`));
  }
  return notes;
}
function exchangeNotes(exchange, unsafe) {
  const notes = [], request = exchange.request, body = exchange.requestBody;
  const events = exchange.rawEvents || [];
  notes.push(...endpointNotes('Request', request?.url));
  if (request) {
    const { method, url, headers, ...details } = request;
    notes.push(note('Request details', details), ...headerNotes('Request headers', headers, !!unsafe));
  } else notes.push('# Request start: not recorded');
  const extraStart = {...exchange.start?.data};delete extraStart.request;
  if (Object.keys(extraStart).length) notes.push(note('Request observation', extraStart));
  notes.push(...bodyNotes('Request body', body, !!request && !unsafe && body?.content?.encoding === 'utf-8'));
  const extraBodies = events.filter(event => event.event_type === 'http.body.captured' && event.data.direction === 'request' && event.data.body !== body);
  for (const event of extraBodies) notes.push(...bodyNotes('Additional request body', event.data.body));
  const responses = events.filter(event => event.event_type === 'http.response.headers').map(event => event.data);
  if (!responses.length && exchange.response) responses.push({phase:'final', response:exchange.response});
  for (const {phase, response} of responses) {
    notes.push(`# Response (${oneLine(phase)}): HTTP ${response.status_code}${response.status_text ? ' '+oneLine(response.status_text) : ''}`,
      ...endpointNotes('Response', response.url), note('Response URL redacted', response.url_redacted), ...headerNotes('Response headers', response.headers));
  }
  if (!responses.length) notes.push('# Response headers: not recorded');
  const responseBodies = events.filter(event => event.event_type === 'http.body.captured' && event.data.direction === 'response').map(event => event.data.body);
  if (!responseBodies.includes(exchange.responseBody) && exchange.responseBody) responseBodies.unshift(exchange.responseBody);
  if (!responseBodies.length) notes.push('# Response body: not recorded');
  for (const value of responseBodies) notes.push(...bodyNotes('Response body', value, false, exchange.response?.headers));
  for (const event of events.filter(event => event.event_type === 'http.trailers')) notes.push(...headerNotes(`${event.data.direction} trailers`, event.data.headers));
  for (const event of events.filter(event => event.event_type === 'http.metrics')) notes.push(note('Transport metrics', event.data));
  if (exchange.end) notes.push(note('Completion', exchange.end.data));
  else notes.push('# Completion: not recorded');
  for (const event of events.filter(event => event.event_type.startsWith('http.') && event.extensions)) notes.push(note(`${event.event_type} extensions`, event.extensions));
  return notes;
}

function exportExchange(exchange, number) {
  const request = exchange.request, body = exchange.requestBody;
  const unsafe = request ? unsafeRequest(request, body) : null;
  let path;
  try { path = new URL(request?.url || exchange.response?.url).pathname; } catch { path = ''; }
  const title = `${request ? request.method : 'Response only'} ${path}`.replace(/[\x00-\x1f\x7f\u2028\u2029]/g, ' ').slice(0, 200);
  const lines = [`### ${number}. ${title}`, ...exchangeNotes(exchange, unsafe)];
  if (!request) return lines.join('\n');
  if (unsafe) {
    lines.push('# Request cannot be represented literally; shown as comments.', `# Method: ${json(request.method)}`, `# URL: ${json(request.url)}`);
    for (const header of request.headers?.entries || []) lines.push(`# Header: ${json(`${header.name}: ${header.value}`)}`);
    // Escaped original request data remains recoverable even for client syntax.
    if (body?.content) lines.push(`# Body${body.content.encoding === 'base64' ? ' (base64)' : ''}: ${json(body.content.data)}`);
    return lines.join('\n');
  }
  if (body?.content?.encoding === 'base64') lines.push(`# Body (base64): ${json(body.content.data)}`);
  else if (!body || body.availability === 'unavailable') lines.push('# Body not captured.');
  lines.push(`${request.method} ${request.url}`);
  for (const header of request.headers?.entries || []) lines.push(`${header.name}: ${header.value}`);
  const inline = formatBody(body, request);
  return lines.join('\n') + (inline ? `\n\n${inline}` : '');
}

/** Export exactly one selected source; no network requests or Node APIs. */
export function exportHTTP(session, sourceId, options = {}) {
  const groups = requestSources(session, options);
  const source = groups.find(group => group.id === sourceId) || (sourceId == null && groups.length === 1 ? groups[0] : null);
  if (!source) throw new TypeError('Select an available HTTP request source.');
  const extension = options.extension === 'rest' ? 'rest' : 'http';
  const parts = [];
  for (const recording of source.recordings) {
    for (const exchange of [...(recording.exchanges || [])].sort((a, b) => sequenceOf(a) - sequenceOf(b))) {
      parts.push(exportExchange(exchange, parts.length + 1));
    }
  }
  return { text: parts.length ? parts.join('\n\n') + '\n' : '', filename: `${filenamePart(session.name || session.sessionId)}-${filenamePart(source.label)}.${extension}`, requestCount: source.requestCount, observationCount: source.observationCount, source, extension };
}
