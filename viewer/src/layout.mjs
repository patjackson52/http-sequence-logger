// Geometry only: no browser, parsing, or network access. Each recording has its own clock.
export const OWNER_LABELS = { integrator: 'App code', sdk: 'SDK', system: 'System', unknown: 'Unknown owner' };
const ROW_HEIGHT = { recording: 38, operation: 58, call: 48, return: 38, stop: 38, operationEnd: 28, orphan: 46, request: 46, response: 48, terminal: 42, unfinished: 38, gap: 26, ancestry: 38 };
const RETURNS = new Set(['returned', 'threw', 'cancelled']);
const asSet = (value) => value instanceof Set ? value : new Set(value || []);
const ownerOf = (actor) => actor?.owner || 'unknown';
const compareEvent = (a, b) => (a?.sequence || 0) - (b?.sequence || 0) || compareMono(a?.monotonic_ns, b?.monotonic_ns) || (a?._line || 0) - (b?._line || 0);
function compareMono(a, b) { const x = BigInt(a || 0), y = BigInt(b || 0); return x < y ? -1 : x > y ? 1 : 0; }
export function durationLabel(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1) return `${Number(ms.toFixed(2))} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}
function elapsed(a, b) { return a && b ? Number(BigInt(b.monotonic_ns) - BigInt(a.monotonic_ns)) / 1e6 : null; }
function outcomeMeta(outcome) {
  return ({ success: ['✓', 'success', 'ok'], http_error: ['✕', 'HTTP error', 'error'], error: ['↯', 'error', 'error'], transport_error: ['⚠', 'transport failure', 'error'], timeout: ['◷', 'timed out', 'error'], cancelled: ['⊘', 'cancelled', 'neutral'], unknown: ['?', 'observation stopped', 'warning'], unfinished: ['…', 'unfinished', 'warning'] })[outcome] || ['?', 'unknown', 'warning'];
}
function bodyPreview(body) {
  if (body?.content?.encoding !== 'utf-8' || !body.content.data) return '';
  const text = body.content.data.replace(/\s+/g, ' ').trim();
  const state = [body.redacted && 'redacted', body.truncated && 'truncated'].filter(Boolean).join(', ');
  return `${text.slice(0, 94)}${text.length > 94 ? '…' : ''}${state ? ` · ${state}` : ''}`;
}
function displayMethod(operation) { const value = operation.method || operation.name || '(method)'; return `${value}${value.endsWith(')') ? '' : '()'}`; }

/** Stable layout for a reconstructed session. `visibleIds` filters rows, never participants. */
export function layoutSequence(session, options = {}) {
  const laneWidth = options.laneWidth || 164;
  const collapsed = asSet(options.collapsed), expandedOwners = asSet(options.expandedOwners);
  const visible = options.visibleIds == null ? null : asSet(options.visibleIds);
  const kind = options.kind || 'all';
  const isHttpOnly = kind === 'http' || kind === 'http-only';
  const isLocalOnly = kind === 'local' || kind === 'local-only';
  const recordings = session.recordings.filter((recording) => !options.recordingId || recording.id === options.recordingId);
  const recordingIds = new Set(recordings.map((r) => r.id));
  const operations = session.operations.filter((o) => recordingIds.has(o.recordingId));
  const exchanges = session.exchanges.filter((x) => recordingIds.has(x.recordingId));
  const opMap = new Map(operations.map((o) => [o.id, o]));
  const entityMap = new Map([...operations, ...exchanges].map((e) => [e.id, e]));
  const ancestors = (entity) => {
    const result = [], seen = new Set([entity.id]); let parent = entity.parentResolved ? entityMap.get(entity.parentId) : null;
    while (parent && !seen.has(parent.id)) { result.push(parent); seen.add(parent.id); parent = parent.parentResolved ? entityMap.get(parent.parentId) : null; }
    return result;
  };
  const hiddenByCollapse = (entity) => ancestors(entity).some((o) => collapsed.has(o.id));
  const matches = (entity) => !visible || visible.has(entity.id);
  const selectedExchanges = exchanges.filter((x) => !isLocalOnly && matches(x) && !hiddenByCollapse(x));
  // An explicit filter can hide the calling SDK operation while preserving an App handler.
  const selectedOperations = operations.filter((o) => !hiddenByCollapse(o) && (matches(o) || (isHttpOnly && o.isHandler && exchanges.some((x) => matches(x) && ancestors(x).some((a) => a.id === o.id)))));
  const descendantCounts = (op) => ({ requests: exchanges.filter((x) => ancestors(x).some((a) => a.id === op.id)).length, calls: operations.filter((o) => o.isHandler && ancestors(o).some((a) => a.id === op.id)).length });

  // First two owner lanes are stable even in a no-HTTP recording. Extra owners are explicit.
  const actors = operations.filter(o => !o.serviceName).map((o) => o.origin).concat(exchanges.filter(x => !x.serviceName).map((x) => x.executor), operations.filter((o) => !o.serviceName && o.isHandler).map((o) => o.invocation?.caller)).filter(Boolean);
  const owners = ['integrator', 'sdk'];
  for (const actor of actors) if (!owners.includes(ownerOf(actor))) owners.push(ownerOf(actor));
  const lanes = [], ownerGroups = []; let nextX = 16;
  for (const owner of owners) {
    const components = [...new Set(actors.filter((a) => ownerOf(a) === owner).map((a) => a.component || 'Not recorded'))];
    const expanded = expandedOwners.has(owner) && components.length > 0;
    const group = { owner, label: OWNER_LABELS[owner] || owner, x: nextX, expanded, components };
    const definitions = expanded ? components.slice(0, 4).map((component) => ({ component, label: component })) : [{ label: group.label, component: null }];
    if (expanded && components.length > 4) definitions.push({ component: '__more__', label: `${components.length - 4} more`, members: components.slice(4) });
    for (const definition of definitions) {
      const width = expanded ? 120 : laneWidth;
      lanes.push({ ...definition, id: `owner:${owner}:${definition.component || '*'}`, owner, kind: 'client', title: `${group.label}${definition.component ? ` · ${definition.label}` : ` · ${components.join(' · ') || 'No components recorded'}`}`, sub: expanded ? group.label : components.join(' · '), left: nextX, width, x: nextX + width / 2 }); nextX += width;
    }
    group.width = nextX - group.x; ownerGroups.push(group);
  }
  const clientGroup = { x: 20, width: nextX - 24 };
  const contactOrigins = new Set(selectedExchanges.flatMap((exchange) => [exchange.origin, ...(exchange.rawEvents || []).flatMap((event) => [event.data.request?.url, event.data.response?.url, event.data.transaction?.request?.url, event.data.transaction?.response?.url]).map((url) => { try { return new URL(url).origin; } catch { return null; } })]).filter(Boolean));
  const allOrigins = (session.origins || []).filter((origin) => isLocalOnly || contactOrigins.has(origin));
  for (const origin of allOrigins) {
    let label = origin; try { label = new URL(origin).host; } catch { /* Invalid metadata is inert text. */ }
    lanes.push({ id: origin, origin, label, title: origin, sub: origin.startsWith('https:') ? 'HTTPS' : origin.startsWith('http:') ? 'HTTP' : 'Origin', kind: 'server', left: nextX, width: laneWidth, x: nextX + laneWidth / 2, muted: !selectedExchanges.some((x) => x.origin === origin) }); nextX += laneWidth;
  }
  for (const service of [...new Set([...operations, ...exchanges].map(i => i.serviceName).filter(Boolean))]) {
    lanes.push({ id: `service:${service}`, service, label: service, title: `${service} · recorded server activity`, sub: 'Service · independent clock', kind: 'service', left: nextX, width: laneWidth, x: nextX + laneWidth / 2 }); nextX += laneWidth;
  }
  const width = nextX + 16;
  const actorLane = (actor, entity) => {
    if (entity?.serviceName) return lanes.find(l => l.service === entity.serviceName) || lanes[0];
    const ownerLanes = lanes.filter((l) => l.kind === 'client' && l.owner === ownerOf(actor));
    return ownerLanes.find((l) => l.component === actor?.component || l.members?.includes(actor?.component)) || ownerLanes[0] || lanes[0];
  };
  const originLane = (origin) => lanes.find((l) => l.origin === origin);

  const rows = [], recordingEnds = new Map(); let cursor = 8;
  const push = (row) => { row.height = ROW_HEIGHT[row.kind]; row.y = cursor + row.height / 2; cursor += row.height; rows.push(row); };
  for (const [recordingIndex, recording] of recordings.entries()) {
    push({ kind: 'recording', recording, label: `${recording.producer?.service_name ? recording.producer.service_name + ' · ' : ''}Recording ${recordingIndex + 1} · schema ${recording.schemaVersion}${recording.incomplete ? ' · incomplete' : ''}`, sub: recordings.length > 1 ? 'Independent clock · event order' : 'Event order · spacing is not duration' });
    const pending = [];
    const add = (rowKind, entity, event, priority = 0, extra = {}) => pending.push({ kind: rowKind, entity, entityId: entity.id, event, priority, ...extra });
    for (const operation of selectedOperations.filter((o) => o.recordingId === recording.id)) {
      if (!operation.start) { add('orphan', operation, operation.end || operation.rawEvents?.[0]); continue; }
      if (isHttpOnly) {
        if (operation.isHandler) add('ancestry', operation, operation.start);
        continue;
      }
      if (operation.isHandler) add('call', operation, operation.start, 0);
      add('operation', operation, operation.start, 1);
      if (collapsed.has(operation.id)) continue;
      if (operation.end) {
        if (operation.isHandler && RETURNS.has(operation.completion)) add('return', operation, operation.end);
        else if (operation.isHandler) add('stop', operation, operation.end);
        else add('operationEnd', operation, operation.end);
      } else add('unfinished', operation, null);
    }
    for (const exchange of selectedExchanges.filter((x) => x.recordingId === recording.id)) {
      if (exchange.start) add('request', exchange, exchange.start);
      if (exchange.responseEvent) add('response', exchange, exchange.responseEvent);
      if (exchange.end) add('terminal', exchange, exchange.end);
      else add('unfinished', exchange, null);
    }
    pending.sort((a, b) => !a.event ? (!b.event ? 0 : 1) : !b.event ? -1 : compareEvent(a.event, b.event) || a.priority - b.priority);
    let lastEvent = null;
    for (const row of pending) {
      if (row.event && lastEvent && row.event !== lastEvent) {
        const gap = elapsed(lastEvent, row.event);
        if (gap > 1500) push({ kind: 'gap', label: `≈ ${durationLabel(gap)} elapsed (compressed)` });
      }
      push(row); if (row.event) lastEvent = row.event;
    }
    recordingEnds.set(recording.id, cursor - 6); cursor += 18;
  }
  const height = cursor + 12;
  const rowFor = (id, kinds) => rows.find((r) => r.entityId === id && kinds.includes(r.kind));
  const bars = [], ancestryPills = [], arrows = [], localArrows = [], waitSegments = [], serverBars = [];
  // Independent concurrent bars on the same lane receive a separate visual slot.
  const occupied = new Map();
  for (const operation of selectedOperations) {
    const row = rowFor(operation.id, ['operation', 'ancestry']); if (!row) continue;
    const lane = actorLane(operation.origin, operation), counts = descendantCounts(operation);
    const method = displayMethod(operation), repeated = operation.repeatCount > 1;
    const label = `${method}${repeated ? ` #${operation.repeatIndex || 1}` : ''}`;
    if (row.kind === 'ancestry') {
      const childRows = rows.filter((r) => r.entity && r.entity.id !== operation.id && ancestors(r.entity).some((o) => o.id === operation.id));
      ancestryPills.push({ entityId: operation.id, x: lane.x, y: row.y, height: childRows.length ? Math.max(...childRows.map((r) => r.y)) - row.y : 0, label: `↦ inside ${label} · handler`, operation }); continue;
    }
    const endRow = rowFor(operation.id, ['return', 'stop', 'operationEnd']);
    const y = row.y - 17, bottom = collapsed.has(operation.id) ? row.y + 18 : endRow?.y ?? recordingEnds.get(operation.recordingId);
    const laneSlots = occupied.get(lane.id) || []; let slot = operation.depth || ancestors(operation).length;
    while (laneSlots.some((s) => s.slot === slot && s.bottom >= y)) slot++;
    laneSlots.push({ slot, bottom }); occupied.set(lane.id, laneSlots);
    bars.push({ entityId: operation.id, operation, kind: operation.isHandler ? 'handler' : 'method', x: lane.x - 7 + slot * 3, y, width: 14, height: Math.max(20, bottom - y), labelX: lane.x + 15 + slot * 3, labelY: row.y - 14, label, component: operation.component || 'Component not recorded', counts, depth: operation.depth || ancestors(operation).length, slot, open: !operation.end, stopped: operation.completion === 'observation_stopped', collapsed: collapsed.has(operation.id), endY: endRow?.y, tone: operation.isHandler ? (operation.completion === 'threw' ? 'error' : operation.completion === 'cancelled' ? 'neutral' : !operation.end || operation.completion === 'observation_stopped' ? 'warning' : 'local') : 'neutral' });
  }
  const barMap = new Map(bars.map((b) => [b.entityId, b]));
  for (const entity of [...selectedOperations, ...selectedExchanges].filter(i => i.parentScope === 'remote' && i.parentResolved)) {
    const parent = entityMap.get(entity.parentId), row = rowFor(entity.id, ['operation', 'ancestry', 'request', 'orphan']);
    if (!parent || !row) continue;
    const from = actorLane(parent.executor || parent.origin, parent), to = actorLane(entity.executor || entity.origin, entity);
    localArrows.push({ key: `${entity.id}:remote`, entityId: entity.id, kind: 'remote', x1: from.x, x2: to.x, y: row.y - 16, label: 'remote parent', sub: 'Causal link · clocks independent', dashed: true, tone: 'local', title: `Remote parent ${parent.spanId} → ${entity.spanId}. Causality recorded; cross-source elapsed time unknown.` });
  }

  for (const row of rows) {
    const entity = row.entity;
    if (!entity) continue;
    if (['request', 'response', 'terminal'].includes(row.kind) || (row.kind === 'unfinished' && !opMap.has(entity.id))) {
      const lane = actorLane(entity.executor, entity), server = originLane(entity.origin); if (!server) continue;
      const [glyph, outcome, tone] = outcomeMeta(entity.end ? entity.outcome : 'unfinished');
      const successfulTransfer = entity.end && ['success', 'http_error'].includes(entity.outcome);
      let label = '', sub = '', rowTone = tone;
      if (row.kind === 'request') { label = `${entity.method} ${entity.path || '/'}${entity.manual ? ' · manual' : ''}${entity.attempt?.reason !== 'initial' ? ` · ${entity.attempt?.reason || ''}` : ''}`; sub = bodyPreview(entity.requestBody); rowTone = 'neutral'; }
      if (row.kind === 'response') { label = `${entity.status >= 400 ? '✕' : successfulTransfer ? entity.status >= 300 ? '↪' : '✓' : '↓'} ${entity.status ?? 'Status not recorded'}${entity.response?.status_text ? ` ${entity.response.status_text}` : ''} · ${durationLabel(entity.timeToHeadersMs)} to headers`; sub = `${successfulTransfer ? '' : 'headers only · '}${bodyPreview(entity.responseBody)}`; rowTone = entity.status >= 400 ? 'error' : successfulTransfer ? entity.status >= 300 ? 'neutral' : 'ok' : 'neutral'; }
      if (row.kind === 'terminal') { label = `${entity.applicationOutcome === 'error' ? '✕ application error' : `${glyph} ${outcome}`} · ${entity.start ? durationLabel(entity.durationMs) : 'duration not verified'}`; sub = !entity.start ? 'request start not recorded' : entity.completedAfterHandlerReturn ? 'completed after handler returned' : entity.completedAfterParentReturn ? 'completed after method returned' : entity.end?.data?.end_reason === 'body_closed' ? 'body closed' : ''; if (entity.applicationOutcome === 'error') rowTone = 'error'; }
      if (row.kind === 'terminal' && entity.status != null && !entity.responseEvent) { label += ` · HTTP ${entity.status}`; if (entity.status >= 400) rowTone = 'error'; }
      if (row.kind === 'unfinished') label = '… unfinished · no http.ended';
      arrows.push({ key: `${entity.id}:${row.kind}`, entityId: entity.id, kind: row.kind, x1: row.kind === 'request' ? lane.x : server.x, x2: row.kind === 'request' ? server.x : lane.x, y: row.y + 9, label, sub, tone: rowTone, dashed: row.kind === 'terminal' || row.kind === 'unfinished' || row.kind === 'response' && !successfulTransfer, title: `${entity.method} ${entity.url}. ${label}${sub ? `. ${sub}` : ''}. Span ${entity.spanId}. Select exchange.` });
    }
    if (row.kind === 'call' || row.kind === 'return') {
      const bar = barMap.get(entity.id); if (!bar) continue;
      const parent = entity.parentScope === 'local' ? opMap.get(entity.parentId) : null, parentBar = parent ? barMap.get(entity.parentId) : null, caller = entity.invocation?.caller;
      const callerLane = actorLane(caller), calleeLane = actorLane(entity.origin, entity);
      const callerX = parentBar ? parentBar.x + 7 : callerLane.x, calleeX = bar.x + 7;
      const sameRole = ownerOf(caller) === ownerOf(entity.origin);
      const callerName = [caller?.component, caller?.method].filter(Boolean).join('.') || 'Caller not recorded';
      const completion = entity.completion;
      const awaited = entity.invocation?.dispatch === 'awaited';
      const returnLabels = { returned: awaited ? '↩ resolved' : '↩ returned', threw: awaited ? '↯ rejected' : '↯ threw', cancelled: '⊘ cancelled' };
      const errorType = entity.end?.data?.error?.type;
      const label = row.kind === 'call' ? `call · ${bar.label}` : `${returnLabels[completion]}${completion === 'threw' && errorType ? ` · ${errorType}` : ''} · ${durationLabel(entity.durationMs)}`;
      localArrows.push({ key: `${entity.id}:${row.kind}`, entityId: entity.id, kind: row.kind, x1: row.kind === 'call' ? callerX : calleeX, x2: row.kind === 'call' ? calleeX : callerX, y: row.y + 10, self: sameRole && callerLane.id === calleeLane.id, label, sub: row.kind === 'call' ? `handler · ${entity.invocation?.dispatch || 'synchronous'}${parent ? '' : ' · caller not instrumented'}` : '', fromDot: row.kind === 'call' && !parent, tone: row.kind === 'call' || completion === 'returned' ? 'local' : completion === 'threw' ? 'error' : 'neutral', title: row.kind === 'call' ? `Local call from ${OWNER_LABELS[ownerOf(caller)]} ${callerName} to ${OWNER_LABELS[entity.owner]} ${entity.component}.${entity.method}, handler, ${entity.invocation?.dispatch || 'synchronous'}. Span ${entity.spanId}. Select invocation.` : `${label} to ${callerName}; elapsed includes nested HTTP and waiting. Span ${entity.spanId}. Select invocation.` });
    }
  }
  for (const bar of bars.filter((b) => b.kind === 'handler')) {
    const parentBar = bar.operation.parentScope === 'local' ? barMap.get(bar.operation.parentId) : null; if (!parentBar || bar.collapsed) continue;
    const start = rowFor(bar.entityId, ['call'])?.y ?? bar.y;
    const stop = Math.min(bar.y + bar.height, parentBar.y + parentBar.height);
    if (stop > start) waitSegments.push({ entityId: bar.entityId, callerId: parentBar.entityId, x: parentBar.x, y: start, width: parentBar.width, height: stop - start, label: `${bar.operation.invocation?.dispatch === 'awaited' ? 'awaiting settlement of' : 'waiting for'} ${bar.operation.method || bar.operation.name}` });
  }
  for (const exchange of selectedExchanges) {
    const start = rowFor(exchange.id, ['request']), end = rowFor(exchange.id, ['terminal']);
    const lane = originLane(exchange.origin); if (!start || !lane) continue;
    serverBars.push({ entityId: exchange.id, x: lane.x - 4, y: start.y + 9, width: 8, height: Math.max(12, (end?.y ?? recordingEnds.get(exchange.recordingId)) - start.y), open: !exchange.end });
  }
  const navigationItems = rows.filter((r) => r.entity && !['operationEnd', 'stop', 'unfinished'].includes(r.kind)).map((r) => ({ key: `${r.entityId}:${r.kind}`, id: r.entityId, kind: r.kind, y: r.y }));
  return { lanes, ownerGroups, clientGroup, laneWidth, width, height, rows, bars, arrows, localArrows, waitSegments, serverBars, ancestryPills, navigationItems, entityMap, opMap, shownIds: selectedExchanges.map((x) => x.id) };
}
