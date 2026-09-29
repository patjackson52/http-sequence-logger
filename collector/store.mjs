import {
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  fsyncSync,
  closeSync,
  existsSync,
  truncateSync,
  unlinkSync,
  statSync,
  fstatSync,
} from "node:fs";
import { resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import validateEvent from "../shared/event-validator.mjs";
export const LIMITS = {
  batchBytes: 1024 * 1024,
  batchEvents: 500,
  journalBytes: 64 * 1024 * 1024,
  journalEvents: 100000,
};
export class TransferError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}
const stable = (value) => JSON.stringify(canonical(value));
export class CaptureStore {
  constructor(directory, limits = {}) {
    this.directory = resolve(directory);
    this.limits = { ...LIMITS, ...limits };
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.lockPath = resolve(this.directory, "collector.lock");
    if (existsSync(this.lockPath)) {
      let stale = false;
      try {
        const pid = Number(readFileSync(this.lockPath, "utf8"));
        if (!Number.isInteger(pid) || pid <= 0)
          throw new Error("Invalid collector lock; inspect before removing");
        try {
          process.kill(pid, 0);
        } catch (error) {
          if (error.code === "ESRCH") stale = true;
          else throw error;
        }
      } catch (error) {
        throw new Error(`Cannot inspect collector lock: ${error.message}`);
      }
      if (stale) unlinkSync(this.lockPath);
      else
        throw new Error(
          "This capture directory already has a running collector",
        );
    }
    writeFileSync(this.lockPath, String(process.pid), {
      flag: "wx",
      mode: 0o600,
    });
    try {
      this.path = resolve(this.directory, "capture.ndjson");
      this.statePath = resolve(this.directory, "connection-state.json");
      if (existsSync(this.statePath)) {
        this.config = JSON.parse(readFileSync(this.statePath, "utf8"));
        if (
          this.config.version !== 1 ||
          !["collector_id", "device_token", "browser_token"].every(
            (k) =>
              typeof this.config[k] === "string" && this.config[k].length >= 16,
          )
        )
          throw new Error("Invalid collector connection state");
      } else {
        this.config = {
          version: 1,
          collector_id: randomUUID(),
          device_token: randomBytes(32).toString("base64url"),
          browser_token: randomBytes(32).toString("base64url"),
        };
        writeFileSync(this.statePath, JSON.stringify(this.config), {
          mode: 0o600,
          flag: "wx",
        });
      }
      this.lines = [];
      this.events = new Map();
      this.sequences = new Map();
      this.recordings = new Map();
      this.bytes = 0;
      this.poisoned = false;
      this.recoveredPartial = false;
      if (existsSync(this.path)) {
        const raw = readFileSync(this.path);
        if (raw.length > this.limits.journalBytes)
          throw new Error("Existing journal exceeds storage limit");
        const complete = raw.lastIndexOf(10) + 1;
        if (complete < raw.length) {
          truncateSync(this.path, complete);
          this.recoveredPartial = true;
        }
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
          raw.subarray(0, complete),
        );
        for (const line of text.split("\n").filter(Boolean)) {
          const event = JSON.parse(line);
          this.checkEvent(event);
          if (this.events.has(event.event_id))
            throw new Error("Duplicate event in persisted journal");
          this.checkIdentity(event);
          this.remember(event, line);
        }
      } else writeFileSync(this.path, "", { mode: 0o600, flag: "wx" });
      if (this.cursor > this.limits.journalEvents)
        throw new Error("Existing journal exceeds event limit");
      this.fd = openSync(this.path, "a");
      this.diskSize = fstatSync(this.fd).size;
      if (this.recoveredPartial) fsyncSync(this.fd);
    } catch (error) {
      unlinkSync(this.lockPath);
      throw error;
    }
  }
  get cursor() {
    return this.lines.length;
  }
  checkEvent(event) {
    if (!validateEvent(event))
      throw new TransferError(
        400,
        "Event does not match capture schema 1.0/1.1",
      );
  }
  checkIdentity(
    event,
    sequences = this.sequences,
    recordings = this.recordings,
  ) {
    const seqKey = JSON.stringify([event.recording_id, event.sequence]);
    const prior = sequences.get(seqKey);
    if (prior && prior !== event.event_id)
      throw new TransferError(409, "Conflicting recording sequence");
    const identity = JSON.stringify([
      event.schema_version,
      event.session_namespace,
      event.session_id,
    ]);
    const old = recordings.get(event.recording_id);
    if (old && old.identity !== identity)
      throw new TransferError(409, "Conflicting recording identity");
    sequences.set(seqKey, event.event_id);
    if (!old)
      recordings.set(event.recording_id, {
        identity,
        sequences: new Set(),
        contiguous: 0,
      });
  }
  remember(event, line) {
    this.events.set(event.event_id, stable(event));
    this.lines.push(line);
    this.bytes += Buffer.byteLength(line) + 1;
    this.checkIdentity(event);
    const record = this.recordings.get(event.recording_id);
    record.sequences.add(event.sequence);
    while (record.sequences.has(record.contiguous + 1)) record.contiguous++;
  }
  ingest(text) {
    if (this.poisoned)
      throw new TransferError(
        503,
        "Journal write failed; restart the collector after checking storage",
      );
    // Do not acknowledge writes to an unlinked/replaced journal descriptor.
    try {
      const path = statSync(this.path),
        descriptor = fstatSync(this.fd);
      if (
        path.dev !== descriptor.dev ||
        path.ino !== descriptor.ino ||
        descriptor.size !== this.diskSize
      )
        throw new Error("Journal changed outside collector");
    } catch {
      this.poisoned = true;
      throw new TransferError(
        503,
        "Capture journal changed; stop the collector and inspect storage",
      );
    }
    if (Buffer.byteLength(text) > this.limits.batchBytes)
      throw new TransferError(413, "Batch exceeds byte limit");
    if (!text.endsWith("\n"))
      throw new TransferError(
        400,
        "Batch must end at a complete NDJSON newline",
      );
    const lines = text.split("\n").filter((l) => l.trim());
    if (!lines.length || lines.length > this.limits.batchEvents)
      throw new TransferError(400, "Batch must contain 1–500 events");
    const pending = [],
      seen = new Map(),
      sequences = new Map(this.sequences),
      recordings = new Map(this.recordings),
      ids = [],
      touched = new Set();
    let duplicate = 0,
      newBytes = 0;
    for (const line of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        throw new TransferError(400, "Invalid JSON line");
      }
      this.checkEvent(event);
      const normalized = stable(event);
      const existing =
        seen.get(event.event_id) || this.events.get(event.event_id);
      ids.push(event.event_id);
      touched.add(event.recording_id);
      if (existing) {
        if (existing !== normalized)
          throw new TransferError(409, "Conflicting event ID");
        duplicate++;
        continue;
      }
      this.checkIdentity(event, sequences, recordings);
      seen.set(event.event_id, normalized);
      pending.push({ event, line });
      newBytes += Buffer.byteLength(line) + 1;
    }
    if (
      this.bytes + newBytes > this.limits.journalBytes ||
      this.cursor + pending.length > this.limits.journalEvents
    )
      throw new TransferError(
        507,
        "Collector storage limit reached; export and start another capture directory",
      );
    if (pending.length) {
      try {
        appendFileSync(this.fd, pending.map((x) => x.line + "\n").join(""));
        fsyncSync(this.fd);
        this.diskSize += newBytes;
      } catch {
        this.poisoned = true;
        throw new TransferError(503, "Capture could not be persisted");
      }
      for (const { event, line } of pending) this.remember(event, line);
    }
    return {
      version: 1,
      collector_id: this.config.collector_id,
      accepted: pending.length,
      duplicates: duplicate,
      acknowledged_event_ids: ids,
      cursor: this.cursor,
      recordings: [...touched].map((id) => ({
        recording_id: id,
        highest_contiguous_sequence: this.recordings.get(id).contiguous,
      })),
    };
  }
  page(after) {
    if (!Number.isSafeInteger(after) || after < 0 || after > this.cursor)
      throw new TransferError(400, "Invalid capture cursor");
    const lines = [];
    let bytes = 0;
    for (const line of this.lines.slice(after, after + 500)) {
      const size = Buffer.byteLength(line);
      if (lines.length && bytes + size > this.limits.batchBytes) break;
      lines.push(line);
      bytes += size;
    }
    return {
      collector_id: this.config.collector_id,
      cursor: after + lines.length,
      lines,
      has_more: after + lines.length < this.cursor,
    };
  }
  close() {
    if (this.fd != null) {
      closeSync(this.fd);
      this.fd = null;
      try {
        unlinkSync(this.lockPath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
}
