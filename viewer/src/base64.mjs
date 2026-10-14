// These are presentation-only heuristics. Captured values remain the authority:
// Base64 has no unique signature, so ambiguous unpadded identifiers stay raw.
export const BASE64_MAX_LENGTH = 256 * 1024;
const MAX_DEPTH = 32;
const MAX_MATCHES = 64;
const MAX_NODES = 10000;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function decode(value, explicit = false) {
  if (typeof value !== 'string' || !value.length || value.length > BASE64_MAX_LENGTH) return null;
  const padded = value.endsWith('=');
  if (!explicit && value.length < (padded ? 4 : 8)) return null;
  const standard = /^[A-Za-z0-9+/]+={0,2}$/.test(value);
  const urlSafe = /^[A-Za-z0-9_-]+={0,2}$/.test(value);
  if (!standard && !urlSafe) return null;
  const unpadded = value.replace(/=+$/, '');
  const remainder = unpadded.length % 4;
  if (remainder === 1 || (padded && (value.length % 4 !== 0 || value.length - unpadded.length !== (4 - remainder) % 4))) return null;
  const normalized = unpadded.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const binary = atob(normalized + '='.repeat((4 - remainder) % 4));
    // Round-tripping rejects nonzero unused pad bits accepted by permissive decoders.
    if (btoa(binary).replace(/=+$/, '') !== normalized) return null;
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    const decoded = decoder.decode(bytes);
    // Joiners are legitimate characters in emoji and international text.
    if (!decoded.length || /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u.test(decoded.replace(/[\t\r\n\u200c\u200d]/g, ''))) return null;
    // A plain unpadded word or number is indistinguishable from an opaque ID.
    // Punctuation, whitespace, or non-ASCII text provides stronger evidence.
    if (!explicit && !padded && /^[A-Za-z0-9]+$/.test(decoded)) return null;
    return { decoded, variant: standard ? 'standard' : 'url-safe', padded };
  } catch {
    return null;
  }
}

/** Detect one complete, canonical Base64 value containing readable UTF-8 text. */
export function detectBase64(value) {
  return decode(value);
}

/** Detect an exact header value or the token in a Basic authorization value. */
export function inspectBase64Header(value) {
  if (typeof value !== 'string') return null;
  const basic = /^(Basic[\t ]+)(\S+)$/i.exec(value);
  const match = detectBase64(basic ? basic[2] : value);
  return match ? { decoded: (basic?.[1] ?? '') + match.decoded, count: 1, format: basic ? 'basic' : 'text' } : null;
}

/**
 * Decode a whole text body, JSON string leaves, or form values for a local preview.
 * Structured previews retain names, repeated form fields, and ordering. Each value
 * is decoded once; parsed input is never modified. Oversized/deep/many-match bodies
 * are left unchanged instead of presenting an incomplete decoded preview.
 */
export function inspectBase64Body(raw, { mediaType = '', encoding = 'utf-8' } = {}) {
  if (typeof raw !== 'string' || raw.length > BASE64_MAX_LENGTH) return null;
  const whole = decode(raw, encoding === 'base64');
  if (whole) return { decoded: whole.decoded, count: 1, format: 'text' };
  // Explicit capture encoding describes the bytes. Do not reinterpret invalid
  // encoded/binary capture data as a JSON/form payload.
  if (encoding !== 'utf-8') return null;
  const type = String(mediaType ?? '').split(';', 1)[0].trim().toLowerCase();
  if (type === 'application/x-www-form-urlencoded') {
    let count = 0;
    const entries = [];
    for (const [name, value] of new URLSearchParams(raw)) {
      if (entries.length >= MAX_NODES) return null;
      const match = detectBase64(value);
      if (match && ++count > MAX_MATCHES) return null;
      entries.push({ name, value: match?.decoded ?? value });
    }
    return count ? { decoded: JSON.stringify(entries, null, 2), count, format: 'form' } : null;
  }
  // JSON can be logged without a media type; only parse complete JSON documents.
  try { JSON.parse(raw); } catch { return null; }
  // Replace string value tokens in the original JSON, retaining every other
  // byte. Re-serializing a parsed object loses duplicate keys, large integers,
  // exponent notation, and whitespace unrelated to the decoded values.
  let count = 0, nodes = 0, depth = 0, cursor = 0;
  const slices = [];
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (/\s/.test(char) || char === ',' || char === ':') continue;
    if (char === '[' || char === '{') {
      if (++depth > MAX_DEPTH || ++nodes > MAX_NODES) return null;
    } else if (char === ']' || char === '}') {
      depth--;
    } else if (char === '"') {
      if (++nodes > MAX_NODES) return null;
      const start = i++;
      while (i < raw.length && raw[i] !== '"') { if (raw[i] === '\\') i++; i++; }
      let next = i + 1;
      while (/\s/.test(raw[next] ?? '') && next < raw.length) next++;
      if (raw[next] === ':') continue; // Object names remain recorded names.
      const match = detectBase64(JSON.parse(raw.slice(start, i + 1)));
      if (!match) continue;
      if (++count > MAX_MATCHES) return null;
      slices.push(raw.slice(cursor, start), JSON.stringify(match.decoded));
      cursor = i + 1;
    } else {
      if (++nodes > MAX_NODES) return null;
      // Numbers, booleans, and null have no quotes or nested delimiters.
      while (i + 1 < raw.length && !/[\s,\]}]/.test(raw[i + 1])) i++;
    }
  }
  return count ? { decoded: slices.join('') + raw.slice(cursor), count, format: 'json' } : null;
}
