import React, { useMemo, useState } from 'react';
import { detectBase64, inspectBase64Header } from './base64.mjs';
import './base64.css';

export function Base64Control({ count = 1, active, onClick }) {
  return <span className="base64-control"><span>Base64{count > 1 ? ` · ${count} values` : ''}</span><button className="small" aria-pressed={active} onClick={onClick} title="Preview decoded text; recorded values stay unchanged">{active ? 'Encoded' : 'Decode'}</button></span>;
}

/** Only detected values acquire extra markup. Decoded text is never HTML. */
export default function Base64Value({ value, header = false, disabled = false }) {
  const [selected, setSelected] = useState(null);
  const match = useMemo(() => disabled ? null : header ? inspectBase64Header(value) : detectBase64(value), [value, header, disabled]);
  if (!match) return value;
  const active = selected === value;
  return <span className="base64-value"><span>{active ? match.decoded : value}</span><Base64Control active={active} onClick={() => setSelected(active ? null : value)} /></span>;
}
