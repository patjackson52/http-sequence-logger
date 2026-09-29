import React, { useEffect, useId, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { filterSessionItems } from './model.mjs';
import { layoutSequence, OWNER_LABELS, durationLabel } from './layout.mjs';
import { sequenceSVG, svgFilename } from './export-svg.mjs';
import './sequence.css';

const COLORS = { neutral: '#5b6673', ok: '#1f7a4d', error: '#b9382c', warning: '#8a5a00', local: '#4f4a8a' };
const EMPTY_SET = new Set();
function Arrow({ arrow, local, selected, register, onSelect }) {
  const color = selected ? '#1b6f8f' : COLORS[arrow.tone] || '#1b2430';
  const direction = arrow.self ? -1 : arrow.x2 >= arrow.x1 ? 1 : -1;
  const head = `${arrow.x2 - 6 * direction},${arrow.y - 4} ${arrow.x2},${arrow.y} ${arrow.x2 - 6 * direction},${arrow.y + 4}`;
  const hitX = Math.min(arrow.x1, arrow.x2) - 8;
  const activate = () => onSelect?.(arrow.entityId);
  return <g ref={(element) => register(arrow.key, element)} className="nll-seq-target" role="button" tabIndex={0} data-sequence-key={arrow.key} data-entity-id={arrow.entityId} aria-label={arrow.title} aria-pressed={selected} onClick={activate} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); } }}>
    <title>{arrow.title}</title>
    <rect className="nll-seq-hit" x={hitX} y={arrow.y - 29} width={Math.max(100, Math.abs(arrow.x2 - arrow.x1) + 16)} height={42} rx={4} fill={selected ? '#e3f1f6' : 'transparent'} />
    {arrow.self ? <path d={`M ${arrow.x1} ${arrow.y - 9} h 22 v 9 H ${arrow.x2}`} fill="none" stroke={color} strokeWidth={selected ? 2.5 : 1.5} strokeDasharray={arrow.kind === 'return' ? '4 3' : undefined} /> : <line x1={arrow.x1} x2={arrow.x2} y1={arrow.y} y2={arrow.y} stroke={color} strokeWidth={selected ? 2.5 : 1.5} strokeDasharray={arrow.dashed || arrow.kind === 'return' ? '4 3' : undefined} />}
    {local ? <polyline points={head} fill="none" stroke={color} strokeWidth={selected ? 2.5 : 1.5} /> : <polygon points={head} fill={color} />}
    {arrow.fromDot && <circle cx={arrow.x1} cy={arrow.y} r={3} fill="#fafbfc" stroke={color} strokeWidth={1.5} />}
  </g>;
}

export default function Sequence({ exportRef, session, filters = {}, collapsed = EMPTY_SET, expandedOwners = EMPTY_SET, selectedId = null, onSelect, onToggleCollapse, onToggleOwner, onClose, onToggleHttpOnly }) {
  const refs = useRef(new Map());
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 719px)').matches);
  useEffect(() => { const query = window.matchMedia('(max-width: 719px)'); const change = () => setMobile(query.matches); query.addEventListener('change', change); return () => query.removeEventListener('change', change); }, []);
  const prefix = useId().replace(/:/g, '');
  const projection = useMemo(() => filterSessionItems(session, filters), [session, filters]);
  const layout = useMemo(() => layoutSequence(session, { visibleIds: projection.visibleIds, kind: filters.kind, recordingId: filters.recordingId, collapsed, expandedOwners, laneWidth: mobile ? 136 : 164 }), [session, projection, filters.kind, filters.recordingId, collapsed, expandedOwners, mobile]);
  useImperativeHandle(exportRef, () => ({ exportSVG: () => ({ svg: sequenceSVG(layout, { name: session.name, selectedId }), filename: svgFilename(session.name) }) }), [layout, session.name, selectedId]);
  const register = (key, element) => { if (element) refs.current.set(key, element); else refs.current.delete(key); };
  const selectAndFocus = (item) => { if (!item) return; onSelect?.(item.id, { open: false }); const element = refs.current.get(item.key); element?.focus({ preventScroll: true }); element?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); };
  const onKeyDown = (event) => {
    if (event.target.closest?.('button') && ['Enter', ' '].includes(event.key)) return;
    const key = event.target.closest?.('[data-sequence-key]')?.getAttribute('data-sequence-key');
    const index = Math.max(0, layout.navigationItems.findIndex((item) => key ? item.key === key : item.id === selectedId));
    const current = layout.navigationItems[index];
    if (['ArrowDown', 'j', 'ArrowUp', 'k'].includes(event.key)) { event.preventDefault(); selectAndFocus(layout.navigationItems[Math.max(0, Math.min(layout.navigationItems.length - 1, index + (['ArrowDown', 'j'].includes(event.key) ? 1 : -1)))]); }
    else if (event.key === 'ArrowRight') {
      event.preventDefault(); const entity = layout.entityMap.get(current?.id || selectedId);
      const next = current?.kind === 'call' ? layout.navigationItems.find((item) => item.id === entity?.id && item.kind === 'operation') : layout.navigationItems.find((item) => { const child = layout.entityMap.get(item.id); return child?.parentScope === 'local' && child.parentId === entity?.id; });
      selectAndFocus(next);
    } else if (event.key === 'ArrowLeft') { event.preventDefault(); const entity = layout.entityMap.get(current?.id || selectedId); if (entity?.parentScope === 'local') selectAndFocus(layout.navigationItems.find((item) => item.id === entity.parentId)); }
    else if (event.key === '[' || event.key === ']') { const id = current?.id || selectedId; if (layout.opMap.has(id) && collapsed.has(id) !== (event.key === '[')) { event.preventDefault(); onToggleCollapse?.(id); } }
    else if (event.key === 'Enter' && event.target === event.currentTarget) { event.preventDefault(); if (selectedId || current?.id) onSelect?.(selectedId || current.id); }
    else if (event.key === 'Escape') { event.preventDefault(); onClose?.(); }
    else if (event.key === 'h') { event.preventDefault(); onToggleHttpOnly?.(); }
  };
  const relatedIds = new Set(); let related = layout.entityMap.get(selectedId); const seen = new Set();
  while (related && !seen.has(related.id)) { seen.add(related.id); relatedIds.add(related.id); related = related.parentScope === 'local' ? layout.opMap.get(related.parentId) : null; }
  return <div className="nll-sequence" role="group" tabIndex={0} aria-label="Sequence diagram. Event order, not a duration scale. Arrow keys or j and k move between rows. Enter opens details; Escape closes details. Left and right navigate caller and children. Brackets collapse or expand methods; h toggles HTTP only." onKeyDown={onKeyDown} style={{ width: layout.width, minWidth: '100%' }}>
    <div className="nll-seq-header" style={{ width: layout.width }}>
      <div className="nll-seq-mobile-band" style={{ left: layout.clientGroup.x, width: layout.clientGroup.width }}>Client</div>
      {layout.lanes.map((lane) => <div key={lane.id} className={`nll-seq-lane ${lane.muted ? 'is-muted' : ''}`} tabIndex={0} title={lane.title} aria-label={lane.title} style={{ left: lane.left, width: lane.width }}>
        <strong>{lane.label}</strong><span>{lane.sub || 'No components recorded'}</span>
      </div>)}
      {layout.ownerGroups.map((group) => <button key={group.owner} className="nll-seq-owner-toggle" style={{ left: group.x + 4, width: group.width - 8 }} onClick={() => onToggleOwner?.(group.owner)} aria-expanded={group.expanded} aria-label={`${group.expanded ? 'Collapse' : 'Expand'} ${group.label} components`}>{group.expanded ? '−' : '+'} {group.expanded ? `${group.label} components` : 'components'}</button>)}
    </div>
    <div className="nll-seq-canvas" style={{ width: layout.width, height: layout.height }}>
      <svg width={layout.width} height={layout.height} className="nll-seq-svg" aria-label="Request and local invocation sequence">
        <defs><pattern id={`${prefix}-waiting`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" x2="0" y1="0" y2="6" stroke="#4f4a8a" strokeWidth="1.5" opacity=".45" /></pattern></defs>
        <rect x={layout.clientGroup.x} width={layout.clientGroup.width} height={layout.height} fill="#f1f4f7" />
        {layout.lanes.map((lane) => <line key={lane.id} x1={lane.x} x2={lane.x} y1={0} y2={layout.height} stroke="#d5dbe2" opacity={lane.muted ? .45 : 1} />)}
        {layout.rows.filter((row) => row.kind === 'recording').map((row) => <rect key={row.recording.id} y={row.y - row.height / 2} width={layout.width} height={row.height} fill={row.recording.incomplete ? '#fff3d6' : '#edf1f5'} />)}
        {layout.rows.filter((row) => row.kind === 'gap').map((row) => <line key={row.y} x1={8} x2={layout.width - 8} y1={row.y} y2={row.y} stroke="#c9d1da" strokeDasharray="2 4" />)}
        {layout.serverBars.map((bar) => <rect key={bar.entityId} x={bar.x} y={bar.y} width={bar.width} height={bar.height} fill={bar.open ? '#fafbfc' : '#e8edf2'} stroke={bar.entityId === selectedId ? '#1b6f8f' : '#a4afba'} strokeDasharray={bar.open ? '3 3' : undefined} />)}
        {layout.bars.map((bar) => {
          const selected = bar.entityId === selectedId, related = relatedIds.has(bar.entityId), color = related ? '#1b6f8f' : COLORS[bar.tone];
          const status = bar.open ? 'no end recorded' : bar.stopped ? 'observation stopped; exit not observed' : bar.operation.completion || bar.operation.outcome;
          const label = `${bar.kind === 'handler' ? 'Handler' : 'Method'} ${bar.label} on ${OWNER_LABELS[bar.operation.owner] || bar.operation.owner}, ${status}${bar.operation.durationMs != null ? `, ${durationLabel(bar.operation.durationMs)} elapsed` : ''}. Contains ${bar.counts.requests} requests and ${bar.counts.calls} calls. ${bar.collapsed ? 'Collapsed' : 'Expanded'}. Span ${bar.operation.spanId}. Select ${bar.kind === 'handler' ? 'invocation' : 'method'}.`;
          return <g key={bar.entityId} ref={(element) => register(`${bar.entityId}:operation`, element)} className="nll-seq-target" role="button" tabIndex={0} data-sequence-key={`${bar.entityId}:operation`} data-entity-id={bar.entityId} aria-label={label} aria-pressed={selected} onClick={() => onSelect?.(bar.entityId)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect?.(bar.entityId); } }}>
            <title>{label}</title><rect className="nll-seq-hit" x={bar.x - 5} y={bar.y} width={Math.min(320, layout.width - bar.x - 12)} height={38} fill={selected ? '#e3f1f6' : 'transparent'} rx={4} />
            <rect x={bar.x} y={bar.y} width={bar.width} height={bar.height} rx={3} fill={bar.kind === 'handler' ? '#ecebf6' : '#e3e9ef'} stroke={color} strokeWidth={related ? 2.5 : 1.2} strokeDasharray={bar.open || bar.stopped ? '3 3' : undefined} />
          </g>;
        })}
        {layout.waitSegments.map((wait) => <g key={wait.entityId} aria-hidden="true" onClick={() => onSelect?.(wait.entityId)} className="nll-seq-wait"><rect x={wait.x} y={wait.y} width={wait.width} height={wait.height} fill={`url(#${prefix}-waiting)`} stroke={wait.entityId === selectedId ? '#1b6f8f' : 'none'} /></g>)}
        {layout.arrows.map((arrow) => <Arrow key={arrow.key} arrow={arrow} selected={arrow.entityId === selectedId} register={register} onSelect={onSelect} />)}
        {layout.localArrows.map((arrow) => <Arrow key={arrow.key} arrow={arrow} local selected={arrow.entityId === selectedId} register={register} onSelect={onSelect} />)}
        {layout.ancestryPills.map((pill) => <line key={pill.entityId} x1={pill.x} x2={pill.x} y1={pill.y} y2={pill.y + pill.height} stroke="#4f4a8a" strokeWidth={4} />)}
      </svg>
      <div className="nll-seq-labels">
        {layout.rows.map((row, index) => {
          if (row.kind === 'recording') return <div key={`row-${index}`} className="nll-seq-recording" style={{ top: row.y - 11 }}><strong>{row.label}</strong><span>{row.sub}</span></div>;
          if (row.kind === 'gap') return <div key={`row-${index}`} className="nll-seq-gap" style={{ top: row.y - 8 }}>{row.label}</div>;
          if (row.kind === 'orphan') return <button key={`row-${index}`} ref={(element) => register(`${row.entityId}:orphan`, element)} data-sequence-key={`${row.entityId}:orphan`} className="nll-seq-orphan" style={{ top: row.y - 14 }} onClick={() => onSelect?.(row.entityId)}>Operation end observed · start not recorded · {row.entity.outcome}</button>;
          if (['stop', 'operationEnd'].includes(row.kind) || row.kind === 'unfinished' && layout.opMap.has(row.entityId)) {
            const bar = layout.bars.find((b) => b.entityId === row.entityId); if (!bar) return null;
            const label = row.kind === 'stop' ? `? observation stopped · ${row.entity.end?.extensions?.['capture.observation_stop_reason'] || 'reason not recorded'} · —` : row.kind === 'unfinished' ? '… no operation.ended' : `${row.entity.method || row.entity.name} → ${row.entity.outcome}${row.entity.durationMs != null ? ` · ${durationLabel(row.entity.durationMs)}` : ''}`;
            return <div key={`row-${index}`} className={`nll-seq-end-label ${row.kind === 'operationEnd' ? '' : 'is-warning'}`} style={{ left: bar.labelX, top: row.y - 8, maxWidth: layout.width - bar.labelX - 16 }}>{label}</div>;
          }
          return null;
        })}
        {layout.bars.map((bar) => <div key={bar.entityId} className="nll-seq-method-label" style={{ left: bar.labelX, top: bar.labelY, maxWidth: Math.min(350, layout.width - bar.labelX - 16) }}>
          <span className={bar.kind === 'handler' ? 'is-local' : ''}>{bar.label}{bar.kind === 'handler' ? ' · handler' : ''}</span>
          <button className="nll-seq-collapse" onClick={() => onToggleCollapse?.(bar.entityId)} aria-label={`${bar.collapsed ? 'Expand' : 'Collapse'} ${bar.label}`} aria-expanded={!bar.collapsed}>{bar.collapsed ? '+' : '−'}</button>
          <small>{bar.component}{bar.kind === 'handler' && bar.operation.invocation?.caller ? ` ← ${bar.operation.invocation.caller.component}.${bar.operation.invocation.caller.method || '(method)'}` : ''}</small>
          {bar.collapsed && <em>{bar.counts.requests} requests · {bar.counts.calls} calls hidden</em>}
        </div>)}
        {[...layout.arrows, ...layout.localArrows].map((arrow) => <div key={arrow.key} className={`nll-seq-arrow-label ${arrow.entityId === selectedId ? 'is-selected' : ''}`} aria-hidden="true" style={{ left: Math.min(arrow.x1, arrow.x2) + (arrow.self ? 28 : 8), top: arrow.y - 27, maxWidth: Math.max(190, Math.min(600, layout.width - Math.min(arrow.x1, arrow.x2) - 32)), color: COLORS[arrow.tone] }}><strong>{arrow.label}</strong>{arrow.sub && <small>{arrow.sub}</small>}</div>)}
        {layout.waitSegments.map((wait) => <span key={wait.entityId} className="nll-seq-wait-label" aria-hidden="true" style={{ left: wait.x + 20, top: wait.y + 9 }}>{wait.label}</span>)}
        {layout.ancestryPills.map((pill) => <button key={pill.entityId} ref={(element) => register(`${pill.entityId}:ancestry`, element)} data-sequence-key={`${pill.entityId}:ancestry`} className="nll-seq-ancestry" style={{ left: pill.x + 10, top: pill.y - 13 }} onClick={() => onSelect?.(pill.entityId)} aria-pressed={pill.entityId === selectedId}>{pill.label}</button>)}
      </div>
    </div>
    {layout.navigationItems.length === 0 && <div className="nll-seq-empty">No events match these filters.</div>}
  </div>;
}
