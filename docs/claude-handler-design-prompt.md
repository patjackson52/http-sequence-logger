Update the existing structured network-log viewer design specifications to support SDK-to-app handler calls and the return of control to the SDK. Preserve the established visual system, file/session navigation, HTTP details, and domain lanes. Extend the existing design rather than restarting it.

Scenario

An Android client app passes a handler implementation to an SDK. While an SDK method is running, it invokes that handler. The handler executes app-owned code, potentially makes HTTP calls, and returns to the SDK. The SDK then continues its own method. We need to make the ownership changes and method boundaries visible independently of HTTP. A handler may make zero HTTP calls. This capability also applies conceptually to future iOS instrumentation.

Concrete sample

App sign-in calls DemoAuthSdk.authenticate(handler). The SDK performs demo authentication requests, invokes CustomerTaskHandler.loadTask(), and remains inside authenticate while the synchronous handler runs. The app handler calls GET https://jsonplaceholder.typicode.com/todos/1 using the customer's own HTTP client. When loadTask returns, control returns to DemoAuthSdk; DemoAuthSdk.acceptTask runs, then authenticate ends. Existing server participants include dummyjson.com, httpbin.org, and jsonplaceholder.typicode.com. These are public demo services, not a real identity-verification system.

Authoritative log model: draft 1.1

Use existing operation spans, not fake HTTP requests. A handler invocation starts with event_type="operation.started" and data:

{
  "name": "CustomerTaskHandler.loadTask",
  "origin": { "owner": "integrator", "component": "CustomerTaskHandler", "method": "loadTask" },
  "invocation": {
    "kind": "handler",
    "dispatch": "synchronous",
    "caller": { "owner": "sdk", "component": "DemoAuthSdk", "method": "authenticate" }
  }
}

The usual envelope contains schema_version="1.1", event_id, session_namespace, session_id, recording_id, sequence, timestamp, monotonic_ns, and context. Context contains trace_id, span_id, parent_span_id, and parent_scope. The handler has a distinct span_id for each invocation; its local parent is the calling SDK operation. origin identifies the handler/callee. invocation.caller identifies the immediate caller, not the top-level business initiator. A caller span may be missing or uninstrumented; explicit caller labels still exist.

The invocation ends with event_type="operation.ended", the SAME context/span ID, and data such as:

{
  "outcome": "success",
  "completion": "returned",
  "duration_ns": "125000000",
  "error": null
}

Exact mappings:
- completion="returned" → outcome="success": normal method return; the business value could still be false/rejected.
- completion="threw" → outcome="error": an exception unwinds to the caller. The caller may catch it, so an enclosing SDK operation may still succeed.
- completion="cancelled" → outcome="cancelled": observed cancellation exit, distinct from a successful return.
- completion="observation_stopped" → outcome="unknown": method exit was not observed. A stop reason is in extensions["capture.observation_stop_reason"]. Do NOT draw a confirmed return.
- Missing operation.ended → unfinished/unknown. Do NOT invent an end time or return arrow.

A nested HTTP request's context.parent_span_id points to the handler span. HTTP origin retains separate initiator and executor actors; app-owned requests must not be shown as executed by the SDK just because the SDK called the handler. No automatic handler argument/return-value capture exists. Display those fields as “Not captured” if surfaced. The existing error object is sanitized; its stage="unknown" does not make it a network error.

The importer supports both 1.0 and 1.1 recordings. Handler fields are new in 1.1. One recording uses one exact version; different recordings in a file may differ. Older generic operation spans must not be retrospectively labeled as known handler handoffs. IDs and explicit parent/caller relationships are authoritative; do not infer them from neighboring timestamps or hostnames.

Required design changes

1. Participants: add distinct local App code and SDK lifelines alongside one lane per server origin. Show component and method labels; allow component expansion without treating code components as network servers. Preserve the existing domain discovery behavior. Explain how two SDK components, repeated calls, nested calls, and same-role calls are differentiated.
2. Invocation: render an SDK → app call arrow at handler start, a handler activation block on the app side, and the explicit app → SDK return/unwind at handler completion. Use a clear local-call treatment distinct from HTTP arrows, status codes, and payload previews. Clicking arrow, block, or return selects the same invocation.
3. Waiting/resumption: keep the caller's SDK activation open during a synchronous handler call. Depict this invocation as waiting without implying every SDK thread is paused. Show the later acceptTask method as SDK work after the handler return. Elapsed duration includes nested HTTP/waiting; do not call it CPU or exclusive execution time.
4. Child HTTP: nest requests causally under the handler; their arrows originate from app code and terminate on the server lane. Show their own status, duration, errors, and permitted payload snippets. If a handler starts asynchronous HTTP and returns before it completes, show the actual method return, preserve the causal link, and let the HTTP request continue beyond the handler block.
5. States: specify normal return, caught exception, cancellation, stopped observation, missing end, missing parent, repeated handler calls, and nested/reentrant calls. Show a handler with zero HTTP as a first-class interaction. An unknown/missing exit must not look like a successful return. Do not turn an inner caught error into automatic failure of the entire session.
6. Inspector: caller/callee ownership, component/method, invocation kind/dispatch, trace/span/parent IDs, session/recording IDs, observed start/end, duration, completion/outcome, sanitized error, stop reason, and child requests. Preserve distinct “not captured”, “unknown”, and empty values. Do not invent handler arguments or returned payloads.
7. Controls: include local calls in the default sequence; offer clear filtering and collapse/expand. HTTP-only filtering should retain a collapsed ancestry indicator. Report handler counts separately from HTTP counts. The new scenario adds a local invocation, not another network request or destination server.
8. Ordering and scale: use sequence and monotonic time within a recording, retaining separate recordings and clocks. Support overlapping HTTP, independent concurrent SDK work, and many handler invocations. Do not derive causality from wall-clock proximity.
9. Scope: synchronous method calls are implemented now. Do not silently equate enqueue-return, coroutine suspension/resumption, or a later asynchronous completion with this synchronous return. Mark any future async continuation design as proposed and name the extra telemetry it would require.

Deliverables

Update the existing specs with the revised information model, sequence layout rules, interaction/inspector behavior, visual states, accessibility labels/keyboard behavior, and testable acceptance criteria. Include annotated sequence examples for: (a) handler with HTTP and normal return; (b) handler with no HTTP; (c) handler throws, SDK catches and continues; (d) interrupted/stopped observation; (e) nested or repeated handler calls; (f) HTTP that outlives its handler. Use actual fixture IDs/content when available. Clearly distinguish observed data from illustrative layout.

Acceptance criteria must explicitly confirm that call and return are visible without HTTP, customer HTTP stays attributed to app code, the correct SDK caller is the return destination, completion is paired by span identity, and incomplete captures never show fabricated returns. Preserve all existing HTTP inspection capabilities.

If repository artifacts are available, use these as the source of truth:
- HANDLER-TRACING.md
- CONTRACT.md and schema/event.schema.json (formats 1.0 and 1.1)
- examples/handler-http.ndjson
- examples/handler-no-http.ndjson
- examples/handler-throw.ndjson
- examples/handler-cancelled.ndjson
- examples/handler-stopped.ndjson
- examples/handler-interrupted.ndjson
- samples/live/successful-sign-in.ndjson
- android/demo-auth/src/main/kotlin/dev/networklog/demoauth/DemoAuthSdk.kt
- android/app/src/main/kotlin/dev/networklog/app/SampleFlow.kt

This request is to update the design specifications. Do not claim the web viewer has been implemented or that the native logger captures telemetry beyond the model above.
