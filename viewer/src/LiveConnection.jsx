import React from 'react';

function AdapterStatus({name,status}) {
  const label=name.startsWith('ios-simulator')?'iOS Simulator':name.startsWith('android')?'Android':name;
  const suffix=name.includes(':')?' · '+name.slice(name.indexOf(':')+1):'';
  return <div><b>{label}{suffix}</b> · {status.reason||status.state}{status.devices?.map(item=><small key={item.serial||item.udid}> · {item.name||item.serial||item.udid}{item.state?' ('+item.state+')':''}</small>)}{status.next_action&&<small> · {status.next_action}</small>}</div>;
}

export default function LiveConnection({ live, available, device, pairing, pairingOpen, onTogglePairing, onStart, onStop, onDownload, onError, followLatest, onFollowLatest, inert, collection, canCollect, onCollect, onCancelCollection }) {
  const collecting=['queued','running'].includes(collection?.state);
  const incomplete=collection?.sources?.some(s=>s.sampled||s.truncated||s.parse_errors);
  const collectionLabel=collection?.state==='completed' ? !collection.sources?.length ? 'No sources' : incomplete ? 'Partial logs' : collection.event_count ? 'Updated' : 'No new logs' : ({queued:'Queued',running:'Collecting…',cancelled:'Cancelled',failed:'Refresh failed'})[collection?.state] || '';
  if (live.state === 'idle') return <section className="live-panel" inert={inert}>
    <div className="live-actions"><strong>{available ? 'Live updates paused' : 'File viewer'}</strong>
      {available ? <button onClick={onStart}>Resume live</button> : <a href="http://127.0.0.1:4319/">Open live viewer →</a>}
    </div><p className="muted">{available ? 'Collection continues while viewer updates are paused. Resume to return to the collector.' : 'Start npm start to discover participating devices and apps.'}</p>
  </section>;
  return <section className="live-panel" inert={inert}>
    <div className="live-actions"><strong role="status">{live.state === 'live' ? '● Live' : live.state === 'error' ? 'Connection needs attention' : live.state === 'connecting' ? '◌ Connecting' : '◌ Reconnecting'} · {live.count} events</strong>
      <div className="related-collection">
        <button className="related-refresh" onClick={collecting ? onCancelCollection : onCollect} disabled={live.state !== 'live' || !canCollect}>{collecting ? 'Cancel refresh' : 'Refresh related logs'}</button>
        <span role="status" className="collection-status" title={collection?.error || collection?.sources?.map(s=>`${s.adapter_id}: ${s.reason || s.state}${s.parse_errors ? ` · ${s.parse_errors} parse errors` : ''}${s.sampled ? ' · sampled' : ''}${s.truncated ? ' · truncated' : ''}${s.diagnostics?.length ? `\n${s.diagnostics.map(d=>`${d.reason}: ${d.reference}`).join('\n')}` : ''}`).join('\n')}>{collectionLabel}</span>
      </div>
      <button onClick={onDownload} disabled={live.state !== 'live'}>Save capture</button>
      <button onClick={onStop}>Pause live</button>
      <button onClick={onTogglePairing} disabled={live.state !== 'live'} aria-expanded={pairingOpen}>{pairingOpen ? 'Close pairing' : 'Pair another device'}</button>
      <label><input type="checkbox" checked={followLatest} onChange={event => onFollowLatest(event.target.checked)}/> Follow newest session</label>
    </div>
    {live.error && <p>{live.error}</p>}
    {device && <div className="device-status" aria-live="polite">{Object.entries(device).filter(([name,status])=>!name.includes(':')||status.state!=='ready').map(([name,status])=><AdapterStatus key={name} name={name} status={status}/>)}{Object.entries(device).some(([name,status])=>name.includes(':')&&status.state==='ready')&&<details><summary>Discovery details</summary>{Object.entries(device).filter(([name,status])=>name.includes(':')&&status.state==='ready').map(([name,status])=><AdapterStatus key={name} name={name} status={status}/>)}</details>}</div>}
    <p className="muted">{live.count ? 'New events appear automatically. Selection and filters stay in place.' : 'Ready and waiting for events from participating apps.'}</p>
    {pairingOpen && <div className="pairing-options">{pairing.map(connection => <div key={connection.endpoint}>
      <b>{connection.endpoint.startsWith('https:') ? 'iOS / Android over Wi-Fi · HTTPS' : 'Android emulator / iOS Simulator · loopback'}</b><p>{connection.endpoint}</p>
      <button onClick={async () => { try { await navigator.clipboard.writeText(JSON.stringify(connection)); } catch { onError('Clipboard unavailable. Use the collector’s connection JSON file.'); } }}>Copy pairing JSON</button>
    </div>)}<p>This invitation pairs one installation and expires in ten minutes. Paste it into the app’s development setup. Android USB and booted iOS simulators connect automatically when their debug apps publish a capture descriptor.</p>{!pairing.some(connection=>connection.endpoint.startsWith('https:'))&&<p>For a physical phone, start the collector with --lan HOST to enable HTTPS pairing.</p>}</div>}
  </section>;
}
