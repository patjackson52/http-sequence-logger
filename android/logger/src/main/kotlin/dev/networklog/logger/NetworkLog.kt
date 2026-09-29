package dev.networklog.logger

import android.os.Build
import android.os.SystemClock
import org.json.JSONObject
import java.io.Closeable
import java.io.File
import java.io.Writer
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.UUID

fun interface EventSink { fun append(line: String) }

/** Share one sink across sessions. Invoke capture APIs off the UI thread with this synchronous file sink. */
class NdjsonFileSink(file: File) : EventSink, Closeable {
    private val writer: Writer = file.apply { parentFile?.mkdirs() }.outputStream().bufferedWriter(Charsets.UTF_8)
    @Synchronized override fun append(line: String) { writer.write(line); writer.write("\n"); writer.flush() }
    @Synchronized override fun close() { writer.close() }
}

interface CaptureClock {
    fun monotonicNanos(): Long
    fun timestamp(): String
}
class AndroidCaptureClock : CaptureClock {
    override fun monotonicNanos() = SystemClock.elapsedRealtimeNanos()
    override fun timestamp(): String = FORMAT.format(Instant.now())
    companion object { private val FORMAT = DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC) }
}

@ConsistentCopyVisibility
data class CaptureContext internal constructor(
    internal val recordingId: String, val traceId: String, val spanId: String, val parentSpanId: String?
) {
    internal fun json() = obj("trace_id" to traceId, "span_id" to spanId, "parent_span_id" to parentSpanId,
        "parent_scope" to if (parentSpanId == null) "none" else "local")
}

class NetworkLog(
    private val sink: EventSink,
    private val appId: String,
    private val namespace: String = "dev.networklog.sample/development",
    private val policy: CapturePolicy = CapturePolicy(),
    private val clock: CaptureClock = AndroidCaptureClock(),
    private val osVersion: String = Build.VERSION.RELEASE ?: "unknown",
    private val diagnostic: (String) -> Unit = {}
) {
    fun startSession(name: String, sessionId: String? = null): Session =
        Session(sink, appId, namespace, policy, clock, osVersion, diagnostic, name, sessionId)
}

class Session internal constructor(
    private val sink: EventSink, private val appId: String, private val namespace: String,
    internal val policy: CapturePolicy, private val clock: CaptureClock, private val osVersion: String,
    private val diagnostic: (String) -> Unit, name: String, providedId: String?
) {
    val sessionId = providedId ?: UUID.randomUUID().toString()
    val recordingId = UUID.randomUUID().toString()
    internal val lock = Any()
    private val origin = clock.monotonicNanos()
    private var sequence = 0L
    private var dropped = 0L
    internal var ended = false
    private val requests = mutableSetOf<Exchange>()
    private val operations = mutableSetOf<Operation>()
    private val handlers = mutableSetOf<HandlerCall>()
    init {
        require(sessionId.isNotEmpty() && sessionId.length <= 512)
        guarded {
            emit("session.started", null, obj("name" to name, "id_source" to if (providedId == null) "generated" else "provided",
                "producer" to obj("platform" to "android", "app_id" to appId, "app_version" to "0.1.0", "os_version" to osVersion, "sdk_version" to "0.2.0"),
                "adapters" to array(listOf("customer.manual", "httpurlconnection").map { adapter ->
                    obj("adapter" to adapter(adapter), "capabilities" to obj("attempts" to "logical", "request_body" to "partial", "response_body" to "partial", "transaction_metrics" to false))
                }), "capture_policy" to policy.json(), "trace_propagation" to "disabled", "propagation_origins" to array(emptyList<Any>())), 0L)
        }
    }
    internal fun adapter(name: String) = obj("name" to name, "version" to "0.1.0")
    internal fun now() = (clock.monotonicNanos() - origin).coerceAtLeast(0)
    internal fun report(message: String) { runCatching { diagnostic(message) } }
    internal fun guarded(block: () -> Unit) = synchronized(lock) {
        try { block() } catch (_: Exception) { report("Capture failed; network behavior preserved") }
    }
    internal fun emit(type: String, context: CaptureContext?, data: JSONObject, time: Long = now(), extensions: JSONObject? = null) {
        if (ended) return
        val event = obj("schema_version" to "1.1", "event_type" to type, "event_id" to UUID.randomUUID().toString(),
            "session_namespace" to namespace, "session_id" to sessionId, "recording_id" to recordingId,
            "sequence" to ++sequence, "timestamp" to clock.timestamp(), "monotonic_ns" to time.toString(), "data" to data)
        context?.let { event.put("context", it.json()) }
        extensions?.let { event.put("extensions", it) }
        try { sink.append(event.toString()) } catch (_: Exception) { dropped++; report("Event sink unavailable") }
    }
    internal fun context(parent: CaptureContext?): CaptureContext {
        val usable = parent?.takeIf { it.recordingId == recordingId }
        if (parent != null && usable == null) report("Cross-recording parent ignored")
        return CaptureContext(recordingId, usable?.traceId ?: id(), id().take(16), usable?.spanId)
    }
    fun startOperation(name: String, actor: Actor = Actor(), parent: CaptureContext? = null): Operation = synchronized(lock) {
        Operation(this, context(parent), now()).also { op -> guarded {
            if (!ended) { operations.add(op); emit("operation.started", op.context, obj("name" to name, "origin" to actor.json()), op.started) }
        } }
    }
    /** Observe a synchronous local call. The parent is the invoking method; origin is the handler. */
    fun startHandler(name: String, caller: Actor, handler: Actor, parent: CaptureContext? = null): HandlerCall = synchronized(lock) {
        HandlerCall(this, context(parent), now()).also { call -> guarded {
            if (!ended) {
                emit("operation.started", call.context, obj("name" to name, "origin" to handler.json(),
                    "invocation" to obj("kind" to "handler", "dispatch" to "synchronous", "caller" to caller.json())), call.started)
                handlers.add(call)
            }
        } }
    }
    /** Runs application code outside the recorder lock. Preserves the exact result or exception. */
    fun <T> invokeHandler(name: String, caller: Actor, handler: Actor, parent: CaptureContext? = null,
                         block: (CaptureContext) -> T): T {
        val call = startHandler(name, caller, handler, parent)
        try {
            val result = block(call.context)
            call.returned()
            return result
        } catch (error: java.util.concurrent.CancellationException) {
            call.cancelled(error)
            throw error
        } catch (error: Throwable) {
            call.threw(error)
            throw error
        }
    }
    fun startRequest(method: String, url: String, parent: CaptureContext? = null,
        initiator: Actor = Actor(), executor: Actor = initiator,
        headers: HeaderCapture = HeaderCapture.unavailable(), adapter: String = "customer.manual",
        retryOf: Exchange? = null, attemptReason: String = "retry"
    ): Exchange = synchronized(lock) {
        val previous = retryOf?.takeIf { it.session === this && it.terminal }
        val context = if (previous != null) CaptureContext(recordingId, previous.context.traceId, id().take(16), previous.context.parentSpanId) else context(parent)
        Exchange(this, context, now(), previous?.let { it.attemptIndex + 1 } ?: 0).also { exchange -> guarded {
            if (!ended) {
                val safe = policy.url(url)
                val registered = adapter.takeIf { it in listOf("customer.manual", "httpurlconnection") } ?: "customer.manual"
                emit("http.request.started", context, obj("name" to "$method ${URIPath(safe.first)}",
                    "origin" to obj("initiator" to initiator.json(), "executor" to executor.json(),
                        "callsite" to obj("source" to "explicit", "file" to null, "line" to null, "function" to executor.method)),
                    "adapter" to adapter(registered), "request" to obj("method" to method, "method_source" to "configured",
                        "url" to safe.first, "url_redacted" to safe.second, "headers" to policy.headers(headers)),
                    "attempt" to obj("index" to exchange.attemptIndex, "visibility" to "logical",
                        "reason" to if (previous != null) attemptReason else "initial", "previous_span_id" to previous?.context?.spanId)), exchange.started)
                exchange.active = true; requests.add(exchange)
            }
        } }
    }
    internal fun forget(exchange: Exchange) { requests.remove(exchange) }
    internal fun forget(handler: HandlerCall) { handlers.remove(handler) }
    internal fun forget(operation: Operation) { operations.remove(operation) }
    fun end() = guarded {
        if (!ended) {
            requests.toList().forEach { it.stopObservation("session_ended") }
            handlers.toList().asReversed().forEach { it.stopObservation("session_ended") }
            operations.toList().forEach { it.complete("cancelled") }
            emit("session.ended", null, obj("reason" to "completed", "dropped_events" to dropped))
            ended = true
        }
    }
    private fun id() = UUID.randomUUID().toString().replace("-", "")
    private fun URIPath(url: String) = java.net.URI(url).rawPath.ifEmpty { "/" }
}

class Operation internal constructor(private val session: Session, val context: CaptureContext, internal val started: Long) {
    private var terminal = false
    fun complete(outcome: String = "success", error: Throwable? = null) = session.guarded {
        if (!terminal && !session.ended) {
            val end = session.now(); terminal = true
            session.emit("operation.ended", context, obj("outcome" to outcome, "duration_ns" to (end - started).toString(),
                "error" to error?.let { safeError(it, "unknown") }), end)
            session.forget(this)
        }
    }
}

/** One invocation, identified by its span ID; completion observes method exit, not an HTTP status. */
class HandlerCall internal constructor(private val session: Session, val context: CaptureContext, internal val started: Long) {
    private var terminal = false
    fun returned() = finish("returned", "success")
    fun threw(error: Throwable) = finish("threw", "error", error)
    fun cancelled(error: Throwable? = null) = finish("cancelled", "cancelled", error)
    fun stopObservation(reason: String = "observation_stopped") = finish("observation_stopped", "unknown", reason = reason)
    private fun finish(boundary: String, outcome: String, error: Throwable? = null, reason: String? = null) = session.guarded {
        if (!terminal && !session.ended) {
            val end = session.now(); terminal = true
            session.emit("operation.ended", context, obj("outcome" to outcome, "completion" to boundary,
                "duration_ns" to (end - started).toString(),
                "error" to error?.let { obj("type" to it.javaClass.simpleName, "message" to "Handler invocation failed", "stage" to "unknown") }),
                end, reason?.let { obj("capture.observation_stop_reason" to it) })
            session.forget(this)
        }
    }
}

class Exchange internal constructor(internal val session: Session, val context: CaptureContext,
    internal val started: Long, internal val attemptIndex: Int
) {
    internal var active = false
    internal var terminal = false
    private var status: Int? = null
    private val bodies = mutableSetOf<String>()
    private fun observe(block: () -> Unit) = session.guarded { if (active && !terminal && !session.ended) block() }
    fun receiveResponseHeaders(status: Int, headers: HeaderCapture = HeaderCapture.unavailable(), effectiveUrl: String? = null) = observe {
        require(status in 100..599)
        if (this.status != null) { if (this.status != status) session.report("Conflicting final response ignored"); return@observe }
        val safe = effectiveUrl?.let { session.policy.url(it) }
        val final = status >= 200 || status == 101
        session.emit("http.response.headers", context, obj("phase" to if (final) "final" else "informational",
            "response" to obj("status_code" to status, "status_text" to null, "url" to safe?.first,
                "url_redacted" to (safe?.second ?: false), "headers" to session.policy.headers(headers))))
        if (final) this.status = status
    }
    fun captureRequestBody(body: BodyCapture) = capture("request", body)
    fun captureResponseBody(body: BodyCapture) = capture("response", body)
    private fun capture(direction: String, body: BodyCapture) = observe {
        if (direction !in bodies) {
            val snapshot = session.policy.body(body)
            session.emit("http.body.captured", context, obj("direction" to direction, "body" to snapshot)); bodies.add(direction)
        }
    }
    fun completeResponse(status: Int? = null, headers: HeaderCapture = HeaderCapture.unavailable(),
        body: BodyCapture? = null, effectiveUrl: String? = null, intentionallyClosed: Boolean = false) = observe {
        if (status != null) receiveResponseHeaders(status, headers, effectiveUrl)
        if (this.status == null) { stopObservation("status_not_observed"); return@observe }
        body?.let { captureResponseBody(it) }
        finish(if (this.status!! >= 400) "http_error" else "success", if (intentionallyClosed) "body_closed" else "body_eof", null)
    }
    fun fail(error: Throwable, stage: String = "unknown") = observe { finish("transport_error", "transport_failure", safeError(error, stage)) }
    fun timeout(error: Throwable, stage: String = "unknown") = observe { finish("timeout", "transport_failure", safeError(error, stage)) }
    fun cancel(error: Throwable? = null) = observe { finish("cancelled", "cancelled", error?.let { safeError(it, "unknown") }) }
    fun stopObservation(reason: String = "observation_stopped") = observe {
        session.report("Observation stopped: $reason")
        finish("unknown", "observation_stopped", null, reason)
    }
    private fun finish(outcome: String, reason: String, error: JSONObject?, observationReason: String? = null) {
        captureRequestBody(BodyCapture.unavailable()); captureResponseBody(BodyCapture.unavailable())
        val end = session.now(); terminal = true
        session.emit("http.ended", context, obj("outcome" to outcome, "application_outcome" to "unknown", "status_code" to status,
            "duration_ns" to (end - started).toString(), "end_reason" to reason, "error" to error), end,
            observationReason?.let { obj("capture.observation_stop_reason" to it) })
        session.forget(this)
    }
}
internal fun safeError(error: Throwable, stage: String) = obj("type" to error.javaClass.simpleName,
    "message" to "Network operation failed", "stage" to stage)
