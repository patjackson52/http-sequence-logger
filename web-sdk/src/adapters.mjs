// These opt-in adapters observe application-visible data. They never install a
// global interceptor or clone a body. Trace propagation is explicitly allowlisted.
const noop = () => {};
const inertExchange = Object.freeze({
  context: null, responseHeaders: noop, requestBody: noop, responseBody: noop,
  complete: noop, fail: noop, timeout: noop, cancel: noop, stopObservation: noop,
});

function safe(action, fallback) {
  try { return action(); } catch { return fallback; }
}

function record(exchange, method, ...args) {
  safe(() => exchange[method](...args));
}

function start(session, supplier) {
  return safe(() => session.enabled ? session.startRequest(supplier) : inertExchange, inertExchange) || inertExchange;
}

function isRequest(value) {
  return typeof Request !== 'undefined' && value instanceof Request;
}

function isBytes(value) {
  return value instanceof Uint8Array || value instanceof ArrayBuffer;
}

function mediaType(headers) {
  return safe(() => new Headers(headers).get('content-type'), null);
}

function bodySnapshot(data, type, absentIsKnown = false) {
  if (typeof data === 'string' || isBytes(data)) return { data, mediaType: type };
  if (data == null && absentIsKnown) return { notApplicable: true, reason: 'no_request_body' };
  return { reason: 'request_body_not_observed', mediaType: type };
}

function signalOf(input, init) {
  return safe(() => init?.signal === undefined ? (isRequest(input) ? input.signal : undefined) : init.signal);
}

function failure(exchange, error, signal, stage) {
  const timedOut = safe(() => error?.name === 'TimeoutError' || (signal?.aborted && signal.reason?.name === 'TimeoutError'), false);
  if (timedOut) record(exchange, 'timeout', error);
  else if (safe(() => signal?.aborted || error?.name === 'AbortError', false)) record(exchange, 'cancel');
  else record(exchange, 'fail', error, stage);
}

/**
 * Fetch keeps its native arguments and returns the original Response. Use the
 * explicit readers, or exchangeFor(response), to observe body completion.
 * Metadata describes caller-owned attribution; it is never sent over HTTP.
 */
export function createFetchClient(session, { fetchImpl, origin, parent } = {}) {
  const send = fetchImpl || globalThis.fetch.bind(globalThis);
  const exchanges = new WeakMap();
  const signals = new WeakMap();

  async function fetch(input, init, metadata) {
    const enabled = safe(() => session.enabled, false);
    const exchange = start(session, () => {
      const request = isRequest(input) ? input : null;
      return {
        name: metadata?.name,
        method: init?.method ?? request?.method ?? 'GET',
        url: request?.url ?? new URL(String(input), globalThis.location?.href).href,
        headers: init?.headers ?? request?.headers,
        reason: 'application_configured_only',
        origin: metadata?.origin ?? origin,
        parent: metadata?.parent ?? parent,
        adapter: 'browser.fetch',
        traceparent: safe(() => new Headers(init?.headers ?? request?.headers).get('traceparent')),
      };
    });
    // The recorder evaluates these suppliers only while recording is enabled.
    record(exchange, 'requestBody', () => {
      const request = isRequest(input) ? input : null;
      const hasOverride = init?.body != null;
      const type = mediaType(init?.headers ?? request?.headers);
      return bodySnapshot(init?.body, type, !request || hasOverride);
    });
    const signal = enabled ? signalOf(input, init) : undefined;
    let outgoing = init;
    // Only configured first-party origins receive trace context. Keep native input/body ownership.
    safe(() => {
      const url=new URL(isRequest(input)?input.url:String(input),globalThis.location?.href);
      const context=exchange.context;
      if(enabled && session.propagationOrigins?.includes(url.origin) && !url.pathname.startsWith('/__networklog') && context && /^[0-9a-f]{32}$/.test(context.trace_id) && /^[0-9a-f]{16}$/.test(context.span_id)) {
        const headers=new Headers(init?.headers ?? (isRequest(input)?input.headers:undefined));
        // A pre-existing context belongs to the host's tracing setup; do not replace it.
        if(!headers.has('traceparent')) {
          headers.set('traceparent',`00-${context.trace_id}-${context.span_id}-01`);
          outgoing={...init,headers};
        }
      }
    });
    let response;
    try { response = await send(input, outgoing); }
    catch (error) { failure(exchange, error, signal, 'unknown'); throw error; }

    safe(() => { exchanges.set(response, exchange); signals.set(response, signal); });
    if (enabled) {
      const exposed = safe(() => response.status > 0 && response.type !== 'opaque' && response.type !== 'opaqueredirect', false);
      if (!exposed) {
        record(exchange, 'stopObservation', 'browser_response_not_exposed');
      } else {
        record(exchange, 'responseHeaders', () => ({
          status: response.status, statusText: response.statusText,
          url: response.url || null, headers: response.headers,
          reason: 'browser_filtered_headers',
        }));
        if (safe(() => response.body === null, false)) {
          record(exchange, 'responseBody', () => ({ notApplicable: true, reason: 'no_response_body' }));
          record(exchange, 'complete');
        }
      }
    }
    return response;
  }

  async function read(response, method) {
    const exchange = exchanges.get(response) || inertExchange;
    if (exchange === inertExchange) return response[method]();
    // A reader invoked on an already consumed/locked body cannot observe the
    // network's completion; its TypeError must not become a transport failure.
    const unavailableBeforeRead = safe(() => response.bodyUsed || response.body?.locked, false);
    let data;
    try { data = await response[method](); }
    catch (error) {
      if (unavailableBeforeRead) record(exchange, 'stopObservation', 'body_already_consumed_or_locked');
      else failure(exchange, error, signals.get(response), 'read');
      throw error;
    }
    record(exchange, 'responseBody', () => ({ data, mediaType: mediaType(response.headers) }));
    record(exchange, 'complete');
    return data;
  }

  return {
    fetch,
    readText: (response) => read(response, 'text'),
    // HTTP ends at EOF even if parsing the returned application bytes fails.
    readJson: async (response) => JSON.parse(await read(response, 'text')),
    readArrayBuffer: (response) => read(response, 'arrayBuffer'),
    exchangeFor: (response) => exchanges.get(response) || inertExchange,
  };
}

/**
 * Call after open()/setRequestHeader(), immediately before send(). One observer
 * covers one send; dispose before reusing an XHR. Omit body when it is unknown,
 * or supply body:null when send() has no body. No upload listener is added,
 * because merely adding one can cause an otherwise absent CORS preflight.
 */
export function observeXHR(session, xhr, metadataSupplier) {
  if (!safe(() => session.enabled, false)) return { exchange: inertExchange, dispose: noop };
  let metadata;
  const exchange = start(session, () => {
    metadata = metadataSupplier();
    return { ...metadata, reason: 'application_configured_only', adapter: 'browser.xhr' };
  });
  record(exchange, 'requestBody', () => bodySnapshot(
    metadata?.body,
    metadata?.mediaType ?? mediaType(metadata?.headers),
    metadata != null && Object.hasOwn(metadata, 'body'),
  ));

  let ended = false;
  let headersCaptured = false;
  const listeners = [];
  function detach() {
    for (const [type, listener] of listeners) safe(() => xhr.removeEventListener(type, listener));
    listeners.length = 0;
  }
  function captureHeaders() {
    if (headersCaptured || ended) return;
    if (!safe(() => xhr.readyState >= 2 && xhr.status > 0, false)) return;
    headersCaptured = true;
    record(exchange, 'responseHeaders', () => ({
      status: xhr.status, statusText: xhr.statusText, url: xhr.responseURL || null,
      headers: xhr.getAllResponseHeaders().split(/\r?\n/).filter(Boolean).map((line) => {
        const colon = line.indexOf(':');
        return [line.slice(0, colon), line.slice(colon + 1).trim()];
      }),
      reason: 'browser_filtered_headers',
    }));
  }
  function finish(kind) {
    if (ended) return;
    captureHeaders();
    ended = true;
    detach();
    if (kind === 'load') {
      if (!safe(() => xhr.status > 0, false)) {
        record(exchange, 'stopObservation', 'browser_response_not_exposed');
        return;
      }
      record(exchange, 'responseBody', () => {
        const type = xhr.getResponseHeader('content-type');
        if (xhr.responseType === '' || xhr.responseType === 'text') return { data: xhr.responseText, mediaType: type };
        if (xhr.responseType === 'arraybuffer' && xhr.response instanceof ArrayBuffer) return { data: xhr.response, mediaType: type };
        return { reason: 'xhr_response_type_not_captured', mediaType: type };
      });
      record(exchange, 'complete');
    } else if (kind === 'abort') record(exchange, 'cancel');
    else if (kind === 'timeout') record(exchange, 'timeout', new DOMException('XHR deadline elapsed', 'TimeoutError'));
    else record(exchange, 'fail', new TypeError('XHR network request failed'), 'unknown');
  }
  function add(type, listener) {
    safe(() => { xhr.addEventListener(type, listener); listeners.push([type, listener]); });
  }
  add('readystatechange', () => safe(captureHeaders));
  for (const kind of ['load', 'error', 'abort', 'timeout']) add(kind, () => safe(() => finish(kind)));

  return {
    exchange,
    dispose() {
      if (ended) return;
      ended = true;
      detach();
      record(exchange, 'stopObservation', 'xhr_observer_disposed');
    },
  };
}
