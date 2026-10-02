import { freezeData, validateSourceReferences } from './comparison-data.mjs';

const aborted = () => new DOMException('Comparison cancelled.', 'AbortError');

/** Terminating the owned worker cancels synchronous engine work immediately. */
export class ComparisonClient {
  constructor({ workerFactory = () => new Worker(new URL('./comparison-worker.mjs', import.meta.url), { type: 'module' }) } = {}) {
    this.workerFactory = workerFactory; this.generation = 0; this.pending = null; this.disposed = false;
  }
  compare(primary, secondary, profile = {}, { signal } = {}) {
    return this._run({ primary: primary.document ?? primary.sequence ?? primary, secondary: secondary.document ?? secondary.sequence ?? secondary, profile }, { signal, complete: data => {
      validateSourceReferences(data.diff, primary, secondary); this.lastModels = freezeData(data.models); return freezeData(data.diff);
    } });
  }
  importFiles(files, { signal } = {}) {
    return this._run({ operation: 'import', files }, { signal, complete: data => freezeData(data.snapshots) });
  }
  _run(request, { signal, complete }) {
    this.cancel();
    if (this.disposed) return Promise.reject(new Error('Comparison client has been disposed.'));
    if (signal?.aborted) return Promise.reject(signal.reason ?? aborted());
    const id = ++this.generation;
    return new Promise((resolve, reject) => {
      let worker;
      try { worker = this.workerFactory(); } catch (error) { reject(error); return; }
      const cleanup = () => { signal?.removeEventListener('abort', cancel); worker.terminate(); if (this.pending?.id === id) this.pending = null; };
      const fail = error => { cleanup(); reject(error); };
      const cancel = () => { if (this.pending?.id === id) { ++this.generation; fail(signal?.reason ?? aborted()); } };
      this.pending = { id, worker, reject: fail };
      signal?.addEventListener('abort', cancel, { once: true });
      worker.onmessage = ({ data }) => {
        if (id !== this.generation || this.pending?.id !== id || data.id !== id) return;
        if (data.error) { const error = new Error(typeof data.error === 'string' ? data.error : data.error.message); error.name = data.error.name ?? 'Error'; error.details = data.error.details ?? []; fail(error); return; }
        try { const result = complete(data); cleanup(); resolve(result); } catch (error) { fail(error); }
      };
      worker.onerror = error => { if (id === this.generation) fail(new Error(error.message || 'Comparison worker failed.')); };
      try { worker.postMessage({ id, ...request }); } catch (error) { fail(error); }
    });
  }
  cancel() { ++this.generation; if (this.pending) this.pending.reject(aborted()); }
  dispose() { this.cancel(); this.disposed = true; this.lastModels = null; }
}
