import { IMPORT_LIMITS } from './model.mjs';

// Folder listing reads bounded file heads only; full parsing happens on open through the import pipeline.
export const EXPLORER_LIMITS = Object.freeze({ firstHeadBytes: 64 * 1024, headBytes: 256 * 1024, maxLogs: 2000, pageLogs: 200, maxScanned: 5000, maxDepth: 8, concurrency: 4, maxFolders: 20, maxFileBytes: IMPORT_LIMITS.maxFileBytes, maxNameLength: 120 });
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
  return { name, startedAt, sessions: sessions.size, events, invalid, complete, unknown, error, found: started.size > 0 };
}

// Reads a small first slice; only a larger file without session.started in it escalates to the full head.
export async function readHead(file, bytes = EXPLORER_LIMITS.headBytes, first = EXPLORER_LIMITS.firstHeadBytes) {
  const read = async size => { const complete = file.size <= size; return readLogHeader(await (complete ? file : file.slice(0, size)).text(), { complete }); };
  if (first < bytes && file.size > first) { const head = await read(first); if (head.found) return head; }
  return read(bytes);
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

// Runs at most n tasks at once; one instance is shared by every folder scan so head reads stay bounded overall.
export function limiter(n) {
  let active = 0; const waiting = [];
  const next = () => {
    if (active >= n || !waiting.length) return;
    active++; const { task, resolve, reject } = waiting.shift();
    Promise.resolve().then(task).then(resolve, reject).finally(() => { active--; next(); });
  };
  return task => new Promise((resolve, reject) => { waiting.push({ task, resolve, reject }); next(); });
}

// path → log entry of a previous scan, so unchanged files (same size and lastModified) keep their header.
export function headerIndex(entries, index = new Map()) {
  for (const entry of entries || []) entry.kind === 'directory' ? headerIndex(entry.entries, index) : entry.header && index.set(entry.path, entry);
  return index;
}

// Walks an added folder breadth-first (bounded by depth and scanned entries), keeps the newest maxLogs logs,
// reads their heads and returns the nested tree of folders that contain logs somewhere below; empty folders are pruned.
export async function scanTree(handle, { limits = EXPLORER_LIMITS, signal, onProgress = () => {}, limit, previous } = {}) {
  const caps = { ...EXPLORER_LIMITS, ...limits }, run = limit ?? limiter(caps.concurrency);
  const root = { kind: 'directory', name: handle.name, path: '', handle, entries: [] }, files = [], queue = [[root, 0]];
  let scanned = 0, truncated = false, tooDeep = 0, unreadable = 0;
  walk: for (const [node, depth] of queue) {
    signal?.throwIfAborted();
    // The added folder itself failing is a folder error; one unreadable subfolder only drops that branch.
    const failed = error => { if (node === root || error?.name === 'AbortError' || signal?.aborted) throw error; unreadable++; };
    let iterator;
    try { iterator = node.handle.values(); } catch (error) { failed(error); continue; }
    for (;;) {
      let step;
      try { step = await iterator.next(); } catch (error) { failed(error); break; }
      if (step.done) break;
      signal?.throwIfAborted();
      const child = step.value;
      if (skipEntry(child.name)) continue;
      if (scanned >= caps.maxScanned) { truncated = true; await iterator.return?.(); break walk; }
      scanned++;
      if (child.kind === 'directory') {
        // depth counts subfolders below the added folder; maxDepth of them are scanned.
        if (depth >= caps.maxDepth) tooDeep++;
        else { const dir = { kind: 'directory', name: child.name, path: node.path + child.name + '/', handle: child, entries: [] }; node.entries.push(dir); queue.push([dir, depth + 1]); }
      } else if (child.kind === 'file' && isLogFile(child.name)) {
        const entry = { kind: 'file', name: child.name, path: node.path + child.name, handle: child };
        node.entries.push(entry); files.push(entry);
      }
      if (scanned % 100 === 0) onProgress(files.length);
    }
  }
  // Metadata is cheap; it decides which logs are kept (newest first) before any head is read.
  await mapLimit(files, caps.concurrency * 4, async entry => {
    signal?.throwIfAborted();
    try { const file = await entry.handle.getFile(); Object.assign(entry, { size: file.size, lastModified: file.lastModified, file }); }
    catch { Object.assign(entry, { size: null, lastModified: null, header: { error: 'Unreadable' } }); }
  });
  const kept = new Set([...files].sort((a, b) => (b.lastModified ?? -Infinity) - (a.lastModified ?? -Infinity)).slice(0, caps.maxLogs));
  for (const entry of files) if (!kept.has(entry)) delete entry.file;
  onProgress(kept.size, 0);
  let read = 0;
  await mapLimit([...kept], caps.concurrency, entry => run(async () => {
    const { file } = entry; delete entry.file;
    signal?.throwIfAborted();
    const old = previous?.get(entry.path);
    // An unreadable file already carries its error header; an unchanged one keeps the previous scan's header.
    const reuse = old?.header && old.size === entry.size && old.lastModified === entry.lastModified;
    if (file) entry.header = reuse ? old.header : file.size > caps.maxFileBytes ? { error: 'Too large' } : await readHead(file, caps.headBytes, caps.firstHeadBytes).catch(error => ({ error: 'Unreadable', message: error.message }));
    onProgress(kept.size, ++read);
  }));
  const finish = ({ handle: _, ...node }) => {
    const entries = []; let logs = 0;
    for (const child of node.entries) {
      if (child.kind === 'file') { if (kept.has(child)) { entries.push(child); logs++; } }
      else { const sub = finish(child); if (sub.logs) { entries.push(sub); logs += sub.logs; } }
    }
    return { ...node, entries: sortEntries(entries), logs };
  };
  const tree = finish(root);
  return { entries: tree.entries, logs: tree.logs, scanned, truncated, logLimit: files.length > kept.size, tooDeep, unreadable };
}

// Directory-handle shape over an <input webkitdirectory> FileList. Snapshot only; never persisted.
export function memoryDirectory(fileList, { maxFiles = EXPLORER_LIMITS.maxScanned } = {}) {
  const root = { kind: 'directory', name: '', children: new Map() };
  let count = 0, truncated = false;
  for (const file of fileList) {
    if (count >= maxFiles) { const parts = String(file.webkitRelativePath || file.name).split('/'); if (isLogFile(parts.at(-1))) { truncated = true; break; } continue; }
    const parts = String(file.webkitRelativePath || file.name).split('/').filter(Boolean);
    // Same visibility rules as scanTree, applied before the cap so ignored files never use it.
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
