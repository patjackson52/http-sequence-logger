import { importFiles } from './model.mjs';
import { layoutSequence } from './layout.mjs';

export function positionLabel(reference) {
  if (!reference) return '— Absent';
  return reference.kind === 'recording' ? `Recording ${reference.position + 1}` : `#${reference.position}`;
}

export const CHANGE_DIMENSIONS = Object.freeze(['structure', 'content', 'outcome', 'timing', 'metadata', 'capture']);

export function dimensionCounts(pair) {
  const counts = Object.fromEntries(CHANGE_DIMENSIONS.map(dimension => [dimension, 0]));
  for (const change of pair.changes) if (Object.hasOwn(counts, change.dimension)) counts[change.dimension]++;
  return counts;
}

/** Unique affected nodes per engine dimension; dimensions intentionally overlap. */
export function subtreeDimensionLabels(aggregate) {
  return CHANGE_DIMENSIONS.filter(dimension => aggregate[dimension].size).map(dimension => `${aggregate[dimension].size} ${dimension}-affected`);
}

export const ORDER_LABELS = { reordered: 'Confirmed reorder', concurrency_changed: 'Concurrency changed', observed_order_only: 'Observed order only' };
const set = (value) => value instanceof Set ? value : new Set(value || []);

/** Presentation index only. Correspondence always comes from the engine. */
export function comparisonIndex(diff) {
  const pairs = new Map(diff.pairs.map(pair => [pair.id, pair])), children = new Map(), orders = new Map(), aggregates = new Map();
  for (const pair of diff.pairs) {
    const key = pair.parent_pair_id || null;
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(pair);
  }
  for (const order of diff.order_changes) for (const id of [order.first_pair_id, order.second_pair_id]) {
    if (!orders.has(id)) orders.set(id, []);
    orders.get(id).push(order);
  }
  function aggregate(pair) {
    const dims = { fields: new Set(), order: new Set(), uncertain: new Set(), oneSided: new Set(), unresolved: new Set(), nodes: new Set([pair.id]), ...Object.fromEntries(CHANGE_DIMENSIONS.map(dimension => [dimension, new Set()])) };
    if (pair.changes.length) dims.fields.add(pair.id);
    for (const dimension of CHANGE_DIMENSIONS) if (pair.changes.some(change => change.dimension === dimension)) dims[dimension].add(pair.id);
    if (orders.has(pair.id)) dims.order.add(pair.id);
    if (pair.uncertainties.length || pair.equivalence === 'unknown') dims.uncertain.add(pair.id);
    if (['primary_only', 'secondary_only'].includes(pair.presence)) dims.oneSided.add(pair.id);
    if (pair.presence === 'unresolved') dims.unresolved.add(pair.id);
    for (const child of children.get(pair.id) || []) for (const [key, values] of Object.entries(aggregate(child))) for (const id of values) dims[key].add(id);
    aggregates.set(pair.id, dims); return dims;
  }
  for (const pair of children.get(null) || []) aggregate(pair);
  return { pairs, children, orders, aggregates };
}

export function pairStatus(pair, index) {
  const labels = [];
  if (pair.presence !== 'both') labels.push(({ primary_only: 'P only', secondary_only: 'S only', unresolved: '? Unresolved' })[pair.presence]);
  if (pair.changes.length) {
    labels.push(`Δ ${pair.changes.length} fields`);
    const counts = dimensionCounts(pair);
    for (const dimension of CHANGE_DIMENSIONS) if (counts[dimension]) labels.push(`Δ ${dimension}: ${counts[dimension]}`);
  }
  const relations = [...new Set((index.orders.get(pair.id) || []).map(order => ORDER_LABELS[order.interpretation]))];
  labels.push(...relations.map(label => `↕ ${label}`));
  if (pair.uncertainties.length || pair.equivalence === 'unknown') labels.push('? Unknown');
  if (!labels.length) labels.push('= Equal fields');
  return labels;
}

export function resolutionLabel(pair, resolution, side) {
  if (!resolution || !pair) return '';
  const ids = (side ? [pair[side]] : [pair.primary, pair.secondary]).filter(Boolean).map(reference => reference.node_id);
  if (ids.includes(resolution.sourceNodeId)) return 'Match source';
  if (ids.includes(resolution.candidateNodeId)) return 'Selected candidate';
  return ids.some(id => (resolution.candidateNodeIds || []).includes(id)) ? 'Candidate' : '';
}

export function resolutionClass(pair, resolution, side) {
  if (!resolution) return '';
  const refs = side ? [pair[side]] : [pair.primary, pair.secondary];
  const ids = refs.filter(Boolean).map(ref => ref.node_id);
  if (ids.includes(resolution.sourceNodeId) || ids.includes(resolution.candidateNodeId)) return 'is-resolving';
  if (ids.some(id => (resolution.candidateNodeIds || []).includes(id))) return 'is-candidate';
  return '';
}

export function visibleTree(index, visibleIds, collapsed) {
  const visible = visibleIds == null ? null : set(visibleIds), closed = set(collapsed), result = [];
  function visit(pair, depth) {
    if (visible && !visible.has(pair.id)) return;
    result.push({ pair, depth, hiddenCount: closed.has(pair.id) ? index.aggregates.get(pair.id).nodes.size - 1 : 0 });
    if (!closed.has(pair.id)) for (const child of index.children.get(pair.id) || []) visit(child, depth + 1);
  }
  for (const pair of index.children.get(null) || []) visit(pair, 0);
  return result;
}

export function orderedSide(index, side, visibleIds, collapsed) {
  const visible = visibleIds == null ? null : set(visibleIds), closed = set(collapsed), result = [];
  function visit(parent, depth) {
    const siblings = (index.children.get(parent) || []).filter(pair => pair[side]).slice().sort((a, b) => a[side].position - b[side].position);
    for (const pair of siblings) {
      if (visible && !visible.has(pair.id)) continue;
      result.push({ pair, depth, position: pair[side].position });
      if (!closed.has(pair.id)) visit(pair.id, depth + 1);
    }
  }
  visit(null, 0); return result;
}

function sequenceModel(snapshot) {
  if (snapshot?.model) return snapshot.model;
  const document = snapshot?.document || snapshot?.sequence || snapshot;
  if (!document?.events?.length) return null;
  const imported = importFiles([{ name: 'comparison-snapshot.ndjson', text: document.events.map(event => JSON.stringify(event)).join('\n') }]);
  return imported.sessions.find(session => session.namespace === document.session?.namespace && session.sessionId === document.session?.id) || imported.sessions[0] || null;
}

/** Find monotone equal-token anchors in O(n log n), never move source rows. */
export function correlateRows(primary, secondary) {
  const right = new Map(secondary.map((row, i) => [row.token, i]).filter(([token]) => token != null));
  const entries = primary.flatMap((row, i) => row.token != null && right.has(row.token) ? [{ p: i, s: right.get(row.token) }] : []);
  const tails = [], prev = new Array(entries.length).fill(-1);
  for (let i = 0; i < entries.length; i++) {
    let low = 0, high = tails.length;
    while (low < high) { const mid = (low + high) >> 1; if (entries[tails[mid]].s < entries[i].s) low = mid + 1; else high = mid; }
    if (low) prev[i] = tails[low - 1]; tails[low] = i;
  }
  const anchors = []; let last = tails.at(-1);
  while (last != null && last >= 0) { anchors.push(entries[last]); last = prev[last]; }
  anchors.reverse();
  const result = []; let pi = 0, si = 0;
  const emit = (p, s) => result.push({ primary: p, secondary: s, height: Math.max(p?.height || 0, s?.height || 0, 34) });
  for (const anchor of [...anchors, { p: primary.length, s: secondary.length }]) {
    // A reorder is shown at its actual position with a move-reference gap on the other side.
    while (pi < anchor.p) emit(primary[pi++], null);
    while (si < anchor.s) emit(null, secondary[si++]);
    if (pi < primary.length && si < secondary.length) emit(primary[pi++], secondary[si++]);
  }
  let y = 8;
  for (const row of result) { row.top = y; row.y = y + row.height / 2; y += row.height; }
  return { rows: result, height: y + 16 };
}

function warpLayout(layout, rows, side, height) {
  const anchors = rows.filter(row => row[side]).map(row => ({ old: row[side].y, next: row.y }));
  anchors.unshift({ old: 0, next: 0 }); anchors.push({ old: layout.height, next: height });
  const warp = (value) => {
    let low = 0, high = anchors.length - 1;
    while (high - low > 1) { const mid = (low + high) >> 1; if (anchors[mid].old <= value) low = mid; else high = mid; }
    const a = anchors[low], b = anchors[high];
    // Keep event-local label/arrow offsets intact when alignment inserts empty rows.
    const nearest = value - a.old <= b.old - value ? a : b;
    return nearest.next + value - nearest.old;
  };
  const line = item => ({ ...item, y: warp(item.y) });
  const rect = item => ({ ...item, y: warp(item.y), height: Math.max(8, warp(item.y + item.height) - warp(item.y)) });
  return { ...layout, height, rows: layout.rows.map(line), arrows: layout.arrows.map(line), localArrows: layout.localArrows.map(line), bars: layout.bars.map(item => ({ ...rect(item), labelY: warp(item.labelY) })), serverBars: layout.serverBars.map(rect), waitSegments: layout.waitSegments.map(rect) };
}

export function alignedComparison(diff, snapshots, options = {}) {
  const index = comparisonIndex(diff), closed = set(options.collapsed);
  const visible = new Set(visibleTree(index, options.visibleIds, closed).map(row => row.pair.id));
  const layouts = {}, sourceMaps = {};
  for (const side of ['primary', 'secondary']) {
    const model = sequenceModel(snapshots[side]);
    if (!model) return { rows: [], height: 0, index, primary: null, secondary: null };
    const events = new Map();
    for (const entity of [...model.operations, ...model.exchanges]) for (const event of entity.rawEvents || []) events.set(event.event_id, entity.id);
    const pairForEntity = new Map(), entityForPair = new Map(), pairForRecording = new Map();
    for (const pair of diff.pairs) {
      const ref = pair[side]; if (!ref) continue;
      if (ref.kind === 'recording') pairForRecording.set(ref.recording_id, pair);
      else { const entityId = ref.event_ids.map(id => events.get(id)).find(Boolean); if (entityId) { pairForEntity.set(entityId, pair); entityForPair.set(pair.id, entityId); } }
    }
    const layout = layoutSequence(model, { laneWidth: 124, visibleIds: visible ? new Set([...visible].map(id => entityForPair.get(id)).filter(Boolean)) : null, collapsed: new Set([...closed].map(id => entityForPair.get(id)).filter(Boolean)) });
    // Give repeated event grammar an exact correspondence token. No timing clocks are compared.
    const occurrences = new Map();
    layout.rows = layout.rows.filter(row => row.kind !== 'recording' || !visible || visible.has(pairForRecording.get(row.recording.id)?.id)).map(row => {
      const pair = row.entityId ? pairForEntity.get(row.entityId) : row.recording ? pairForRecording.get(row.recording.id) : null;
      const key = pair ? `${pair.id}:${row.kind}` : null, n = occurrences.get(key) || 0; occurrences.set(key, n + 1);
      return { ...row, pair, token: key ? `${key}:${n}` : null };
    });
    layouts[side] = layout; sourceMaps[side] = pairForEntity;
  }
  const alignment = correlateRows(layouts.primary.rows, layouts.secondary.rows);
  const positions = Object.fromEntries(['primary', 'secondary'].map(side => [side, new Map(alignment.rows.flatMap((row, i) => row[side]?.token ? [[row[side].token, i + 1]] : []))]));
  for (const row of alignment.rows) for (const side of ['primary', 'secondary']) {
    const other = side === 'primary' ? 'secondary' : 'primary';
    if (!row[side] && row[other]?.pair) {
      const source = row[other];
      row[`${side}Gap`] = positions[side].has(source.token) ? `↷ ${side === 'primary' ? 'P' : 'S'} original row ${positions[side].get(source.token)} · order differs` : source.pair[side] ? `${source.kind} not observed here` : source.pair.presence === 'unresolved' ? 'Counterpart unresolved' : `Absent in ${side}`;
    }
  }
  return { ...alignment, index, sourceMaps, primary: warpLayout(layouts.primary, alignment.rows, 'primary', alignment.height), secondary: warpLayout(layouts.secondary, alignment.rows, 'secondary', alignment.height) };
}
