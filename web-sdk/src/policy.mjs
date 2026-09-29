const encoder = new TextEncoder();
const token = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const defaultHeaders = ['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key'];
const defaultQueries = ['token', 'access_token', 'refresh_token', 'password', 'code', 'api_key', 'key'];
const defaultKeys = ['password', 'accesstoken', 'refreshtoken', 'access_token', 'refresh_token', 'token', 'authorization', 'cookie', 'secret', 'api_key', 'ssn'];
export function createPolicy(options = {}) {
  const list = (defaults, extra) => [...new Set([...defaults, ...(extra || [])].map(s => String(s).toLowerCase()))];
  const bodyLimit = options.bodyLimitBytes ?? 65536;
  if (!Number.isSafeInteger(bodyLimit) || bodyLimit < 0 || bodyLimit > 65536) throw new TypeError('bodyLimitBytes must be 0–65536');
  return Object.freeze({ bodyLimit, headers: list(defaultHeaders, options.redactHeaders), queries: list(defaultQueries, options.redactQueryKeys), keys: list(defaultKeys, options.redactBodyKeys) });
}
export function cleanURL(value, policy, relative = false) {
  const original = String(value);
  if (original.length > 16384) throw new TypeError('URL exceeds capture limit');
  const url = new URL(original, globalThis.location?.href || 'http://localhost/');
  if (!['http:', 'https:'].includes(url.protocol)) throw new TypeError('Only HTTP URL capture is supported');
  let redacted = Boolean(url.username || url.password || url.hash);
  url.username = ''; url.password = ''; url.hash = '';
  if (url.search) {
    const query = url.search.slice(1).split('&').map(part => {
      const rawKey = part.split('=', 1)[0];
      const key = new URLSearchParams(`${rawKey}=`).keys().next().value;
      if (!policy.queries.includes(key.toLowerCase())) return part;
      redacted = true;
      return `${rawKey}=${encodeURIComponent('[REDACTED]')}`;
    }).join('&');
    url.search = `?${query}`;
  }
  let result = url.href;
  if (relative && !/^[a-z][a-z\d+.-]*:/i.test(original)) {
    if (original.startsWith('//')) result = `//${url.host}${url.pathname}${url.search}`;
    else { const beforeHash = original.split('#', 1)[0]; result = beforeHash.split('?', 1)[0] + (beforeHash.includes('?') ? url.search : ''); }
  }
  return { value: result, redacted };
}
export function cleanHeaders(input, policy, reason = 'application_visible_headers_only') {
  if (input == null) return { availability: 'unavailable', representation: 'library', order_preserved: false, entries: [], reason: 'headers_not_observed' };
  const iterable = typeof input[Symbol.iterator] === 'function' ? input : Object.entries(input);
  const entries = [];
  let headerBytes = 0;
  for (const [rawName, rawValue] of iterable) {
    if (entries.length >= 128) { reason = 'header_count_limit'; break; }
    const name = String(rawName), value = String(rawValue);
    if (!token.test(name)) continue;
    let result = value, redacted = false;
    if (policy.headers.includes(name.toLowerCase()) || value.length > 8192 || name.length > 256) { result = '[REDACTED]'; redacted = true; }
    else if (['location', 'content-location', 'referer'].includes(name.toLowerCase())) {
      try { const safe = cleanURL(value, policy, true); result = safe.value; redacted = safe.redacted; }
      catch { result = '[REDACTED]'; redacted = true; }
    }
    const cost = encoder.encode(name.slice(0, 256)).byteLength + encoder.encode(result).byteLength;
    if (headerBytes + cost > 65536) { reason = 'header_bytes_limit'; break; }
    headerBytes += cost;
    entries.push({ name: name.slice(0, 256), value: result, redacted });
  }
  return { availability: 'partial', representation: 'library', order_preserved: false, entries, reason };
}
export function missingBody(reason = 'body_not_observed', notApplicable = false) {
  return { availability: notApplicable ? 'not_applicable' : 'unavailable', representation: 'application', media_type: null, charset: null, content_encoding: null, observed_bytes: notApplicable ? 0 : null, total_bytes: notApplicable ? 0 : null, stored_bytes: 0, truncated: false, redacted: false, reason, content: null };
}
export function cleanBody(input = {}, policy) {
  const { data, mediaType, notApplicable, reason } = input;
  if (notApplicable) return missingBody(reason || 'no_body', true);
  if (data == null) return missingBody(reason || 'body_not_observed');
  const media = typeof mediaType === 'string' ? mediaType.split(';')[0].trim().toLowerCase() : null;
  const unavailable = (why, length = null) => ({ ...missingBody(why), media_type: media, observed_bytes: length, total_bytes: length });
  // Bound work before decoding or parsing; never parse partial JSON and then redact it.
  if (typeof data === 'string' && data.length > 1048576) return unavailable('redaction_input_limit');
  const bytes = typeof data === 'string' ? encoder.encode(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Uint8Array ? data : null;
  if (!bytes) return unavailable('unsupported_body_type');
  if (bytes.byteLength > 1048576) return unavailable('redaction_input_limit', bytes.byteLength);
  if (bytes.byteLength === 0) return { ...missingBody('empty_body'), availability: 'captured', media_type: media, charset: 'utf-8', observed_bytes: 0, total_bytes: 0, reason: null, content: { encoding: 'utf-8', data: '' } };
  if (!media || !(media === 'application/json' || media.endsWith('+json'))) return unavailable('non_json_withheld', bytes.byteLength);
  let decoded, parsed;
  try { decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); parsed = JSON.parse(decoded.replace(/^\uFEFF/, '')); }
  catch { return unavailable('invalid_json_withheld', bytes.byteLength); }
  let redacted = false;
  function visit(value, depth = 0) {
    if (depth > 64) throw new Error('depth');
    if (value && typeof value === 'object') {
      for (const key of Object.keys(value)) {
        if (policy.keys.includes(key.toLowerCase())) { value[key] = '[REDACTED]'; redacted = true; }
        else visit(value[key], depth + 1);
      }
    }
  }
  try { visit(parsed); } catch { return unavailable('json_depth_limit', bytes.byteLength); }
  // Preserve exact application bytes if no redaction was needed.
  const safe = redacted ? encoder.encode(JSON.stringify(parsed)) : bytes;
  const truncated = safe.byteLength > policy.bodyLimit;
  const prefix = safe.subarray(0, policy.bodyLimit);
  let content;
  if (truncated) { let binary = ''; for (const byte of prefix) binary += String.fromCharCode(byte); content = { encoding: 'base64', data: btoa(binary) }; }
  else content = { encoding: 'utf-8', data: redacted ? JSON.stringify(parsed) : decoded };
  return { availability: 'captured', representation: 'application', media_type: media, charset: 'utf-8', content_encoding: null, observed_bytes: bytes.byteLength, total_bytes: bytes.byteLength, stored_bytes: prefix.byteLength, truncated, redacted, reason: truncated ? 'body_limit' : null, content };
}
export function safeError(error, stage = 'unknown') {
  // Arbitrary names/messages/stacks and thrown values may contain credentials.
  let type = 'Error';
  try { const name = error?.name; if (['AbortError', 'TimeoutError', 'TypeError', 'SyntaxError', 'RangeError'].includes(name)) type = name; } catch { /* hostile getters are not inspected */ }
  return { type, message: '[message withheld]', stage: ['dns', 'connect', 'tls', 'write', 'read'].includes(stage) ? stage : 'unknown' };
}
