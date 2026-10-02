import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { diffSequences, sequencesFromCapture } from '../sequence-diff/index.mjs';
import { alignedComparison, correlateRows, comparisonIndex, orderedSide, visibleTree, resolutionClass, pairStatus, positionLabel, resolutionLabel, dimensionCounts, subtreeDimensionLabels } from '../viewer/src/comparison-layout.mjs';
const load = name => sequencesFromCapture(readFileSync(new URL(`../examples/${name}.ndjson`, import.meta.url), 'utf8'))[0];
const source = (id, position, kind = 'http') => ({ node_id: id, position, kind, label: id });
function pair(id, primary, secondary, parent = null, changes = [], uncertainties = []) {
  return { id, primary, secondary, parent_pair_id: parent, presence: primary && secondary ? 'both' : primary ? 'primary_only' : 'secondary_only', changes, uncertainties, equivalence: changes.length ? 'different' : uncertainties.length ? 'unknown' : 'equal', matching: { basis: 'signature', candidate_node_ids: [] } };
}

test('comparison aggregate dimensions count unique nodes separately and retain descendants', () => {
  const diff = { pairs: [pair('root', source('p0', 0, 'operation'), source('s0', 0, 'operation')), pair('a', source('pa', 0), source('sa', 1), 'root', [{ path: '/x', dimension: 'content' }, { path: '/y', dimension: 'outcome' }], [{ path: '/body' }]), pair('b', source('pb', 1), source('sb', 0), 'root'), pair('extra', null, source('sx', 2), 'root')], order_changes: [{ first_pair_id: 'a', second_pair_id: 'b', interpretation: 'reordered' }, { first_pair_id: 'a', second_pair_id: 'b', interpretation: 'concurrency_changed' }] };
  const idx = comparisonIndex(diff), aggregate = idx.aggregates.get('root');
  assert.equal(aggregate.content.size, 1); assert.equal(aggregate.outcome.size, 1); assert.deepEqual([...aggregate.content], ['a']); assert.deepEqual([...aggregate.outcome], ['a']);
  assert.deepEqual(subtreeDimensionLabels(aggregate), ['1 content-affected', '1 outcome-affected']);
  assert.ok(pairStatus(diff.pairs[1], idx).includes('Δ content: 1')); assert.ok(pairStatus(diff.pairs[1], idx).includes('Δ outcome: 1'));
  assert.equal(aggregate.nodes.size, 4); assert.equal(aggregate.fields.size, 1); assert.equal(aggregate.order.size, 2); assert.equal(aggregate.uncertain.size, 1); assert.equal(aggregate.oneSided.size, 1);
  assert.deepEqual(orderedSide(idx, 'primary').map(row => row.pair.id), ['root', 'a', 'b']);
  assert.deepEqual(orderedSide(idx, 'secondary').map(row => row.pair.id), ['root', 'b', 'a', 'extra']);
  assert.deepEqual(visibleTree(idx, null, new Set(['root'])).map(row => row.hiddenCount), [3]);
  assert.ok(pairStatus(diff.pairs[1], idx).some(label => label.includes('Concurrency changed')));
});

test('monotone correlation preserves both original sequences and leaves reorder rows explicit', () => {
  const mk = token => ({ token, height: token === 'b' ? 60 : 40 });
  const p = ['a', 'b', 'c', 'd'].map(mk), s = ['a', 'c', 'b', 'extra', 'd'].map(mk), layout = correlateRows(p, s);
  assert.deepEqual(layout.rows.flatMap(row => row.primary ? [row.primary.token] : []), ['a', 'b', 'c', 'd']);
  assert.deepEqual(layout.rows.flatMap(row => row.secondary ? [row.secondary.token] : []), ['a', 'c', 'b', 'extra', 'd']);
  assert.equal(layout.rows.filter(row => row.primary?.token === 'b' && !row.secondary).length, 1);
  assert.equal(layout.rows.filter(row => row.secondary?.token === 'b' && !row.primary).length, 1);
  assert.ok(layout.rows.every((row, i) => !i || row.top >= layout.rows[i - 1].top + layout.rows[i - 1].height));
});

test('canonical aligned geometry retains HTTP origins, nested local calls, returns and evidence pairing', () => {
  for (const name of ['success', 'handler-no-http', 'handler-repeated-nested', 'viewer-three-origin']) {
    let document; try { document = load(name); } catch (error) { if (name === 'handler-repeated-nested' && error.code === 'ENOENT') continue; throw error; }
    const diff = diffSequences(document, document), before = JSON.stringify([diff, document]), layout = alignedComparison(diff, { primary: { document }, secondary: { document } });
    assert.ok(layout.primary); assert.equal(JSON.stringify([diff, document]), before);
    assert.equal(layout.primary.arrows.length, layout.secondary.arrows.length);
    assert.equal(layout.rows.every(row => row.primary?.token === row.secondary?.token), true);
    for (const arrow of [...layout.primary.arrows, ...layout.primary.localArrows]) {
      const pair = layout.sourceMaps.primary.get(arrow.entityId);
      assert.ok(pair.primary.event_ids.some(id => document.events.some(event => event.event_id === id)));
    }
    if (name === 'handler-no-http') { assert.equal(layout.primary.localArrows.length, 2); assert.equal(layout.primary.lanes.filter(lane => lane.kind === 'server').length, 0); }
    if (name === 'viewer-three-origin') assert.equal(layout.primary.lanes.filter(lane => lane.kind === 'server').length, 3);
  }
});

test('one-sided paired row gaps and presentation filters preserve canonical references', () => {
  const primary = load('success'), secondary = structuredClone(primary);
  for (const event of secondary.events) { event.event_id += '-other'; event.session_id += '-other'; event.recording_id += '-other'; if (event.data.request?.url) event.data.request.url = event.data.request.url.replace('/verify', '/different'); if (event.data.response?.url) event.data.response.url = event.data.response.url.replace('/verify', '/different'); }
  secondary.session.id += '-other';
  const diff = diffSequences(primary, secondary), index = comparisonIndex(diff), one = diff.pairs.find(pair => pair.presence !== 'both' && (pair.primary || pair.secondary).kind === 'http');
  assert.ok(one, 'fixture endpoint signature changes remain one-sided');
  const layout = alignedComparison(diff, { primary, secondary });
  assert.ok(layout.rows.some(row => row.primary?.pair?.id === one.id || row.secondary?.pair?.id === one.id));
  assert.ok(layout.rows.some(row => (row.primaryGap || row.secondaryGap || '').includes('Absent')));
  const root = (index.children.get(null) || [])[0];
  const collapsed = alignedComparison(diff, { primary, secondary }, { collapsed: new Set([root.id]) });
  assert.equal(collapsed.primary.arrows.length, 0); assert.equal(collapsed.secondary.arrows.length, 0);
});

test('resolution treatment distinguishes inspected nodes, picked candidates and unpicked candidates on both sides', () => {
  const item = pair('x', source('p', 0), source('s', 0)), resolution = { sourceNodeId: 'p', candidateNodeId: 'picked', candidateNodeIds: ['s', 'picked'] };
  assert.equal(resolutionLabel(item, resolution, 'primary'), 'Match source'); assert.equal(resolutionLabel(item, resolution, 'secondary'), 'Candidate');
  assert.equal(resolutionClass(item, resolution, 'primary'), 'is-resolving'); assert.equal(resolutionClass(item, resolution, 'secondary'), 'is-candidate');
  assert.equal(resolutionClass(item, { ...resolution, candidateNodeId: 's' }, 'secondary'), 'is-resolving');
});

function reorderedDocuments() {
  const original = load('success'), http = original.events.filter(event => event.event_type.startsWith('http.'));
  const start = original.events.findIndex(event => event.event_type === 'http.request.started');
  const last = original.events.findLastIndex(event => event.event_type === 'http.ended');
  const extra = structuredClone(http);
  for (const event of extra) {
    event.event_id += '-extra'; event.context.span_id = 'f'.repeat(16);
    if (event.data.request?.url) event.data.request.url = event.data.request.url.replace('/verify', '/extra');
    if (event.data.response?.url) event.data.response.url = event.data.response.url.replace('/verify', '/extra');
  }
  function build(reverse) {
    const events = structuredClone([...original.events.slice(0, start), ...(reverse ? [...extra, ...http] : [...http, ...extra]), ...original.events.slice(last + 1)]), starts = new Map();
    events.forEach((event, i) => {
      event.sequence = i + 1; event.monotonic_ns = String(i * 1000000); event.timestamp = new Date(Date.UTC(2026, 9, reverse ? 1 : 2) + i).toISOString();
      if (reverse) { event.event_id += '-secondary'; event.session_id += '-secondary'; event.recording_id += '-secondary'; }
      if (event.event_type === 'operation.started' || event.event_type === 'http.request.started') starts.set(event.context.span_id, i);
      if (event.event_type === 'operation.ended' || event.event_type === 'http.ended') event.data.duration_ns = String((i - starts.get(event.context.span_id)) * 1000000);
    });
    return sequencesFromCapture(events)[0];
  }
  return { primary: build(false), secondary: build(true) };
}

test('real engine reorder is shown in original order with move placeholders and intact row geometry', () => {
  const snapshots = reorderedDocuments(), diff = diffSequences(snapshots.primary, snapshots.secondary), layout = alignedComparison(diff, snapshots), index = comparisonIndex(diff);
  assert.deepEqual(diff.order_changes.map(order => order.interpretation), ['reordered']);
  for (const side of ['primary', 'secondary']) {
    const requestRows = layout.rows.filter(row => row[side]?.kind === 'request').map(row => row[side]);
    assert.deepEqual(requestRows.map(row => row.entity.path.split('?')[0]), side === 'primary' ? ['/verify', '/extra'] : ['/extra', '/verify']);
    for (const arrow of layout[side].arrows) {
      const row = layout.rows.find(row => row[side]?.entityId === arrow.entityId && row[side].kind === arrow.kind);
      assert.equal(arrow.y, row.y + 9, 'alignment must retain arrow offset within its own event row');
    }
    assert.deepEqual(orderedSide(index, side).filter(row => row.pair[side].kind === 'http').map(row => row.pair[side].label), side === 'primary' ? ['POST /verify', 'POST /extra'] : ['POST /extra', 'POST /verify']);
  }
  assert.ok(layout.rows.some(row => (row.primaryGap || row.secondaryGap || '').startsWith('↷')));
});


test('position labels preserve canonical event sequence numbers and distinguish recording ordinals', () => {
  const document = load('success'), diff = diffSequences(document, document);
  for (const pair of diff.pairs) {
    if (pair.primary.kind === 'recording') assert.equal(positionLabel(pair.primary), 'Recording 1');
    else {
      const start = document.events.find(event => pair.primary.event_ids.includes(event.event_id) && ['operation.started', 'http.request.started'].includes(event.event_type));
      assert.equal(positionLabel(pair.primary), `#${start.sequence}`);
    }
  }
  assert.equal(positionLabel(null), '— Absent');
});


test('field dimension badges count field changes while subtree dimension counts count each affected node once', () => {
  const multidimensional = pair('a', source('pa', 1), source('sa', 1), 'root', [
    { path: '/request/header', dimension: 'content' }, { path: '/response/body', dimension: 'content' }, { path: '/outcome', dimension: 'outcome' }, { path: '/capture', dimension: 'capture' },
  ]);
  const diff = { pairs: [pair('root', source('pr', 0, 'operation'), source('sr', 0, 'operation')), multidimensional, pair('b', source('pb', 2), source('sb', 2), 'root', [{ path: '/duration', dimension: 'timing' }, { path: '/metadata', dimension: 'metadata' }, { path: '/structure', dimension: 'structure' }])], order_changes: [] };
  const index = comparisonIndex(diff), aggregate = index.aggregates.get('root');
  assert.deepEqual(dimensionCounts(multidimensional), { structure: 0, content: 2, outcome: 1, timing: 0, metadata: 0, capture: 1 });
  assert.equal(aggregate.fields.size, 2);
  for (const dimension of ['structure', 'content', 'outcome', 'timing', 'metadata', 'capture']) assert.equal(aggregate[dimension].size, 1);
  assert.deepEqual(subtreeDimensionLabels(aggregate), ['1 structure-affected', '1 content-affected', '1 outcome-affected', '1 timing-affected', '1 metadata-affected', '1 capture-affected']);
  assert.deepEqual(pairStatus(multidimensional, index), ['Δ 4 fields', 'Δ content: 2', 'Δ outcome: 1', 'Δ capture: 1']);
});
