import React from 'react';

export default function LiveConnection({ live, available, device, pairing, pairingOpen, onTogglePairing, onStart, onStop, onDownload, onError, followLatest, onFollowLatest, inert }) {
  if (live.state === 'idle') return <section className="live-panel" inert={inert}>
    <div className="live-actions"><strong>{available ? 'Live updates paused' : 'File viewer'}</strong>
      {available ? <button onClick={onStart}>Resume live</button> : <a href="http://127.0.0.1:4319/">Open live viewer →</a>}
    </div><p className="muted">{available ? 'Resume to return to the collector capture.' : 'For automatic device streaming, run npm run android:live. For other producers, run npm start.'}</p>
  </section>;
  return <section className="live-panel" inert={inert}>
    <div className="live-actions"><strong role="status">{live.state === 'live' ? '● Live' : live.state === 'error' ? 'Connection needs attention' : live.state === 'connecting' ? '◌ Connecting' : '◌ Reconnecting'} · {live.count} events</strong>
      <button onClick={onDownload} disabled={live.state !== 'live'}>Save capture</button>
      <button onClick={onStop}>Pause live</button>
      <button onClick={onTogglePairing}>Other devices</button>
      <label><input type="checkbox" checked={followLatest} onChange={event => onFollowLatest(event.target.checked)}/> Follow newest session</label>
    </div>
    {live.error && <p>{live.error}</p>}
    {device && <p className="device-status" aria-live="polite">{device.label && <b>{device.label} · </b>}{device.message}</p>}
    <p className="muted">{live.count ? 'New events appear automatically. Selection and filters stay in place.' : 'Waiting for events. Run a sample flow on the connected device.'}</p>
    {pairingOpen && <div className="pairing-options">{pairing.map(connection => <div key={connection.endpoint}>
      <b>{connection.certificate_sha256 ? 'iOS / Wi-Fi · paired HTTPS' : 'Android USB / iOS Simulator'}</b><p>{connection.endpoint}</p>
      <button onClick={async () => { try { await navigator.clipboard.writeText(JSON.stringify(connection)); } catch { onError('Clipboard unavailable. Use the collector’s connection JSON file.'); } }}>Copy pairing JSON</button>
    </div>)}<p>Android USB connects automatically through npm run android:live. Other apps can paste pairing JSON into their development setup.</p></div>}
  </section>;
}
