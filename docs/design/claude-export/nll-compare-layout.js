// Network Log Lab — aligned-sequence layout for comparisons.
// Shared rows come from the diff pair tree (correspondence), never from independent per-side pixel offsets.
// Vertical position = sequence alignment, not elapsed time. Each row takes the larger height either side needs.
import { OUTCOME_META, COMPLETION_META, fmtMs } from './nll-data.js';

export const ROW = { rec: 30, call: 26, opstart: 46, collapsed: 24, run: 26, ret: 28, opend: 12, req: 34, res: 30, end: 30, moved: 24, hidden: 22 };
const RETURNS = ['returned', 'threw', 'cancelled'];
const ENDS = ['transport_failure', 'timeout', 'cancelled', 'unknown', 'unfinished'];

// rows: [{kind, pairId, p: node|null, s: node|null, y, h, ...}]
export function buildAlignedRows(diff, idx, treeP, treeS, opts = {}) {
  const collapsedPairs = opts.collapsedPairs || new Set();
  const expandedRuns = opts.expandedRuns || new Set();
  const collapseUnchanged = opts.collapseUnchanged !== false;
  const visible = opts.visible || (() => true);
  const rows = [];
  const node = (ref, tree) => (ref ? tree.nodes.get(ref.node_id) || null : null);
  const kindOf = (pair) => (pair.primary || pair.secondary).kind;
  const clean = (pair) => { const a = idx.agg.get(pair.id); return pair.presence === 'both' && a && !a.changed && !a.oneSided && !a.unresolved && !a.order && !a.uncertain; };
  const add = (kind, pair, pn, sn, extra) => { const r = Object.assign({ kind, pairId: pair ? pair.id : null, p: pn, s: sn }, extra); rows.push(r); return r; };

  function emitChildren(pair, pn, sn) {
    const all = idx.children.get(pair.id) || [];
    const shown = all.filter(visible);
    const hidden = all.filter((c) => !visible(c));
    // confirmed reorders under this parent: secondary-order placeholders
    const reordered = new Set();
    diff.order_changes.filter((oc) => oc.parent_pair_id === pair.id && oc.interpretation === 'reordered').forEach((oc) => { reordered.add(oc.first_pair_id); reordered.add(oc.second_pair_id); });
    const secOrder = shown.filter((c) => c.secondary).slice().sort((a, b) => a.secondary.position - b.secondary.position);
    const movedAfter = new Map(); // pairId (predecessor in secondary order) → [moved pair]
    secOrder.forEach((c, i) => { if (!reordered.has(c.id) || !c.primary) return; const prev = secOrder[i - 1]; const key = prev ? prev.id : '(start)'; if (!movedAfter.has(key)) movedAfter.set(key, []); movedAfter.get(key).push(c); });
    const moved = (key) => (movedAfter.get(key) || []).forEach((c) => add('moved', c, null, node(c.secondary, treeS), { label: `↷ #${c.secondary.position} ${c.secondary.label} runs here in secondary · aligned row ${c.primary.position < c.secondary.position ? 'above' : 'below'}`, moved: true }));
    moved('(start)');
    // unchanged runs
    let i = 0;
    while (i < shown.length) {
      const c = shown[i];
      if (collapseUnchanged && clean(c)) {
        let j = i; while (j < shown.length && clean(shown[j])) j++;
        const run = shown.slice(i, j);
        const runKey = run.map((r) => r.id).join('+');
        if (run.length >= 3 && !expandedRuns.has(runKey) && !run.some((r) => r.id === opts.selected)) {
          emitPair(run[0]);
          moved(run[0].id);
          add('run', pair, pn, sn, { count: run.length - 2, runKey, label: `${run.length - 2} unchanged call${run.length - 2 === 1 ? '' : 's'} hidden — click to expand`, owner: (run[1].primary ? treeP.nodes.get(run[1].primary.node_id) : treeS.nodes.get(run[1].secondary.node_id)) });
          emitPair(run[run.length - 1]);
          moved(run[run.length - 1].id);
          i = j; continue;
        }
      }
      emitPair(c); moved(c.id); i++;
    }
    if (hidden.length) add('hidden', pair, pn, sn, { count: hidden.length, label: `${hidden.length} hidden by filters · original positions ${hidden.map((h) => (h.primary ? 'P#' + h.primary.position : 'S#' + h.secondary.position)).join(', ')}` });
  }

  function emitPair(pair) {
    const pn = node(pair.primary, treeP), sn = node(pair.secondary, treeS);
    const kind = kindOf(pair);
    const start = rows.length;
    if (kind === 'recording') { add('rec', pair, pn, sn); emitChildren(pair, pn, sn); }
    else if (kind === 'http') {
      const xp = pn && pn.ref, xs = sn && sn.ref;
      add('req', pair, pn, sn);
      if ((xp && xp.status != null && xp.headersMs != null) || (xs && xs.status != null && xs.headersMs != null)) add('res', pair, pn, sn);
      const needsEnd = (x) => x && (ENDS.includes(x.outcome) || (x.status != null && x.headersMs == null));
      if (needsEnd(xp) || needsEnd(xs)) add('end', pair, pn, sn);
    } else {
      const op = pn && pn.ref, os = sn && sn.ref;
      const handler = !!((op && op.invocation) || (os && os.invocation));
      if (handler) add('call', pair, pn, sn);
      add('opstart', pair, pn, sn);
      if (collapsedPairs.has(pair.id)) { const a = idx.agg.get(pair.id); add('collapsed', pair, pn, sn, { count: a ? a.nodes - 1 : 0, label: `${a ? a.nodes - 1 : 0} nested node${a && a.nodes - 1 === 1 ? '' : 's'} hidden — expand to show` }); }
      else emitChildren(pair, pn, sn);
      const ended = (op && op.endMs != null) || (os && os.endMs != null);
      if (ended) { if (handler && ((op && RETURNS.includes(op.completion)) || (os && RETURNS.includes(os.completion)))) add('ret', pair, pn, sn); add('opend', pair, pn, sn); }
    }
    rows[start].first = true; rows[start].pairStart = pair.id; rows[rows.length - 1].pairEnd = pair.id;
  }
  (idx.children.get('(root)') || []).forEach(emitPair);

  let y = opts.top ?? 12;
  rows.forEach((r) => { r.h = ROW[r.kind]; r.top = y; r.y = y + r.h / 2; y += r.h; });
  const height = y + 24;
  const span = new Map();
  rows.forEach((r) => { if (!r.pairId) return; if (!span.has(r.pairId)) span.set(r.pairId, { y0: r.top, y1: r.top + r.h, yMark: r.y }); const sp = span.get(r.pairId); sp.y1 = Math.max(sp.y1, r.top + r.h); if (r.first && r.pairStart === r.pairId) sp.yMark = r.y; });
  // propagate: a parent's span covers its descendants
  const order = diff.pairs.slice().reverse();
  order.forEach((p) => { const sp = span.get(p.id); if (!sp) return; let par = p.parent_pair_id; if (par && span.has(par)) span.get(par).y1 = Math.max(span.get(par).y1, sp.y1); });
  return { rows, span, height };
}

// Per-side geometry in the same shape layoutSequence() returns, so NLL Sequence renders both sides unchanged.
export function layoutAlignedSide(session, rows, side, lanes, opts = {}) {
  const laneW = opts.laneWidth ?? 124, left = opts.left ?? 16, height = opts.height;
  const laneX = (id) => { const l = lanes.find((q) => q.id === id); return l ? l.x : lanes[1].x; };
  const clientX = (owner) => laneX(owner === 'app' ? 'app' : 'sdk');
  const mine = rows.filter((r) => r[side]).map((r) => ({ kind: r.kind, ref: r[side].ref, y: r.y, count: r.count, label: r.label, pairId: r.pairId }));
  const opById = new Map(session.operations.map((o) => [o.id, o]));
  const arrows = [], bars = [], serverBars = [], gaps = [], recs = [], collapsedRows = [], ghosts = [];
  const yOf = (kind, ref) => { const r = mine.find((q) => q.kind === kind && q.ref === ref); return r ? r.y : null; };
  const maxLabel = Math.max(8, Math.floor((laneW * 1.4) / 6.6));
  const trunc = (s, n = maxLabel) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const ops = []; const exShown = [];
  mine.forEach((r) => {
    if (r.kind === 'rec') recs.push({ y: r.y, id: r.ref.id, label: `Recording ${r.ref.id}`, sub: r.ref.interrupted ? 'interrupted — no recording.stop' : `stopped: ${r.ref.stopReason}`, interrupted: r.ref.interrupted, clockNote: r.ref.clockNote });
    if (r.kind === 'opstart') ops.push(r.ref);
    if (r.kind === 'collapsed') collapsedRows.push({ y: r.y, x: clientX(r.ref.owner), opId: r.ref.id, label: r.label });
    if (r.kind === 'req') {
      const x = r.ref, x1 = clientX(x.owner), x2 = laneX(x.origin); exShown.push(x);
      arrows.push({ key: x.id + ':req', exId: x.id, kind: 'req', x1, x2, y: r.y, label: `${x.method} ${trunc(x.path + (x.search || ''), maxLabel + 6)}`, full: `${x.method} ${x.url}`, glyph: '', tone: 'neutral', dashed: false, sub: x.adapter === 'manual' ? 'manual' : (x.retryOf ? `retry of ${x.retryOf}` : '') });
    }
    if (r.kind === 'res') {
      const x = r.ref; if (x.status == null || x.headersMs == null) return;
      const x1 = laneX(x.origin), x2 = clientX(x.owner);
      const tone = x.status >= 400 ? 'error' : x.status >= 300 ? 'neutral' : 'ok';
      const later = ENDS.includes(x.outcome);
      const ttfb = x.headersMs != null && x.startMs != null ? fmtMs(x.headersMs - x.startMs) : null;
      arrows.push({ key: x.id + ':res', exId: x.id, kind: 'res', x1, x2, y: r.y, label: `${x.status} ${x.statusText || ''}`.trim() + (ttfb ? ` · ${ttfb}` : ''), full: `Response headers received${later ? ' — transfer did not complete' : ''}`, glyph: later ? '↓' : (tone === 'error' ? '✕' : '✓'), tone: later ? 'neutral' : tone, dashed: later, sub: later ? 'headers only' : '' });
    }
    if (r.kind === 'end') {
      const x = r.ref; if (!(ENDS.includes(x.outcome) || (x.status != null && x.headersMs == null))) return;
      const m = OUTCOME_META[x.outcome] || OUTCOME_META.unknown, cx = clientX(x.owner), sx = laneX(x.origin);
      const dur = x.startMs != null && x.endMs != null ? fmtMs(x.endMs - x.startMs) : null;
      const labelMap = { timeout: `Body read timed out${dur ? ' · ' + dur : ''}`, transport_failure: `Transport failure${dur ? ' · ' + dur : ''}`, cancelled: `Cancelled${dur ? ' · ' + dur : ''}`, unknown: 'Observation stopped — outcome unknown', unfinished: 'Unfinished — recording interrupted' };
      arrows.push({ key: x.id + ':end', exId: x.id, kind: 'end', x1: sx, x2: cx, y: r.y, label: x.status != null && x.headersMs == null && x.outcome === 'success' ? `${x.status} ${x.statusText || ''} · headers time not recorded` : (labelMap[x.outcome] || m.label), full: x.error || m.desc, glyph: m.glyph, tone: x.outcome === 'success' ? 'ok' : m.tone, dashed: true, sub: '' });
    }
  });
  const descendantsEx = (op) => { let n = op.exchanges.length; op.children.forEach((c) => { n += descendantsEx(c); }); return n; };
  ops.forEach((op) => {
    const y1 = yOf('opstart', op), y2 = op.endMs != null ? yOf('opend', op) : null;
    if (y1 == null) return;
    const x = clientX(op.owner);
    const depth = (() => { let d = 0, c = op; while (c && c.parentId) { d++; c = opById.get(c.parentId); } return d; })();
    const row = mine.find((q) => q.kind === 'opstart' && q.ref === op);
    const collapsed = !!mine.find((q) => q.kind === 'collapsed' && q.ref === op);
    bars.push({ opId: op.id, pairId: row && row.pairId, x: x - 7 + depth * 3, w: 14, y: y1 - 8, h: (y2 != null ? y2 : height - 24) - (y1 - 8) + (y2 != null ? 4 : 0), open: y2 == null, owner: op.owner, label: `${op.method || '(method)'}`, component: op.component || 'component not recorded', labelX: x + 12 + depth * 3, labelY: y1 + 4, collapsed, count: descendantsEx(op), result: op.result, depth, returnedEarly: op.exchanges.some((e) => e.returnedEarly), handler: !!op.invocation, caller: op.invocation ? op.invocation.caller : null, completion: op.invocation ? (op.endMs != null ? op.completion : 'missing') : null, stopped: !!op.invocation && op.endMs != null && !RETURNS.includes(op.completion) });
  });
  const localArrows = [], waitSegments = [];
  ops.filter((op) => op.invocation).forEach((op) => {
    const bar = bars.find((b) => b.opId === op.id); if (!bar) return;
    const callerOp = op.parentId ? opById.get(op.parentId) : null;
    const callerBar = callerOp ? bars.find((b) => b.opId === callerOp.id) : null;
    const callerOwner = callerOp ? callerOp.owner : (op.invocation.caller && op.invocation.caller.owner === 'sdk' ? 'sdk' : 'app');
    const cx0 = callerBar ? callerBar.x + callerBar.w / 2 : clientX(callerOwner), hx0 = bar.x + bar.w / 2;
    const toRight = hx0 > cx0;
    const x1 = callerBar ? (toRight ? callerBar.x + callerBar.w : callerBar.x) : cx0;
    const x2 = toRight ? bar.x : bar.x + bar.w;
    const callerName = op.invocation.caller ? `${op.invocation.caller.component || '?'}.${op.invocation.caller.method || '?'}` : (callerOp ? `${callerOp.component}.${callerOp.method}` : 'caller not recorded');
    const yc = yOf('call', op);
    if (yc != null) localArrows.push({ key: op.id + ':call', opId: op.id, kind: 'call', x1, x2, y: yc, fromDot: !callerBar, label: `call · ${op.method || op.component}`, sub: `${op.invocation.kind} · ${op.invocation.dispatch}`, tone: 'local', full: `Local call from ${callerName} to ${op.component}.${op.method}` });
    const yr = yOf('ret', op);
    if (yr != null && RETURNS.includes(op.completion)) { const m = COMPLETION_META[op.completion] || COMPLETION_META.returned; const dur = op.startMs != null && op.endMs != null ? fmtMs(op.endMs - op.startMs) : null; const errType = op.error && typeof op.error === 'object' ? op.error.type : op.error; localArrows.push({ key: op.id + ':ret', opId: op.id, kind: 'ret', x1: x2, x2: x1, y: yr, fromDot: false, label: `${m.glyph} ${m.label.toLowerCase()}${errType ? ' · ' + errType : ''}${dur ? ' · ' + dur : ''}`, sub: '', tone: m.tone, full: `${m.label} to ${callerName}${dur ? ' after ' + dur : ''}` }); }
    if (callerBar) waitSegments.push({ opId: callerOp.id, forOp: op.id, x: callerBar.x, w: callerBar.w, y: bar.y, h: bar.h, label: `waiting for ${op.method || op.component}` });
  });
  exShown.forEach((x) => { const yr = yOf('req', x); const ye = yOf('res', x) ?? yOf('end', x); if (yr == null) return; serverBars.push({ exId: x.id, x: laneX(x.origin) - 4, y: yr, h: Math.max(10, (ye ?? yr + 14) - yr), open: ye == null || x.outcome === 'unfinished' }); });
  // Rows that exist only on the other side → explicit empty counterparts; moved placeholders on this side
  const other = side === 'p' ? 's' : 'p';
  rows.forEach((r) => {
    if (r.kind === 'run') { collapsedRows.push({ y: r.y, x: clientX(r.owner ? r.owner.ref.owner : 'sdk'), opId: null, label: r.label, runKey: r.runKey }); return; }
    if (r.kind === 'hidden') { collapsedRows.push({ y: r.y, x: left + 8, opId: null, label: r.label }); return; }
    if (r.kind === 'moved') { if (side === 's') ghosts.push({ y: r.y - 11, x: clientX(r.s.ref.owner) - 7, w: laneW * 2.6, h: 22, kind: 'moved', label: r.label, pairId: r.pairId }); return; }
    if (!r.first || r[side] || !r[other]) return;
    const lbl = opts.ghostLabel ? opts.ghostLabel(r.pairId, side) : `not in ${side === 'p' ? 'primary' : 'secondary'}`;
    if (lbl === null) return;
    const n = r[other]; const ref = n.ref; const x = clientX(ref.owner) - 7;
    const sp = opts.span && opts.span.get(r.pairId);
    ghosts.push({ y: r.top + 4, x, w: laneW * 1.7, h: Math.max(18, (sp ? sp.y1 : r.top + r.h) - r.top - 8), kind: 'absent', label: lbl, pairId: r.pairId });
  });
  return { lanes, laneW, left, width: left * 2 + lanes.length * laneW, height, arrows, bars, serverBars, gaps, recs, collapsedRows, localArrows, waitSegments, ghosts, clientGroup: { x: lanes[0].x - laneW / 2 + 4, w: laneW * 2 - 8 }, shownIds: exShown.map((x) => x.id) };
}

export function unionLanes(primary, secondary, laneW, left = 16) {
  const lanes = [{ id: 'app', label: 'Sample App', title: primary.app || 'Integrating application', kind: 'client' }, { id: 'sdk', label: 'DemoAuth SDK', title: primary.sdk || 'SDK', kind: 'client' }];
  [primary, secondary].forEach((sess) => sess.exchanges.slice().sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0)).forEach((x) => { if (!lanes.find((l) => l.id === x.origin)) lanes.push({ id: x.origin, label: x.label, title: x.origin, kind: 'server', scheme: x.scheme }); }));
  lanes.forEach((l, i) => { l.x = left + i * laneW + laneW / 2; l.index = i; });
  return lanes;
}
