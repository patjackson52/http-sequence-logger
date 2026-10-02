const encoder = new TextEncoder();
const defaults = { maxBytes: 8 * 1024 * 1024, maxEvents: 10_000 };

function limits(options) {
  const result = { ...defaults, ...options };
  for (const key of ["maxBytes", "maxEvents"])
    if (!Number.isSafeInteger(result[key]) || result[key] < 1)
      throw new TypeError(`${key} must be a positive safe integer`);
  return result;
}

function canonicalLine(value) {
  if (typeof value !== "string") throw new TypeError("Expected an NDJSON line");
  const text = value.endsWith("\n") ? value.slice(0, -1) : value;
  if (!text || /[\r\n]/.test(text))
    throw new TypeError("Expected one complete NDJSON event");
  const event = JSON.parse(text);
  if (!event || typeof event !== "object" || Array.isArray(event))
    throw new TypeError("Expected a JSON event object");
  return text + "\n";
}

/** Stores already-sanitized events. This class does not redact raw input. */
export class MemoryJournal {
  constructor(options = {}) {
    this._limits = limits(options);
    this._lines = [];
    this._bytes = 0;
    this._dropped = 0;
    this._error = null;
    this._listeners = new Set(); this._deliveries = new Map();
    this._identity = {journal_id: globalThis.crypto.randomUUID(), installation_id: globalThis.crypto.randomUUID(), environment_id: globalThis.crypto.randomUUID(), instance_id: globalThis.crypto.randomUUID()};
  }

  append(value) {
    // Bound input before JSON parsing, including a caller-provided large string.
    if (typeof value === "string" && value.length > this._limits.maxBytes) {
      this._dropped++;
      return false;
    }
    const line = canonicalLine(value);
    const bytes = encoder.encode(line).byteLength;
    if (this._lines.length >= this._limits.maxEvents || this._bytes + bytes > this._limits.maxBytes) {
      this._dropped++;
      return false;
    }
    this._lines.push(line);
    for (const listener of this._listeners) { try { listener(); } catch {} }
    this._bytes += bytes;
    return true;
  }

  get identity() { return this._identity; }
  exportNDJSON() { return this._lines.join(""); }
  async flush() {}
  subscribe(listener) { this._listeners.add(listener); return () => this._listeners.delete(listener); }
  async readPage(after = 0, {maxEvents = 500, maxBytes = 1024 * 1024} = {}) { const lines = []; let bytes = 0; for (const line of this._lines.slice(after, after + maxEvents)) { const size = encoder.encode(line).byteLength; if (size > maxBytes) throw new Error("Journal event exceeds batch byte limit"); if (bytes + size > maxBytes) break; lines.push(line); bytes += size; } return {lines, next: after + lines.length}; }
  getDeliveryCursor(collectorId, sourceId) { return this._deliveries.get(collectorId + ":" + sourceId) || 0; }
  async acknowledge(collectorId, sourceId, cursor) { this._deliveries.set(collectorId + ":" + sourceId, cursor); }
  get stats() {
    return { bytes: this._bytes, events: this._lines.length, dropped: this._dropped, error: this._error };
  }
}

function openDatabase(factory, name, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, db) => {
      if (settled) { db?.close(); return; }
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(db);
    };
    const timer = setTimeout(() => finish(new Error("IndexedDB opening timed out")), timeoutMs);
    let request;
    try { request = factory.open(name, 2); }
    catch { finish(new Error("IndexedDB could not be opened")); return; }
    request.onupgradeneeded = () => {
      if (settled) { request.transaction.abort(); return; }
      const db = request.result;
      if (db.objectStoreNames.contains("journals")) { request.transaction.abort(); return; }
      db.createObjectStore("journals", { keyPath: "id" });
      const records = db.createObjectStore("events", { keyPath: ["journalId", "index"] });
      records.createIndex("journal", "journalId");
    };
    request.onsuccess = () => finish(null, request.result);
    request.onerror = () => finish(new Error("IndexedDB could not be opened"));
    request.onblocked = () => finish(new Error("IndexedDB opening is blocked by another tab"));
  });
}

/** Metadata-first persistent journal. Every mutation checks a transactional owner epoch. */
export class IndexedDBJournal extends MemoryJournal {
  static async open({ databaseName = "http-sequence-logger-v2", journalId, indexedDB = globalThis.indexedDB, openTimeoutMs = 5000, leaseMs = 15000, now = Date.now, locks = globalThis.navigator?.locks, ...options } = {}) {
    if (typeof journalId !== "string" || !journalId || journalId.startsWith("@") || journalId.length > 256) throw new TypeError("A journalId of 1–512 characters is required");
    if (typeof databaseName !== "string" || !databaseName || databaseName.length > 256) throw new TypeError("Invalid databaseName");
    if (!Number.isSafeInteger(openTimeoutMs) || openTimeoutMs < 1 || !Number.isSafeInteger(leaseMs) || leaseMs < 100) throw new TypeError("Invalid journal timeout");
    if (!indexedDB) throw new Error("IndexedDB is unavailable; use a memory journal and export");
    const journal = new IndexedDBJournal(options);
    if (locks) {
      await new Promise((resolve, reject) => {
        journal._browserLockTask = locks.request("network-log:" + databaseName + ":" + journalId, {ifAvailable:true}, lock => {
          if (!lock) { reject(new Error("Another writer owns this journal")); return; }
          journal._hasBrowserLock = true;
          const held = new Promise(release => { journal._releaseBrowserLock = release; }); resolve(); return held;
        }); journal._browserLockTask.catch(reject);
      });
    }
    let db;try {db=await openDatabase(indexedDB,databaseName,openTimeoutMs);} catch(error){journal._releaseBrowserLock?.();await journal._browserLockTask;throw error;}
    Object.assign(journal, { _journalId: journalId, _owner: globalThis.crypto.randomUUID(), _leaseMs: leaseMs, _now: now, _db: db });
    try {
      const environmentDb = await openDatabase(indexedDB, "http-sequence-logger-environment-v2", openTimeoutMs);
      const identityRecord = db => new Promise((resolve, reject) => { const tx = db.transaction("journals", "readwrite"); const store = tx.objectStore("journals"), request = store.get("@environment"); let result; request.onsuccess = () => { result = request.result || {id:"@environment", environmentId:globalThis.crypto.randomUUID(), installationId:globalThis.crypto.randomUUID()}; store.put(result); }; tx.oncomplete = () => resolve(result); tx.onabort = () => reject(new Error("Identity persistence failed")); });
      let environment;
      try { environment = await identityRecord(environmentDb); } finally { environmentDb.close(); }
      const shared = {...await identityRecord(journal._db), environmentId: environment.environmentId};
      const metadata = await journal._transaction(meta => {
        if (meta?.owner && meta.expires > now() && !journal._hasBrowserLock) throw new Error("Another writer owns this journal");
        const next = { id: journalId, events: 0, bytes: 0, installationId: shared.installationId, environmentId: shared.environmentId, deliveries: {}, ...meta, owner: journal._owner, epoch: (meta?.epoch || 0) + 1, expires: now() + leaseMs };
        if (next.events > journal._limits.maxEvents || next.bytes > journal._limits.maxBytes) throw new Error("Stored journal exceeds configured limits");
        return next;
      }, false);
      journal._epoch = metadata.epoch; journal._meta = metadata;
      journal._bytes = metadata.bytes; journal._persistedEvents = metadata.events; journal._events = metadata.events;
      journal._renewTimer = setInterval(() => journal._queue = journal._queue.then(() => journal._transaction(meta => ({ ...meta, expires: now() + leaseMs }))).catch(error => { journal._error = error.message; }), Math.floor(leaseMs / 3));
      journal._renewTimer.unref?.();
      journal._db.onversionchange = () => { journal._error = "IndexedDB changed; reopen journal"; journal._db.close(); };
      return journal;
    } catch (error) { journal._db.close(); journal._releaseBrowserLock?.(); await journal._browserLockTask; throw error; }
  }
  constructor(options) { super(options); this._events = 0; this._persistedEvents = 0; this._queue = Promise.resolve(); this._pending = []; this._pendingBytes = 0; this._queuedBytes = 0; this._closed = false; this._listeners = new Set(); }
  _transaction(update, fence = true, stores = ["journals"]) {
    return new Promise((resolve, reject) => {
      let failure, result, tx;
      try { tx = this._db.transaction(stores, "readwrite", { durability: "strict" }); } catch (error) { reject(error); return; }
      const request = tx.objectStore("journals").get(this._journalId);
      request.onsuccess = () => {
        try {
          const meta = request.result;
          if (fence && (meta?.owner !== this._owner || meta.epoch !== this._epoch)) throw new Error("Journal owner expired or was replaced; reopen after closing this writer");
          result = update(meta, tx); tx.objectStore("journals").put(result);
        } catch (error) { failure = error; tx.abort(); }
      };
      tx.oncomplete = () => { this._meta = result; resolve(result); };
      tx.onabort = () => reject(failure || new Error("IndexedDB write failed; pending memory export remains available")); tx.onerror = () => {};
    });
  }
  append(value) {
    if (this._closed || this._error) { this._dropped++; return false; }
    if (typeof value === "string" && value.length > this._limits.maxBytes) { this._dropped++; return false; }
    const line = canonicalLine(value), bytes = encoder.encode(line).byteLength;
    if (this._events >= this._limits.maxEvents || this._bytes + bytes > this._limits.maxBytes || this._events - this._persistedEvents >= 500 || this._queuedBytes + bytes > 1024 * 1024) { this._dropped++; return false; }
    this._pending.push({ line, index: this._events++ }); this._pendingBytes += bytes; this._queuedBytes += bytes; this._bytes += bytes;
    if (!this._scheduled) { this._scheduled = true; queueMicrotask(() => this._schedule()); }
    return true;
  }
  _schedule() {
    this._scheduled = false;
    if (!this._pending.length || this._error) return;
    const records = this._pending; this._pending = []; this._pendingBytes = 0;
    this._queue = this._queue.then(async () => {
      if (this._error) { this._pending.unshift(...records); return; }
      try {
        await this._transaction((meta, tx) => {
          if (meta.events !== records[0].index) throw new Error("Journal accounting changed");
          let bytes = meta.bytes;
          for (const record of records) { tx.objectStore("events").add({ journalId: this._journalId, ...record }); bytes += encoder.encode(record.line).byteLength; }
          return { ...meta, events: meta.events + records.length, bytes, expires: this._now() + this._leaseMs };
        }, true, ["journals", "events"]);
        this._persistedEvents += records.length; this._queuedBytes -= records.reduce((sum,record)=>sum+encoder.encode(record.line).byteLength,0);
        for (const listener of this._listeners) { try { listener(); } catch {} }
      } catch (error) { this._error = error.message; this._pending.unshift(...records); }
    });
  }
  async flush() { if (this._scheduled) this._schedule(); await this._queue; if (this._error) throw new Error(this._error); }
  async readPage(after = 0, { maxEvents = 500, maxBytes = 1024 * 1024 } = {}) {
    await this.flush();
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction("events", "readonly"), records = [];
      let bytes = 0;
      const request = tx.objectStore("events").openCursor();
      request.onsuccess = () => {
        const cursor = request.result; if (!cursor) return;
        const record = cursor.value;
        if (record.journalId < this._journalId || (record.journalId === this._journalId && record.index < after)) { cursor.continue([this._journalId, after]); return; }
        if (record.journalId !== this._journalId) return;
        const size = encoder.encode(record.line).byteLength;
        if (records.length && (records.length >= maxEvents || bytes + size > maxBytes)) return;
        if (size > maxBytes) { tx.abort(); return; }
        records.push(record); bytes += size; cursor.continue();
      };
      tx.oncomplete = () => resolve({ lines: records.map(r => r.line), next: records.length ? records.at(-1).index + 1 : after });
      tx.onabort = () => reject(new Error("IndexedDB range read failed")); tx.onerror = () => {};
    });
  }
  async exportNDJSON() { let after = 0, text = ""; for (;;) { const page = await this.readPage(after); if (!page.lines.length) return text; text += page.lines.join(""); after = page.next; } }
  exportPendingNDJSON() { return this._pending.map(r => r.line).join(""); }
  subscribe(listener) { this._listeners.add(listener); return () => this._listeners.delete(listener); }
  get identity() { return { journal_id: this._journalId, installation_id: this._meta.installationId, environment_id: this._meta.environmentId, instance_id: this._owner }; }
  getDeliveryCursor(collectorId, sourceId) { return this._meta.deliveries?.[collectorId + ":" + sourceId] || 0; }
  async acknowledge(collectorId, sourceId, cursor) {
    await this.flush();
    await this._transaction(meta => {
      if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > meta.events) throw new Error("Invalid delivery cursor");
      const key = collectorId + ":" + sourceId;
      return { ...meta, deliveries: { ...meta.deliveries, [key]: Math.max(meta.deliveries?.[key] || 0, cursor) } };
    });
  }
  async close() {
    this._closed = true; clearInterval(this._renewTimer);
    try { await this.flush(); await this._transaction(meta => ({ ...meta, owner: null, expires: 0 })); }
    finally { this._db.close(); this._releaseBrowserLock?.(); await this._browserLockTask; }
  }
  get stats() { return { bytes: this._bytes, events: this._events, dropped: this._dropped, error: this._error, persistedEvents: this._persistedEvents, pending: this._events - this._persistedEvents, closed: this._closed }; }
}
