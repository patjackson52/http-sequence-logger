import { stable, LIMITS, SequenceDiffError } from './model.mjs';

const escape = text => text.replace(/~/g, '~0').replace(/\//g, '~1');
const under = (path, prefix) => path === prefix || path.startsWith(prefix + '/');
const own = (value, key) => Object.hasOwn(value, key);

function dimension(path) {
  if (/^\/(request_body|response_body)\/(availability|truncated|redacted|reason|stored_bytes|observed_bytes|total_bytes)/.test(path) ||
      /\/headers\/(availability|representation|order_preserved|reason)/.test(path)) return 'capture';
  if (path.startsWith('/timing')) return 'timing';
  if (path.startsWith('/result') || path.startsWith('/response/status')) return 'outcome';
  if (path.startsWith('/operation') || path.startsWith('/origin') || path.startsWith('/attempt') || path.startsWith('/context')) return 'structure';
  if (path.startsWith('/start') || path.startsWith('/end') || path.startsWith('/adapter')) return 'metadata';
  return 'content';
}

/** Parse only unambiguous JSON whose numeric tokens survive JS exactly.
 * Raw content is always compared as well, so this is an additional projection.
 */
function safeJSON(text) {
  let offset = 0;
  const ws = () => { while (/\s/.test(text[offset] ?? '') && offset < text.length) offset++; };
  const string = () => {
    const from = offset++;
    while (offset < text.length) {
      const c = text[offset++];
      if (c === '\\') { offset++; continue; }
      if (c === '"') return JSON.parse(text.slice(from, offset));
    }
    throw Error('Unterminated string');
  };
  function read(depth = 0) {
    if (depth > 64) throw Error('JSON nesting limit');
    ws();
    if (text[offset] === '"') return string();
    if (text[offset] === '{') {
      offset++; ws(); const result = Object.create(null);
      if (text[offset] === '}') { offset++; return result; }
      while (offset < text.length) {
        ws(); if (text[offset] !== '"') throw Error('Expected key');
        const key = string(); if (own(result, key)) throw Error('Duplicate key');
        ws(); if (text[offset++] !== ':') throw Error('Expected colon');
        result[key] = read(depth + 1); ws();
        const next = text[offset++]; if (next === '}') return result;
        if (next !== ',') throw Error('Expected comma');
      }
    }
    if (text[offset] === '[') {
      offset++; ws(); const result = [];
      if (text[offset] === ']') { offset++; return result; }
      while (offset < text.length) {
        result.push(read(depth + 1)); ws(); const next = text[offset++];
        if (next === ']') return result;
        if (next !== ',') throw Error('Expected comma');
      }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(offset))?.[0];
    if (!token) throw Error('Invalid value');
    offset += token.length;
    const value = JSON.parse(token);
    if (typeof value === 'number' && (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value) || JSON.stringify(value) !== token)) throw Error('Numeric spelling requires raw comparison');
    return value;
  }
  try { const result = read(); ws(); if (offset !== text.length) return null; return { value: result }; } catch { return null; }
}

export function compareFields(primary, secondary, profile, budget) {
  const a = structuredClone(primary.data), b = structuredClone(secondary.data);
  const changes = [], uncertainties = [], ignored = new Set(), blocked = new Set();
  const uncertain = (path, reason, block = false) => {
    if (!uncertainties.some(u => u.path === path && u.reason === reason)) uncertainties.push({ path, reason });
    if (block) blocked.add(path);
  };
  for (const [side, node, data] of [['primary', primary, a], ['secondary', secondary, b]]) {
    if (node.kind === 'recording') {
      if (!node.complete) uncertain('', side + '_incomplete_recording');
      continue;
    }
    if (!node.start) uncertain('', side + '_missing_start');
    if (!node.end) uncertain('/result', side + '_missing_end');
    if (node.missingParent) uncertain('', side + '_missing_parent');
    if (node.end?.data.outcome === 'unknown') uncertain('/result', side + '_observation_stopped');
    if (node.kind !== 'http') continue;
    for (const dir of ['request', 'response']) {
      if (!data[dir]) {
        if (!(dir === 'response' && node.end && node.end.data.status_code === null)) uncertain('/' + dir, side + '_missing_' + dir);
      } else {
        if (data[dir].url_redacted) uncertain('/' + dir + '/url', side + '_redacted_url', true);
        if (data[dir].url_redacted && dir === 'request') blocked.add('/request/query');
        if (data[dir].request_target?.redacted) uncertain('/' + dir + '/request_target/value', side + '_redacted_target', true);
        const headers = data[dir].headers;
        if (headers.availability !== 'captured') uncertain('/' + dir + '/headers', side + '_' + headers.availability + '_headers');
        headers.entries = headers.entries.filter(entry => {
          if (!profile.ignore_headers.includes(entry.name.toLowerCase())) return true;
          ignored.add('/' + dir + '/headers/entries'); return false;
        });
        headers.entries.forEach((entry, index) => {
          if (entry.redacted) uncertain('/' + dir + '/headers/entries/' + index + '/value', side + '_redacted_header', true);
        });
      }
      const path = '/' + dir + '_body', body = data[dir + '_body'];
      if (!body) { uncertain(path, side + '_missing_body', true); continue; }
      if (body.availability === 'unavailable') uncertain(path + '/content', side + '_unavailable_body', true);
      if (body.truncated || body.redacted) uncertain(path + '/content', side + (body.redacted ? '_redacted_body' : '_truncated_body'), true);
    }
  }
  if (profile.json_fields && primary.kind === 'http') {
    for (const dir of ['request_body', 'response_body']) {
      const eligible = body => body?.availability === 'captured' && !body.redacted && !body.truncated && body.content?.encoding === 'utf-8' && /(?:\/|\+)json(?:;|$)/i.test(body.media_type ?? '');
      if (eligible(a[dir]) && eligible(b[dir])) {
        const x = safeJSON(a[dir].content.data), y = safeJSON(b[dir].content.data);
        if (x && y) { a[dir].json = x.value; b[dir].json = y.value; }
      }
    }
  }
  if (profile.compare_timing && primary.kind !== 'recording') {
    const duration = node => node.end && node.end.data.outcome !== 'unknown' && node.start ? node.end.data.duration_ns : null;
    a.timing = { duration_ns: duration(primary) }; b.timing = { duration_ns: duration(secondary) };
    if (a.timing.duration_ns === null || b.timing.duration_ns === null) uncertain('/timing/duration_ns', 'incomplete_duration', true);
  }
  function walk(x, y, path, xp = true, yp = true, depth = 0) {
    if (depth > 128) throw new SequenceDiffError('Comparison nesting exceeds 128 levels.');
    if (profile.ignore_paths.some(p => under(path, p))) { ignored.add(path); return; }
    if ([...blocked].some(p => under(path, p))) return;
    if (xp === yp && stable(x) === stable(y)) return;
    const compatible = xp && yp && x !== null && y !== null && typeof x === 'object' && typeof y === 'object' && Array.isArray(x) === Array.isArray(y);
    if (compatible) {
      const keys = Array.isArray(x) ? Array.from({ length: Math.max(x.length, y.length) }, (_, i) => String(i)) : [...new Set([...Object.keys(x), ...Object.keys(y)])].sort();
      for (const key of keys) walk(x[key], y[key], path + '/' + escape(key), own(x, key), own(y, key), depth + 1);
      return;
    }
    if (++budget.count > LIMITS.changes) throw new SequenceDiffError('Comparison exceeds ' + LIMITS.changes + ' field changes.');
    changes.push({ path, dimension: dimension(path), primary: { present: xp, value: xp ? x : null }, secondary: { present: yp, value: yp ? y : null } });
  }
  walk(a, b, '');
  // An ignored path explicitly excludes its uncertainty as well.
  const included = uncertainties.filter(u => !profile.ignore_paths.some(p => under(u.path, p)));
  return { changes, uncertainties: included, ignored_paths: [...ignored].sort() };
}
