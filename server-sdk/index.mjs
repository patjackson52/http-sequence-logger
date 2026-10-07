import { createPolicy, cleanURL, cleanHeaders, missingBody, safeError } from '../web-sdk/src/policy.mjs';
export const SDK_VERSION = '0.2.0';
const hex = n => [...crypto.getRandomValues(new Uint8Array(n))].map(x => x.toString(16).padStart(2, '0')).join('');
export function parseTraceparent(value) {
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(value || '');
  return match && !/^0+$/.test(match[1]) && !/^0+$/.test(match[2]) ? { trace_id: match[1], span_id: match[2], flags: match[3] } : null;
}
export const traceparent = context => `00-${context.trace_id}-${context.span_id}-${context.flags || '01'}`;
/** Explicit request contexts work across concurrent Node requests and Workers invocations. */
export function createServerLogger({ service, environment = 'local', sessionNamespace, appVersion = 'development', runtime = 'node', emit, propagationOrigins = [], fetch: fetcher = globalThis.fetch, policy: policyOptions, onDiagnostic } = {}) {
  if (!service || !sessionNamespace || typeof emit !== 'function' || !['node', 'cloudflare'].includes(runtime)) throw new TypeError('service, sessionNamespace and emit are required');
  const policy = createPolicy(policyOptions), origins = new Set(propagationOrigins.map(x => new URL(x).origin));
  const actor = { owner: 'integrator', component: service, method: null };
  const pending = new Set();
  const diagnostic = code => { try { onDiagnostic?.(code); } catch {} };
  const capture = (fn, fallback = null) => { try { return fn(); } catch { diagnostic('capture_failed'); return fallback; } };
  function recordRequest(request, handler) {
    const parent = capture(() => parseTraceparent(request.headers.get('traceparent')));
    const binding = { session_namespace: sessionNamespace, session_id: parent?.trace_id || hex(16), recording_id: crypto.randomUUID() };
    const epoch = performance.now(); let sequence = 0, previous = 0n, closed = false;
    const context = { trace_id: binding.session_id, span_id: hex(8), parent_span_id: parent?.span_id || null, parent_scope: parent ? 'remote' : 'none' };
    function write(type, data, ctx) {
      if (closed) { diagnostic('context_closed'); return null; }
      return capture(() => {
        const now = sequence === 0 ? 0n : BigInt(Math.max(0, Math.floor((performance.now() - epoch) * 1e6)));
        const clock = now > previous ? now : previous;
        // Construct all metadata before admitting its sequence number.
        const payload = typeof data === 'function' ? data(clock) : data;
        const event = { schema_version: '1.3', event_type: type, event_id: crypto.randomUUID(), ...binding, sequence: sequence + 1, timestamp: new Date().toISOString(), monotonic_ns: String(clock), ...(ctx ? { context: ctx } : {}), data: payload };
        previous = clock; sequence++;
        try {
          const result = emit(event);
          if (result?.then) {
            const work = Promise.resolve(result).catch(() => diagnostic('emit_failed')).finally(() => pending.delete(work));
            pending.add(work);
          }
        } catch { diagnostic('emit_failed'); }
        return clock;
      });
    }
    write('session.started', () => ({ name: `${service} request`, id_source: parent ? 'provided' : 'generated', producer: { platform: 'server', app_id: service, app_version: appVersion, os_version: runtime, sdk_version: SDK_VERSION, service_name: service, environment, runtime }, adapters: [{ adapter: { name: 'server.fetch', version: SDK_VERSION }, capabilities: { attempts: 'logical', request_body: 'unsupported', response_body: 'unsupported', transaction_metrics: false } }], capture_policy: { profile: 'development', body_limit_bytes: policy.bodyLimit, redact_headers: policy.headers, redact_query_keys: policy.queries, redact_body_paths: policy.keys }, trace_propagation: origins.size ? 'allowlist' : 'disabled', propagation_origins: [...origins] }));
    const start = write('operation.started', () => ({ name: `${request.method} ${new URL(request.url).pathname}`, origin: actor, span_kind: 'server' }), context);
    const makeContext = ctx => Object.freeze({ ...ctx,
      log(message, level = 'info') { write('log.message', () => ({ message: String(message).slice(0, 16384), level: ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info' }), ctx); },
      async operation(name, fn) {
        const child = { trace_id: ctx.trace_id, span_id: hex(8), parent_span_id: ctx.span_id, parent_scope: 'local' };
        const started = write('operation.started', () => ({ name: String(name), origin: actor, span_kind: 'internal' }), child);
        try { const value = await fn(makeContext(child)); if (started !== null) write('operation.ended', now => ({ outcome: 'success', duration_ns: String(now - started), error: null }), child); return value; }
        catch (error) { if (started !== null) write('operation.ended', now => ({ outcome: 'error', duration_ns: String(now - started), error: safeError(error) }), child); throw error; }
      },
      async fetch(input, init) {
        const outgoing = new Request(input, init), child = { trace_id: ctx.trace_id, span_id: hex(8), parent_span_id: ctx.span_id, parent_scope: 'local' };
        capture(() => { if (!closed && origins.has(new URL(outgoing.url).origin)) outgoing.headers.set('traceparent', traceparent({ ...child, flags: parent?.flags })); });
        const started = write('http.request.started', () => {
          const url = cleanURL(outgoing.url, policy);
          return { name: `${outgoing.method} ${new URL(url.value).pathname}`, span_kind: 'client', origin: { initiator: actor, executor: actor, callsite: null }, adapter: { name: 'server.fetch', version: SDK_VERSION }, request: { method: outgoing.method, url: url.value, url_redacted: url.redacted, headers: cleanHeaders(outgoing.headers, policy) }, attempt: { index: 0, visibility: 'logical', reason: 'initial', previous_span_id: null } };
        }, child);
        if (started !== null) write('http.body.captured', { direction: 'request', body: missingBody('server_body_not_observed') }, child);
        let response;
        try { response = await fetcher(outgoing); }
        catch (error) {
          if (started !== null) write('http.ended', now => {
            const cancelled = capture(() => error?.name === 'AbortError', false);
            return { outcome: cancelled ? 'cancelled' : 'transport_error', application_outcome: 'unknown', status_code: null, duration_ns: String(now - started), end_reason: cancelled ? 'cancelled' : 'transport_failure', error: safeError(error) };
          }, child);
          throw error;
        }
        if (started !== null) {
          write('http.response.headers', () => {
            const responseURL = response.url ? cleanURL(response.url, policy) : null;
            return { phase: 'final', response: { status_code: response.status, status_text: response.statusText || null, url: responseURL?.value || null, url_redacted: responseURL?.redacted || false, headers: cleanHeaders(response.headers, policy) } };
          }, child);
          write('http.body.captured', { direction: 'response', body: missingBody('server_body_not_observed') }, child);
          write('http.ended', now => ({ outcome: 'unknown', application_outcome: 'unknown', status_code: response.status, duration_ns: String(now - started), end_reason: 'observation_stopped', error: null }), child);
        }
        return response;
      },
    });
    return Promise.resolve().then(() => handler(makeContext(context))).then(response => {
      if (start !== null) write('operation.ended', now => ({ outcome: 'success', duration_ns: String(now - start), error: null }), context); write('session.ended', { reason: 'completed', dropped_events: 0 }); closed = true; return response;
    }, error => {
      if (start !== null) write('operation.ended', now => ({ outcome: 'error', duration_ns: String(now - start), error: safeError(error) }), context); write('session.ended', { reason: 'completed', dropped_events: 0 }); closed = true; throw error;
    });
  }
  return Object.freeze({ handleRequest: recordRequest, async flush() { await Promise.all([...pending]); } });
}
