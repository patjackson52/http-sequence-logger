// Network Log Lab — prototype port of the conservative-tree-v1 sequence diff.
// Pure: (primary session, secondary session, profile) → http-sequence-diff 1.0 document.
// Matching: recordings → parent-scoped signatures → explicit overrides. Duplicate signatures stay unresolved.
// Output shape follows sequence-diff/schema/diff.schema.json; node labels/positions are derived from the viewer's reconstruction.

export const ENGINE = { name: '@http-sequence-logger/sequence-diff', version: '0.1.0', algorithm: 'conservative-tree-v1' };
export const DEFAULT_PROFILE = { ignore_paths: [], ignore_headers: ['x-request-id', 'date'], compare_timing: false, json_fields: true, matches: [], recording_matches: [] };

const esc = (seg) => String(seg).replace(/~/g, '~0').replace(/\//g, '~1');
const lower = (s) => String(s).toLowerCase();

// ---- Session document wrapper (sequence.schema 1.0-ish) ----------------------------------------
export function sessionNamespace(sess) { return `sample-app/${sess.platform || 'unknown'}`; }
export function sessionDocument(sess) {
  return { format: 'http-sequence', schema_version: '1.0', session: { namespace: sessionNamespace(sess), id: sess.id }, event_count: countEvents(sess), recording_count: sess.recordings.length };
}
function countEvents(sess) { const lines = new Set(); sess.operations.forEach((o) => o.events.forEach((e) => lines.add(e.line))); sess.exchanges.forEach((x) => x.events.forEach((e) => lines.add(e.line))); sess.recordings.forEach((r) => lines.add(r.line)); return lines.size + 2; }

// ---- Tree ----------------------------------------------------------------------------------
export function buildTree(sess) {
  const nodes = new Map();
  const recNodes = sess.recordings.map((r, i) => ({ node_id: r.id, kind: 'recording', ref: r, label: `Recording ${r.id}`, position: i, parent: null, children: [], recording_id: r.id, start: r.startMs, end: r.stopMs, lines: [r.line] }));
  recNodes.forEach((n) => nodes.set(n.node_id, n));
  const firstRec = recNodes[0] || null;
  const recOf = (id) => (id && nodes.get(id)) || firstRec;
  const seq = [].concat(sess.operations.map((o) => ({ t: o.startMs ?? 0, line: o.events[0] ? o.events[0].line : 0, op: o })), sess.exchanges.map((x) => ({ t: x.startMs ?? 0, line: x.line, ex: x }))).sort((a, b) => a.t - b.t || a.line - b.line);
  seq.forEach((e, i) => {
    if (e.op) { const o = e.op; const n = { node_id: o.id, kind: o.invocation ? 'handler' : 'operation', ref: o, label: `${o.component || '?'}.${o.method || '?'}`, position: i, parent: null, children: [], recording_id: o.recordingId, start: o.startMs, end: o.endMs, lines: o.events.map((ev) => ev.line) }; nodes.set(n.node_id, n); }
    else { const x = e.ex; const n = { node_id: x.id, kind: 'http', ref: x, label: `${x.method} ${x.path}`, position: i, parent: null, children: [], recording_id: x.recordingId, start: x.startMs, end: x.endMs, lines: x.events.map((ev) => ev.line) }; nodes.set(n.node_id, n); }
  });
  sess.operations.forEach((o) => { const n = nodes.get(o.id); const p = (o.parentId && nodes.get(o.parentId)) || recOf(o.recordingId); if (p) { n.parent = p; p.children.push(n); } });
  sess.exchanges.forEach((x) => { const n = nodes.get(x.id); const p = (x.opId && nodes.get(x.opId)) || recOf(x.recordingId); if (p) { n.parent = p; p.children.push(n); } });
  nodes.forEach((n) => n.children.sort((a, b) => (a.start ?? 0) - (b.start ?? 0) || a.position - b.position));
  return { nodes, roots: recNodes, sess };
}

// Platform-neutral method name: strips Swift argument labels/colons and whitespace so `signIn(username:)` ≡ `signIn(username)`.
export function normalizeMethod(m) { return String(m || '').replace(/\s+/g, '').replace(/:(?=[,)])/g, '').replace(/:/g, '_'); }

export function signature(n) {
  if (n.kind === 'recording') return `rec|${n.ref.trigger || ''}`;
  if (n.kind === 'http') { const x = n.ref; let depth = 0, cur = x; const seen = new Set(); while (cur && cur.retryOf && !seen.has(cur.id)) { seen.add(cur.id); depth++; cur = n.sessEx ? n.sessEx.get(cur.retryOf) : null; } return `http|${x.owner}|${x.method}|${x.origin}${x.path}|attempt${x.retryOf ? Math.max(1, depth) : 0}`; }
  const o = n.ref; return `${n.kind}|${o.owner}|${o.component || ''}|${normalizeMethod(o.method)}${o.invocation ? `|${o.invocation.kind}|${o.invocation.dispatch}` : ''}`;
}

const sourceRef = (n) => n ? { recording_id: n.recording_id || (n.kind === 'recording' ? n.node_id : '(none)'), node_id: n.node_id, kind: n.kind, label: n.label, position: n.position, parent_node_id: n.parent ? n.parent.node_id : null, event_ids: n.lines.map((l) => `L${l}`), event_pointers: n.lines.map((l) => `/events/${l - 1}`) } : null;

// ---- Field projection ---------------------------------------------------------------------------
const UNKNOWN_BODY = new Set(['redacted', 'truncated', 'partial', 'unavailable', 'not_recorded']);
function headerMap(list, ignore) { const m = new Map(); (list || []).forEach(([k, v]) => { if (ignore.has(lower(k))) return; const key = lower(k); if (!m.has(key)) m.set(key, { name: k, values: [] }); m.get(key).values.push(v); }); return m; }
function jsonOf(text) { try { const v = JSON.parse(text); return { ok: true, v }; } catch (e) { return { ok: false }; } }
function diffJson(path, a, b, out, ignored) {
  if (ignored.has(path)) return;
  const ta = a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a, tb = b === null ? 'null' : Array.isArray(b) ? 'array' : typeof b;
  if (ta === 'object' && tb === 'object') { const keys = new Set([...Object.keys(a), ...Object.keys(b)]); keys.forEach((k) => { const p = `${path}/${esc(k)}`; if (ignored.has(p)) return; const ina = k in a, inb = k in b; if (ina && inb) diffJson(p, a[k], b[k], out, ignored); else out.push({ path: p, dimension: 'content', primary: { present: ina, value: ina ? a[k] : null }, secondary: { present: inb, value: inb ? b[k] : null } }); }); return; }
  if (ta === 'array' && tb === 'array') { const n = Math.max(a.length, b.length); for (let i = 0; i < n; i++) { const p = `${path}/${i}`; if (i < a.length && i < b.length) diffJson(p, a[i], b[i], out, ignored); else out.push({ path: p, dimension: 'content', primary: { present: i < a.length, value: i < a.length ? a[i] : null }, secondary: { present: i < b.length, value: i < b.length ? b[i] : null } }); } return; }
  if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ path, dimension: 'content', primary: { present: true, value: a }, secondary: { present: true, value: b } });
}

function compareHttp(p, s, profile, changes, unc, ignoredHit) {
  const ignore = new Set(profile.ignore_headers.map(lower));
  const ignored = new Set(profile.ignore_paths);
  const chg = (path, dimension, a, b, presentA = true, presentB = true) => { if (ignored.has(path) || [...ignored].some((ip) => ip && path.startsWith(ip + '/'))) { ignoredHit.add(path); return; } if (JSON.stringify(a) !== JSON.stringify(b) || presentA !== presentB) changes.push({ path, dimension, primary: { present: presentA, value: a }, secondary: { present: presentB, value: b } }); };
  chg('/request/method', 'content', p.method, s.method);
  chg('/request/url', 'content', p.url, s.url);
  chg('/request/query', 'content', p.query, s.query);
  const hdrs = (side, which, a, b) => { const ma = headerMap(a, ignore), mb = headerMap(b, ignore); new Set([...ma.keys(), ...mb.keys()]).forEach((k) => { const ea = ma.get(k), eb = mb.get(k); chg(`/${which}/headers/${esc((ea || eb).name)}`, 'content', ea ? ea.values : null, eb ? eb.values : null, !!ea, !!eb); }); };
  if (p.reqHeaders && s.reqHeaders) hdrs('both', 'request', p.reqHeaders, s.reqHeaders); else unc.push({ path: '/request/headers', reason: `Request headers ${!p.reqHeaders ? 'not captured on primary' : ''}${!p.reqHeaders && !s.reqHeaders ? ' and ' : ''}${!s.reqHeaders ? 'not captured on secondary' : ''} (${!p.reqHeaders ? p.reqHeadersState : s.reqHeadersState}); header equality cannot be established.` });
  if (p.resHeaders && s.resHeaders) hdrs('both', 'response', p.resHeaders, s.resHeaders); else if (p.status != null || s.status != null) unc.push({ path: '/response/headers', reason: `Response headers ${!p.resHeaders ? 'not captured on primary' : 'not captured on secondary'}.` });
  chg('/response/status', 'outcome', p.status, s.status, p.status != null, s.status != null);
  chg('/outcome', 'outcome', p.outcome, s.outcome);
  chg('/error', 'outcome', p.error, s.error, p.error != null, s.error != null);
  chg('/attribution/adapter', 'metadata', p.adapter, s.adapter, p.adapter != null, s.adapter != null);
  chg('/attribution/callsite', 'metadata', p.callsite, s.callsite, p.callsite != null, s.callsite != null);
  chg('/attribution/component', 'metadata', p.component, s.component, p.component != null, s.component != null);
  chg('/retry/of_attempt', 'metadata', p.retryReason, s.retryReason, p.retryOf != null, s.retryOf != null);
  if (p.native || s.native) chg('/native', 'metadata', p.native, s.native, p.native != null, s.native != null);
  const body = (which, ta, sa, tb, sb, bytesA, bytesB) => {
    chg(`/${which}/state`, 'capture', sa, sb);
    if (bytesA != null || bytesB != null) chg(`/${which}/bytes`, 'capture', bytesA, bytesB, bytesA != null, bytesB != null);
    const unkA = UNKNOWN_BODY.has(sa), unkB = UNKNOWN_BODY.has(sb);
    if (ta != null && tb != null) {
      if (!ignored.has(`/${which}/raw`)) { if (ta !== tb) changes.push({ path: `/${which}/raw`, dimension: 'content', primary: { present: true, value: ta }, secondary: { present: true, value: tb } }); } else ignoredHit.add(`/${which}/raw`);
      if (profile.json_fields && !unkA && !unkB) { const ja = jsonOf(ta), jb = jsonOf(tb); if (ja.ok && jb.ok) diffJson(`/${which}/json`, ja.v, jb.v, changes, ignored); }
    } else if (sa !== 'not_applicable' || sb !== 'not_applicable') { if ((ta == null) !== (tb == null)) unc.push({ path: `/${which}/raw`, reason: `Body ${ta == null ? 'not captured on primary' : 'not captured on secondary'} (${ta == null ? sa : sb}); content equality unknown.` }); }
    if (unkA || unkB) { const r = []; if (sa === 'redacted' || sb === 'redacted') r.push('redaction markers replace original values; identical markers do not establish equal originals'); if (sa === 'truncated' || sb === 'truncated') r.push('truncated at the capture limit; remaining bytes are not in the log'); if (sa === 'partial' || sb === 'partial') r.push('transfer ended before the body completed'); if (sa === 'unavailable' || sb === 'unavailable' || sa === 'not_recorded' || sb === 'not_recorded') r.push('body not observed by the adapter'); if (r.length) unc.push({ path: `/${which}/raw`, reason: `${r.join('; ')} (primary: ${sa}, secondary: ${sb}).` }); }
  };
  body('request_body', p.reqBody, p.reqBodyState, s.reqBody, s.reqBodyState, p.reqBytes, s.reqBytes);
  body('response_body', p.resBody, p.resBodyState, s.resBody, s.resBodyState, p.resBytes, s.resBytes);
  if (profile.compare_timing) { const da = p.startMs != null && p.endMs != null ? String((p.endMs - p.startMs) * 1e6) : null, db = s.startMs != null && s.endMs != null ? String((s.endMs - s.startMs) * 1e6) : null; if (da != null && db != null) chg('/timing/duration_ns', 'timing', da, db); else unc.push({ path: '/timing/duration_ns', reason: 'Duration incomplete on at least one side; not compared.' }); }
  ['unknown', 'unfinished'].forEach((o) => { if (p.outcome === o || s.outcome === o) unc.push({ path: '/outcome', reason: `${o === 'unknown' ? 'Observation stopped' : 'Recording interrupted'} while in flight on ${p.outcome === o ? 'primary' : 'secondary'}; terminal outcome not observed.` }); });
}
function compareOp(p, s, profile, changes, unc) {
  const chg = (path, dimension, a, b, pa = true, pb = true) => { if (profile.ignore_paths.includes(path)) return; if (JSON.stringify(a) !== JSON.stringify(b) || pa !== pb) changes.push({ path, dimension, primary: { present: pa, value: a }, secondary: { present: pb, value: b } }); };
  chg('/result', 'outcome', p.result, s.result, p.result != null, s.result != null);
  chg('/attribution/callsite', 'metadata', p.callsite, s.callsite, p.callsite != null, s.callsite != null);
  if (p.invocation || s.invocation) { chg('/completion', 'outcome', p.completion, s.completion, p.completion != null, s.completion != null); chg('/error', 'outcome', p.error, s.error, p.error != null, s.error != null); unc.push({ path: '/invocation/arguments', reason: 'Handler arguments and return values are not captured; they cannot be compared.' }); }
  if (p.endMs == null || s.endMs == null) unc.push({ path: '/result', reason: `Operation end not recorded on ${p.endMs == null ? 'primary' : 'secondary'}; result unknown.` });
  if (profile.compare_timing) { const da = p.startMs != null && p.endMs != null ? String((p.endMs - p.startMs) * 1e6) : null, db = s.startMs != null && s.endMs != null ? String((s.endMs - s.startMs) * 1e6) : null; if (da != null && db != null) chg('/timing/duration_ns', 'timing', da, db); }
}
function compareRec(p, s, profile, changes, unc) {
  const chg = (path, dimension, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) changes.push({ path, dimension, primary: { present: true, value: a }, secondary: { present: true, value: b } }); };
  chg('/trigger', 'metadata', p.trigger, s.trigger); chg('/stop_reason', 'capture', p.stopReason, s.stopReason); chg('/interrupted', 'capture', p.interrupted, s.interrupted);
  if (p.interrupted || s.interrupted) unc.push({ path: '/interrupted', reason: `Recording ${p.interrupted ? 'on primary' : 'on secondary'} has no recording.stop; later calls may be missing.` });
}

// ---- Order relations -----------------------------------------------------------------------------
function relation(a, b) {
  if (a.start == null || b.start == null) return 'unknown';
  if (a.end != null && a.end <= b.start) return 'before';
  if (b.end != null && b.end <= a.start) return 'after';
  if (a.end == null || b.end == null) return 'unknown';
  return 'overlap';
}

// ---- Engine --------------------------------------------------------------------------------------
export function diffSessions(primary, secondary, profileIn) {
  const profile = Object.assign({}, DEFAULT_PROFILE, profileIn || {});
  profile.ignore_paths = profile.ignore_paths.slice(); profile.ignore_headers = profile.ignore_headers.slice(); profile.matches = profile.matches.slice(); profile.recording_matches = profile.recording_matches.slice();
  const P = buildTree(primary), S = buildTree(secondary);
  const exP = new Map(primary.exchanges.map((x) => [x.id, x])), exS = new Map(secondary.exchanges.map((x) => [x.id, x]));
  P.nodes.forEach((n) => { n.sessEx = exP; }); S.nodes.forEach((n) => { n.sessEx = exS; });
  const explicit = new Map(profile.matches.map((m) => [m.primary, m.secondary]));
  const explicitRev = new Map(profile.matches.map((m) => [m.secondary, m.primary]));
  const pairs = [], orderChanges = [], diagnostics = [];
  let counter = 0; const nextId = () => `p${String(++counter).padStart(3, '0')}`;
  const ignoredHit = new Set();

  function emit(pn, sn, parentPairId, basis, confidence, candidates, extraUnc) {
    const presence = pn && sn ? 'both' : basis === 'ambiguous' ? 'unresolved' : pn ? 'primary_only' : 'secondary_only';
    const pair = { id: nextId(), parent_pair_id: parentPairId, primary: sourceRef(pn), secondary: sourceRef(sn), presence, matching: { basis, confidence, candidate_node_ids: candidates || [] }, equivalence: 'unknown', changes: [], uncertainties: (extraUnc || []).slice(), ignored_paths: [] };
    if (pn && sn) {
      const kind = pn.kind; const hit = new Set();
      if (kind === 'http') compareHttp(pn.ref, sn.ref, profile, pair.changes, pair.uncertainties, hit); else if (kind === 'recording') compareRec(pn.ref, sn.ref, profile, pair.changes, pair.uncertainties); else compareOp(pn.ref, sn.ref, profile, pair.changes, pair.uncertainties);
      pair.ignored_paths = [...hit].sort(); hit.forEach((h) => ignoredHit.add(h));
      pair.equivalence = pair.changes.length ? 'different' : pair.uncertainties.length ? 'unknown' : 'equal';
    }
    pairs.push(pair); return pair;
  }

  function matchChildren(pParent, sParent, parentPair, inherited) {
    const pc = pParent ? pParent.children : [], sc = sParent ? sParent.children : [];
    const bySig = new Map();
    pc.forEach((n) => { const k = signature(n); if (!bySig.has(k)) bySig.set(k, { p: [], s: [] }); bySig.get(k).p.push(n); });
    sc.forEach((n) => { const k = signature(n); if (!bySig.has(k)) bySig.set(k, { p: [], s: [] }); bySig.get(k).s.push(n); });
    const done = new Set(); const childPairs = [];
    // explicit overrides first (must be same kind, under paired parents)
    pc.forEach((pn) => { const sid = explicit.get(pn.node_id); if (!sid) return; const sn = sc.find((n) => n.node_id === sid); if (!sn || sn.kind !== pn.kind) { diagnostics.push({ side: 'primary', severity: 'warning', message: `Explicit match ${pn.node_id}→${sid} ignored: counterpart not found under the paired parent or kind differs.` }); return; } done.add(pn); done.add(sn); childPairs.push({ pn, sn, basis: 'explicit', confidence: 'explicit', cands: [] }); });
    bySig.forEach((g) => {
      const ps = g.p.filter((n) => !done.has(n)), ss = g.s.filter((n) => !done.has(n));
      if (ps.length === 1 && ss.length === 1) { childPairs.push({ pn: ps[0], sn: ss[0], basis: ps[0].node_id === ss[0].node_id && ps[0].kind === 'recording' ? 'source_identity' : 'signature', confidence: 'exact', cands: [] }); }
      else if (ps.length && ss.length) { ps.forEach((n) => childPairs.push({ pn: n, sn: null, basis: 'ambiguous', confidence: 'none', cands: ss.map((x) => x.node_id), unresolved: true })); ss.forEach((n) => childPairs.push({ pn: null, sn: n, basis: 'ambiguous', confidence: 'none', cands: ps.map((x) => x.node_id), unresolved: true })); }
      else { ps.forEach((n) => childPairs.push({ pn: n, sn: null, basis: inherited ? 'unpaired_parent' : 'unmatched', confidence: 'none', cands: [] })); ss.forEach((n) => childPairs.push({ pn: null, sn: n, basis: inherited ? 'unpaired_parent' : 'unmatched', confidence: 'none', cands: [] })); }
    });
    childPairs.sort((a, b) => { const pa = a.pn ? a.pn.position : a.sn.position + 0.5, pb = b.pn ? b.pn.position : b.sn.position + 0.5; return pa - pb; });
    const emitted = [];
    childPairs.forEach((c) => {
      const unc = [];
      if (c.unresolved) unc.push({ path: '', reason: `${c.pn ? c.cands.length : c.cands.length} node${c.cands.length === 1 ? '' : 's'} on the other side share this signature; correspondence cannot be established without source identity or an explicit match.` });
      if (c.basis === 'unpaired_parent') unc.push({ path: '', reason: 'Parent is one-sided, so this node inherits the unpaired state; a changed parent signature can hide an otherwise equal subtree.' });
      const recIncomplete = (c.pn && !c.sn && pParent && recInterrupted(pParent)) || (c.sn && !c.pn && sParent && recInterrupted(sParent));
      if (recIncomplete && !c.unresolved && c.basis !== 'unpaired_parent') unc.push({ path: '', reason: 'The recording containing this node is incomplete; the missing counterpart may simply not have been captured.' });
      const pair = emit(c.pn, c.sn, parentPair ? parentPair.id : null, c.basis, c.confidence, c.cands, unc);
      if (c.unresolved || (recIncomplete && !c.sn !== !c.pn && c.basis === 'unmatched')) { pair.presence = 'unresolved'; pair.equivalence = 'unknown'; }
      emitted.push({ pair, pn: c.pn, sn: c.sn });
      matchChildren(c.pn, c.sn, pair, inherited || !(c.pn && c.sn));
    });
    // sibling order relations among matched pairs
    const matched = emitted.filter((e) => e.pn && e.sn);
    for (let i = 0; i < matched.length; i++) for (let j = i + 1; j < matched.length; j++) {
      const a = matched[i], b = matched[j];
      const rp = relation(a.pn, b.pn), rs = relation(a.sn, b.sn);
      const startSwap = a.sn.start != null && b.sn.start != null && a.pn.start != null && b.pn.start != null && Math.sign(a.sn.start - b.sn.start) !== Math.sign(a.pn.start - b.pn.start);
      if (rp === rs && !(rp === 'overlap' && startSwap)) continue;
      let interpretation;
      if ((rp === 'before' || rp === 'after') && (rs === 'before' || rs === 'after')) interpretation = 'reordered';
      else if (rp === 'unknown' || rs === 'unknown' || (rp === rs && rp === 'overlap')) interpretation = 'observed_order_only';
      else interpretation = 'concurrency_changed';
      orderChanges.push({ parent_pair_id: parentPair ? parentPair.id : '(root)', first_pair_id: a.pair.id, second_pair_id: b.pair.id, primary_relation: rp, secondary_relation: rs, interpretation });
    }
  }
  function recInterrupted(n) { let c = n; while (c && c.kind !== 'recording') c = c.parent; return !!(c && c.ref.interrupted); }

  // Recordings: same id → source identity; single recording each side → producer identity fallback; else by ordinal only if explicitly matched.
  const recExplicit = new Map(profile.recording_matches.map((m) => [m.primary, m.secondary]));
  const usedS = new Set();
  P.roots.forEach((pr) => {
    let sr = S.roots.find((r) => r.node_id === pr.node_id) || null; let basis = 'source_identity';
    if (!sr && recExplicit.has(pr.node_id)) { sr = S.roots.find((r) => r.node_id === recExplicit.get(pr.node_id)) || null; basis = 'explicit'; }
    if (!sr && P.roots.length === 1 && S.roots.length === 1) { sr = S.roots[0]; basis = 'signature'; }
    if (!sr && P.roots.length === S.roots.length && (primary.platform === secondary.platform)) { const cand = S.roots[pr.position]; if (cand && !usedS.has(cand)) { sr = cand; basis = 'signature'; diagnostics.push({ side: 'primary', severity: 'warning', message: `Recording ${pr.node_id} paired with ${cand.node_id} by producer identity and ordinal; recording names differ.` }); } }
    if (sr) usedS.add(sr);
    const pair = emit(pr, sr, null, sr ? basis : 'unmatched', sr ? (basis === 'explicit' ? 'explicit' : 'exact') : 'none', []);
    matchChildren(pr, sr, pair, !sr);
  });
  S.roots.filter((r) => !usedS.has(r)).forEach((sr) => { const pair = emit(null, sr, null, 'unmatched', 'none', []); matchChildren(null, sr, pair, true); });

  const summary = { matched: 0, primary_only: 0, secondary_only: 0, unresolved: 0, changed_pairs: 0, equal_pairs: 0, uncertain_pairs: 0, order_changes: orderChanges.length, field_changes: 0 };
  pairs.forEach((p) => { if (p.presence === 'both') summary.matched++; else if (p.presence === 'primary_only') summary.primary_only++; else if (p.presence === 'secondary_only') summary.secondary_only++; else summary.unresolved++; if (p.changes.length) summary.changed_pairs++; if (p.presence === 'both' && p.equivalence === 'equal') summary.equal_pairs++; if (p.uncertainties.length || p.equivalence === 'unknown') summary.uncertain_pairs++; summary.field_changes += p.changes.length; });
  if (primary.platform !== secondary.platform) diagnostics.push({ side: 'secondary', severity: 'warning', message: `Producer platforms differ (${primary.platform} vs ${secondary.platform}); operation signatures include method names, so platform-specific naming appears as one-sided subtrees.` });
  const known = summary.changed_pairs + summary.primary_only + summary.secondary_only + orderChanges.length > 0;
  const result = known ? 'different' : summary.uncertain_pairs ? 'inconclusive' : 'equal';
  const excluded = ['wall-clock timestamps', 'monotonic clock origins', 'native transport metrics (compared as metadata only)', 'handler arguments and return values (not captured)'].concat(profile.compare_timing ? [] : ['timing (compare_timing=false)']).concat(profile.ignore_headers.map((h) => `header ${h}`)).concat(profile.ignore_paths.map((p) => `path ${p}`));
  return {
    format: 'http-sequence-diff', schema_version: '1.0', engine: ENGINE,
    inputs: { primary: { session: { namespace: sessionNamespace(primary), id: primary.id }, event_count: countEvents(primary), recording_count: primary.recordings.length }, secondary: { session: { namespace: sessionNamespace(secondary), id: secondary.id }, event_count: countEvents(secondary), recording_count: secondary.recordings.length } },
    profile, scope: { included: ['recordings', 'operations', 'handler invocations', 'HTTP exchanges', 'request/response metadata', 'ordered repeated headers and query values', 'raw bodies', profile.json_fields ? 'JSON body fields (complete, unredacted UTF-8 JSON only)' : null, 'outcomes and attempts', 'sibling order relations'].filter(Boolean), excluded },
    result, summary, pairs, order_changes: orderChanges, diagnostics,
  };
}

// ---- Convenience for consumers: index pairs and derive per-pair flags ---------------------------------
export function indexDiff(diff) {
  const byId = new Map(diff.pairs.map((p) => [p.id, p]));
  const children = new Map(); diff.pairs.forEach((p) => { const k = p.parent_pair_id || '(root)'; if (!children.has(k)) children.set(k, []); children.get(k).push(p); });
  const orderByPair = new Map(); diff.order_changes.forEach((oc) => { [oc.first_pair_id, oc.second_pair_id].forEach((id) => { if (!orderByPair.has(id)) orderByPair.set(id, []); orderByPair.get(id).push(oc); }); });
  const byPrimary = new Map(), bySecondary = new Map(); diff.pairs.forEach((p) => { if (p.primary) byPrimary.set(p.primary.node_id, p); if (p.secondary) bySecondary.set(p.secondary.node_id, p); });
  const agg = new Map();
  const walk = (p) => { const a = { changed: p.changes.length ? 1 : 0, oneSided: p.presence === 'primary_only' || p.presence === 'secondary_only' ? 1 : 0, unresolved: p.presence === 'unresolved' ? 1 : 0, order: orderByPair.has(p.id) ? 1 : 0, uncertain: p.uncertainties.length ? 1 : 0, nodes: 1 }; (children.get(p.id) || []).forEach((c) => { const b = walk(c); Object.keys(a).forEach((k) => { a[k] += b[k]; }); }); agg.set(p.id, a); return a; };
  (children.get('(root)') || []).forEach(walk);
  return { byId, children, orderByPair, byPrimary, bySecondary, agg };
}
