import React, { useId, useState } from 'react';
import './comparison-inspector.css';

const TABS = ['Changes', 'Request', 'Response', 'Context', 'Evidence'];
const SIDES = ['primary', 'secondary'];
const words = value => String(value).replaceAll('_', ' ');
const own = (value, key) => value != null && Object.hasOwn(value, key);
const observed = (value, key) => ({ present: own(value, key), value: own(value, key) ? value[key] : null });

/** Preserve absence and all recorded JSON values, including false, zero and null. */
export function pairedValueText(observation) {
  if (!observation?.present) return 'Absent · not observed';
  if (observation.value === null) return 'null';
  if (observation.value === '') return '"" · empty string';
  return JSON.stringify(observation.value, null, 2);
}

/** Resolve exact canonical pointers and check IDs; never substitute a nearby event. */
export function sourceEvidence(reference, snapshot) {
  if (!reference) return [];
  const document = snapshot?.document || snapshot?.sequence;
  return Array.from({ length: Math.max(reference.event_pointers.length, reference.event_ids.length) }, (_, index) => {
    const pointer = reference.event_pointers[index];
    const match = /^\/events\/(0|[1-9]\d*)$/.exec(pointer);
    const event = match ? document?.events?.[Number(match[1])] : null;
    const eventId = reference.event_ids[index];
    const valid = !!event && event.event_id === eventId && event.recording_id === reference.recording_id &&
      event.session_namespace === document.session.namespace && event.session_id === document.session.id;
    const entry = (snapshot?.evidence || snapshot?.sources)?.[eventId];
    const original = Array.isArray(entry) ? entry[0] : entry;
    return { pointer, eventId, event: valid ? event : null, valid, original };
  });
}

export function findingFor(pair, diff, snapshots) {
  return {
    finding_format: 'network-log-lab-finding-1.0',
    pair_id: pair.id, engine: diff.engine, inputs: diff.inputs, profile: diff.profile, scope: diff.scope,
    presence: pair.presence, equivalence: pair.equivalence, matching: pair.matching,
    changes: pair.changes, uncertainties: pair.uncertainties, ignored_paths: pair.ignored_paths,
    order_changes: diff.order_changes.filter(order => order.first_pair_id === pair.id || order.second_pair_id === pair.id),
    sources: Object.fromEntries(SIDES.map(side => [side, {
      snapshot_id: snapshots?.[side]?.id ?? null,
      scope: snapshots?.[side]?.scope ?? null,
      boundary: snapshots?.[side]?.boundary ?? null,
      reference: pair[side],
      evidence: sourceEvidence(pair[side], snapshots?.[side]).map(({ pointer, eventId, valid }) => ({ pointer, event_id: eventId, verified: valid }))
    }]))
  };
}

function CopyFinding({ pair, diff, snapshots }) {
  const [state, setState] = useState('');
  return <div className="actions"><button onClick={async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(findingFor(pair, diff, snapshots), null, 2)); setState('Finding copied'); }
    catch { setState('Clipboard unavailable. Select and copy the finding below.'); }
  }}>Copy finding</button><span role="status">{state}</span>{state.startsWith('Clipboard') && <pre tabIndex={0}>{JSON.stringify(findingFor(pair, diff, snapshots), null, 2)}</pre>}</div>;
}

function PairedValue({ title, values, dimension }) {
  return <section className="paired-field"><header><code>{title || '/'}</code>{dimension && <span className="pair-dimension">Δ {dimension}</span>}</header>
    <div className="paired-values">{SIDES.map(side => <div className={`paired-value ${side}`} key={side}><span className="pair-side-label">{side}</span><pre>{pairedValueText(values[side])}</pre></div>)}</div>
  </section>;
}

function SourceSummary({ reference, events }) {
  const terminal = events.find(e => e.event_type === 'http.ended' || e.event_type === 'operation.ended' || e.event_type === 'session.ended');
  const response = events.find(e => e.event_type === 'http.response.headers' && e.data.phase === 'final');
  return <><strong>{reference?.label || 'No counterpart'}</strong>{reference && <small>Original position {reference.position} · {reference.kind}</small>}
    <small>Execution: {terminal ? words(terminal.data.outcome ?? terminal.data.completion ?? terminal.data.reason ?? 'terminal event observed') : reference ? 'terminal completion not observed' : 'no counterpart'}{response ? ` · HTTP ${response.data.response.status_code}` : ''}</small></>;
}

function RawPairedEvents({ title, events, select }) {
  const chosen = Object.fromEntries(SIDES.map(side => [side, events[side].filter(select)]));
  const count = Math.max(chosen.primary.length, chosen.secondary.length);
  return <section><h3>{title}</h3>{count ? Array.from({ length: count }, (_, index) => <PairedValue key={index} title={`${title} ${index + 1}`} values={Object.fromEntries(SIDES.map(side => [side, { present: !!chosen[side][index], value: chosen[side][index]?.data ?? null }]))} />) : <p className="muted">No observation captured on either side.</p>}</section>;
}

export default function PairInspector({ pair, diff, snapshots, tab = 'Changes', onTab, onClose, onResolve, onLocate }) {
  const id = useId();
  const selectedTab = TABS.includes(tab) ? tab : 'Changes';
  const evidence = Object.fromEntries(SIDES.map(side => [side, sourceEvidence(pair[side], snapshots?.[side])]));
  const events = Object.fromEntries(SIDES.map(side => [side, evidence[side].flatMap(item => item.event ? [item.event] : [])]));
  const order = diff.order_changes.filter(item => item.first_pair_id === pair.id || item.second_pair_id === pair.id);
  const parent = diff.pairs.find(item => item.id === pair.parent_pair_id);
  const request = Object.fromEntries(SIDES.map(side => [side, events[side].find(e => e.event_type === 'http.request.started')?.data]));
  const invalidReferences = SIDES.some(side => evidence[side].some(item => !item.valid));
  function tabKey(event, index) {
    const next = event.key === 'ArrowRight' ? (index + 1) % TABS.length : event.key === 'ArrowLeft' ? (index + TABS.length - 1) % TABS.length : event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : null;
    if (next !== null) { event.preventDefault(); onTab?.(TABS[next]); event.currentTarget.parentElement.children[next].focus(); }
  }
  return <div className="pair-inspector" role="region" aria-label="Paired details inspector">
    <header className="pair-inspector-head"><button onClick={onClose} aria-label="Close paired inspector">×</button><div><h2>{pair.primary?.label || pair.secondary?.label}</h2><code>{pair.id}</code></div></header>
    <div className="pair-status"><span className={`pair-pill ${pair.presence}`}>{words(pair.presence)}</span><span className={`pair-pill ${pair.equivalence}`}>{pair.equivalence === 'equal' ? '= Fields equal within rules' : pair.equivalence === 'different' ? 'Δ Observed difference' : '? Unknown equivalence'}</span><span>Match: {words(pair.matching.basis)} · {pair.matching.confidence}</span></div>
    <div className="pair-source-summary">{SIDES.map(side => <div key={side} className={side}><span className="pair-side-label">{side}</span><SourceSummary reference={pair[side]} events={events[side]} /></div>)}</div>
    {invalidReferences && <p className="notice error" role="alert">Source reference integrity failed. Missing or mismatched evidence is unavailable; this finding cannot be verified.</p>}
    <div role="tablist" aria-label="Paired inspector views" className="tabs">{TABS.map((name, index) => <button key={name} id={`${id}-tab-${name}`} role="tab" aria-controls={`${id}-panel`} aria-selected={selectedTab === name} tabIndex={selectedTab === name ? 0 : -1} onClick={() => onTab?.(name)} onKeyDown={event => tabKey(event, index)}>{name}</button>)}</div>
    <div id={`${id}-panel`} className="pair-inspector-content" role="tabpanel" aria-labelledby={`${id}-tab-${selectedTab}`} tabIndex={0}>
      {selectedTab === 'Changes' && <>
        {pair.presence !== 'both' && <section className="pair-uncertainty"><p>{pair.presence === 'unresolved' ? 'Correspondence is unresolved. Unknown observations cannot establish absence.' : 'This node has no corresponding node in the other snapshot.'}</p>{onResolve && <button onClick={() => onResolve(pair)}>Resolve match…</button>}</section>}
        <section><h3>Field changes · {pair.changes.length}</h3>{pair.changes.map((change, index) => <PairedValue key={`${change.path}-${index}`} title={change.path} dimension={change.dimension} values={change} />)}{!pair.changes.length && <p className="muted">No observed field differences. This does not imply complete capture or unchanged descendants.</p>}</section>
        <section><h3>Unknown observations · {pair.uncertainties.length}</h3>{pair.uncertainties.map((item, index) => <p className="pair-uncertainty" key={index}><code>{item.path || '/'}</code> · {words(item.reason)}</p>)}{!pair.uncertainties.length && <p className="muted">No uncertainty reported for this pair.</p>}</section>
        <section><h3>Sibling order relationships · {order.length}</h3>{order.map((item, index) => <div key={index} className="pair-order"><strong>↔ {words(item.interpretation)}</strong><p>{item.first_pair_id} → {item.second_pair_id}: Primary {item.primary_relation}; Secondary {item.secondary_relation}</p><button onClick={() => onLocate?.(item.first_pair_id === pair.id ? item.second_pair_id : item.first_pair_id)}>Locate related pair</button></div>)}<p className="muted">Positions follow each recording. Observed start order and crossings alone do not prove causal reordering.</p></section>
        <section><h3>Excluded by profile</h3>{pair.ignored_paths.length ? <ul>{pair.ignored_paths.map(path => <li key={path}><code>{path || '/ (whole projection)'}</code></li>)}</ul> : <p className="muted">No projected paths excluded for this pair.</p>}<p>Ignored headers: {diff.profile.ignore_headers.join(', ') || 'none'}</p></section>
        <details><summary>Captured context, including unchanged values</summary><RawPairedEvents title="Start metadata" events={events} select={event => event.event_type.endsWith('.started')} /></details>
      </>}
      {selectedTab === 'Request' && <><PairedValue title="Request metadata, URL, repeated headers" values={Object.fromEntries(SIDES.map(side => [side, observed(request[side], 'request')]))} /><RawPairedEvents title="Request body capture" events={events} select={event => event.event_type === 'http.body.captured' && event.data.direction === 'request'} /><RawPairedEvents title="Local invocation" events={events} select={event => event.event_type === 'operation.started'} /><p className="muted">Values are preserved as recorded. Absent, null, empty strings, redacted and truncated captures remain distinct. Local arguments are not captured.</p></>}
      {selectedTab === 'Response' && <><RawPairedEvents title="Response metadata and headers" events={events} select={event => event.event_type === 'http.response.headers'} /><RawPairedEvents title="Response body capture" events={events} select={event => event.event_type === 'http.body.captured' && event.data.direction === 'response'} /><RawPairedEvents title="Trailers" events={events} select={event => event.event_type === 'http.trailers'} /><RawPairedEvents title="Terminal execution outcome" events={events} select={event => event.event_type === 'http.ended' || event.event_type === 'operation.ended' || event.event_type === 'session.ended'} /><p className="muted">Header arrival does not establish successful completion. Local business return values are not captured.</p></>}
      {selectedTab === 'Context' && <><section><h3>Correspondence</h3><p>{words(pair.matching.basis)} · confidence {pair.matching.confidence}</p><p className="muted">Exact matching describes source identity or a unique key, not equivalent behavior.</p>{pair.matching.candidate_node_ids.length > 0 && <pre>{JSON.stringify(pair.matching.candidate_node_ids, null, 2)}</pre>}{pair.presence !== 'both' && onResolve && <button onClick={() => onResolve(pair)}>Resolve match…</button>}</section><PairedValue title="Source identity and ancestry" values={Object.fromEntries(SIDES.map(side => [side, { present: !!pair[side], value: pair[side] }]))} />{parent && <button onClick={() => onLocate?.(parent.id)}>Open paired ancestor · {parent.primary?.label || parent.secondary?.label}</button>}<section><h3>Locate in layout</h3><div className="actions">{['aligned', 'outline', 'connections'].map(layout => <button key={layout} onClick={() => onLocate?.(pair.id, layout)}>{layout === 'aligned' ? 'Aligned sequences' : layout === 'outline' ? 'Change outline' : 'Order connections'}</button>)}</div></section><section><h3>Comparison scope</h3><p>Included: {diff.scope.included.join('; ')}</p><p>Excluded: {diff.scope.excluded.join('; ') || 'none'}</p><p className="muted">Presentation filters do not change matching or compared input.</p></section></>}
      {selectedTab === 'Evidence' && <><CopyFinding pair={pair} diff={diff} snapshots={snapshots} /><p className="muted">Pointers address the immutable canonical snapshot, and each ID is checked against that event. Recorded content is inert text.</p>{SIDES.map(side => <section key={side}><h3 className={`pair-evidence-heading ${side}`}>{side} source events</h3>{!pair[side] && <p>No counterpart.</p>}{evidence[side].map((item, index) => <details key={`${item.pointer}-${index}`}><summary>{item.event?.event_type || 'Unavailable evidence'} · {item.pointer}</summary><p className="mono">Event ID: {item.eventId}</p>{item.original?.fileName && <p>{item.original.fileName} · line {item.original.line}</p>}<p className={item.valid ? 'muted' : 'error'}>{item.valid ? '✓ Pointer and event ID verified' : 'Reference does not resolve to the expected event'}</p>{item.event && <pre>{JSON.stringify(item.event, null, 2)}</pre>}{item.event && item.original?.text && <details><summary>Original source line</summary><pre>{item.original.text}</pre></details>}</details>)}</section>)}</>}
    </div>
  </div>;
}
