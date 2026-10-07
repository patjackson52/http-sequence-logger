import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import validateEvent from '../shared/event-validator.mjs';
const hash = x => createHash('sha256').update(x).digest('hex');
const field = (value, path) => String(path).split('.').reduce((x, k) => x && Object.hasOwn(x, k) ? x[k] : undefined, value);
/** Canonical event, JSON logger wrapper, or Cloudflare logs[].message array. */
export function canonicalParser(record) {
  let value = record;
  if (typeof record === 'string') {
    const text = record.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim();
    const begin = text.indexOf('{'); if (begin < 0) return [];
    try { value = JSON.parse(text.slice(begin)); }
    catch (error) { if (/"(?:schema_version|event_type|http_sequence|logs)"\s*:/.test(text.slice(begin))) throw error; return []; }
  }
  if (value?.schema_version) return [value];
  if (value?.http_sequence) return canonicalParser(value.http_sequence);
  if (value?.logs) return value.logs.flatMap(x => (Array.isArray(x.message) ? x.message : [x.message]).flatMap(m => canonicalParser(m)));
  if (value?.message != null) return canonicalParser(value.message);
  return [];
}
/** Raw logs remain messages; missing span lifecycle or timing is never synthesized. */
export function createJSONMappingParser({ namespace, service, fields }) {
  if (!namespace || !service || !fields?.message || !fields?.timestamp) throw new TypeError('Raw parser requires namespace, service, message and timestamp mapping');
  return (record, reference) => {
    const raw = typeof record === 'string' ? JSON.parse(record) : record;
    const message = field(raw, fields.message), stamp = field(raw, fields.timestamp);
    if (typeof message !== 'string' || !Number.isFinite(Date.parse(stamp))) return [];
    const identity = hash(reference), trace = field(raw, fields.trace_id), span = field(raw, fields.span_id), parent = field(raw, fields.parent_span_id);
    const validTrace = /^[0-9a-f]{32}$/.test(trace || '') && !/^0+$/.test(trace);
    const valid = validTrace && /^[0-9a-f]{16}$/.test(span || '') && !/^0+$/.test(span);
    const hasParent = /^[0-9a-f]{16}$/.test(parent || '') && !/^0+$/.test(parent);
    const level = field(raw, fields.level);
    return [{ schema_version: '1.3', event_type: 'log.message', event_id: identity, session_namespace: namespace, session_id: validTrace ? trace : service, recording_id: `raw:${identity}`, sequence: 1, timestamp: new Date(stamp).toISOString(), monotonic_ns: '0', ...(valid ? { context: { trace_id: trace, span_id: span, parent_span_id: hasParent ? parent : null, parent_scope: hasParent ? 'remote' : 'none' } } : {}), data: { ...(validTrace && !valid ? {trace_id:trace} : {}), message: message.slice(0, 16384), level: ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info' }, extensions: { 'source.reference': reference, 'source.service_name': service, 'source.clock': 'monotonic_unavailable' } }];
  };
}
export function createLocalFileAdapter({ id, path, metadata, parser = canonicalParser }) {
  if (!id || !path || !metadata) throw new TypeError('Local adapter id, path and metadata required');
  return { id, kind: 'local-file', metadata, parser,
    async query({ signal, cursor, max_records, max_bytes }) {
      const fd = await open(path, 'r');
      try {
        const info = await fd.stat(); if (!info.isFile()) throw new Error('Source is not a regular file');
        const prior = cursor ? JSON.parse(cursor) : null;
        if (prior && (prior.dev !== info.dev || prior.ino !== info.ino || prior.offset > info.size)) throw new Error('Local log rotated or truncated during collection');
        const offset = prior?.offset || 0;
        const bytes = Buffer.alloc(Math.min(info.size - offset, max_bytes));
        const { bytesRead } = await fd.read(bytes, 0, bytes.length, offset); signal.throwIfAborted();
        const records = []; let consumed = 0;
        while (records.length < max_records) {
          const newline = bytes.subarray(0,bytesRead).indexOf(10,consumed);
          if (newline < 0) break;
          const line = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(consumed,newline));
          if (line.trim()) records.push({ value: line, reference: `${id}:${info.dev}:${info.ino}:${offset + consumed}:${hash(line)}` });
          consumed = newline + 1;
        }
        if (!consumed && bytesRead && offset + bytesRead < info.size) throw new Error('Raw log record exceeds page byte limit');
        const incomplete = consumed < bytesRead && offset + bytesRead === info.size && records.length < max_records;
        return { records, cursor: JSON.stringify({dev:info.dev,ino:info.ino,offset:offset+consumed}), truncated: incomplete, has_more: offset + consumed < info.size && !incomplete };
      } finally { await fd.close(); }
    },
  };
}
/** App-provided retained NDJSON endpoint, not Cloudflare's native observability API. */
export function createCloudflareAdapter({ id, endpoint, token, metadata, parser = canonicalParser, fetch: fetcher = fetch }) {
  if (!id || !endpoint || !metadata) throw new TypeError('Endpoint adapter id, endpoint and metadata required');
  const url = new URL(endpoint); if (!['http:', 'https:'].includes(url.protocol) || (url.protocol === 'http:' && !['127.0.0.1','localhost','[::1]'].includes(url.hostname)) || url.username || url.password) throw new TypeError('Invalid retained log endpoint');
  return { id, kind: 'cloudflare-retained', metadata, parser,
    async query({ trace_ids, time_window, cursor, max_records, max_bytes, signal }) {
      const response = await fetcher(endpoint, { method: 'POST', redirect: 'error', signal, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ trace_ids, time_window, cursor, max_records, max_bytes }) });
      if (!response.ok) throw new Error(`Retained log endpoint returned ${response.status}`);
      const reader = response.body.getReader(); let length = 0; const parts = [];
      try { for (;;) { const { value, done } = await reader.read(); if (done) break; length += value.byteLength; if (length > max_bytes) throw new Error('Retained log response exceeds byte limit'); parts.push(value); } } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const result = JSON.parse(Buffer.concat(parts).toString('utf8'));
      if (!Array.isArray(result.records)) throw new Error('Retained endpoint requires records array');
      return { ...result, records: result.records.slice(0, max_records).map(value => ({ value, reference: `${id}:${hash(JSON.stringify(value))}` })), truncated: Boolean(result.truncated || result.records.length > max_records) };
    },
  };
}
export function adaptersFromConfig(config) {
  if (!Array.isArray(config) || config.length > 32) throw new TypeError('Sources configuration must be an array of at most 32 adapters');
  return config.map(source => {
    if (!source || typeof source !== 'object' || (source.parser && !['canonical','json-mapping'].includes(source.parser.type))) throw new TypeError('Unknown parsing adapter configuration');
    const parser = source.parser?.type === 'json-mapping' ? createJSONMappingParser(source.parser) : canonicalParser;
    if (source.kind === 'local-file') return createLocalFileAdapter({ ...source, parser });
    if (source.kind === 'cloudflare-retained') return createCloudflareAdapter({ ...source, parser });
    throw new TypeError(`Unknown source adapter kind: ${source.kind}`);
  });
}
export function parseRecords(adapter, records, traceIDs, timeWindow) {
  const events = [], diagnostics = { parse_errors: 0, unmatched: 0, examples: [] };
  for (const record of records) {
    let failure = 'record_too_large';
    try {
      if (Buffer.byteLength(JSON.stringify(record.value)) > 1024 * 1024) throw new Error('Record too large');
      failure = 'parser_failed';
      const parsed = adapter.parser(record.value, record.reference);
      failure = 'invalid_parser_output';
      if (!Array.isArray(parsed)) throw new Error('Parser must return events array');
      if (!parsed.length) diagnostics.unmatched++;
      for (const event of parsed) {
        if (!validateEvent(event)) throw new Error('Parser produced invalid canonical event');
        const eventTrace = event.context?.trace_id || event.data?.trace_id;
        if (eventTrace && !traceIDs.includes(eventTrace)) continue;
        if (timeWindow && (Date.parse(event.timestamp) < Date.parse(timeWindow.start) || Date.parse(event.timestamp) > Date.parse(timeWindow.end))) continue;
        events.push(event);
      }
    } catch { diagnostics.parse_errors++; if (diagnostics.examples.length < 5) diagnostics.examples.push({ reference: String(record.reference ?? 'unavailable').slice(0,256), reason: failure }); }
  }
  // Retain metadata only for recordings whose correlated records matched.
  const recordings = new Set(events.filter(x => x.context || x.data?.trace_id).map(x => x.recording_id));
  return { events: events.filter(x => x.context || x.data?.trace_id || recordings.has(x.recording_id)), ...diagnostics };
}
