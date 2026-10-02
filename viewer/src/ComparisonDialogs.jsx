import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import './comparison-inspector.css';

function Dialog({ title, onCancel, children, className = '' }) {
  const ref = useRef(null), id = useId();
  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.querySelector('button,input,select,textarea,[tabindex="0"]')?.focus();
    return () => { requestAnimationFrame(() => { if (previous?.isConnected) previous.focus(); }); };
  }, []);
  function key(event) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); }
    if (event.key !== 'Tab') return;
    const controls = [...ref.current.querySelectorAll('button,input,select,textarea,[tabindex="0"]')].filter(item => !item.disabled && item.getClientRects().length);
    const index = controls.indexOf(document.activeElement);
    if (event.shiftKey && index <= 0) { event.preventDefault(); controls.at(-1)?.focus(); }
    else if (!event.shiftKey && (index === controls.length - 1 || index < 0)) { event.preventDefault(); controls[0]?.focus(); }
  }
  return <div className="comparison-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onCancel(); }}>
    <section className={`comparison-modal ${className}`} ref={ref} role="dialog" aria-modal="true" aria-labelledby={id} onKeyDown={key}>
      <header><h2 id={id}>{title}</h2><button onClick={onCancel} aria-label={`Close ${title.toLowerCase()}`}>×</button></header>{children}
    </section>
  </div>;
}

/** UI validation uses engine references; the worker independently validates on Apply. */
export function matchCandidates(pair, diff, side = pair.primary ? 'primary' : 'secondary') {
  const source = pair[side], other = side === 'primary' ? 'secondary' : 'primary';
  if (!source) return [];
  const parent = diff.pairs.find(item => item[side]?.node_id === source.parent_node_id);
  const overrides = [...diff.profile.matches, ...diff.profile.recording_matches];
  return diff.pairs.flatMap(item => {
    const candidate = item[other];
    if (!candidate || candidate.kind !== source.kind) return [];
    let conflict = '';
    if (source.kind !== 'recording' && (!parent?.[other] || parent[other].node_id !== candidate.parent_node_id)) conflict = 'Pair recordings and ancestors first.';
    else if (item[side] && item[side].node_id !== source.node_id) conflict = 'Already paired to another node; one-to-one correspondence required.';
    else if (overrides.some(match => (match[side] === source.node_id && match[other] !== candidate.node_id) || (match[other] === candidate.node_id && match[side] !== source.node_id))) conflict = 'Conflicts with an existing explicit match. Remove it in Comparison rules first.';
    return [{ reference: candidate, pairId: item.id, conflict, suggested: pair.matching.candidate_node_ids.includes(candidate.node_id) }];
  }).sort((a, b) => Number(!!a.conflict) - Number(!!b.conflict) || Number(b.suggested) - Number(a.suggested) || a.reference.position - b.reference.position);
}

export function profileWithMatch(profile, source, candidate, side) {
  const key = source.kind === 'recording' ? 'recording_matches' : 'matches';
  const other = side === 'primary' ? 'secondary' : 'primary';
  const entry = { [side]: source.node_id, [other]: candidate.node_id };
  const conflicts = [...profile.matches, ...profile.recording_matches].some(match =>
    (match[side] === entry[side] && match[other] !== entry[other]) || (match[other] === entry[other] && match[side] !== entry[side]));
  if (conflicts) throw new Error('Explicit matches must be one-to-one. Remove the conflicting match in Comparison rules.');
  return { ...profile, [key]: [...profile[key].filter(match => match.primary !== entry.primary || match.secondary !== entry.secondary), entry] };
}

export function MatchDialog({ pair, diff, resolution, onCandidate, onApply, onCancel, error, busy = false, onCancelComputation }) {
  const side = resolution?.side || (pair.primary ? 'primary' : 'secondary');
  const source = pair[side], other = side === 'primary' ? 'secondary' : 'primary';
  const candidates = useMemo(() => matchCandidates(pair, diff, side), [pair, diff, side]);
  const [selected, setSelected] = useState(resolution?.selectedNodeId || resolution?.candidateNodeId || '');
  const [localError, setLocalError] = useState('');
  const current = candidates.find(item => item.reference.node_id === selected);
  const candidateCallback = useRef(onCandidate);
  candidateCallback.current = onCandidate;
  useEffect(() => {
    candidateCallback.current?.({ side, nodeId: source?.node_id, candidateNodeIds: candidates.filter(item => !item.conflict).map(item => item.reference.node_id), selectedNodeId: selected || null });
  }, [selected, side, source?.node_id, candidates]);
  return <Dialog title="Resolve match" onCancel={onCancel} className="match-dialog">
    <p className="pair-uncertainty">{side === 'primary' ? 'Primary' : 'Secondary'} source: <strong>{source?.label}</strong>. Candidate selection previews a correspondence; Apply recomputes both snapshots.</p>
    <p>Choose a {other} node of the same kind within paired ancestry. Exact recorded names remain unchanged; explicit pairing supports different platform names.</p>
    <div className="match-candidates" role="radiogroup" aria-label="Correspondence candidates">
      {candidates.map(item => <label key={item.reference.node_id} className={`match-candidate ${selected === item.reference.node_id ? 'picked' : ''} ${item.conflict ? 'conflict' : ''}`}>
        <input type="radio" name="match-candidate" value={item.reference.node_id} checked={selected === item.reference.node_id} disabled={!!item.conflict} onChange={() => { setSelected(item.reference.node_id); setLocalError(''); }} />
        <span><strong>{item.reference.label}</strong><small>{item.reference.kind} · original position {item.reference.position} · {item.reference.recording_id}</small><small>{item.conflict || (item.suggested ? 'Engine ambiguity candidate' : 'Explicit correspondence; signature differs or was unpaired')}</small><code>{item.reference.node_id}</code></span>
      </label>)}
      {!candidates.length && <p className="notice">No nodes of the same kind are present in the other snapshot.</p>}
    </div>
    {!candidates.some(item => !item.conflict) && candidates.length > 0 && <p className="notice">No valid candidate is currently available. Resolve ancestors or remove conflicting explicit matches first.</p>}
    {(error || localError) && <p className="notice error" role="alert">{error || localError}</p>}
    {busy && <p role="status">Computing canonical comparison… <button onClick={onCancelComputation}>Cancel computation</button></p>}
    <footer className="actions"><button onClick={onCancel}>Cancel</button><button className="primary" disabled={busy || !current || !!current.conflict} onClick={() => { try { onApply(profileWithMatch(diff.profile, source, current.reference, side)); } catch (issue) { setLocalError(issue.message); } }}>Apply explicit match and recompute</button></footer>
  </Dialog>;
}

export function RulesDialog({ diff, profile = diff.profile, onApply, onCancel, error, busy = false, onCancelComputation }) {
  const id = useId();
  const [draft, setDraft] = useState(() => structuredClone(profile));
  const [headers, setHeaders] = useState(profile.ignore_headers.join('\n'));
  const [paths, setPaths] = useState(profile.ignore_paths.filter(path => path !== '').join('\n'));
  const [excludeWholeProjection, setExcludeWholeProjection] = useState(profile.ignore_paths.includes(''));
  const [localError, setLocalError] = useState('');
  function apply() {
    const ignore_headers = [...new Set(headers.split('\n').map(value => value.trim()).filter(Boolean))];
    const ignore_paths = [...new Set([...paths.split('\n').filter(value => value !== ''), ...(excludeWholeProjection ? [''] : [])])];
    if (ignore_paths.some(path => !/^(|\/(?:[^~]|~[01])*)$/.test(path))) { setLocalError('Ignored paths must be exact JSON pointers, with ~0 and ~1 escapes.'); return; }
    onApply({ ...draft, ignore_headers, ignore_paths });
  }
  return <Dialog title="Comparison rules" onCancel={onCancel} className="rules-dialog">
    <p>Rules are stored in the exported engine profile. Applying rules recomputes the immutable snapshots; presentation filters do not change this profile.</p>
    <label className="comparison-check"><input type="checkbox" checked={draft.json_fields} onChange={event => setDraft({ ...draft, json_fields: event.target.checked })} /> Compare complete, unredacted UTF-8 JSON fields</label>
    <p className="muted">Raw bodies remain compared. Ignoring a JSON field does not automatically ignore the raw content difference.</p>
    <label className="comparison-check"><input type="checkbox" checked={draft.compare_timing} onChange={event => setDraft({ ...draft, compare_timing: event.target.checked })} /> Compare completed duration values</label>
    <p className="muted">Timing compares recorded durations exactly; independent recording clocks are never subtracted.</p>
    <label htmlFor={`${id}-headers`}>Ignored header names · one per line, case insensitive</label><textarea id={`${id}-headers`} rows={4} value={headers} onChange={event => setHeaders(event.target.value)} placeholder="No ignored headers" />
    <label htmlFor={`${id}-paths`}>Ignored projected paths · one exact JSON pointer per line</label><textarea id={`${id}-paths`} rows={4} value={paths} onChange={event => setPaths(event.target.value)} placeholder="/request_body/json/example" />
    <label className="comparison-check"><input type="checkbox" checked={excludeWholeProjection} onChange={event => setExcludeWholeProjection(event.target.checked)} /> Exclude entire field projection (empty JSON pointer)</label>
    <section><h3>Explicit matches</h3>{['recording_matches', 'matches'].map(key => <div key={key}>{draft[key].map((match, index) => <div className="explicit-match-rule" key={`${key}-${index}`}><code>{key}: {match.primary} ↔ {match.secondary}</code><button aria-label={`Remove ${key} ${index + 1}`} onClick={() => setDraft({ ...draft, [key]: draft[key].filter((_, i) => i !== index) })}>Remove</button></div>)}</div>)}{!draft.matches.length && !draft.recording_matches.length && <p className="muted">None. Use Resolve match on a one-sided or unresolved pair to add a validated correspondence.</p>}</section>
    <section><h3>Snapshot scope</h3><p>Included: {diff.scope.included.join('; ')}</p><p>Excluded: {diff.scope.excluded.join('; ') || 'none'}</p><p className="muted">Whole-session or source-limited input is chosen when snapshots are acquired. Rules exclude projected fields, not input events.</p></section>
    {(error || localError) && <p className="notice error" role="alert">{error || localError}</p>}
    {busy && <p role="status">Computing canonical comparison… <button onClick={onCancelComputation}>Cancel computation</button></p>}
    <footer className="actions"><button onClick={onCancel}>Cancel</button><button className="primary" disabled={busy} onClick={apply}>Apply rules and recompute</button></footer>
  </Dialog>;
}
