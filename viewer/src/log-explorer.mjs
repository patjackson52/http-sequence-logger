import { IMPORT_LIMITS } from './model.mjs';

// Folder listing reads bounded file heads only; full parsing happens on open through the import pipeline.
export const EXPLORER_LIMITS = Object.freeze({ headBytes: 256 * 1024, maxEntries: 500, maxScanned: 5000, maxDepth: 8, concurrency: 4, maxFolders: 20, maxFileBytes: IMPORT_LIMITS.maxFileBytes, maxNameLength: 120 });
const LOG_EXTENSION = /\.ndjson$/i;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export const isLogFile = name => LOG_EXTENSION.test(name) && !name.startsWith('.');
export const skipEntry = name => name.startsWith('.') || name === 'node_modules';
export const baseName = name => String(name).replace(/\.(ndjson|jsonl|json|txt)$/i, '');
// Epoch 0 / negative lastModified means "unknown" in File APIs.
const validDate = value => { if (value == null || value === '' || (typeof value === 'number' && value <= 0)) return null; const date = value instanceof Date ? value : new Date(value); return Number.isFinite(date.getTime()) ? date : null; };

// Reads the first session.started from a head of NDJSON text. Partial final lines are ignored unless the head is the whole file.
export function readLogHeader(text, { complete = true, maxNameLength = EXPLORER_LIMITS.maxNameLength } = {}) {
  const lines = String(text).split('\n');
  if (!complete) lines.pop();
  const sessions = new Set(), started = new Set();
  let name = null, startedAt = null, events = 0, invalid = 0, first = true;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let event;
    try { event = JSON.parse(line); } catch { invalid++; continue; }
    if (!event || typeof event !== 'object' || typeof event.session_id !== 'string') { invalid++; continue; }
    events++;
    const key = JSON.stringify([event.session_namespace, event.session_id]);
    sessions.add(key);
    if (event.event_type === 'session.started' && !started.has(key)) {
      started.add(key);
      // Name and time both come from the first session.started so a row never mixes sessions.
      if (first) {
        first = false;
        if (validDate(event.timestamp)) startedAt = new Date(event.timestamp).toISOString();
        if (typeof event.data?.name === 'string' && event.data.name.trim()) name = event.data.name.trim().slice(0, maxNameLength);
      }
    }
  }
  // A head with no complete line (first line longer than the head) is unknown, not broken: label falls back to the filename.
  const unknown = !complete && !events && !invalid;
  const error = !events && !unknown ? (invalid ? 'Unreadable' : 'No sessions') : null;
  return { name, startedAt, sessions: sessions.size, events, invalid, complete, unknown, error };
}

export async function readHead(file, bytes = EXPLORER_LIMITS.headBytes) {
  const complete = file.size <= bytes;
  const text = await (complete ? file : file.slice(0, bytes)).text();
  return readLogHeader(text, { complete });
}

// Intl.DateTimeFormat construction dominates formatting cost; reuse one per (kind, locale, zone).
const formatters = new Map();
const formatter = (kind, locale, timeZone) => {
  const key = `${kind}|${locale ?? ''}|${timeZone ?? ''}`;
  let value = formatters.get(key);
  if (!value) {
    const options = { day: { year: 'numeric', month: 'numeric', day: 'numeric' }, time: { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }, weekday: { weekday: 'short' }, date: { month: 'short', day: 'numeric' } }[kind];
    value = new Intl.DateTimeFormat(kind === 'day' ? 'en-US' : locale, { timeZone, ...options });
    if (formatters.size > 64) formatters.clear();
    formatters.set(key, value);
  }
  return value;
};
const dayParts = (date, timeZone) => {
  const parts = Object.fromEntries(formatter('day', undefined, timeZone).formatToParts(date).map(p => [p.type, p.value]));
  return { year: Number(parts.year), day: Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) / 86400000, month: parts.month.padStart(2, '0'), date: parts.day.padStart(2, '0') };
};

// 24h short time: same day 14:32 · previous 6 days Tue 14:32 · same year Oct 3 · else 2025-10-03.
export function formatShortTime(value, now = new Date(), { locale, timeZone } = {}) {
  const date = validDate(value), today = validDate(now);
  if (!date || !today) return '';
  const a = dayParts(date, timeZone), b = dayParts(today, timeZone), days = b.day - a.day;
  const time = () => formatter('time', locale, timeZone).format(date);
  if (days === 0) return time();
  if (days > 0 && days <= 6) return `${formatter('weekday', locale, timeZone).format(date)} ${time()}`;
  // Future dates (clock skew) and older same-year dates show the calendar day.
  if (a.year === b.year) return formatter('date', locale, timeZone).format(date);
  return `${a.year}-${a.month}-${a.date}`;
}

// Display identity for a log row. Never shows "Session metadata not recorded".
export function logLabel(entry) {
  const header = entry.header || {};
  const time = validDate(header.startedAt) || validDate(entry.lastModified);
  return { name: header.name || baseName(entry.name), time: time ? time.toISOString() : null, sessions: header.sessions || 0 };
}

export function rowTitle({ name, file, path, time, events, sessions, extra }) {
  return [name, path || file, time, sessions > 1 ? `${sessions} sessions` : null, Number.isFinite(events) ? `${events} events` : null, extra].filter(Boolean).join('\n');
}

const entryTime = entry => { const t = logLabel(entry).time; return t ? Date.parse(t) : null; };
export function sortEntries(entries) {
  return [...entries].sort((a, b) => {
    if ((a.kind === 'directory') !== (b.kind === 'directory')) return a.kind === 'directory' ? -1 : 1;
    if (a.kind === 'directory') return collator.compare(a.name, b.name);
    const ta = entryTime(a), tb = entryTime(b);
    if (ta !== tb) { if (ta === null) return 1; if (tb === null) return -1; return tb - ta; }
    return collator.compare(logLabel(a).name, logLabel(b).name) || collator.compare(a.name, b.name);
  });
}

// Marks rows whose visible text collides with a sibling so the filename can be shown as a secondary line.
// Rows may carry a precomputed `short` time so each label is formatted once.
export function duplicateLabels(rows, now = new Date(), options) {
  const texts = rows.map(row => `${row.name}\u0000${row.short ?? formatShortTime(row.time, now, options)}`), counts = new Map();
  for (const text of texts) counts.set(text, (counts.get(text) || 0) + 1);
  return texts.map(text => counts.get(text) > 1);
}

export async function mapLimit(items, limit, task) {
  const results = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) { const i = next++; results[i] = await task(items[i], i); } }));
  return results;
}

// Lists one directory level: subfolders and *.ndjson files, newest logs first, bounded per level.
export async function listDirectory(handle, { limits = EXPLORER_LIMITS, signal, path = '', onProgress = () => {} } = {}) {
  const caps = { ...EXPLORER_LIMITS, ...limits }, directories = [], files = [];
  let scanned = 0, truncated = false;
  for await (const child of handle.values()) {
    signal?.throwIfAborted();
    if (skipEntry(child.name)) continue;
    if (scanned >= caps.maxScanned) { truncated = true; break; }
    scanned++;
    if (child.kind === 'directory') directories.push({ kind: 'directory', name: child.name, path: path + child.name + '/', handle: child });
    else if (child.kind === 'file' && isLogFile(child.name)) files.push(child);
    if (scanned % 100 === 0) onProgress(scanned);
  }
  const stats = await mapLimit(files, caps.concurrency * 4, async child => {
    signal?.throwIfAborted();
    try { const file = await child.getFile(); return { kind: 'file', name: child.name, path: path + child.name, handle: child, size: file.size, lastModified: file.lastModified, file }; }
    catch (error) { return { kind: 'file', name: child.name, path: path + child.name, handle: child, size: null, lastModified: null, error: error.message || 'Unreadable' }; }
  });
  stats.sort((a, b) => (b.lastModified ?? -Infinity) - (a.lastModified ?? -Infinity));
  const keptDirs = directories.sort((a, b) => collator.compare(a.name, b.name)).slice(0, caps.maxEntries);
  const keptLogs = stats.slice(0, caps.maxEntries);
  let done = 0;
  await mapLimit(keptLogs, caps.concurrency, async entry => {
    signal?.throwIfAborted();
    if (entry.error) entry.header = { error: 'Unreadable' };
    else if (entry.size > caps.maxFileBytes) entry.header = { error: 'Too large' };
    else { try { entry.header = await readHead(entry.file, caps.headBytes); } catch (error) { entry.header = { error: 'Unreadable', message: error.message }; } }
    delete entry.file;
    onProgress(scanned, ++done);
  });
  // Overflow counts only folders and logs that were found but not shown; truncated means the scan itself stopped.
  const overflow = directories.length - keptDirs.length + stats.length - keptLogs.length;
  return { entries: sortEntries([...keptDirs, ...keptLogs]), overflow, truncated, scanned, logs: stats.length };
}

// Directory-handle shape over an <input webkitdirectory> FileList. Snapshot only; never persisted.
export function memoryDirectory(fileList, { maxFiles = EXPLORER_LIMITS.maxScanned } = {}) {
  const root = { kind: 'directory', name: '', children: new Map() };
  let count = 0, truncated = false;
  for (const file of fileList) {
    if (count >= maxFiles) { const parts = String(file.webkitRelativePath || file.name).split('/'); if (isLogFile(parts.at(-1))) { truncated = true; break; } continue; }
    const parts = String(file.webkitRelativePath || file.name).split('/').filter(Boolean);
    // Same visibility rules as listDirectory, applied before the cap so ignored files never use it.
    if (!parts.length || !isLogFile(parts.at(-1)) || parts.slice(parts.length > 1 ? 1 : 0, -1).some(skipEntry)) continue;
    count++;
    if (!root.name && parts.length > 1) root.name = parts[0];
    let node = root;
    for (const part of parts.slice(parts.length > 1 ? 1 : 0, -1)) {
      if (!node.children.has(part)) node.children.set(part, { kind: 'directory', name: part, children: new Map() });
      node = node.children.get(part);
    }
    node.children.set(parts.at(-1), { kind: 'file', name: parts.at(-1), file });
  }
  const wrap = node => node.kind === 'file'
    ? { kind: 'file', name: node.name, getFile: async () => node.file }
    : { kind: 'directory', name: node.name, memory: true, async *values() { for (const child of node.children.values()) yield wrap(child); }, async isSameEntry(other) { return other === this; } };
  const handle = wrap(root);
  if (!handle.name) handle.name = 'Selected folder';
  return Object.assign(handle, { truncated, count });
}

// Groups an imported capture's sessions by the files that contain their events.
export function sessionsByFile(capture) {
  if (!capture) return [];
  const byFile = new Map(capture.files.map(file => [file.id, []]));
  const order = new Map(capture.files.map((file, index) => [file.id, index]));
  // A session split across files is listed once, under the earliest file that contains it.
  for (const session of capture.sessions) {
    let best = null;
    for (const recording of session.recordings) for (const event of recording.events) { const id = capture.sourceLines?.[event.event_id]?.[0]?.fileId; if (id && (best === null || order.get(id) < order.get(best))) best = id; }
    byFile.get(best ?? capture.files[0]?.id)?.push(session);
  }
  return capture.files.map(file => ({ file, sessions: byFile.get(file.id) || [] }));
}

export const machineLabel = name => (typeof name === 'string' && name.trim() ? name.trim().split('.')[0] || name.trim() : null);
