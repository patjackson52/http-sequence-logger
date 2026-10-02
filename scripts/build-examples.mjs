import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

// Synthetic, deterministic examples. All hosts are reserved .example domains.
const hex = (value, length) => createHash('sha256').update(value).digest('hex').slice(0, length);
const epoch = Date.parse('2026-09-28T18:30:00.000Z');
const stamp = (ms) => new Date(epoch + ms).toISOString();
const actor = (owner, component, method) => ({ owner, component, method });
const app = actor('integrator', 'Checkout', 'submit');
const sdk = actor('sdk', 'VerificationClient', 'verify');
const header = (name, value, redacted = false) => ({ name, value, redacted });
const headers = (entries = []) => ({ availability: 'captured', representation: 'library', order_preserved: false, entries, reason: null });
const body = (value, options = {}) => {
  const data = typeof value === 'string' ? value : JSON.stringify(value);
  const size = Buffer.byteLength(data);
  return {
    availability: 'captured', representation: 'application', media_type: 'application/json',
    charset: 'utf-8', content_encoding: null, observed_bytes: size, total_bytes: size,
    stored_bytes: size, truncated: false, redacted: false, reason: null,
    content: { encoding: 'utf-8', data }, ...options,
  };
};
const noBody = (reason = 'body_not_present') => ({
  availability: 'not_applicable', representation: 'application', media_type: null,
  charset: null, content_encoding: null, observed_bytes: 0, total_bytes: 0,
  stored_bytes: 0, truncated: false, redacted: false, reason, content: null,
});
const unavailable = (reason) => ({ ...noBody(reason), availability: 'unavailable', observed_bytes: null, total_bytes: null });
const err = (type, message, stage = 'read') => ({ type, message, stage });

function recording(name, { sessionId = `session-${name}`, platform = 'android', custom = false, offset = 0, sdkOperation = true, manual = false, methodOperations = true, attemptVisibility } = {}) {
  const events = [];
  const recordingId = `recording-${name}`;
  const traceId = hex(`trace-${name}`, 32);
  const rootId = hex(`root-${name}`, 16);
  const sdkId = hex(`sdk-${name}`, 16);
  const adapter = { name: manual ? 'customer.manual' : custom ? 'custom-http' : platform === 'ios' ? 'urlsession' : 'httpurlconnection', version: '0.1.0' };
  const visibility = attemptVisibility ?? (manual ? 'logical' : custom || platform === 'ios' ? 'individual' : 'logical');
  const context = (span, parent) => ({ trace_id: traceId, span_id: span, parent_span_id: parent, parent_scope: parent === null ? 'none' : 'local' });
  const emit = (type, ms, data, ctx) => {
    const sequence = events.length + 1;
    const event = {
      schema_version: '1.2', event_type: type, event_id: `${recordingId}/event-${sequence}`,
      session_namespace: 'com.example.shop/development', session_id: sessionId, recording_id: recordingId,
      sequence, timestamp: stamp(offset + ms), monotonic_ns: String(ms * 1_000_000),
      ...(ctx ? { context: ctx } : {}), data,
    };
    events.push(event);
    return event;
  };
  emit('session.started', 0, {
    name, id_source: 'provided',
    producer: { platform, app_id: 'com.example.shop', app_version: '1.0-fixture', os_version: 'fixture', sdk_version: '0.1.0' },
    adapters: [{ adapter, capabilities: { attempts: visibility, request_body: manual ? 'partial' : 'supported', response_body: manual ? 'partial' : 'supported', transaction_metrics: !manual && platform === 'ios' } }],
    capture_policy: { profile: 'development', body_limit_bytes: 262144, redact_headers: ['authorization', 'cookie', 'set-cookie'], redact_query_keys: ['token'], redact_body_paths: ['$.token'] },
    trace_propagation: 'disabled', propagation_origins: [],
  });
  if (methodOperations) emit('operation.started', 1, { name: 'Checkout.submit', origin: app }, context(rootId, null));
  if (methodOperations && sdkOperation) emit('operation.started', 2, { name: 'VerificationClient.verify', origin: sdk }, context(sdkId, rootId));

  function request(label, start, { url = 'https://api.example/verify?tag=mobile&tag=checkout', method = 'POST', payload = { mode: 'instant' }, previous = null, reason = 'initial', requestHeaders, deferRequestBody = false } = {}) {
    const ctx = context(hex(`${name}/${label}`, 16), !methodOperations ? null : sdkOperation ? sdkId : rootId);
    const index = previous ? previous.index + 1 : 0;
    emit('http.request.started', start, {
      name: `${method} ${new URL(url).pathname}`,
      origin: { initiator: app, executor: sdkOperation ? sdk : app, callsite: { source: 'explicit', file: platform === 'ios' ? 'Checkout.swift' : 'Checkout.kt', line: 142, function: 'submit' } },
      adapter, request: { method, method_source: 'configured', url, url_redacted: false, headers: requestHeaders ?? { ...headers([header('Content-Type', 'application/json'), header('Authorization', '[REDACTED]', true)]), availability: 'partial', reason: 'application_configured_only' } },
      attempt: { index, visibility, reason, previous_span_id: previous?.ctx.span_id ?? null },
    }, ctx);
    if (!deferRequestBody) emit('http.body.captured', start + 1, { direction: 'request', body: payload === null ? noBody() : body(payload) }, ctx);
    let finalStatus = null;
    return {
      ctx, index, start,
      respond(ms, status = 200, payloadValue = { verified: true }, { extraHeaders = [], capturedBody = null, responseHeaders, effectiveUrl = url, deferBody = false } = {}) {
        finalStatus = status;
        emit('http.response.headers', ms, { phase: 'final', response: {
          status_code: status, status_text: null, url: effectiveUrl, url_redacted: false,
          headers: responseHeaders ?? headers([header('Content-Type', 'application/json'), ...extraHeaders]),
        } }, ctx);
        if (!deferBody) emit('http.body.captured', ms + 1, { direction: 'response', body: capturedBody ?? body(payloadValue) }, ctx);
      },
      finish(ms, outcome = finalStatus >= 400 ? 'http_error' : 'success', error = null) {
        if (deferRequestBody) emit('http.body.captured', ms - 2, { direction: 'request', body: unavailable('not_recorded') }, ctx);
        if (finalStatus === null) emit('http.body.captured', ms - 1, { direction: 'response', body: unavailable('no_response') }, ctx);
        emit('http.ended', ms, {
          outcome, application_outcome: 'unknown', status_code: finalStatus,
          duration_ns: String((ms - start) * 1_000_000),
          end_reason: outcome === 'unknown' ? 'observation_stopped' : outcome === 'cancelled' ? 'cancelled' : ['timeout', 'transport_error'].includes(outcome) ? 'transport_failure' : 'body_eof', error,
        }, ctx);
      },
    };
  }
  let operationsEnded = false;
  const endOperations = (ms, outcome = 'success', error = null) => {
    if (operationsEnded) return;
    operationsEnded = true;
    if (methodOperations && sdkOperation) emit('operation.ended', ms, { outcome, duration_ns: String((ms - 2) * 1_000_000), error }, context(sdkId, rootId));
    if (methodOperations) emit('operation.ended', ms + 1, { outcome, duration_ns: String(ms * 1_000_000), error }, context(rootId, null));
  };
  const finish = (ms, outcome = 'success', error = null) => {
    endOperations(ms, outcome, error);
    emit('session.ended', ms + 2, { reason: 'completed', dropped_events: 0 });
  };
  return { events, request, finish, endOperations, emit, offset };
}

const captures = [];
function save(name, r, description, expected) {
  captures.push({ file: `${name}.ndjson`, description, expected });
  writeFileSync(new URL(`../examples/${name}.ndjson`, import.meta.url), `${r.events.map((e) => JSON.stringify(e)).join('\n')}\n`);
}
const expected = (requests = 1, failed = 0, extra = {}) => ({ sessions: 1, recordings: 1, requests, failed_requests: failed, cancelled_requests: 0, unfinished_requests: 0, unknown_outcomes: 0, ...extra });

{
  const r = recording('success');
  const call = r.request('verify', 10);
  call.respond(40, 200, { verified: true }, { extraHeaders: [header('Set-Cookie', '[REDACTED]', true), header('Set-Cookie', '[REDACTED]', true)] });
  call.finish(45); r.finish(50);
  save('success', r, 'Integrator → SDK → API; repeated query keys and repeated redacted Set-Cookie fields remain separate.', expected());
}
{
  const r = recording('direct-integrator', { custom: true, sdkOperation: false, sessionId: 'b5179d75-e2a3-4f91-a7f1-66383a9fce30' });
  r.events[0].data.id_source = 'generated';
  const call = r.request('configuration', 10, { url: 'https://config.example/settings', method: 'GET', payload: null });
  call.respond(20, 200, { enabled: true }); call.finish(25); r.finish(30);
  save('direct-integrator', r, 'Generated session ID and custom recorder; the integrator executes the request without an SDK method block.', expected());
}
{
  const r = recording('http-error');
  const call = r.request('verify', 10);
  call.respond(40, 400, { error: 'invalid_input', field: 'mode' });
  call.finish(45); r.finish(50, 'error', err('HttpError', 'Verification rejected'));
  save('http-error', r, 'HTTP 400 with a complete JSON error body, including the HttpURLConnection error-stream use case.', expected(1, 1));
}
{
  const r = recording('timeout');
  const call = r.request('verify', 10);
  call.finish(3010, 'timeout', err('ReadTimeout', 'No response headers before deadline'));
  r.finish(3020, 'error', err('ReadTimeout', 'Verification timed out'));
  save('timeout', r, 'No response received: status is null, not zero, and response content is explicitly unavailable.', expected(1, 1));
}
{
  const r = recording('retry');
  const first = r.request('attempt-0', 10);
  first.respond(30, 503, { error: 'temporarily_unavailable' }); first.finish(35);
  const second = r.request('attempt-1', 135, { previous: first, reason: 'retry' });
  second.respond(160); second.finish(165); r.finish(170);
  save('retry', r, '503 → 100 ms backoff → 200; two explicit SDK calls through HttpURLConnection inside one successful operation. Hidden native attempts remain unknown.', expected(2, 1));
}
{
  const r = recording('concurrent', { platform: 'ios' });
  const slow = r.request('profile', 10, { url: 'https://profile.example/me', method: 'GET', payload: null });
  const fast = r.request('configuration', 20, { url: 'https://config.example/settings', method: 'GET', payload: null });
  fast.respond(30, 200, { enabled: true }); fast.finish(35);
  slow.respond(90, 200, { name: 'Example' }); slow.finish(95);
  r.emit('http.metrics', 96, {
    source: 'URLSessionTaskTransactionMetrics', transaction: { index: 0, request: null, response: null }, protocol_version: 'h2', remote_address: null, remote_port: null,
    connection_reused: true, response_source: 'network', phases: [{ name: 'response_read', start_timestamp: stamp(90), end_timestamp: stamp(94) }],
  }, slow.ctx);
  r.finish(100);
  save('concurrent', r, 'Two overlapping requests complete in reverse order; late native metrics retain their HTTP span association.', expected(2));
}
{
  const r = recording('cancelled', { platform: 'ios' });
  const call = r.request('verify', 10);
  call.finish(25, 'cancelled'); r.finish(30, 'cancelled');
  save('cancelled', r, 'Caller cancellation has its own outcome and no fabricated HTTP status or transport error.', expected(1, 0, { cancelled_requests: 1 }));
}
{
  const r = recording('interrupted');
  r.request('verify', 10);
  save('interrupted', r, 'Abruptly stopped recording; importer keeps the unfinished request and open method blocks with warnings.', expected(1, 0, { unfinished_requests: 1 }));
}
{
  const r = recording('redacted-truncated');
  const call = r.request('verify', 10);
  call.respond(40, 200, null, { capturedBody: body('{"token":"[REDACTED]","items":[', {
    observed_bytes: 400000, total_bytes: 400000, truncated: true, redacted: true, reason: 'body_limit',
  }) });
  call.finish(45); r.finish(50);
  save('redacted-truncated', r, 'Redaction and truncation coexist; incomplete JSON remains inspectable as text.', expected());
}
{
  const r = recording('redirect', { platform: 'ios' });
  const first = r.request('original', 10, { url: 'https://api.example/start', method: 'GET', payload: null });
  first.respond(20, 302, null, { extraHeaders: [header('Location', 'https://edge.example/result')], capturedBody: unavailable('redirect_body_not_exposed') }); first.finish(25);
  const second = r.request('redirected', 30, { url: 'https://edge.example/result', method: 'GET', payload: null, previous: first, reason: 'redirect' });
  second.respond(40); second.finish(45); r.finish(50);
  save('redirect', r, 'Redirect to another origin creates a new participant and attempt; hidden redirect body is explicitly unavailable.', expected(2));
}
{
  const a = recording('multi-android', { sessionId: 'checkout-123', custom: true });
  const b = recording('multi-ios', { sessionId: 'checkout-456', platform: 'ios', offset: 5 });
  const c = recording('multi-resumed', { sessionId: 'checkout-123', custom: true, offset: 2000 });
  const urls = ['https://auth.example/token', 'https://api.example/verify', 'https://config.example/settings', 'https://profile.example/me', 'https://telemetry.example/events', 'https://edge.example/result'];
  for (let i = 0; i < 10; i++) {
    const call = a.request(`request-${i}`, 10 + i * 60, { url: urls[i % urls.length] });
    call.respond(40 + i * 60); call.finish(45 + i * 60);
  }
  a.finish(620);
  for (let i = 0; i < 2; i++) {
    const call = b.request(`request-${i}`, 10 + i * 60, { url: urls[i] });
    call.respond(40 + i * 60); call.finish(45 + i * 60);
  }
  b.finish(140);
  for (let i = 0; i < 2; i++) {
    const call = c.request(`request-${i}`, 10 + i * 60, { url: urls[i + 2] });
    call.respond(40 + i * 60); call.finish(45 + i * 60);
  }
  c.finish(140);
  const combined = { events: [...a.events, ...b.events, ...c.events].sort((x, y) => x.timestamp.localeCompare(y.timestamp)) };
  save('multi-session', combined, 'Two session IDs, three recordings, interleaved producers, six origins, and a resumed caller-supplied session (12 requests in that session).', expected(14, 0, { sessions: 2, recordings: 3 }));
}

{
  const r = recording('manual-minimal', { manual: true, methodOperations: false, sdkOperation: false });
  const missingHeaders = { ...headers(), availability: 'unavailable', reason: 'not_recorded' };
  const call = r.request('customer-call', 10, { method: 'GET', requestHeaders: missingHeaders, deferRequestBody: true });
  call.respond(30, 200, null, { effectiveUrl: null, responseHeaders: missingHeaders, capturedBody: unavailable('not_recorded') });
  call.finish(35); r.finish(40);
  save('manual-minimal', r, 'Manual begin + completeResponse, no method spans, no fabricated body/header data, and unknown effective response URL.', expected());
}
{
  const r = recording('manual-observation-stopped', { manual: true, methodOperations: false, sdkOperation: false });
  const call = r.request('customer-call', 10);
  call.respond(30, 200, null, { capturedBody: unavailable('body_lifecycle_unobserved') });
  call.finish(35, 'unknown'); r.finish(40);
  save('manual-observation-stopped', r, 'Caller observes HTTP 200 but cannot observe body completion; transfer outcome stays unknown.', expected(1, 0, { unknown_outcomes: 1 }));
}
{
  const r = recording('stream-read-timeout', { platform: 'ios' });
  const call = r.request('stream', 10, { method: 'GET', payload: null });
  call.respond(30, 200, null, { deferBody: true });
  r.endOperations(35); // Calling method returns at headers; its HTTP child stays open.
  r.emit('http.body.captured', 3009, { direction: 'response', body: body('{"pa', { truncated: true, total_bytes: null, reason: 'stream_failed' }) }, call.ctx);
  call.finish(3010, 'timeout', err('ReadTimeout', 'Body read timed out after HTTP 200'));
  r.finish(3020);
  save('stream-read-timeout', r, 'Method returns at headers; body iteration later times out. Known HTTP 200 is retained and failed_requests is one.', expected(1, 1));
}
{
  const r = recording('ios-partial-metrics', { platform: 'ios', attemptVisibility: 'logical' });
  const call = r.request('tls', 10);
  call.finish(1010, 'timeout', err('SecureConnectionTimeout', 'TLS did not finish', 'tls'));
  r.emit('http.metrics', 1011, {
    source: 'URLSessionTaskTransactionMetrics',
    transaction: { index: 0, request: structuredClone(r.events.find((e) => e.event_type === 'http.request.started').data.request), response: null },
    protocol_version: null, remote_address: null, remote_port: null, connection_reused: false, response_source: 'network',
    phases: [{ name: 'tls', start_timestamp: stamp(20), end_timestamp: null }],
  }, call.ctx);
  r.finish(1020, 'error', err('SecureConnectionTimeout', 'TLS did not finish', 'tls'));
  save('ios-partial-metrics', r, 'Native TLS phase has a start but no end after failure; transaction identity/request are preserved.', expected(1, 1));
}
{
  const r = recording('ios-logical-transactions', { platform: 'ios', attemptVisibility: 'logical' });
  const call = r.request('redirected-task', 10, { method: 'GET', payload: null, url: 'https://api.example/start' });
  call.respond(50, 200, { verified: true }, { effectiveUrl: 'https://edge.example/result' }); call.finish(55);
  const requestSnapshot = r.events.find((e) => e.event_type === 'http.request.started').data.request;
  for (const [index, url, status] of [[0, 'https://api.example/start', 302], [1, 'https://edge.example/result', 200]]) {
    r.emit('http.metrics', 56 + index, {
      source: 'URLSessionTaskTransactionMetrics',
      transaction: { index, request: { ...structuredClone(requestSnapshot), url }, response: { status_code: status, status_text: null, url, url_redacted: false, headers: headers() } },
      protocol_version: 'h2', remote_address: null, remote_port: null, connection_reused: false, response_source: 'network',
      phases: [{ name: 'response_read', start_timestamp: stamp(index === 0 ? 20 : 50), end_timestamp: stamp(index === 0 ? 25 : 54) }],
    }, call.ctx);
  }
  r.finish(60);
  save('ios-logical-transactions', r, 'One observed task and two native transaction snapshots; no retrospective spans or fabricated callback timing.', expected());
}

// Control-flow spans are independent of HTTP.
for (const mode of ['http', 'no-http', 'throw', 'cancelled', 'stopped', 'interrupted']) {
  const name = `handler-${mode}`;
  const r = recording(name);
  const sdkStart = r.events.find(e => e.event_type === 'operation.started' && e.data.origin.owner === 'sdk');
  const handler = actor('integrator', 'CustomerTaskHandler', 'loadTask');
  const ctx = { ...sdkStart.context, span_id: hex(name + '/handler', 16), parent_span_id: sdkStart.context.span_id, parent_scope: 'local' };
  r.emit('operation.started', 5, { name: 'CustomerTaskHandler.loadTask', origin: handler,
    invocation: { kind: 'handler', dispatch: 'synchronous', caller: sdk } }, ctx);
  if (mode === 'http') {
    const request = r.request('handler-http', 10, { method: 'GET', url: 'https://tasks.example/todos/1', payload: null });
    request.ctx.parent_span_id = ctx.span_id;
    r.events.find(e => e.event_type === 'http.request.started').data.origin = { initiator: handler, executor: handler, callsite: null };
    request.respond(30, 200, { title: 'Review task' }); request.finish(35);
  }
  if (mode !== 'interrupted') {
    const outcome = mode === 'throw' ? 'error' : mode === 'cancelled' ? 'cancelled' : mode === 'stopped' ? 'unknown' : 'success';
    const completion = mode === 'throw' ? 'threw' : mode === 'cancelled' ? 'cancelled' : mode === 'stopped' ? 'observation_stopped' : 'returned';
    const end = r.emit('operation.ended', 45, { outcome, completion, duration_ns: '40000000',
      error: mode === 'throw' ? err('HandlerError', 'Handler rejected task', 'unknown') : null }, ctx);
    if (mode === 'stopped') end.extensions = { 'capture.observation_stop_reason': 'capture_disabled' };
  }
  if (['http', 'no-http', 'throw'].includes(mode)) {
    const resume = { ...ctx, span_id: hex(name + '/resume', 16), parent_span_id: sdkStart.context.span_id };
    r.emit('operation.started', 46, { name: 'VerificationClient.acceptTask', origin: actor('sdk', 'VerificationClient', 'acceptTask') }, resume);
    r.emit('operation.ended', 48, { outcome: 'success', duration_ns: '2000000', error: null }, resume);
  }
  r.finish(50);
  save(name, r, `SDK invokes an app-owned handler (${mode}); return/unwind is separate from HTTP.`,
    expected(mode === 'http' ? 1 : 0, 0, { handler_calls: 1, unfinished_handler_calls: mode === 'interrupted' ? 1 : 0, unknown_handler_outcomes: mode === 'stopped' ? 1 : 0 }));
}

// Current synthetic multi-origin graph, replacing active references to older native evidence.
{
  const r = recording('viewer-three-origin');
  for (const [i, host] of ['api.example', 'auth.example', 'api.example'].entries()) {
    const call = r.request(`sdk-before-${i}`, 10 + i * 30, { url: `https://${host}/sdk/${i}`, payload: null });
    call.respond(20 + i * 30); call.finish(25 + i * 30);
  }
  const sdkStart = r.events.find(e => e.event_type === 'operation.started' && e.data.origin.owner === 'sdk');
  const handler = actor('integrator', 'CustomerTaskHandler', 'loadTask');
  const ctx = { ...sdkStart.context, span_id: hex('viewer-three-origin/handler', 16), parent_span_id: sdkStart.context.span_id, parent_scope: 'local' };
  r.emit('operation.started', 110, { name: 'CustomerTaskHandler.loadTask', origin: handler, invocation: { kind: 'handler', dispatch: 'synchronous', caller: sdk } }, ctx);
  const manualAdapter = { name: 'customer.manual', version: '0.1.0' };
  r.events[0].data.adapters.push({adapter: manualAdapter, capabilities: {attempts: 'logical', request_body: 'partial', response_body: 'partial', transaction_metrics: false}});
  const call = r.request('manual-task', 120, { method: 'GET', url: 'https://tasks.example/todos/1', payload: null });
  call.ctx.parent_span_id = ctx.span_id;
  const started = r.events.find(e => e.event_type === 'http.request.started' && e.context.span_id === call.ctx.span_id);
  started.data.adapter = manualAdapter;
  started.data.origin = {initiator: handler, executor: actor('integrator', 'CustomerTaskClient', 'loadTask'), callsite: null};
  call.respond(130, 200, {title: 'Synthetic task'}); call.finish(140);
  r.emit('operation.ended', 150, {outcome: 'success', completion: 'returned', duration_ns: '40000000', error: null}, ctx);
  for (let i = 0; i < 4; i++) {
    const request = r.request(`sdk-after-${i}`, 160 + i * 30, {url: `https://auth.example/sdk/after/${i}`, payload: null});
    request.respond(170 + i * 30); request.finish(175 + i * 30);
  }
  r.finish(300);
  save('viewer-three-origin', r, 'Synthetic current-format app handler, manual child HTTP and SDK traffic across three reserved origins.', expected(8, 0, {handler_calls: 1}));
}

// These acceptance captures use the current vocabulary, not prototype IDs.
{
  const name = 'handler-http-outlives-return';
  const r = recording(name);
  const sdkStart = r.events.find(e => e.event_type === 'operation.started' && e.data.origin.owner === 'sdk');
  const handler = actor('integrator', 'CustomerTaskHandler', 'loadTask');
  const ctx = { ...sdkStart.context, span_id: hex(`${name}/handler`, 16), parent_span_id: sdkStart.context.span_id, parent_scope: 'local' };
  r.emit('operation.started', 5, { name: 'CustomerTaskHandler.loadTask', origin: handler,
    invocation: { kind: 'handler', dispatch: 'synchronous', caller: sdk } }, ctx);
  const request = r.request('streaming-task', 10, { method: 'GET', url: 'https://tasks.example/todos/1', payload: null });
  request.ctx.parent_span_id = ctx.span_id;
  r.events.find(e => e.event_type === 'http.request.started').data.origin = { initiator: handler, executor: handler, callsite: null };
  request.respond(20, 200, null, { deferBody: true });
  // The handler returns its stream to application code; subsequent body delivery
  // is still causally linked to the handler, without extending its method span.
  r.emit('operation.ended', 25, { outcome: 'success', completion: 'returned', duration_ns: '20000000', error: null }, ctx);
  const resumed = { ...ctx, span_id: hex(`${name}/resume`, 16), parent_span_id: sdkStart.context.span_id };
  r.emit('operation.started', 26, { name: 'VerificationClient.acceptTask', origin: actor('sdk', 'VerificationClient', 'acceptTask') }, resumed);
  r.emit('operation.ended', 28, { outcome: 'success', duration_ns: '2000000', error: null }, resumed);
  r.emit('http.body.captured', 40, { direction: 'response', body: body({ title: 'Read after handler return' }) }, request.ctx);
  request.finish(45);
  r.finish(50);
  save(name, r, 'Handler returns at 25 ms; SDK resumes immediately while its app-owned HTTP child finishes reading at 45 ms. The method boundary is not stretched to the request end.',
    expected(1, 0, { handler_calls: 1, unfinished_handler_calls: 0, unknown_handler_outcomes: 0 }));
}
{
  const name = 'handler-repeated-nested';
  const r = recording(name, { methodOperations: false });
  const rootCtx = { trace_id: hex(`trace-${name}`, 32), span_id: hex(`${name}/sdk-root`, 16), parent_span_id: null, parent_scope: 'none' };
  r.emit('operation.started', 2, { name: 'VerificationClient.verify', origin: sdk }, rootCtx);
  const handler = actor('integrator', 'CustomerTaskHandler', 'loadTask');
  const tokenStore = actor('sdk', 'DemoAuthTokenStore', 'currentToken');
  const beginHandler = (label, ms, caller, callee, parent) => {
    const ctx = { ...parent, span_id: hex(`${name}/${label}`, 16), parent_span_id: parent.span_id, parent_scope: 'local' };
    r.emit('operation.started', ms, { name: `${callee.component}.${callee.method}`, origin: callee,
      invocation: { kind: 'handler', dispatch: 'synchronous', caller } }, ctx);
    return { ctx, returned: (end) => r.emit('operation.ended', end, { outcome: 'success', completion: 'returned', duration_ns: String((end - ms) * 1_000_000), error: null }, ctx) };
  };
  const childRequest = (label, ms, url, parent, executor) => {
    const request = r.request(label, ms, { method: 'GET', url, payload: null });
    request.ctx.parent_span_id = parent.span_id;
    request.ctx.parent_scope = 'local';
    r.events.find(e => e.event_type === 'http.request.started' && e.context.span_id === request.ctx.span_id).data.origin = { initiator: executor, executor, callsite: null };
    return request;
  };
  const first = beginHandler('load-task-1', 5, sdk, handler, rootCtx);
  const firstTask = childRequest('first-task', 10, 'https://tasks.example/todos/1', first.ctx, handler);
  firstTask.respond(20, 200, { title: 'First invocation' }); firstTask.finish(22);
  first.returned(25);
  const second = beginHandler('load-task-2', 30, sdk, handler, rootCtx);
  // The second app handler calls back into an SDK component synchronously.
  const nested = beginHandler('current-token', 40, handler, tokenStore, second.ctx);
  const token = childRequest('token-metadata', 45, 'https://auth.example/token-metadata', nested.ctx, tokenStore);
  token.respond(55, 200, { active: true, scope: 'tasks:read' }); token.finish(57);
  nested.returned(60);
  const secondTask = childRequest('second-task', 65, 'https://tasks.example/todos/2', second.ctx, handler);
  secondTask.respond(75, 200, { title: 'Second invocation' }); secondTask.finish(77);
  second.returned(80);
  const resumeCtx = { ...rootCtx, span_id: hex(`${name}/resume`, 16), parent_span_id: rootCtx.span_id, parent_scope: 'local' };
  r.emit('operation.started', 82, { name: 'VerificationClient.acceptTask', origin: actor('sdk', 'VerificationClient', 'acceptTask') }, resumeCtx);
  r.emit('operation.ended', 84, { outcome: 'success', duration_ns: '2000000', error: null }, resumeCtx);
  r.emit('operation.ended', 90, { outcome: 'success', duration_ns: '88000000', error: null }, rootCtx);
  r.finish(90);
  save(name, r, 'Two distinct CustomerTaskHandler.loadTask invocations (#1/#2); the second calls DemoAuthTokenStore.currentToken on the SDK at depth 2. App and SDK HTTP ownership follows each request origin.',
    expected(3, 0, { handler_calls: 3, unfinished_handler_calls: 0, unknown_handler_outcomes: 0 }));
}

writeFileSync(new URL('../examples/manifest.json', import.meta.url), `${JSON.stringify({ synthetic: true, captures }, null, 2)}\n`);
