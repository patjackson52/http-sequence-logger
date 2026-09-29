// Network Log Lab — deterministic sequence layout. Pure function: session + view options → geometry.
// Vertical axis = event order with compressed spacing (not a duration scale). Gaps > 1.5 s get an explicit marker.
import { OUTCOME_META, COMPLETION_META, fmtMs } from './nll-data.js';

const ROW = { rec: 30, opstart: 46, opend: 12, req: 34, res: 30, end: 30, gap: 22, collapsed: 24, call: 26, ret: 28 };
const PRIO = { rec: 0, ret: 1, opend: 2, call: 3, opstart: 4, req: 5, res: 6, end: 7 };
const RETURNS = ['returned', 'threw', 'cancelled'];

export function layoutSequence(session, opts = {}) {
  const laneW = opts.laneWidth ?? 150, left = opts.left ?? 16, top = opts.top ?? 12, bottomPad = 24;
  const hidden = opts.hidden || new Set();
  const collapsed = opts.collapsed || new Set();
  const filtersActive = !!opts.filtersActive;
  const recFocus = opts.recordingId || null;

  const exVisible = session.exchanges.filter((x) => !hidden.has(x.id) && (!recFocus || x.recordingId === recFocus));
  const opById = new Map(session.operations.map((o) => [o.id, o]));
  const ancestorCollapsed = (opId) => { let cur = opId ? opById.get(opId) : null; while (cur) { if (collapsed.has(cur.id)) return cur.id; cur = cur.parentId ? opById.get(cur.parentId) : null; } return null; };
  const descendantsEx = (op) => { let n = op.exchanges.filter((x) => !hidden.has(x.id)).length; op.children.forEach((c) => { n += descendantsEx(c); }); return n; };
  const opVisible = (op) => {
    if (recFocus && op.recordingId && op.recordingId !== recFocus) return false;
    if (ancestorCollapsed(op.parentId)) return false;
    if (!filtersActive) return true;
    return descendantsEx(op) > 0;
  };
  const ops = session.operations.filter(opVisible);
  const exShown = exVisible.filter((x) => !ancestorCollapsed(x.opId));

  // Lanes: app, sdk, then origins in order of first visible contact
  const lanes = [{ id: 'app', label: session.app ? 'Sample App' : 'App', title: session.app || 'Integrating application', kind: 'client' }, { id: 'sdk', label: 'DemoAuth SDK', title: session.sdk || 'SDK', kind: 'client' }];
  const originOrder = exShown.slice().sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0) || a.line - b.line);
  originOrder.forEach((x) => { if (!lanes.find((l) => l.id === x.origin)) lanes.push({ id: x.origin, label: x.label, title: x.origin, kind: 'server', scheme: x.scheme }); });
  lanes.forEach((l, i) => { l.x = left + i * laneW + laneW / 2; l.index = i; });
  const laneX = (id) => { const l = lanes.find((q) => q.id === id); return l ? l.x : lanes[1].x; };
  const clientX = (owner) => laneX(owner === 'app' ? 'app' : 'sdk');

  // Rows
  const rows = [];
  const add = (kind, ts, ref, extra) => rows.push(Object.assign({ kind, ts: ts ?? null, ref }, extra));
  if (!recFocus || session.recordings.length > 1) session.recordings.filter((r) => !recFocus || r.id === recFocus).forEach((r) => add('rec', r.startMs, r));
  ops.forEach((op) => {
    if (op.invocation) add('call', op.startMs, op);
    add('opstart', op.startMs, op);
    if (collapsed.has(op.id)) add('collapsed', op.startMs, op, { count: descendantsEx(op) });
    if (op.endMs != null) { if (op.invocation && RETURNS.includes(op.completion)) add('ret', op.endMs, op); add('opend', op.endMs, op); }
  });
  exShown.forEach((x) => {
    add('req', x.startMs, x);
    if (x.status != null && x.headersMs != null) add('res', x.headersMs, x);
    const needsEnd = ['transport_failure', 'timeout', 'cancelled', 'unknown', 'unfinished'].includes(x.outcome) || (x.status != null && x.headersMs == null);
    if (needsEnd) add('end', x.endMs, x, { pinned: x.endMs == null });
  });
  const order = (r) => (r.ts == null ? (r.pinned ? Infinity : 0) : r.ts);
  rows.sort((a, b) => order(a) - order(b) || PRIO[a.kind] - PRIO[b.kind] || (a.ref.line || 0) - (b.ref.line || 0));

  // Insert gap markers
  const withGaps = [];
  let lastTs = null;
  rows.forEach((r) => {
    if (r.ts != null && lastTs != null && r.ts - lastTs > 1500 && r.kind !== 'rec') withGaps.push({ kind: 'gap', label: `≈ ${fmtMs(r.ts - lastTs)} elapsed (compressed)` });
    withGaps.push(r);
    if (r.ts != null) lastTs = r.ts;
  });

  // Assign y
  let y = top;
  withGaps.forEach((r) => { r.y = y + ROW[r.kind] / 2; y += ROW[r.kind]; });
  const height = y + bottomPad;
  const width = left * 2 + lanes.length * laneW;

  const arrows = [], bars = [], serverBars = [], gaps = [], recs = [], collapsedRows = [];
  const yOf = (kind, ref) => { const r = withGaps.find((q) => q.kind === kind && q.ref === ref); return r ? r.y : null; };
  const maxLabel = Math.max(8, Math.floor((laneW * 1.4) / 6.6));
  const trunc = (s, n = maxLabel) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  withGaps.forEach((r) => {
    if (r.kind === 'gap') gaps.push({ y: r.y, label: r.label });
    if (r.kind === 'rec') recs.push({ y: r.y, id: r.ref.id, label: `Recording ${r.ref.id}`, sub: r.ref.interrupted ? 'interrupted — no recording.stop' : `stopped: ${r.ref.stopReason}`, interrupted: r.ref.interrupted, clockNote: r.ref.clockNote });
    if (r.kind === 'collapsed') collapsedRows.push({ y: r.y, x: clientX(r.ref.owner), opId: r.ref.id, label: `${r.count} request${r.count === 1 ? '' : 's'} hidden — expand to show` });
    if (r.kind === 'req') {
      const x = r.ref, x1 = clientX(x.owner), x2 = laneX(x.origin);
      arrows.push({ key: x.id + ':req', exId: x.id, kind: 'req', x1, x2, y: r.y, label: `${x.method} ${trunc(x.path + (x.search || ''), maxLabel + 6)}`, full: `${x.method} ${x.url}`, glyph: '', tone: 'neutral', dashed: false, sub: x.adapter === 'manual' ? 'manual' : (x.retryOf ? `retry of ${x.retryOf}` : '') });
    }
    if (r.kind === 'res') {
      const x = r.ref, x1 = laneX(x.origin), x2 = clientX(x.owner);
      const tone = x.status >= 500 ? 'error' : x.status >= 400 ? 'error' : x.status >= 300 ? 'neutral' : 'ok';
      const later = ['timeout', 'transport_failure', 'cancelled', 'unknown', 'unfinished'].includes(x.outcome);
      const ttfb = x.headersMs != null && x.startMs != null ? fmtMs(x.headersMs - x.startMs) : null;
      arrows.push({ key: x.id + ':res', exId: x.id, kind: 'res', x1, x2, y: r.y, label: `${x.status} ${x.statusText || ''}`.trim() + (ttfb ? ` · ${ttfb}` : ''), full: `Response headers received${later ? ' — transfer did not complete' : ''}`, glyph: later ? '↓' : (tone === 'error' ? '✕' : '✓'), tone: later ? 'neutral' : tone, dashed: later, sub: later ? 'headers only' : '' });
    }
    if (r.kind === 'end') {
      const x = r.ref, m = OUTCOME_META[x.outcome] || OUTCOME_META.unknown, cx = clientX(x.owner), sx = laneX(x.origin);
      const dur = x.startMs != null && x.endMs != null ? fmtMs(x.endMs - x.startMs) : null;
      const labelMap = { timeout: `Body read timed out${dur ? ' · ' + dur : ''}`, transport_failure: `Transport failure${dur ? ' · ' + dur : ''}`, cancelled: `Cancelled${dur ? ' · ' + dur : ''}`, unknown: 'Observation stopped — outcome unknown', unfinished: 'Unfinished — recording interrupted' };
      arrows.push({ key: x.id + ':end', exId: x.id, kind: 'end', x1: sx, x2: cx, y: r.y, label: labelMap[x.outcome] || m.label, full: x.error || m.desc, glyph: m.glyph, tone: m.tone, dashed: true, sub: '' });
    }
  });

  // Operation bars on client lanes
  ops.forEach((op) => {
    const y1 = yOf('opstart', op), y2 = op.endMs != null ? yOf('opend', op) : null;
    if (y1 == null) return;
    const x = clientX(op.owner);
    const depth = (() => { let d = 0, c = op; while (c && c.parentId) { d++; c = opById.get(c.parentId); } return d; })();
    bars.push({ opId: op.id, x: x - 7 + depth * 3, w: 14, y: y1 - 8, h: (y2 != null ? y2 : height - bottomPad) - (y1 - 8) + (y2 != null ? 4 : 0), open: y2 == null, owner: op.owner, label: `${op.method || '(method)'}`, component: op.component || 'component not recorded', labelX: x + 12 + depth * 3, labelY: y1 + 4, collapsed: collapsed.has(op.id), count: descendantsEx(op), result: op.result, depth, returnedEarly: op.exchanges.some((e) => e.returnedEarly), handler: !!op.invocation, caller: op.invocation ? op.invocation.caller : null, completion: op.invocation ? (op.endMs != null ? op.completion : 'missing') : null, stopped: !!op.invocation && op.endMs != null && !RETURNS.includes(op.completion) });
  });
  // Local call / return arrows and caller waiting segments (handler invocations only)
  const localArrows = [], waitSegments = [];
  const ownerLane = (o) => (o === 'sdk' ? 'sdk' : 'app');
  ops.filter((op) => op.invocation).forEach((op) => {
    const bar = bars.find((b) => b.opId === op.id); if (!bar) return;
    const callerOp = op.parentId ? opById.get(op.parentId) : null;
    const callerBar = callerOp ? bars.find((b) => b.opId === callerOp.id) : null;
    const callerOwner = callerOp ? callerOp.owner : ownerLane(op.invocation.caller && op.invocation.caller.owner);
    const cx0 = callerBar ? callerBar.x + callerBar.w / 2 : clientX(callerOwner), hx0 = bar.x + bar.w / 2;
    const toRight = hx0 > cx0;
    const x1 = callerBar ? (toRight ? callerBar.x + callerBar.w : callerBar.x) : cx0;
    const x2 = toRight ? bar.x : bar.x + bar.w;
    const callerName = op.invocation.caller ? `${op.invocation.caller.component || '?'}.${op.invocation.caller.method || '?'}` : (callerOp ? `${callerOp.component}.${callerOp.method}` : 'caller not recorded');
    const yc = yOf('call', op);
    if (yc != null) localArrows.push({ key: op.id + ':call', opId: op.id, kind: 'call', x1, x2, y: yc, fromDot: !callerBar, label: `call · ${op.method || op.component}`, sub: `${op.invocation.kind} · ${op.invocation.dispatch}${callerBar ? '' : ' · caller not instrumented'}`, tone: 'local', full: `Local call from ${callerName} to ${op.component}.${op.method}` });
    const yr = yOf('ret', op);
    if (yr != null) {
      const m = COMPLETION_META[op.completion] || COMPLETION_META.returned;
      const dur = op.startMs != null && op.endMs != null ? fmtMs(op.endMs - op.startMs) : null;
      const errType = op.error && typeof op.error === 'object' ? op.error.type : op.error;
      localArrows.push({ key: op.id + ':ret', opId: op.id, kind: 'ret', x1: x2, x2: x1, y: yr, fromDot: false, label: `${m.glyph} ${m.label.toLowerCase()}${errType ? ' · ' + errType : ''}${dur ? ' · ' + dur : ''}`, sub: '', tone: m.tone, full: `${m.label} to ${callerName}${dur ? ' after ' + dur : ''}` });
    }
    if (callerBar) waitSegments.push({ opId: callerOp.id, forOp: op.id, x: callerBar.x, w: callerBar.w, y: bar.y, h: bar.h, label: `waiting for ${op.method || op.component}` });
  });
  // Server activation bars (in-flight span)
  exShown.forEach((x) => {
    const yr = yOf('req', x); const ye = yOf('res', x) ?? yOf('end', x);
    if (yr == null) return;
    serverBars.push({ exId: x.id, x: laneX(x.origin) - 4, y: yr, h: Math.max(10, (ye ?? yr + 14) - yr), open: ye == null || x.outcome === 'unfinished' });
  });

  return { lanes, laneW, left, width, height, arrows, bars, serverBars, gaps, recs, collapsedRows, localArrows, waitSegments, clientGroup: { x: lanes[0].x - laneW / 2 + 4, w: laneW * 2 - 8 }, shownIds: exShown.map((x) => x.id) };
}
