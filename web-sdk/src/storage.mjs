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
    this._bytes += bytes;
    return true;
  }

  exportNDJSON() { return this._lines.join(""); }
  async flush() {}
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
    try { request = factory.open(name, 1); }
    catch { finish(new Error("IndexedDB could not be opened")); return; }
    request.onupgradeneeded = () => {
      if (settled) { request.transaction.abort(); return; }
      const db = request.result;
      db.createObjectStore("journals", { keyPath: "id" });
      const records = db.createObjectStore("events", { keyPath: ["journalId", "index"] });
      records.createIndex("journal", "journalId");
    };
    request.onsuccess = () => finish(null, request.result);
    request.onerror = () => finish(new Error("IndexedDB could not be opened"));
    request.onblocked = () => finish(new Error("IndexedDB opening is blocked by another tab"));
  });
}

/** One writer per journal. A stale concurrent writer fails rather than replacing data. */
export class IndexedDBJournal extends MemoryJournal {
  static async open({ databaseName = "http-sequence-logger", journalId, indexedDB = globalThis.indexedDB, openTimeoutMs = 5000, ...options } = {}) {
    if (typeof journalId !== "string" || !journalId || journalId.length > 512)
      throw new TypeError("A journalId of 1–512 characters is required");
    if (typeof databaseName !== "string" || !databaseName || databaseName.length > 256)
      throw new TypeError("A databaseName of 1–256 characters is required");
    if (!Number.isSafeInteger(openTimeoutMs) || openTimeoutMs < 1)
      throw new TypeError("openTimeoutMs must be positive");
    if (!indexedDB) throw new Error("IndexedDB is unavailable; use a memory journal and export");
    const journal = new IndexedDBJournal(options);
    journal._journalId = journalId;
    journal._db = await openDatabase(indexedDB, databaseName, openTimeoutMs);
    try {
      journal._db.onversionchange = () => {
        journal._error = "IndexedDB changed in another tab; reopen this journal";
        journal._db.close();
      };
      journal._db.onclose = () => {
        if (!journal._closed) journal._error = "IndexedDB closed unexpectedly; memory export remains available";
      };
      await journal._load();
      return journal;
    } catch (error) { journal._db.close(); throw error; }
  }

  constructor(options) {
    super(options);
    this._queue = Promise.resolve();
    this._persistedEvents = 0;
    this._closed = false;
  }

  _load() {
    return new Promise((resolve, reject) => {
      let tx;
      try { tx = this._db.transaction(["journals", "events"], "readonly"); }
      catch { reject(new Error("IndexedDB journal stores are unavailable")); return; }
      let metadata = null, failure = null;
      const fail = (message) => { failure = new Error(message); tx.abort(); };
      const meta = tx.objectStore("journals").get(this._journalId);
      meta.onsuccess = () => { metadata = meta.result; };
      const records = tx.objectStore("events").index("journal").openCursor(this._journalId);
      records.onsuccess = () => {
        const cursor = records.result;
        if (!cursor) return;
        const record = cursor.value;
        try {
          if (record.index !== this._lines.length || !super.append(record.line)) {
            fail("Stored journal is inconsistent or exceeds configured limits"); return;
          }
        } catch { fail("Stored journal contains an invalid event"); return; }
        cursor.continue();
      };
      tx.onabort = () => reject(failure || new Error("IndexedDB journal could not be read"));
      tx.onerror = () => {};
      tx.oncomplete = () => {
        if ((metadata?.events ?? 0) !== this._lines.length || (metadata?.bytes ?? 0) !== this._bytes) {
          reject(new Error("Stored journal accounting is inconsistent")); return;
        }
        this._persistedEvents = this._lines.length;
        resolve();
      };
    });
  }

  append(value) {
    if (this._closed) { this._dropped++; return false; }
    const index = this._lines.length, priorBytes = this._bytes;
    if (!super.append(value)) return false;
    const line = this._lines[index], bytes = this._bytes;
    this._queue = this._queue.then(async () => {
      if (this._error) return;
      try { await this._persist(index, priorBytes, bytes, line); }
      catch (error) { this._error = error.message; }
    });
    return true;
  }

  _persist(index, priorBytes, bytes, line) {
    return new Promise((resolve, reject) => {
      let tx;
      try { tx = this._db.transaction(["journals", "events"], "readwrite", { durability: "strict" }); }
      catch { reject(new Error("IndexedDB is unavailable; memory export remains available")); return; }
      let failure = "IndexedDB write failed; memory export remains available";
      const request = tx.objectStore("journals").get(this._journalId);
      request.onsuccess = () => {
        const previous = request.result;
        if ((previous?.events ?? 0) !== index || (previous?.bytes ?? 0) !== priorBytes) {
          failure = "Another writer changed this journal; use a unique journalId or reopen after closing that writer";
          tx.abort(); return;
        }
        tx.objectStore("events").add({ journalId: this._journalId, index, line });
        tx.objectStore("journals").put({ id: this._journalId, events: index + 1, bytes });
      };
      tx.oncomplete = () => { this._persistedEvents = index + 1; resolve(); };
      tx.onabort = () => reject(new Error(failure));
      tx.onerror = () => {};
    });
  }

  async flush() {
    await this._queue;
    if (this._error) throw new Error(this._error);
  }
  async close() {
    this._closed = true;
    try { await this.flush(); } finally { this._db.close(); }
  }
  get stats() {
    return { ...super.stats, persistedEvents: this._persistedEvents, pending: this._lines.length - this._persistedEvents, closed: this._closed };
  }
}
