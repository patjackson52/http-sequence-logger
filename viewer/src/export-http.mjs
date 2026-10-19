// Read-only HTTP transcripts. Captures are displayed and downloaded, never executed.
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

const oneLine = value => String(value).replace(/[\x00-\x1f\x7f\u2028\u2029]/g, char => JSON.stringify(char).slice(1, -1));

// Protocol comes only from recorded metrics. Different native transactions may
// negotiate different versions; a logical exchange must not guess which applies.
function httpVersion(exchange) {
  const metrics = (exchange.rawEvents || []).filter(event => event.event_type === 'http.metrics');
  const versions = metrics.map(event => {
    const value = event.data.protocol_version?.toLowerCase();
    if (value === 'h2') return 'HTTP/2';
    if (value === 'h3') return 'HTTP/3';
    if (/^(?:http\/)?(?:1\.[01]|2(?:\.0)?|3(?:\.0)?)$/.test(value || '')) return `HTTP/${value.replace(/^http\//, '').replace(/^([23])\.0$/, '$1')}`;
    return null;
  });
  return versions.length && versions.every(version => version && version === versions[0]) ? versions[0] : null;
}

function headersText(headers) {
  const lines = (headers?.entries || []).map(header => `${oneLine(header.name)}: ${oneLine(header.value)}`);
  if (!headers || headers.availability === 'unavailable') lines.unshift('# Headers not captured');
  else if (headers.availability === 'partial') lines.unshift('# Headers partially captured');
  return lines;
}

function bodyText(body, headers) {
  if (body?.availability === 'not_applicable') return '';
  const lines = [];
  if (body?.truncated) lines.push('# Body truncated');
  if (body?.redacted) lines.push('# Body redacted');
  if (!body?.content) {
    lines.push('# Body not captured');
  } else if (body.content.encoding === 'base64') {
    lines.push('# Body (base64)', body.content.data);
  } else {
    const value = formatBody(body, {headers});
    // Preserve exceptional bytes without creating separators or client directives.
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) || /(?:^|[\r\n])\s*(?:###|#|<|>|@|\{%|%\})/.test(value)) lines.push(`# Body (escaped UTF-8): ${json(body.content.data)}`);
    else lines.push(value);
  }
  return lines.join('\n');
}

function messageText(start, headers, body) {
  const lines = [start, ...headersText(headers)];
  const payload = bodyText(body, headers);
  return lines.join('\n') + (payload ? `\n\n${payload}` : '');
}

function exportExchange(exchange) {
  const request = exchange.request, version = httpVersion(exchange);
  const parts = [];
  if (request) {
    const unsafe = unsafeRequest(request, exchange.requestBody);
    if (unsafe) {
      const lines = ['# Request cannot be represented literally; shown as comments.', `# Method: ${json(request.method)}`, `# URL: ${json(request.url)}`];
      for (const header of request.headers?.entries || []) lines.push(`# Header: ${json(`${header.name}: ${header.value}`)}`);
      const body = exchange.requestBody;
      if (body?.truncated) lines.push('# Body truncated');
      if (body?.redacted) lines.push('# Body redacted');
      if (body?.content) lines.push(`# Body${body.content.encoding === 'base64' ? ' (base64)' : ''}: ${json(body.content.data)}`);
      else if (body?.availability !== 'not_applicable') lines.push('# Body not captured');
      parts.push(lines.join('\n'));
    } else parts.push(messageText(`${request.method} ${request.url}${version ? ' '+version : ''}`, request.headers, exchange.requestBody));
  } else parts.push('# Request not captured');

  const events = exchange.rawEvents || [];
  const responses = events.filter(event => event.event_type === 'http.response.headers').map(event => event.data);
  if (!responses.length && exchange.response) responses.push({phase:'final', response:exchange.response});
  for (const {phase, response} of responses) {
    const start = `${version || 'HTTP'} ${response.status_code}${response.status_text ? ' '+oneLine(response.status_text) : ''}`;
    parts.push('# Response\n' + messageText(start, response.headers, phase === 'informational' ? {availability:'not_applicable'} : exchange.responseBody));
  }
  if (!responses.length) parts.push('# No response captured');
  for (const event of events.filter(event => event.event_type === 'http.trailers')) parts.push(`# ${event.data.direction === 'request' ? 'Request' : 'Response'} trailers\n${headersText(event.data.headers).join('\n')}`);
  return parts.join('\n\n');
}

/** A selected source, or all sources in separate sections when sourceId is null. */
export function exportHTTP(session, sourceId, options = {}) {
  const groups = requestSources(session, options);
  const source = sourceId == null ? null : groups.find(group => group.id === sourceId);
  if (sourceId != null && !source) throw new TypeError('Select an available HTTP request source.');
  const selected = source ? [source] : groups;
  const extension = options.extension === 'rest' ? 'rest' : 'http';
  const sections = [];
  for (const group of selected) {
    const parts = [];
    for (const recording of group.recordings) {
      for (const exchange of [...(recording.exchanges || [])].sort((a, b) => sequenceOf(a) - sequenceOf(b))) parts.push(exportExchange(exchange));
    }
    if (parts.length) sections.push((groups.length > 1 ? `### Source: ${oneLine(group.label)}\n\n` : '') + parts.join('\n\n###\n\n'));
  }
  return {
    text: sections.length ? sections.join('\n\n') + '\n' : '',
    filename: `${filenamePart(session.name || session.sessionId)}${source ? '-'+filenamePart(source.label) : ''}.${extension}`,
    requestCount: selected.reduce((sum, group) => sum + group.requestCount, 0),
    observationCount: selected.reduce((sum, group) => sum + group.observationCount, 0),
    source, extension,
  };
}
