import { Worker } from "node:worker_threads";
import { resolve } from "node:path";
export const LIMITS = {
  batchBytes: 1024 * 1024,
  batchEvents: 500,
  journalBytes: 1024 * 1024 * 1024,
  sourceBytes: 512 * 1024 * 1024,
  physicalBytes: 4 * 1024 * 1024 * 1024,
  freeReserve: 64 * 1024 * 1024,
  sources: 1000,
  queueBytes: 16 * 1024 * 1024,
  sourceQueueBytes: 2 * 1024 * 1024,
  queueJobs: 128,
};
export class TransferError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export class CaptureStore {
  constructor(directory, limits = {}, options = {}) {
    this.directory = resolve(directory);
    this.path = resolve(directory, "capture.sqlite");
    this.limits = { ...LIMITS, ...limits };
    this.pending = new Map();
    this.queues = new Map();
    this.sequence = 0;
    this.bytes = 0;
    this.jobs = 0;
    this.sourceBytes = new Map();
    this.authSources = new Map();
    this.closed = false;
    this.worker = new Worker(new URL("./store-worker.mjs", import.meta.url), {
      execArgv: [],
      workerData: {
        directory: this.directory,
        limits: this.limits,
        testCommitGate: options.testCommitGate,
        testClock: options.testClock,
        testFilesystemFaults: options.testFilesystemFaults,
      },
    });
    this.ready = new Promise((ok, fail) => {
      this.readyReject = fail;
      this.worker.once("message", (m) => {
        if (m.error) {
          this.closed = true;
          this.worker.terminate();
          fail(new TransferError(m.error.status, m.error.message));
        } else {
          this.config = m.ready;
          this.cursor = m.ready.event_cursor;
          this.registryRevision = m.ready.registry_revision;
          ok(this);
        }
      });
    });
    this.worker.on("message", (m) => {
      if (!m.id) return;
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      this.bytes -= p.bytes;
      this.jobs--;
      this.sourceBytes.set(p.key, (this.sourceBytes.get(p.key) || 0) - p.bytes);
      if (m.result?.event_cursor != null) this.cursor = m.result.event_cursor;
      if (m.result?.registry_revision != null)
        this.registryRevision = m.result.registry_revision;
      m.error
        ? p.fail(new TransferError(m.error.status, m.error.message))
        : p.ok(m.result);
      this.active = false;
      this.dispatch();
      if (!this.pending.size) this.idleResolve?.();
    });
    this.worker.on("error", (e) => {
      this.readyReject?.(e);
      this.failAll(e);
    });
    this.worker.on("exit", (code) => {
      if (!this.closed) {
        const e = new TransferError(503, `Storage worker exited (${code})`);
        this.readyReject?.(e);
        this.failAll(e);
      }
    });
  }
  failAll(e) {
    for (const p of this.pending.values()) p.fail(e);
    this.pending.clear();
    this.queues.clear();
    this.bytes = 0;
    this.jobs = 0;
    this.closed = true;
    this.idleResolve?.();
  }
  async call(op, args = {}, key = "control") {
    await this.ready;
    if (this.closed || (this.closing && op !== "close"))
      throw new TransferError(503, "Store closing or closed");
    const bytes = Buffer.byteLength(args.text || "");
    if (
      this.jobs >=
        (key === "control"
          ? this.limits.queueJobs + 16
          : this.limits.queueJobs) ||
      this.bytes + bytes > this.limits.queueBytes ||
      (this.sourceBytes.get(key) || 0) + bytes > this.limits.sourceQueueBytes
    )
      throw new TransferError(429, "Collector busy; retry later");
    return new Promise((ok, fail) => {
      const id = ++this.sequence;
      this.pending.set(id, { ok, fail, bytes, key });
      this.bytes += bytes;
      this.jobs++;
      this.sourceBytes.set(key, (this.sourceBytes.get(key) || 0) + bytes);
      if (!this.queues.has(key)) this.queues.set(key, []);
      this.queues.get(key).push({ id, op, args });
      this.dispatch();
    });
  }
  dispatch() {
    if (this.active || !this.queues.size || this.closed) return;
    const [key, q] = this.queues.entries().next().value;
    const job = q.shift();
    this.queues.delete(key);
    if (q.length) this.queues.set(key, q);
    this.active = true;
    this.worker.postMessage(job);
  }
  cacheAuth(token, source_id) {
    this.authSources.set(token, source_id);
    if (this.authSources.size > 4000)
      this.authSources.delete(this.authSources.keys().next().value);
  }
  async authorize(token) {
    const result = await this.call("authorize", { token });
    this.cacheAuth(token, result.source_id);
    return result;
  }

  bindLocal(token, metadata) {
    return this.call("bindLocal", { token, metadata });
  }
  ticket(args) {
    return this.call("ticket", args);
  }
  async register(token, metadata) {
    const result = await this.call("register", { token, metadata });
    this.cacheAuth(result.source_token, result.source_id);
    return result;
  }
  presence(token, args = {}) {
    return this.call(
      "presence",
      { token, ...args },
      this.authSources.get(token) || token,
    );
  }
  async ingest(token, text, checkpoint) {
    const source_id =
      this.authSources.get(token) || (await this.authorize(token)).source_id;
    return this.call("ingest", { token, text, checkpoint }, source_id);
  }

  sources(args) {
    return this.call("sources", args);
  }
  page(args) {
    return this.call("page", typeof args === "number" ? { after: args } : args);
  }
  traceSeeds(args) { return this.call("traceSeeds", args); }
  sessions(args) {
    return this.call("sessions", args);
  }
  expirePresence(now) {
    return this.call("expirePresence", { now });
  }
  sourceStatus(source_id, status, reason) {
    return this.call("sourceStatus", { source_id, status, reason });
  }
  sourceReconciled(token, reason) {
    return this.call("sourceReconciled", { token, reason });
  }
  checkpoint(source_id, key) {
    return this.call("checkpoint", { source_id, key });
  }
  revoke(source_id) {
    return this.call("revoke", { source_id });
  }
  async rotate(source_id) {
    const result = await this.call("rotate", { source_id });
    this.cacheAuth(result.source_token, result.source_id);
    return result;
  }
  backup() {
    return this.call("backup");
  }
  status() {
    return this.call("status");
  }
  close() {
    return (this.closePromise ??= this.finishClose());
  }
  async finishClose() {
    if (this.closed) return;
    this.closing = true;
    await this.ready;
    if (this.pending.size)
      await new Promise((ok) => {
        this.idleResolve = ok;
      });
    if (this.closed) return;
    await this.call("close");
    this.closed = true;
    await this.worker.terminate();
  }
}
