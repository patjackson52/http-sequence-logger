import { modelOf, reference, stable, LIMITS, SequenceDiffError } from './model.mjs';
import { compareFields } from './compare-fields.mjs';
import validateDiffSchema from './generated/diff-validator.mjs';
export { sequencesFromCapture, validateSequence, SequenceDiffError, LIMITS } from './model.mjs';

export const DEFAULT_PROFILE = Object.freeze({
  ignore_paths: Object.freeze([]), ignore_headers: Object.freeze([]),
  compare_timing: false, json_fields: true, matches: Object.freeze([]), recording_matches: Object.freeze([])
});

function profileOf(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new SequenceDiffError('Comparison options must be an object.');
  for (const key of Object.keys(options)) if (!Object.hasOwn(DEFAULT_PROFILE, key)) throw new SequenceDiffError('Unknown comparison option: ' + key);
  const p = { ...DEFAULT_PROFILE, ...structuredClone(options) };
  for (const name of ['ignore_paths', 'ignore_headers', 'matches', 'recording_matches']) if (!Array.isArray(p[name])) throw new SequenceDiffError(name + ' must be an array.');
  if (p.ignore_paths.some(x => typeof x !== 'string' || !/^(|\/(?:[^~]|~[01])*)$/.test(x))) throw new SequenceDiffError('ignore_paths requires exact JSON pointers.');
  if (p.ignore_headers.some(x => typeof x !== 'string' || !x.length)) throw new SequenceDiffError('ignore_headers requires header names.');
  for (const key of ['compare_timing', 'json_fields']) if (typeof p[key] !== 'boolean') throw new SequenceDiffError(key + ' must be boolean.');
  p.ignore_paths = [...new Set(p.ignore_paths)].sort();
  p.ignore_headers = [...new Set(p.ignore_headers.map(x => x.toLowerCase()))].sort();
  for (const list of [p.matches, p.recording_matches]) {
    const left = new Set(), right = new Set();
    for (const pair of list) {
      if (!pair || Object.keys(pair).sort().join(',') !== 'primary,secondary' || typeof pair.primary !== 'string' || !pair.primary || typeof pair.secondary !== 'string' || !pair.secondary) throw new SequenceDiffError('Explicit matches require primary and secondary node IDs.');
      if (left.has(pair.primary) || right.has(pair.secondary)) throw new SequenceDiffError('Explicit matches must be one-to-one.');
      left.add(pair.primary); right.add(pair.secondary);
    }
    list.sort((x, y) => x.primary < y.primary ? -1 : x.primary > y.primary ? 1 : 0);
  }
  return p;
}

/** Pure, deterministic comparison. Does not mutate inputs or read network/files. */
export function diffSequences(primary, secondary, options = {}) {
  const profile = profileOf(options), a = modelOf(primary), b = modelOf(secondary);
  const pairs = [], orders = [], pairedA = new Map(), pairedB = new Map(), usedOverrides = new Set();
  const budget = { count: 0, orders: 0 };
  const sameSession = stable(primary.session) === stable(secondary.session);
  const overrides = [...profile.recording_matches, ...profile.matches];
  for (const match of overrides) {
    const x = a.nodes.get(match.primary), y = b.nodes.get(match.secondary);
    if (!x || !y || x.kind !== y.kind) throw new SequenceDiffError('Explicit match references missing nodes or different kinds.');
    if (profile.recording_matches.includes(match) !== (x.kind === 'recording')) throw new SequenceDiffError('Use recording_matches only for recording nodes.');
  }
  function add(x, y, parent, basis, candidates = [], unresolved = false) {
    const presence = x && y ? 'both' : unresolved ? 'unresolved' : x ? 'primary_only' : 'secondary_only';
    const fields = x && y ? compareFields(x, y, profile, budget) : { changes: [], uncertainties: [], ignored_paths: [] };
    if (unresolved) fields.uncertainties.push({ path: '', reason: basis === 'ambiguous' ? 'ambiguous_correspondence' : 'counterpart_not_established' });
    const pair = {
      id: 'pair-' + (pairs.length + 1), parent_pair_id: parent?.id ?? null,
      primary: x ? reference(x, a) : null, secondary: y ? reference(y, b) : null, presence,
      matching: { basis, confidence: basis === 'explicit' ? 'explicit' : ['signature', 'source_identity'].includes(basis) ? 'exact' : 'none', candidate_node_ids: candidates },
      equivalence: presence === 'unresolved' ? 'unknown' : presence !== 'both' || fields.changes.length ? 'different' : fields.uncertainties.length ? 'unknown' : 'equal',
      ...fields
    };
    pairs.push(pair);
    if (x) pairedA.set(x.id, pair);
    if (y) pairedB.set(y.id, pair);
    return pair;
  }
  function group(left, right, parent = null) {
    const matched = new Map(), used = new Set(), bases = new Map();
    const connect = (x, y, basis) => { matched.set(x.id, y); used.add(y.id); bases.set(x.id, basis); };
    for (const override of overrides) {
      const x = left.find(n => n.id === override.primary), y = right.find(n => n.id === override.secondary);
      if (x && y) { connect(x, y, 'explicit'); usedOverrides.add(override); }
    }
    if (sameSession) for (const x of left.filter(n => !matched.has(n.id))) {
      const y = right.find(n => !used.has(n.id) && n.id === x.id && n.kind === x.kind);
      if (y) connect(x, y, 'source_identity');
    }
    for (const key of ['signature', ...(left[0]?.kind === 'recording' ? ['identity'] : [])]) {
      const l = bucket(left.filter(n => !matched.has(n.id)), key), r = bucket(right.filter(n => !used.has(n.id)), key);
      for (const [signature, xs] of l) {
        const ys = r.get(signature);
        if (xs.length === 1 && ys?.length === 1) connect(xs[0], ys[0], 'signature');
      }
    }
    const unmatchedL = left.filter(n => !matched.has(n.id)), unmatchedR = right.filter(n => !used.has(n.id));
    const candidates = (x, others) => others.filter(y => x.kind === y.kind && (x.signature && x.signature === y.signature || x.kind === 'recording' && x.identity && x.identity === y.identity));
    const sameParentComplete = !parent || parent.primary && parent.secondary &&
      a.nodes.get(parent.primary.node_id).complete && b.nodes.get(parent.secondary.node_id).complete &&
      a.nodes.get(parent.primary.node_id).recording.complete && b.nodes.get(parent.secondary.node_id).recording.complete;
    for (const x of left) {
      const y = matched.get(x.id);
      if (y) {
        const pair = add(x, y, parent, bases.get(x.id));
        group(x.children, y.children, pair);
      } else {
        const matches = candidates(x, unmatchedR);
        // An unpaired recording cannot establish absence from the other session.
        const unresolved = matches.length > 0 || !sameParentComplete || x.kind === 'recording' && b.recordings.some(r => !r.complete) || !x.signature;
        const pair = add(x, null, parent, matches.length ? 'ambiguous' : 'unmatched', matches.map(y => y.id), unresolved);
        descend(x, null, pair, unresolved);
      }
    }
    for (const y of unmatchedR) {
      const matches = candidates(y, unmatchedL);
      const unresolved = matches.length > 0 || !sameParentComplete || y.kind === 'recording' && a.recordings.some(r => !r.complete) || !y.signature;
      const pair = add(null, y, parent, matches.length ? 'ambiguous' : 'unmatched', matches.map(x => x.id), unresolved);
      descend(null, y, pair, unresolved);
    }
    // Recording order is source file presentation, not a shared causal timeline.
    if (parent) compareOrder(left.filter(n => matched.has(n.id)), matched, parent);
  }
  function descend(x, y, parent, unresolved) {
    const nodes = x?.children ?? y?.children ?? [];
    for (const n of nodes) {
      const pair = add(x ? n : null, y ? n : null, parent, 'unpaired_parent', [], unresolved);
      descend(x ? n : null, y ? n : null, pair, unresolved);
    }
  }
  function relation(x, y) {
    if (!x.start || !y.start) return 'unknown';
    if (x.end && x.end.sequence < y.start.sequence) return 'before';
    if (y.end && y.end.sequence < x.start.sequence) return 'after';
    return x.end && y.end ? 'overlap' : 'unknown';
  }
  function compareOrder(left, matched, parent) {
    for (let i = 0; i < left.length; i++) for (let j = i + 1; j < left.length; j++) {
      if (++budget.orders > LIMITS.orderComparisons) throw new SequenceDiffError('Comparison exceeds the sibling-order work limit.');
      const x = left[i], y = left[j], rx = matched.get(x.id), ry = matched.get(y.id);
      const p = relation(x, y), s = relation(rx, ry);
      const observedReversed = rx.position > ry.position;
      if (p === s && !observedReversed) continue;
      if (++budget.count > LIMITS.changes) throw new SequenceDiffError('Comparison exceeds the change limit.');
      const uncertain = p === 'unknown' || s === 'unknown' || p === 'overlap' && s === 'overlap';
      orders.push({ parent_pair_id: parent.id, first_pair_id: pairedA.get(x.id).id, second_pair_id: pairedA.get(y.id).id,
        primary_relation: p, secondary_relation: s,
        interpretation: uncertain ? 'observed_order_only' : p === 'overlap' || s === 'overlap' ? 'concurrency_changed' : 'reordered' });
    }
  }
  group(a.recordings, b.recordings);
  if (usedOverrides.size !== overrides.length) throw new SequenceDiffError('Explicit matches must be inside corresponding parents. Pair recordings and ancestors first.');
  const summary = {
    matched: pairs.filter(p => p.presence === 'both').length,
    primary_only: pairs.filter(p => p.presence === 'primary_only').length,
    secondary_only: pairs.filter(p => p.presence === 'secondary_only').length,
    unresolved: pairs.filter(p => p.presence === 'unresolved').length,
    changed_pairs: pairs.filter(p => p.equivalence === 'different').length,
    equal_pairs: pairs.filter(p => p.equivalence === 'equal').length,
    uncertain_pairs: pairs.filter(p => p.uncertainties.length).length,
    order_changes: orders.length, field_changes: pairs.reduce((sum, p) => sum + p.changes.length, 0)
  };
  const diagnostics = [a, b].flatMap((m, i) => m.warnings.map(message => ({ side: i ? 'secondary' : 'primary', severity: 'warning', message })));
  const result = {
    format: 'http-sequence-diff', schema_version: '1.0',
    engine: { name: '@http-sequence-logger/sequence-diff', version: '0.1.0', algorithm: 'conservative-tree-v1' },
    inputs: { primary: { session: structuredClone(primary.session), event_count: primary.events.length, recording_count: a.recordings.length },
      secondary: { session: structuredClone(secondary.session), event_count: secondary.events.length, recording_count: b.recordings.length } },
    profile,
    scope: { included: ['parent_scoped_structure', 'sibling_order', 'request_response_fields', 'body_capture', 'outcomes', 'informational_responses', 'trailers', 'producer_metadata', ...(profile.compare_timing ? ['completed_duration_ns'] : [])],
      excluded: ['event_identity', 'wall_timestamps', 'monotonic_origins', 'native_metrics', 'handler_arguments_and_return_values', 'extensions', ...(!profile.compare_timing ? ['completed_duration_ns'] : [])] },
    result: summary.changed_pairs || orders.length ? 'different' : summary.uncertain_pairs || diagnostics.length ? 'inconclusive' : 'equal',
    summary, pairs, order_changes: orders, diagnostics
  };
  validateDiff(result);
  return result;
}
function bucket(nodes, key) {
  const result = new Map();
  for (const node of nodes) if (node[key]) {
    if (!result.has(node[key])) result.set(node[key], []);
    result.get(node[key]).push(node);
  }
  return result;
}

/** Structural schema validation; source referential integrity is checked by the engine. */
export function validateDiff(value) {
  if (!validateDiffSchema(value)) throw new SequenceDiffError('Invalid diff document.', (validateDiffSchema.errors ?? []).slice(0, 12).map(e => (e.instancePath || '/') + ' ' + e.message));
  return true;
}

export function formatDiffText(diff) {
  validateDiff(diff);
  const lines = [diff.result.toUpperCase(), JSON.stringify(diff.inputs.primary.session) + ' → ' + JSON.stringify(diff.inputs.secondary.session),
    diff.summary.matched + ' matched; ' + diff.summary.primary_only + ' primary only; ' + diff.summary.secondary_only + ' secondary only; ' +
    diff.summary.unresolved + ' unresolved; ' + diff.summary.uncertain_pairs + ' uncertain pairs'];
  for (const pair of diff.pairs) {
    if (pair.equivalence === 'equal') continue;
    lines.push(pair.id + ' ' + pair.presence + ' ' + JSON.stringify(pair.primary?.label ?? pair.secondary.label) + ' [' + pair.matching.basis + ']');
    for (const c of pair.changes) lines.push('  ' + c.dimension + ' ' + c.path + ': ' + (c.primary.present ? JSON.stringify(c.primary.value) : '<absent>') + ' → ' + (c.secondary.present ? JSON.stringify(c.secondary.value) : '<absent>'));
    for (const u of pair.uncertainties) lines.push('  ? ' + (u.path || '/') + ': ' + u.reason);
  }
  for (const o of diff.order_changes) lines.push('order ' + o.first_pair_id + ' / ' + o.second_pair_id + ': ' + o.primary_relation + ' → ' + o.secondary_relation + ' [' + o.interpretation + ']');
  for (const d of diff.diagnostics) lines.push('warning ' + d.side + ': ' + JSON.stringify(d.message));
  // Captures are untrusted. Prevent terminal escape/control injection in human output.
  return lines.join('\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')) + '\n';
}
