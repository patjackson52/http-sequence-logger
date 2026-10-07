# Server capture SDK

This development recorder runs in Node and Cloudflare Workers using standard Request/Response/Fetch APIs. Import `server-sdk/index.mjs` from the pinned logger checkout. It shares the logger's sanitization policy module; copy/package the whole checkout or preserve that dependency. The local package is private and is not published to npm. Capture schema is **1.3**, SDK/package version **0.2.0**.

```js
import { createServerLogger } from '/absolute/logger/server-sdk/index.mjs';

const logger = createServerLogger({
  service: 'server-a',
  environment: 'local',
  sessionNamespace: 'example.auth',
  runtime: 'node', // 'cloudflare' inside Workers
  propagationOrigins: ['https://server-b.example', 'https://server-c.example'],
  emit: event => applicationLogger.info({ http_sequence: event }),
});

export async function handle(request) {
  const response = await logger.handleRequest(request, async context => {
    context.log('Authentication lookup started'); // application-sanitized text
    const [b, c] = await Promise.all([
      context.fetch('https://server-b.example/lookup'),
      context.operation('Check entitlement', async child =>
        child.fetch('https://server-c.example/entitlement')),
    ]);
    return new Response(JSON.stringify({ b: b.status, c: c.status }));
  });
  await logger.flush(); // when emit returns a persistence promise
  return response;
}
```

`handleRequest(request, handler)` creates a separate recording and immutable explicit context for each invocation. Concurrent requests never share ambient state. Pass the callback's context into business HTTP client wiring (`fetcher: context.fetch`) and use the child context supplied by `operation(name, handler)`. A context retained after its handler settles stops recording and reports `context_closed`; business fetches still execute. Await child work before the handler returns if it belongs to that invocation.

The incoming valid W3C `traceparent` supplies the trace ID and the remote parent of a newly created server span. Each outgoing fetch creates its own client span and propagates only to the configured exact origins. On an allowed origin it replaces an existing outgoing header with the new client span ID, so forwarding incoming headers cannot reuse the caller's span. Calls outside the allowlist retain their original header behavior. Server B/C must also capture incoming requests to render the next hop. Existing trace systems should use the same header/context rather than introduce a second trace tree.

Options are declared in `index.d.mts`: required `service`, `sessionNamespace`, and `emit`; optional `environment`, `appVersion`, `runtime`, `propagationOrigins`, `fetch`, `policy`, and `onDiagnostic`. `parseTraceparent` and `traceparent` are exported for framework/service-binding integrations. `context.log(message, level)` accepts `debug`, `info`, `warn`, and `error`; it attaches a message to the active span without inventing a transaction.

The recorder emits canonical objects synchronously into the application logger. No separate file is required. `emit` can return a promise; errors report `emit_failed` and do not fail the business handler. `flush()` awaits the async emissions already admitted when it is called; `handleRequest` does not automatically await them. On Workers, retain asynchronous persistence with `executionContext.waitUntil(logger.flush())` or flush the application's per-request buffered records. Provider log pipelines can sample/truncate records, so use the [collector adapters](../collector/README.md#server-sources-and-parsing-adapters) and retained endpoint when complete developer traces are needed.

Request/response headers and URLs use the existing redaction defaults and configurable policy. Metadata evaluation failures (including oversized URLs or throwing message/name coercion) skip that observation and report `capture_failed`; business fetches, response identity, callbacks and thrown errors are preserved. Bodies are recorded as unavailable: the SDK never clones or consumes application streams. Outgoing observation ends when response headers arrive and explicitly reports `observation_stopped`/unknown outcome; it does not claim body EOF, application success, or measured network transaction phases. Server operation completion describes handler settlement, not the network's final delivery of the returned response. Free-form message text must be sanitized before calling `log`.

There is no ambient AsyncLocalStorage dependency, automatic middleware registration, provider credential handling, production no-op entry, or shipping build alias in this package. Keep development wiring out of the host's shipping build, and retain its actual runtime and error behavior.
