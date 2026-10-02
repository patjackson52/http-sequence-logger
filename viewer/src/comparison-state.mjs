// Presentation only: correspondence and field semantics belong to sequence-diff.
export function orderPairIds(diff) {
  return new Set(diff.order_changes.flatMap(change => [change.first_pair_id, change.second_pair_id]));
}
export function isDifference(pair, orderIds) {
  return pair.presence !== 'both' || pair.changes.length > 0 || orderIds.has(pair.id);
}
export function projectComparison(diff, {search = '', filter = 'all', collapseEqual = false, collapsed = new Set(), selectedId = null} = {}) {
  const byId = new Map(diff.pairs.map(pair => [pair.id, pair]));
  const orderIds = orderPairIds(diff);
  const query = search.trim().toLowerCase();
  const matches = pair => {
    if (query && ![pair.primary?.label, pair.secondary?.label, pair.primary?.node_id, pair.secondary?.node_id, ...pair.changes.map(c => c.path)].join(' ').toLowerCase().includes(query)) return false;
    if (filter === 'changed') return pair.changes.length > 0;
    if (filter === 'one-sided') return ['primary_only', 'secondary_only'].includes(pair.presence);
    if (filter === 'unresolved') return pair.presence === 'unresolved';
    if (filter === 'order') return orderIds.has(pair.id);
    if (filter === 'unknown') return pair.uncertainties.length > 0;
    if (filter === 'unknown-only') return pair.uncertainties.length > 0 && !isDifference(pair, orderIds);
    return true;
  };
  const directIds = new Set(diff.pairs.filter(matches).map(pair => pair.id));
  const visibleIds = new Set(directIds);
  for (const id of directIds) {
    let pair = byId.get(id);
    while (pair?.parent_pair_id) { visibleIds.add(pair.parent_pair_id); pair = byId.get(pair.parent_pair_id); }
  }
  // Hide only evidence-complete equal regions, retaining ancestors of changes/unknowns.
  if (collapseEqual && !query && filter === 'all') {
    const interesting = new Set(diff.pairs.filter(p => isDifference(p, orderIds) || p.uncertainties.length || p.id === selectedId).map(p => p.id));
    for (const id of [...interesting]) {
      let pair = byId.get(id);
      while (pair?.parent_pair_id) { interesting.add(pair.parent_pair_id); pair = byId.get(pair.parent_pair_id); }
    }
    for (const id of visibleIds) if (!interesting.has(id)) visibleIds.delete(id);
  }
  const navigable = diff.pairs.filter(pair => {
    if (!visibleIds.has(pair.id)) return false;
    for (let parent = byId.get(pair.parent_pair_id); parent; parent = byId.get(parent.parent_pair_id)) if (collapsed.has(parent.id)) return false;
    return true;
  });
  return {visibleIds, directIds, navigable, orderIds, hiddenCount: diff.pairs.length - navigable.length,
    differences: diff.pairs.filter(p => isDifference(p, orderIds)), unknownOnly: diff.pairs.filter(p => p.uncertainties.length && !isDifference(p, orderIds))};
}
export function restorePair(previous, nextDiff, swapped = false) {
  if (!previous) return null;
  // Node IDs are stable across profiles; event identities additionally fence node ID reuse.
  for (const oldSide of ['primary', 'secondary']) {
    const ref = previous[oldSide]; if (!ref) continue;
    const side = swapped ? (oldSide === 'primary' ? 'secondary' : 'primary') : oldSide;
    const pair = nextDiff.pairs.find(p => p[side]?.node_id === ref.node_id && p[side].event_ids.some(id => ref.event_ids.includes(id)));
    if (pair) return pair.id;
  }
  return null;
}
export function swapProfile(profile) {
  return {...profile, matches: (profile.matches || []).map(m => ({primary:m.secondary, secondary:m.primary})), recording_matches: (profile.recording_matches || []).map(m => ({primary:m.secondary, secondary:m.primary}))};
}
