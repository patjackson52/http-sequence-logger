// Portable SVG: native shapes and text only. Capture values never become markup,
// attributes, links, CSS, scripts, or external resource references.
import { durationLabel } from './layout.mjs';

const COLORS = { neutral: '#5b6673', ok: '#1f7a4d', error: '#b9382c', warning: '#8a5a00', local: '#4f4a8a' };
const BACKGROUND = '#fafbfc', SELECTED = '#1b6f8f', HIGHLIGHT = '#e3f1f6';
const FONT = 'Arial, sans-serif', MONO = 'monospace';
const TITLE_HEIGHT = 66, HEADER_HEIGHT = 120, FOOTER_HEIGHT = 32;
// XML 1.0 excludes control characters and unpaired UTF-16 surrogates.
const clean = value => String(value ?? '').toWellFormed().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '\uFFFD');
const escape = value => clean(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const shorten = value => clean(value).slice(0, 4096).toWellFormed();

export function svgFilename(name) {
  const safe = clean(name).normalize('NFKC').replace(/[^\p{L}\p{N} _-]+/gu, '-').trim().replace(/[\s_-]+/g, '-');
  const stem = [...safe].slice(0, 100).join('').replace(/^-+|-+$/g, '');
  return `${stem ? stem + '-' : ''}sequence.svg`;
}

/** Share the currently rendered layout, not a fresh unfiltered reconstruction. */
export function renderSequenceSVG(layout, { name = 'Sequence diagram', selectedId = null, measureText } = {}) {
  const width = layout.width, height = TITLE_HEIGHT + HEADER_HEIGHT + layout.height + FOOTER_HEIGHT;
  if (![width, height].every(n => Number.isFinite(n) && n > 0)) throw new Error('Diagram dimensions are invalid');
  const measure = (value, size, mono = false, bold = false) => measureText
    ? measureText(value, `${bold ? '600 ' : ''}${size}px ${mono ? MONO : FONT}`)
    : [...value].length * size * (mono ? 0.61 : 0.57);
  const fit = (value, maxWidth, size, mono = false, bold = false) => {
    const text = shorten(value);
    if (measure(text, size, mono, bold) <= maxWidth) return text;
    const points = [...text]; let low = 0, high = points.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (measure(points.slice(0, middle).join('') + '…', size, mono, bold) <= maxWidth) low = middle; else high = middle - 1;
    }
    return points.slice(0, low).join('') + '…';
  };
  const wrap = (value, maxWidth, size, lines, mono = false, bold = false) => {
    let remaining = shorten(value).replace(/\s+/g, ' '); const result = [];
    while (remaining && result.length < lines) {
      if (measure(remaining, size, mono, bold) <= maxWidth) { result.push(remaining); break; }
      const line = fit(remaining, maxWidth, size, mono, bold);
      if (result.length === lines - 1) { result.push(line); break; }
      let length = line.length - 1;
      const space = remaining.lastIndexOf(' ', length);
      if (space > length / 2) length = space;
      if (length === 0) { result.push('…'); break; }
      result.push(remaining.slice(0, length)); remaining = remaining.slice(length).trimStart();
    }
    return result;
  };
  const elements = [];
  const rect = (x, y, w, h, fill, extra = '') => `<rect x="${x}" y="${y}" width="${Math.max(0, w)}" height="${Math.max(0, h)}" fill="${fill}"${extra}/>`;
  const line = (x1, y1, x2, y2, stroke, extra = '') => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}"${extra}/>`;
  function text(value, x, y, maxWidth, { size = 11, mono = false, bold = false, fill = COLORS.neutral, background, italic = false, center = false } = {}) {
    const visible = fit(value, Math.max(1, maxWidth), size, mono, bold);
    const length = Math.min(maxWidth, measure(visible, size, mono, bold));
    const left = center ? x - length / 2 : x;
    return (background ? rect(left - 3, y - size, length + 6, size + 4, background) : '') +
      `<text x="${x}" y="${y}" fill="${fill}" font-family="${mono ? MONO : FONT}" font-size="${size}"${bold ? ' font-weight="600"' : ''}${italic ? ' font-style="italic"' : ''}${center ? ' text-anchor="middle"' : ''}>${escape(visible)}</text>`;
  }
  const relatedIds = new Set(); let related = layout.entityMap.get(selectedId);
  while (related && !relatedIds.has(related.id)) { relatedIds.add(related.id); related = related.parentScope === 'local' ? layout.opMap.get(related.parentId) : null; }
  elements.push(`<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="diagram-title diagram-description">`);
  elements.push(`<title id="diagram-title">${escape(name)} — sequence diagram</title><desc id="diagram-description">Current session and diagram filters, component lanes, collapsed methods and selected item. Full diagram, including offscreen rows. Event order uses compressed spacing, not a duration scale.</desc>`);
  elements.push('<defs><pattern id="waiting" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" x2="0" y1="0" y2="6" stroke="#4f4a8a" stroke-width="1.5" opacity=".45"/></pattern></defs>');
  elements.push(rect(0, 0, width, height, BACKGROUND));
  elements.push(text(name, 16, 27, width - 32, { size: 18, bold: true, fill: '#1b2430' }));
  elements.push(text('Sequence diagram · current view', 16, 49, width - 32, { size: 11 }));
  elements.push(`<g transform="translate(0 ${TITLE_HEIGHT})">`);
  elements.push(text('CLIENT', layout.clientGroup.x + layout.clientGroup.width / 2, 17, layout.clientGroup.width, { size: 10, bold: true, center: true }));
  for (const lane of layout.lanes) {
    elements.push(`<g${lane.muted ? ' opacity="0.5"' : ''}>`);
    elements.push(`<title>${escape(lane.title)}</title>`);
    const titles = wrap(lane.label, lane.width - 16, 12, 3, false, true);
    titles.forEach((value, i) => elements.push(text(value, lane.x, 41 + i * 15, lane.width - 16, { size: 12, bold: true, center: true, fill: '#1b2430' })));
    wrap(lane.sub || 'No components recorded', lane.width - 16, 10, 2, true).forEach((value, i) => elements.push(text(value, lane.x, 45 + titles.length * 15 + i * 13, lane.width - 16, { size: 10, mono: true, center: true, fill: '#7a8592' })));
    elements.push('</g>');
  }
  elements.push(line(0, HEADER_HEIGHT, width, HEADER_HEIGHT, '#e1e6eb'), '</g>');
  elements.push(`<g transform="translate(0 ${TITLE_HEIGHT + HEADER_HEIGHT})">`);
  elements.push(rect(layout.clientGroup.x, 0, layout.clientGroup.width, layout.height, '#f1f4f7'));
  for (const lane of layout.lanes) elements.push(line(lane.x, 0, lane.x, layout.height, '#d5dbe2', lane.muted ? ' opacity="0.45"' : ''));
  for (const row of layout.rows) {
    if (row.kind === 'recording') elements.push(rect(0, row.y - row.height / 2, width, row.height, row.recording.incomplete ? '#fff3d6' : '#edf1f5'));
    if (row.kind === 'gap') elements.push(line(8, row.y, width - 8, row.y, '#c9d1da', ' stroke-dasharray="2 4"'));
  }
  for (const bar of layout.serverBars) elements.push(rect(bar.x, bar.y, bar.width, bar.height, bar.open ? BACKGROUND : '#e8edf2', ` stroke="${bar.entityId === selectedId ? SELECTED : '#a4afba'}"${bar.open ? ' stroke-dasharray="3 3"' : ''}`));
  for (const bar of layout.bars) {
    if (bar.entityId === selectedId) elements.push(rect(bar.x - 5, bar.y, Math.min(320, width - bar.x - 12), 38, HIGHLIGHT, ' rx="4"'));
    elements.push(rect(bar.x, bar.y, bar.width, bar.height, bar.kind === 'handler' ? '#ecebf6' : '#e3e9ef', ` rx="3" stroke="${relatedIds.has(bar.entityId) ? SELECTED : COLORS[bar.tone]}" stroke-width="${relatedIds.has(bar.entityId) ? 2.5 : 1.2}"${bar.open || bar.stopped ? ' stroke-dasharray="3 3"' : ''}`));
  }
  for (const wait of layout.waitSegments) elements.push(rect(wait.x, wait.y, wait.width, wait.height, 'url(#waiting)', wait.entityId === selectedId ? ` stroke="${SELECTED}"` : ''));
  function arrow(shape, local) {
    const selected = shape.entityId === selectedId, color = selected ? SELECTED : COLORS[shape.tone];
    const weight = selected ? 2.5 : 1.5, direction = shape.self ? -1 : shape.x2 >= shape.x1 ? 1 : -1;
    const dash = shape.dashed || shape.kind === 'return' ? ' stroke-dasharray="4 3"' : '';
    if (selected) elements.push(rect(Math.min(shape.x1, shape.x2) - 8, shape.y - 29, Math.max(100, Math.abs(shape.x2 - shape.x1) + 16), 42, HIGHLIGHT, ' rx="4"'));
    if (shape.self) elements.push(`<path d="M ${shape.x1} ${shape.y - 9} h 22 v 9 H ${shape.x2}" fill="none" stroke="${color}" stroke-width="${weight}"${dash}/>`);
    else elements.push(line(shape.x1, shape.y, shape.x2, shape.y, color, ` stroke-width="${weight}"${dash}`));
    elements.push(`<${local ? 'polyline' : 'polygon'} points="${shape.x2 - 6 * direction},${shape.y - 4} ${shape.x2},${shape.y} ${shape.x2 - 6 * direction},${shape.y + 4}" fill="${local ? 'none' : color}"${local ? ` stroke="${color}" stroke-width="${weight}"` : ''}/>`);
    if (shape.fromDot) elements.push(`<circle cx="${shape.x1}" cy="${shape.y}" r="3" fill="${BACKGROUND}" stroke="${color}" stroke-width="1.5"/>`);
  }
  layout.arrows.forEach(shape => arrow(shape, false)); layout.localArrows.forEach(shape => arrow(shape, true));
  for (const pill of layout.ancestryPills) elements.push(line(pill.x, pill.y, pill.x, pill.y + pill.height, '#4f4a8a', ' stroke-width="4"'));
  // Text is a separate layer, like the live HTML labels, so arrows never cover it.
  for (const row of layout.rows) {
    if (row.kind === 'recording') {
      const labelWidth = Math.min(measure(row.label, 11, true, true), width - 24);
      elements.push(text(row.label, 12, row.y + 4, width - 24, { mono: true, bold: true, fill: '#3b4650' }));
      if (width - labelWidth > 150) elements.push(text(row.sub, labelWidth + 24, row.y + 4, width - labelWidth - 36, { size: 10.5 }));
    } else if (row.kind === 'gap') elements.push(text(row.label, 32, row.y + 4, width - 48, { size: 10.5, background: BACKGROUND }));
    else if (row.kind === 'orphan') elements.push(text(`Operation end observed · start not recorded · ${row.entity.outcome}`, 40, row.y + 4, width - 56, { fill: COLORS.warning, background: '#fff3d6' }));
    else if (['stop', 'operationEnd'].includes(row.kind) || row.kind === 'unfinished' && layout.opMap.has(row.entityId)) {
      const bar = layout.bars.find(bar => bar.entityId === row.entityId); if (!bar) continue;
      const label = row.kind === 'stop' ? `? observation stopped · ${row.entity.end?.extensions?.['capture.observation_stop_reason'] || 'reason not recorded'} · —` : row.kind === 'unfinished' ? '… no operation.ended' : `${row.entity.method || row.entity.name} → ${row.entity.outcome}${row.entity.durationMs != null ? ` · ${durationLabel(row.entity.durationMs)}` : ''}`;
      elements.push(text(label, bar.labelX + 3, row.y + 3, width - bar.labelX - 16, { size: 10, mono: true, background: '#f1f4f7', fill: row.kind === 'operationEnd' ? COLORS.neutral : COLORS.warning }));
    }
  }
  for (const bar of layout.bars) {
    const x = bar.labelX + 3, y = bar.labelY + 12, max = Math.min(350, width - x - 16);
    elements.push(text(bar.label + (bar.kind === 'handler' ? ' · handler' : ''), x, y, max, { size: 11.5, mono: true, bold: true, fill: bar.kind === 'handler' ? COLORS.local : '#394653', background: '#f1f4f7' }));
    const component = bar.component + (bar.kind === 'handler' && bar.operation.invocation?.caller ? ` ← ${bar.operation.invocation.caller.component}.${bar.operation.invocation.caller.method || '(method)'}` : '');
    elements.push(text(component, x, y + 15, max, { size: 10.5, background: '#f1f4f7' }));
    if (bar.collapsed) elements.push(text(`${bar.counts.requests} requests · ${bar.counts.calls} calls hidden`, x, y + 29, max, { size: 10.5, italic: true, background: '#f1f4f7' }));
  }
  for (const shape of [...layout.arrows, ...layout.localArrows]) {
    const x = Math.min(shape.x1, shape.x2) + (shape.self ? 28 : 8) + 3;
    const max = Math.max(1, Math.min(600, width - x - 8));
    elements.push(text(shape.label, x, shape.y - 16, max, { mono: true, bold: true, fill: COLORS[shape.tone], background: shape.entityId === selectedId ? HIGHLIGHT : BACKGROUND }));
    if (shape.sub) elements.push(text(shape.sub, x, shape.y - 3, max, { size: 10, mono: true, fill: '#7a8592', background: BACKGROUND }));
  }
  for (const wait of layout.waitSegments) elements.push(text(wait.label, wait.x + 23, wait.y + 19, width - wait.x - 39, { size: 9.5, italic: true, fill: COLORS.local, background: '#f1f4f7' }));
  for (const pill of layout.ancestryPills) elements.push(text(pill.label, pill.x + 18, pill.y + 4, width - pill.x - 34, { mono: true, fill: COLORS.local, background: pill.entityId === selectedId ? HIGHLIGHT : '#ecebf6' }));
  if (!layout.navigationItems.length) elements.push(text('No events match these filters.', 32, 40, width - 48, { size: 14 }));
  elements.push('</g>');
  elements.push(line(0, height - FOOTER_HEIGHT, width, height - FOOTER_HEIGHT, '#e1e6eb'));
  elements.push(text('Event order · compressed spacing, not a duration scale.', 16, height - 12, width - 32, { size: 10 }));
  elements.push('</svg>');
  return elements.join('\n');
}

/** Browser-only wrapper. The pure renderer is also used by contract/UI tests. */
export function sequenceSVG(layout, options) {
  const context = document.createElement('canvas').getContext('2d');
  return renderSequenceSVG(layout, { ...options, measureText: context ? (text, font) => { context.font = font; return context.measureText(text).width; } : undefined });
}

export function downloadSVG(svg, filename) {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = filename;
  try { document.body.append(link); link.click(); }
  finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30_000); }
}
