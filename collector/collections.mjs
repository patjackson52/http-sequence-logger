import { randomUUID } from 'node:crypto';
import { TransferError } from './store.mjs';
import { parseRecords } from './adapters.mjs';
async function withAbort(task, signal) {
  signal.throwIfAborted(); let abort;
  const aborted = new Promise((_, reject) => { abort = () => reject(signal.reason || new Error('Cancelled')); signal.addEventListener('abort', abort, {once:true}); });
  try { return await Promise.race([task,aborted]); } finally { signal.removeEventListener('abort',abort); }
}
export class CollectionManager {
  constructor(collector, adapters = [], changed = () => {}) {
    this.collector = collector; this.adapters = new Map(); this.jobs = new Map(); this.changed = changed; this.closed = false;
    for (const adapter of adapters) { if (!adapter.id || this.adapters.has(adapter.id) || typeof adapter.query !== 'function' || typeof adapter.parser !== 'function') throw new TypeError('Invalid or duplicate collection adapter'); this.adapters.set(adapter.id, adapter); }
    this.enrollments = new Map();
  }
  snapshot(job) { const { abort, task, key, ...value } = job; return structuredClone(value); }
  list() { return { adapters: [...this.adapters.values()].map(x => ({ adapter_id: x.id, kind: x.kind })), jobs: [...this.jobs.values()].map(x => this.snapshot(x)) }; }
  get(id) { const job = this.jobs.get(id); if (!job) throw new TransferError(404, 'Collection job unavailable'); return this.snapshot(job); }
  cancel(id) { const job = this.jobs.get(id); if (!job) throw new TransferError(404, 'Collection job unavailable'); if (['queued', 'running'].includes(job.state)) { job.state = 'cancelled'; job.abort.abort(); this.changed(); } return this.snapshot(job); }
  async start(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TransferError(400, 'Collection request must be an object');
    if (this.closed) throw new TransferError(503, 'Collector closing');
    const selected = request.adapter_ids ?? [...this.adapters.keys()];
    if (!Array.isArray(selected) || selected.length > 32 || selected.some(x => !this.adapters.has(x))) throw new TransferError(400, 'Unknown collection adapter');
    const traceIDs = request.trace_ids ?? await this.collector.store.traceSeeds(request);
    if (!Array.isArray(traceIDs) || !traceIDs.length || traceIDs.length > 64 || traceIDs.some(x => !/^(?!0{32}$)[0-9a-f]{32}$/.test(x))) throw new TransferError(400, 'Select a capture with trace IDs (maximum 64)');
    const window = request.time_window;
    if (window && (!Number.isFinite(Date.parse(window.start)) || !Number.isFinite(Date.parse(window.end)) || Date.parse(window.end) < Date.parse(window.start) || Date.parse(window.end) - Date.parse(window.start) > 86400000)) throw new TransferError(400, 'Time window must be ordered and at most 24 hours');
    const normalized = { trace_ids: [...new Set(traceIDs)].sort(), adapter_ids: [...new Set(selected)].sort(), ...(window ? { time_window: window } : {}) };
    const key = JSON.stringify(normalized);
    for (const job of this.jobs.values()) if (job.key === key && ['queued', 'running'].includes(job.state)) return this.snapshot(job);
    if ([...this.jobs.values()].filter(x => ['queued', 'running'].includes(x.state)).length >= 4) throw new TransferError(429, 'Collection capacity busy');
    while (this.jobs.size >= 32) { const old = [...this.jobs.values()].find(x => !['queued', 'running'].includes(x.state)); if (!old) break; this.jobs.delete(old.job_id); }
    const job = { job_id: randomUUID(), key, ...normalized, state: 'queued', event_count: 0, sources: normalized.adapter_ids.map(adapter_id => ({ adapter_id, state: 'queued', event_count: 0, parse_errors: 0, unmatched: 0 })), abort: new AbortController() };
    this.jobs.set(job.job_id, job); this.changed(); job.task = this.run(job).catch(() => { if (job.state !== 'cancelled') job.state = 'failed'; this.changed(); }); return this.snapshot(job);
  }
  async enrollment(adapter) {
    if (!this.enrollments.has(adapter.id)) this.enrollments.set(adapter.id, this.collector.enroll({ platform: 'server', ...adapter.metadata, registration_id: `adapter:${adapter.id}` }, `collection:${adapter.id}`).catch(error => { this.enrollments.delete(adapter.id); throw error; }));
    return this.enrollments.get(adapter.id);
  }
  async run(job) {
    job.state = 'running'; this.changed(); const timer = setTimeout(() => job.abort.abort(new Error('Collection deadline exceeded')), 30000); timer.unref();
    try {
      for (const status of job.sources) {
        if (job.state === 'cancelled') break;
        const adapter = this.adapters.get(status.adapter_id); status.state = 'running'; this.changed();
        try {
          const credentials = await this.enrollment(adapter); let cursor, records = 0, bytes = 0; const retained = [];
          for (let page = 0; page < 20; page++) {
            job.abort.signal.throwIfAborted();
            const result = await withAbort(adapter.query({ trace_ids: job.trace_ids, time_window: job.time_window, cursor, max_records: Math.min(500, 5000 - records), max_bytes: Math.min(1024 * 1024, 8 * 1024 * 1024 - bytes), signal: job.abort.signal }), job.abort.signal);
            job.abort.signal.throwIfAborted();
            if (!Array.isArray(result.records) || result.records.length > 500) throw new Error('Adapter exceeded record limit');
            records += result.records.length; bytes += Buffer.byteLength(JSON.stringify(result.records));
            if (bytes > 8 * 1024 * 1024) throw new Error('Adapter exceeded byte limit');
            retained.push(...result.records);
            status.sampled ||= Boolean(result.sampled); status.truncated ||= Boolean(result.truncated);
            if (!result.has_more) break;
            if (!result.cursor || result.cursor === cursor || records >= 5000 || bytes >= 8 * 1024 * 1024 || page === 19) { status.truncated = true; break; }
            cursor = result.cursor;
          }
            const parsed = parseRecords(adapter, retained, job.trace_ids, job.time_window);
            status.parse_errors += parsed.parse_errors; status.unmatched += parsed.unmatched; status.diagnostics = parsed.examples;

            let batch = [], size = 0;
            const flush = async () => { if (!batch.length) return; job.abort.signal.throwIfAborted(); const ingested = await this.collector.ingest(credentials.source_token, batch.join('\n') + '\n'); status.event_count += ingested.accepted; job.event_count += ingested.accepted; batch = []; size = 0; };
            for (const event of parsed.events) { const line = JSON.stringify(event); if (Buffer.byteLength(line) + 1 > this.collector.store.limits.batchBytes) { status.parse_errors++; continue; } if (batch.length >= 500 || size + Buffer.byteLength(line) + 1 > this.collector.store.limits.batchBytes) await flush(); batch.push(line); size += Buffer.byteLength(line) + 1; }
            await flush(); this.changed();
          status.state = 'completed';
        } catch (error) { status.state = job.state === 'cancelled' ? 'cancelled' : 'failed'; status.reason = job.abort.signal.aborted ? 'Collection cancelled or deadline exceeded' : 'Collection source failed; inspect configured adapter'; }
        this.changed();
      }
      if (job.state !== 'cancelled') job.state = job.sources.some(x => x.state === 'failed') ? 'failed' : 'completed';
      else for (const source of job.sources) if (source.state === 'queued') source.state = 'cancelled';
    } finally { clearTimeout(timer); this.changed(); }
  }
  async close() { this.closed = true; for (const job of this.jobs.values()) this.cancel(job.job_id); await Promise.allSettled([...this.jobs.values()].map(x => x.task)); }
}
