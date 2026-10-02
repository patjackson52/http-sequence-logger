import React, { useEffect, useMemo, useRef } from 'react';
import { alignedComparison, comparisonIndex, orderedSide, pairStatus, resolutionClass, visibleTree, ORDER_LABELS, positionLabel, resolutionLabel, subtreeDimensionLabels } from './comparison-layout.mjs';
import './comparison-layout.css';

const EMPTY = new Set();
const TONES = { neutral: '#5b6673', local: '#4f4a8a', warning: '#8a5a00', ok: '#1f7a4d', error: '#b9382c' };
const titleOf = pair => pair.primary?.label || pair.secondary?.label || pair.id;
const kindOf = pair => (pair.primary || pair.secondary).kind;
function classes(pair, selectedId, resolution, side) { if (!pair) return ''; return `nll-cmp-pair ${pair.id === selectedId ? 'is-selected' : ''} ${resolutionClass(pair, resolution, side)} ${pair.presence !== 'both' ? 'is-one-sided' : ''} ${pair.equivalence === 'unknown' ? 'is-unknown' : ''}`; }
function Badges({ pair, index }) { return <span className="nll-cmp-badges">{pairStatus(pair, index).map(label => <span key={label} className={label.startsWith('Δ') ? 'fields' : label.startsWith('↕') ? 'order' : label.startsWith('?') ? 'unknown' : ''}>{label}</span>)}</span>; }
function Overview({ index, selectedId, onSelect, onLocate }) {
  return <nav className="nll-cmp-overview" aria-label="Comparison overview"><span>Overview</span>{(index.children.get(null) || []).flatMap(root => [root, ...(index.children.get(root.id) || [])]).map(pair => {
    const dims = index.aggregates.get(pair.id);
    return <button key={pair.id} title={`${titleOf(pair)} · ${dims.fields.size} nodes with field changes · ${dims.uncertain.size} uncertain`} aria-label={`Locate ${titleOf(pair)}`} aria-pressed={selectedId === pair.id} onClick={() => (onLocate || onSelect)(pair.id)}><span>{kindOf(pair) === 'recording' ? '▤' : '▥'}</span><strong>{titleOf(pair)}</strong><span className="nll-cmp-region-tracks" aria-hidden="true"><i className="p-track">P</i><i className="s-track">S</i></span>{dims.fields.size > 0 && <em>Δ</em>}{dims.order.size > 0 && <em>↕</em>}{dims.oneSided.size > 0 && <em>P/S</em>}{(dims.uncertain.size > 0 || dims.unresolved.size > 0) && <em>?</em>}</button>;
  })}</nav>;
}

function SequenceSide({ side, geometry, sourceMap, aligned, selectedId, onSelect, onToggleCollapse, collapsed, resolution }) {
  const pairFor = entity => sourceMap.get(entity);
  const activate = pair => pair && onSelect(pair.id);
  return <section className={`nll-cmp-sequence cmp-${side}`} style={{ width: geometry.width }} aria-label={`${side} sequence`}>
    <header className="nll-cmp-lanes" style={{ width: geometry.width }}><strong className="nll-cmp-side-name">{side === 'primary' ? 'P · Primary' : 'S · Secondary'}</strong>{geometry.lanes.map(lane => <div key={lane.id} className="nll-cmp-lane" style={{ left: lane.left, width: lane.width }} title={lane.title}><strong>{lane.label}</strong><small>{lane.sub || 'Actor'}</small></div>)}</header>
    <div className="nll-cmp-canvas" style={{ width: geometry.width, height: geometry.height }}>
      <svg className="nll-cmp-svg" width={geometry.width} height={geometry.height} aria-hidden="true">
        {geometry.lanes.map(lane => <line key={lane.id} x1={lane.x} x2={lane.x} y1={0} y2={geometry.height} stroke="#cbd3dc" strokeDasharray="3 5" />)}
        {aligned.rows.filter(row => row[side]?.pair?.id === selectedId).map(row => <rect key={row.y} x={0} y={row.top} width={geometry.width} height={row.height} fill="#e3f1f6" opacity=".65" />)}
        {geometry.bars.map(bar => <rect key={bar.entityId} x={bar.x} y={bar.y} width={bar.width} height={bar.height} rx={2} fill={bar.kind === 'handler' ? '#ecebf6' : '#e3e9ef'} stroke={TONES[bar.tone]} strokeDasharray={bar.open || bar.stopped ? '3 3' : undefined} />)}
        {geometry.waitSegments.map(wait => <rect key={wait.entityId} x={wait.x} y={wait.y} width={wait.width} height={wait.height} fill="#ecebf6" fillOpacity=".7" stroke="#4f4a8a" strokeDasharray="2 4" />)}
        {geometry.serverBars.map(bar => <rect key={bar.entityId} x={bar.x} y={bar.y} width={bar.width} height={bar.height} fill="#e3e9ef" stroke="#939eaa" />)}
        {[...geometry.arrows, ...geometry.localArrows].map(arrow => {
          const color = TONES[arrow.tone], direction = arrow.x2 >= arrow.x1 ? 1 : -1;
          return <g key={arrow.key}>{arrow.self ? <path d={`M ${arrow.x1} ${arrow.y - 9} h 22 v 9 H ${arrow.x2}`} fill="none" stroke={color} /> : <line x1={arrow.x1} x2={arrow.x2} y1={arrow.y} y2={arrow.y} stroke={color} strokeDasharray={arrow.dashed || arrow.kind === 'return' ? '4 3' : undefined} />}<polyline points={`${arrow.x2 - 5 * direction},${arrow.y - 4} ${arrow.x2},${arrow.y} ${arrow.x2 - 5 * direction},${arrow.y + 4}`} fill={geometry.localArrows.includes(arrow) ? 'none' : color} stroke={color} />{arrow.fromDot && <circle cx={arrow.x1} cy={arrow.y} r={3} fill="white" stroke={color} />}</g>;
        })}
      </svg>
      {geometry.rows.map((row, i) => {
        if (row.kind === 'recording') return <button key={`rec-${i}`} className={`nll-cmp-recording ${row.pair ? classes(row.pair, selectedId, resolution, side) : ''}`} style={{ top: row.y - 15 }} data-pair-id={row.pair?.id} onClick={() => activate(row.pair)}>{row.label} <small>Independent clock</small></button>;
        if (row.kind === 'gap') return <span key={`gap-${i}`} className="nll-cmp-elapsed" style={{ top: row.y - 8 }}>{row.label}</span>;
        if (['stop', 'operationEnd', 'orphan', 'unfinished'].includes(row.kind) && geometry.opMap.has(row.entityId)) return <button key={`end-${i}`} className={`${classes(row.pair, selectedId, resolution, side)} nll-cmp-terminal`} style={{ left: geometry.bars.find(bar => bar.entityId === row.entityId)?.labelX || 20, top: row.y - 15, maxWidth: geometry.width - 110 }} data-pair-id={row.pair?.id} onClick={() => activate(row.pair)}>{row.kind === 'unfinished' ? '… End not observed' : row.kind === 'stop' ? '? Observation stopped' : row.kind === 'orphan' ? '? Start not observed' : `→ ${row.entity.outcome}`}</button>;
        return null;
      })}
      {geometry.bars.map(bar => {
        const pair = pairFor(bar.entityId); if (!pair) return null;
        return <div key={bar.entityId} className="nll-cmp-method" style={{ left: bar.labelX, top: bar.labelY, width: Math.max(190, geometry.width - bar.labelX - 10), maxWidth: Math.max(190, geometry.width - bar.labelX - 10) }}><button className={classes(pair, selectedId, resolution, side)} data-pair-id={pair.id} aria-pressed={selectedId === pair.id} title={`${bar.label} · ${bar.component}`} onClick={() => activate(pair)}><strong>{bar.kind === 'handler' ? '↦ ' : ''}{bar.label}</strong>{resolutionLabel(pair, resolution, side) && <em className="nll-cmp-resolution-label">{resolutionLabel(pair, resolution, side)}</em>}<small>{bar.component}{bar.kind === 'handler' ? ` · ${bar.operation.invocation?.dispatch || 'synchronous'} handler` : ''}</small></button>{aligned.index.children.has(pair.id) && <button className="nll-cmp-collapse" aria-label={`${collapsed.has(pair.id) ? 'Expand' : 'Collapse'} ${titleOf(pair)}`} aria-expanded={!collapsed.has(pair.id)} onClick={() => onToggleCollapse?.(pair.id)}>{collapsed.has(pair.id) ? '+' : '−'}</button>}{collapsed.has(pair.id) && <small>{aligned.index.aggregates.get(pair.id).nodes.size - 1} nested nodes hidden</small>}</div>;
      })}
      {[...geometry.arrows, ...geometry.localArrows].map(arrow => {
        const pair = pairFor(arrow.entityId); if (!pair) return null;
        return <button key={arrow.key} className={`${classes(pair, selectedId, resolution, side)} nll-cmp-arrow-label`} data-pair-id={pair.id} title={arrow.title} aria-label={`${side}, ${arrow.title}, ${pairStatus(pair, aligned.index).join(', ')}`} aria-pressed={selectedId === pair.id} style={{ left: Math.min(arrow.x1, arrow.x2) + (arrow.self ? 28 : 6), top: arrow.y - 29, maxWidth: Math.max(190, geometry.width - Math.min(arrow.x1, arrow.x2) - 18), color: TONES[arrow.tone] }} onClick={() => activate(pair)}><strong>{arrow.label}</strong>{resolutionLabel(pair, resolution, side) && <em className="nll-cmp-resolution-label">{resolutionLabel(pair, resolution, side)}</em>}{arrow.sub && <small>{arrow.sub}</small>}</button>;
      })}
      {aligned.rows.filter(row => !row[side] && row[`${side}Gap`]).map(row => {
        const other = row[side === 'primary' ? 'secondary' : 'primary'];
        return <button key={row.y} className={`nll-cmp-gap ${classes(other.pair, selectedId, resolution, side)}`} data-pair-id={other.pair.id} style={{ left: 20, top: row.top + 5, width: geometry.width - 40, height: row.height - 10 }} onClick={() => activate(other.pair)}>{row[`${side}Gap`]}<small>{titleOf(other.pair)}</small></button>;
      })}
    </div>
  </section>;
}

function Aligned(props) {
  const { diff, snapshots, selectedId, onSelect, visibleIds, collapsed, resolution, onToggleCollapse } = props;
  const aligned = useMemo(() => alignedComparison(diff, snapshots, { visibleIds, collapsed }), [diff, snapshots, visibleIds, collapsed]);
  if (!aligned.primary) return <p className="nll-cmp-empty">Source snapshots are unavailable for sequence geometry.</p>;
  const marks = new Map();
  for (const row of aligned.rows) for (const side of ['primary', 'secondary']) if (row[side]?.pair && !marks.has(row[side].pair.id)) marks.set(row[side].pair.id, row.y);
  return <div className="nll-cmp-aligned" style={{ minWidth: aligned.primary.width + aligned.secondary.width + 56 }}>
    <SequenceSide {...props} side="primary" geometry={aligned.primary} sourceMap={aligned.sourceMaps.primary} aligned={aligned} />
    <div className="nll-cmp-gutter" style={{ height: aligned.height + 98 }}><header>Diff</header>{[...marks].map(([id, y]) => {
      const pair = aligned.index.pairs.get(id), statuses = pairStatus(pair, aligned.index);
      return <button key={id} className={classes(pair, selectedId, resolution)} style={{ top: y + 82 }} title={statuses.join(' · ')} aria-label={`Inspect ${titleOf(pair)}: ${statuses.join(', ')}`} data-pair-id={id} aria-pressed={selectedId === id} onClick={() => onSelect(id)}>{pair.presence === 'primary_only' ? 'P' : pair.presence === 'secondary_only' ? 'S' : pair.presence === 'unresolved' ? '?' : pair.changes.length ? 'Δ' : aligned.index.orders.has(id) ? '↕' : pair.equivalence === 'unknown' ? '?' : '='}</button>;
    })}</div>
    <SequenceSide {...props} side="secondary" geometry={aligned.secondary} sourceMap={aligned.sourceMaps.secondary} aligned={aligned} />
  </div>;
}

function Outline({ index, selectedId, onSelect, visibleIds, collapsed, resolution, onToggleCollapse }) {
  const rows = visibleTree(index, visibleIds, collapsed);
  return <div className="nll-cmp-outline"><div className="nll-cmp-outline-head"><span>Shared ancestry / correspondence</span><span>P position</span><span>S position</span><span>Independent change dimensions</span></div>{rows.map(({ pair, depth, hiddenCount }) => {
    const dims = index.aggregates.get(pair.id), hasChildren = index.children.has(pair.id);
    return <div key={pair.id} className={`${classes(pair, selectedId, resolution)} nll-cmp-outline-row`}><div className="nll-cmp-outline-name" style={{ paddingLeft: 12 + depth * 18 }}>{hasChildren ? <button className="nll-cmp-collapse" aria-expanded={!collapsed.has(pair.id)} aria-label={`${collapsed.has(pair.id) ? 'Expand' : 'Collapse'} ${titleOf(pair)}`} onClick={() => onToggleCollapse?.(pair.id)}>{collapsed.has(pair.id) ? '▸' : '▾'}</button> : <span className="nll-cmp-leaf">·</span>}<button className="nll-cmp-outline-select" data-pair-id={pair.id} aria-pressed={selectedId === pair.id} onClick={() => onSelect(pair.id)}><strong>{titleOf(pair)}</strong><small>{kindOf(pair)} · {pair.matching.basis.replaceAll('_', ' ')}{hiddenCount ? ` · ${hiddenCount} nested nodes hidden` : ''}</small></button></div><span className="nll-cmp-position">{positionLabel(pair.primary)}</span><span className="nll-cmp-position">{positionLabel(pair.secondary)}</span><div className="nll-cmp-outline-dimensions"><Badges pair={pair} index={index} />{resolutionLabel(pair, resolution) && <em className="nll-cmp-resolution-label">{resolutionLabel(pair, resolution)}</em>}{hasChildren && <small className="nll-cmp-aggregates">Subtree: {dims.nodes.size} nodes · {dims.fields.size} field-changed{subtreeDimensionLabels(dims).length > 0 ? ` · ${subtreeDimensionLabels(dims).join(' · ')}` : ''} · {dims.order.size} order-affected · {dims.oneSided.size} one-sided · {dims.unresolved.size} unresolved · {dims.uncertain.size} uncertain</small>}</div></div>;
  })}<p className="nll-cmp-layout-note">Call positions are original event sequence numbers within each recording; recording labels use recording ordinals. Subtree counts are unique nodes per dimension; dimensions overlap.</p></div>;
}

function Connections({ index, diff, selectedId, onSelect, visibleIds, collapsed, resolution, onToggleCollapse }) {
  const primary = orderedSide(index, 'primary', visibleIds, collapsed), secondary = orderedSide(index, 'secondary', visibleIds, collapsed);
  const height = Math.max(primary.length, secondary.length) * 72 + 30, center = 260, positions = { primary: new Map(primary.map((row, i) => [row.pair.id, 36 + i * 72])), secondary: new Map(secondary.map((row, i) => [row.pair.id, 36 + i * 72])) };
  const related = new Set([selectedId, ...(index.orders.get(selectedId) || []).flatMap(order => [order.first_pair_id, order.second_pair_id])]);
  return <div className="nll-cmp-connections"><div className="nll-cmp-order-head"><strong>P · Primary original order</strong><span>Correspondence</span><strong>S · Secondary original order</strong></div><div className="nll-cmp-order-body" style={{ height }}><svg className="nll-cmp-links" width={900} height={height} aria-label="Correspondence links. Crossings alone do not imply causality.">
    {primary.filter(({ pair }) => positions.secondary.has(pair.id)).map(({ pair }) => {
      const orders = index.orders.get(pair.id) || [], type = orders.some(order => order.interpretation === 'reordered') ? 'reordered' : orders.some(order => order.interpretation === 'concurrency_changed') ? 'concurrency_changed' : orders.length ? 'observed_order_only' : 'correspondence';
      return <path key={pair.id} className={`nll-cmp-link ${type} ${selectedId && !related.has(pair.id) ? 'is-dimmed' : ''} ${resolutionClass(pair, resolution)} ${selectedId === pair.id ? 'is-selected' : ''}`} d={`M 310 ${positions.primary.get(pair.id)} C ${310 + center} ${positions.primary.get(pair.id)}, ${590 - center} ${positions.secondary.get(pair.id)}, 590 ${positions.secondary.get(pair.id)}`} fill="none"><title>{titleOf(pair)} · {ORDER_LABELS[type] || 'Matched correspondence'}</title></path>;
    })}</svg>{['primary', 'secondary'].map(side => <div className={`nll-cmp-order-side cmp-${side}`} key={side}>{(side === 'primary' ? primary : secondary).map(({ pair, depth }, i) => <div key={pair.id} className={`${classes(pair, selectedId, resolution, side)} nll-cmp-order-node`} style={{ top: i * 72, paddingLeft: 6 + Math.min(depth, 5) * 8 }}><button data-pair-id={pair.id} className="nll-cmp-order-select" aria-pressed={selectedId === pair.id} title={titleOf(pair)} onClick={() => onSelect(pair.id)}><span className="nll-cmp-position">{positionLabel(pair[side])} · {kindOf(pair)}</span><strong>{titleOf(pair)}</strong><small>{pairStatus(pair, index).join(' · ')}{resolutionLabel(pair, resolution, side) ? ` · ${resolutionLabel(pair, resolution, side)}` : ''}</small></button>{index.children.has(pair.id) && <button className="nll-cmp-collapse" aria-expanded={!collapsed.has(pair.id)} aria-label={`${collapsed.has(pair.id) ? 'Expand' : 'Collapse'} ${titleOf(pair)}`} onClick={() => onToggleCollapse?.(pair.id)}>{collapsed.has(pair.id) ? '+' : '−'}</button>}</div>)}</div>)}</div><p className="nll-cmp-layout-note">Solid purple: confirmed reorder. Dashed purple: concurrency changed. Dotted gray: observed order only. Crossings show correspondence; they do not establish causality across recordings.</p><div className="nll-cmp-relationships" aria-label="Order relationships">{diff.order_changes.filter(order => !visibleIds || visibleIds.has(order.first_pair_id) || visibleIds.has(order.second_pair_id)).map((order, i) => <button key={i} onClick={() => onSelect(order.first_pair_id)}><strong>↕ {ORDER_LABELS[order.interpretation]}</strong><span>{titleOf(index.pairs.get(order.first_pair_id))} ↔ {titleOf(index.pairs.get(order.second_pair_id))}</span><small>P: {order.primary_relation} · S: {order.secondary_relation}</small></button>)}</div></div>;
}

export default function ComparisonLayouts({ diff, snapshots, layout = 'aligned', selectedId, onSelect, visibleIds, collapsed = EMPTY, onToggleCollapse, resolution, onLocate }) {
  const host = useRef(null), index = useMemo(() => comparisonIndex(diff), [diff]);
  const props = { diff, snapshots, index, selectedId, onSelect, visibleIds, collapsed, onToggleCollapse, resolution };
  useEffect(() => {
    const scroller = host.current?.querySelector('.nll-cmp-layout-scroll');
    const item = [...(scroller?.querySelectorAll('[data-pair-id]') || [])].find(element => element.dataset.pairId === selectedId);
    if (!item || !scroller) return;
    // Scroll this diagram only; keep comparison identities and shared controls stable.
    const bounds = scroller.getBoundingClientRect(), rect = item.getBoundingClientRect();
    const stickyHeight = layout === 'aligned' ? 98 : layout === 'outline' ? 38 : 44;
    if (rect.top < bounds.top + stickyHeight) scroller.scrollTop -= bounds.top + stickyHeight - rect.top;
    else if (rect.bottom > bounds.bottom) scroller.scrollTop += rect.bottom - bounds.bottom;
    if (rect.left < bounds.left) scroller.scrollLeft -= bounds.left - rect.left;
    else if (rect.right > bounds.right) scroller.scrollLeft += rect.right - bounds.right;
  }, [selectedId, layout, visibleIds, collapsed, diff]);
  const shown = visibleTree(index, visibleIds, collapsed).length;
  return <div className="nll-cmp-layouts" data-layout={layout} ref={host}><Overview index={index} selectedId={selectedId} onSelect={onSelect} onLocate={onLocate} /><div className="nll-cmp-layout-scroll" tabIndex={0} role="group" aria-label={`${layout} comparison. Pan horizontally to read both sessions.`}>{!shown ? <p className="nll-cmp-empty">No pairs match these presentation filters. The snapshot and comparison are unchanged.</p> : layout === 'outline' ? <Outline {...props} /> : layout === 'connections' ? <Connections {...props} /> : <Aligned {...props} />}</div></div>;
}
