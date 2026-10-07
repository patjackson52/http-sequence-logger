import { noOpLogger } from './api.mjs';
import { createPolicy, cleanURL, cleanHeaders, cleanBody, missingBody, safeError } from './policy.mjs';

export const SDK_VERSION = '0.2.0';
const fallback = noOpLogger.startSession();
const label = (value, fallbackValue = 'unknown') => typeof value === 'string' && value.length ? value.slice(0, 512) : fallbackValue;
const actor = value => ({ owner: ['integrator', 'sdk', 'system', 'unknown'].includes(value?.owner) ? value.owner : 'unknown', component: label(value?.component), method: value?.method ? label(value.method) : null });
const id = () => globalThis.crypto.randomUUID();
const hex = count => [...globalThis.crypto.getRandomValues(new Uint8Array(count))].map(b => b.toString(16).padStart(2, '0')).join('');
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const stopReason = reason => ['browser_response_not_exposed', 'body_already_consumed_or_locked', 'xhr_observer_disposed', 'component_disposed', 'session_stopped'].includes(reason) ? reason : 'observation_stopped';
const clone = value => JSON.parse(JSON.stringify(value));
const adapters = ['customer.manual', 'browser.fetch', 'browser.xhr'].map(name => ({ adapter: { name, version: SDK_VERSION }, capabilities: { attempts: 'logical', request_body: 'partial', response_body: 'partial', transaction_metrics: false } }));

/** Development recorder. Supply a journal explicitly; no global session or automatic interception. */
export function createLogger({ namespace, appId, appVersion = 'development', sink, policy: policyOptions, onDiagnostic, propagationOrigins = [] } = {}) {
  if (!validId(namespace) || !appId || !sink || typeof sink.append !== 'function') throw new TypeError('namespace, appId and append sink are required');
  const policy = createPolicy(policyOptions);
  const allowedOrigins = [...new Set(propagationOrigins.map(value => {const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new TypeError('Invalid propagation origin');return url.origin;}))];
  const diagnostic = code => { try { onDiagnostic?.(code); } catch { /* application diagnostics cannot break requests */ } };
  const attempt = (fn, other) => { try { return fn(); } catch { diagnostic('capture_failed'); return other; } };
  return Object.freeze({
    enabled: true,
    startSession(options = {}) {
      return attempt(() => recording(options), fallback);
    },
  });

  function recording({ name = 'Browser session', sessionId } = {}) {
    if (sessionId !== undefined && !validId(sessionId)) throw new TypeError('Invalid session ID');
    const recordingId = id(), binding = { session_namespace: namespace, session_id: sessionId === undefined ? id() : sessionId, recording_id: recordingId };
    const epoch = performance.now();
    let sequence = 0, lastTime = 0n, closed = false, dropped = 0;
    const live = new Set(), contexts = new WeakMap();
    function emit(eventType, data, context, extensions) {
      const time = sequence === 0 ? 0n : BigInt(Math.max(0, Math.floor((performance.now() - epoch) * 1e6)));
      lastTime = time > lastTime ? time : lastTime;
      const event = { schema_version: '1.3', event_type: eventType, event_id: id(), ...binding, sequence: ++sequence, timestamp: new Date().toISOString(), monotonic_ns: String(lastTime), ...(context ? { context } : {}), data: typeof data === 'function' ? data(lastTime) : data, ...(extensions ? { extensions } : {}) };
      try { if (sink.append(`${JSON.stringify(event)}\n`) === false) { dropped++; diagnostic('journal_full'); } }
      catch { dropped++; diagnostic('journal_write_failed'); }
      return lastTime;
    }
    const contextFor = (parent, traceparent) => {
      if (parent && !contexts.has(parent)) throw new TypeError('Parent must belong to this recording');
      const wire = typeof traceparent === 'string' ? /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec(traceparent) : null;
      const validWire = wire && !/^0+$/.test(wire[1]) && !/^0+$/.test(wire[2]);
      const linkedParent = parent && (!validWire || parent.trace_id === wire[1]);
      const context = Object.freeze({ trace_id: validWire ? wire[1] : parent?.trace_id || hex(16), span_id: validWire ? wire[2] : hex(8), parent_span_id: linkedParent ? parent.span_id : null, parent_scope: linkedParent ? 'local' : 'none' });
      return context;
    };
    const guarded = (fn, defaultValue) => (...args) => closed ? defaultValue : attempt(() => fn(...args), defaultValue);
    emit('session.started', {
      name: label(name), id_source: sessionId ? 'provided' : 'generated',
      producer: { platform: 'web', app_id: label(appId), app_version: label(appVersion), os_version: 'browser (not collected)', sdk_version: SDK_VERSION }, adapters: clone(adapters),
      capture_policy: { profile: 'development', body_limit_bytes: policy.bodyLimit, redact_headers: policy.headers, redact_query_keys: policy.queries, redact_body_paths: policy.keys.map(key => `**.${key}`) },
      trace_propagation: allowedOrigins.length ? 'allowlist' : 'disabled', propagation_origins: allowedOrigins,
    }, null, { 'browser.clock': 'performance.now; precision reduced; sleep behavior engine dependent' });

    function startOperation(options, handler = false) {
      const meta = typeof options === 'function' ? options() : options;
      const origin = actor(meta.origin), context = contextFor(meta.parent);
      const invocation = handler ? { kind: 'handler', dispatch: meta.dispatch === 'awaited' ? 'awaited' : 'synchronous', caller: actor(meta.caller) } : null;
      if (handler && meta.parent) {
        const parent = contexts.get(meta.parent);
        if (parent.kind !== 'operation' || parent.ended || JSON.stringify(parent.origin) !== JSON.stringify(invocation.caller)) throw new TypeError('Handler requires its active caller operation');
      }
      const state = { kind: 'operation', origin, ended: false };
      contexts.set(context, state);
      const started = emit('operation.started', { name: label(meta.name), origin, ...(invocation ? { invocation } : {}) }, context);
      function finish(outcome = 'success', error = null, completion, reason) {
        if (state.ended) return;
        // Closing a caller cannot manufacture a return for its open child handlers.
        for (const child of [...live]) if (child.parent === context && child.handler) child.stop();
        state.ended = true; live.delete(entry);
        emit('operation.ended', now => ({ outcome, duration_ns: String(now - started), error, ...(handler ? { completion: completion || (outcome === 'success' ? 'returned' : outcome === 'error' ? 'threw' : 'cancelled') } : {}) }), context, reason ? { 'capture.observation_stop_reason': reason } : undefined);
      }
      const stop = reason => handler ? finish('unknown', null, 'observation_stopped', stopReason(reason)) : finish('cancelled');
      const handle = Object.freeze({ context,
        end: guarded((outcome = 'success', error) => finish(['success', 'error', 'cancelled'].includes(outcome) ? outcome : 'cancelled', outcome === 'error' ? safeError(error) : null)),
        returned: guarded(() => finish()), threw: guarded(error => finish('error', safeError(error))), cancel: guarded(() => finish('cancelled')),
        stopObservation: guarded(stop),
      });
      const entry = { parent: meta.parent, handler, stop };
      live.add(entry);
      return handle;
    }
    function startRequest(supplier) {
      const meta = supplier(), context = contextFor(meta.parent, meta.traceparent), url = cleanURL(meta.url, policy);
      const method = String(meta.method || 'GET');
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(method)) throw new TypeError('Invalid method');
      const adapter = adapters.find(a => a.adapter.name === (meta.adapter || 'customer.manual'))?.adapter;
      if (!adapter) throw new TypeError('Unknown adapter');
      const origin = { initiator: actor(meta.origin?.initiator), executor: actor(meta.origin?.executor), callsite: meta.origin?.callsite ? { source: 'explicit', file: meta.origin.callsite.file ? label(meta.origin.callsite.file) : null, line: Number.isInteger(meta.origin.callsite.line) && meta.origin.callsite.line > 0 ? meta.origin.callsite.line : null, function: meta.origin.callsite.function ? label(meta.origin.callsite.function) : null } : null };
      const started = emit('http.request.started', { name: label(meta.name, method), origin, adapter, request: { method, url: url.value, url_redacted: url.redacted, headers: cleanHeaders(meta.headers, policy, meta.reason), method_source: 'configured', configured_method: method }, attempt: { index: 0, visibility: 'logical', reason: 'initial', previous_span_id: null } }, context);
      let ended = false, status = null;
      const bodies = new Set();
      contexts.set(context, { kind: 'http' });
      function body(direction, supplier) {
        if (ended || bodies.has(direction)) return;
        const snapshot = cleanBody(supplier(), policy);
        emit('http.body.captured', { direction, body: snapshot }, context); bodies.add(direction);
      }
      function finish(outcome, endReason, error = null, reason) {
        if (ended) return;
        for (const direction of ['request', 'response']) if (!bodies.has(direction)) { emit('http.body.captured', { direction, body: missingBody() }, context); bodies.add(direction); }
        ended = true; live.delete(entry);
        emit('http.ended', now => ({ outcome, application_outcome: 'unknown', status_code: status, duration_ns: String(now - started), end_reason: endReason, error }), context, reason ? { 'capture.observation_stop_reason': reason } : undefined);
      }
      const stop = reason => finish('unknown', 'observation_stopped', null, stopReason(reason));
      const entry = { stop }; live.add(entry);
      return Object.freeze({ context,
        responseHeaders: guarded(supplier => {
          if (ended || status !== null) return;
          const response = supplier();
          if (!Number.isInteger(response.status) || response.status < 200 || response.status > 599) return;
          const safeURL = response.url ? cleanURL(response.url, policy) : null;
          const data = { status_code: response.status, status_text: null, url: safeURL?.value || null, url_redacted: safeURL?.redacted || false, headers: cleanHeaders(response.headers, policy, response.reason) };
          // status text may be server controlled; the numeric status is sufficient.
          status = response.status; emit('http.response.headers', { phase: 'final', response: data }, context);
        }),
        requestBody: guarded(supplier => body('request', supplier)), responseBody: guarded(supplier => body('response', supplier)),
        complete: guarded(() => status === null ? stop() : finish(status >= 400 ? 'http_error' : 'success', 'body_eof')),
        fail: guarded((error, stage) => finish('transport_error', 'transport_failure', safeError(error, stage))),
        timeout: guarded(error => finish('timeout', 'transport_failure', safeError(error))),
        cancel: guarded(() => finish('cancelled', 'cancelled')),
        stopObservation: guarded(stop),
      });
    }
    const session = {
      enabled: true, propagationOrigins: Object.freeze([...allowedOrigins]), sessionId: binding.session_id, recordingId,
      startOperation: guarded(options => startOperation(options), fallback.startOperation()),
      startHandler: guarded(options => startOperation(options, true), fallback.startHandler()),
      startRequest: guarded(startRequest, fallback.startRequest()),
      invokeHandler(options, fn) {
        const span = session.startHandler(() => ({ ...options, dispatch: 'synchronous' }));
        try { const result = fn(span.context); span.returned(); return result; }
        catch (error) { span.threw(error); throw error; }
      },
      async invokeAsyncHandler(options, fn) {
        const span = session.startHandler(() => ({ ...options, dispatch: 'awaited' }));
        try { const result = await fn(span.context); span.returned(); return result; }
        catch (error) { span.threw(error); throw error; }
      },
      end(reason = 'completed') {
        if (closed) return;
        attempt(() => { for (const entry of [...live].reverse()) entry.stop(); emit('session.ended', { reason: reason === 'completed' ? 'completed' : 'stopped', dropped_events: dropped }); }, undefined);
        closed = true;
      },
    };
    return Object.freeze(session);
  }
}
