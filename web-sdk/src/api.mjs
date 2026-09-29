// Production entry: deliberately has no imports, clocks, IDs, storage or capture code.
const exchange = Object.freeze({ context: null, responseHeaders() {}, requestBody() {}, responseBody() {}, complete() {}, fail() {}, timeout() {}, cancel() {}, stopObservation() {} });
const operation = Object.freeze({ context: null, end() {}, returned() {}, threw() {}, cancel() {}, stopObservation() {} });
const session = Object.freeze({
  enabled: false, sessionId: null, recordingId: null,
  startOperation() { return operation; }, startHandler() { return operation; }, startRequest() { return exchange; },
  invokeHandler(_options, fn) { return fn(null); },
  async invokeAsyncHandler(_options, fn) { return await fn(null); },
  end() {},
});
export const noOpLogger = Object.freeze({ enabled: false, startSession() { return session; } });
export function createLogger() { return noOpLogger; }
export function createFetchClient(_session, { fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
  return { fetch: (input, init) => fetchImpl(input, init), readText: response => response.text(), readJson: response => response.json(), readArrayBuffer: response => response.arrayBuffer(), exchangeFor: () => exchange };
}
export function observeXHR() { return { exchange, dispose() {} }; }
