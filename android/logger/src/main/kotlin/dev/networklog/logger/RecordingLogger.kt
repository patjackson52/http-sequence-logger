package dev.networklog.logger

import dev.networklog.api.Actor as ApiActor
import dev.networklog.api.BodyCapture as ApiBody
import dev.networklog.api.CaptureContext as ApiContext
import dev.networklog.api.Exchange as ApiExchange
import dev.networklog.api.HandlerCall as ApiHandler
import dev.networklog.api.HeaderCapture as ApiHeaders
import dev.networklog.api.Logger
import dev.networklog.api.Operation as ApiOperation
import dev.networklog.api.Session as ApiSession

/** Debug-only adapter. Shared customer code imports logger-api; only debug wiring imports this class. */
class RecordingLogger(private val recorder: NetworkLog) : Logger {
    override val enabled = true
    override fun startSession(name: String, sessionId: String?): ApiSession = RecordingSession(recorder.startSession(name, sessionId))
}
private class RecordingContext(val native: CaptureContext) : ApiContext
private fun ApiContext?.native() = (this as? RecordingContext)?.native
private fun ApiActor.native() = Actor(owner, component, method)
private fun (() -> ApiHeaders).nativeHeaders(): HeaderCapture = try {
    val value = invoke()
    when (value.availability) {
        "captured" -> HeaderCapture.library(value.entries)
        "partial" -> HeaderCapture.partial(value.entries, value.reason ?: "caller_supplied_subset")
        else -> HeaderCapture.unavailable(value.reason ?: "not_recorded")
    }
} catch (_: Exception) { HeaderCapture.unavailable("metadata_supplier_failed") }
private fun (() -> ApiBody).nativeBody(): BodyCapture = try {
    val value = invoke()
    when {
        value.absent -> BodyCapture.none(value.reason ?: "no_body")
        value.data == null -> BodyCapture.unavailable(value.reason ?: "not_recorded")
        value.complete -> BodyCapture.bytes(requireNotNull(value.data), value.mediaType ?: "application/octet-stream")
        else -> BodyCapture.prefix(requireNotNull(value.data), value.observedBytes ?: value.data!!.size.toLong(), value.totalBytes,
            value.reason ?: "incomplete_transfer", value.mediaType ?: "application/octet-stream")
    }
} catch (_: Exception) { BodyCapture.unavailable("metadata_supplier_failed") }
private class RecordingSession(private val native: Session) : ApiSession {
    override val sessionId get() = native.sessionId
    override fun startOperation(name: String, actor: ApiActor, parent: ApiContext?): ApiOperation =
        RecordingOperation(native.startOperation(name, actor.native(), parent.native()))
    override fun startHandler(name: String, caller: ApiActor, handler: ApiActor, parent: ApiContext?): ApiHandler =
        RecordingHandler(native.startHandler(name, caller.native(), handler.native(), parent.native()))
    override fun startRequest(method: String, url: String, parent: ApiContext?, initiator: ApiActor, executor: ApiActor,
        headers: () -> ApiHeaders, adapter: String, retryOf: ApiExchange?, attemptReason: String): ApiExchange =
        RecordingExchange(native.startRequest(method, url, parent.native(), initiator.native(), executor.native(),
            headers.nativeHeaders(), adapter, (retryOf as? RecordingExchange)?.native, attemptReason))
    override fun end() = native.end()
}
private class RecordingOperation(private val native: Operation) : ApiOperation {
    override val context = RecordingContext(native.context)
    override fun complete(outcome: String, error: Throwable?) = native.complete(outcome, error)
}
private class RecordingHandler(private val native: HandlerCall) : ApiHandler {
    override val context = RecordingContext(native.context)
    override fun returned() = native.returned()
    override fun threw(error: Throwable) = native.threw(error)
    override fun cancelled(error: Throwable?) = native.cancelled(error)
    override fun stopObservation(reason: String) = native.stopObservation(reason)
}
private class RecordingExchange(val native: Exchange) : ApiExchange {
    override val context = RecordingContext(native.context)
    override fun receiveResponseHeaders(status: Int, headers: () -> ApiHeaders, effectiveUrl: String?) =
        native.receiveResponseHeaders(status, headers.nativeHeaders(), effectiveUrl)
    override fun captureRequestBody(body: () -> ApiBody) = native.captureRequestBody(body.nativeBody())
    override fun captureResponseBody(body: () -> ApiBody) = native.captureResponseBody(body.nativeBody())
    override fun completeResponse(status: Int?, headers: () -> ApiHeaders, body: (() -> ApiBody)?, effectiveUrl: String?, intentionallyClosed: Boolean) =
        native.completeResponse(status, headers.nativeHeaders(), body?.nativeBody(), effectiveUrl, intentionallyClosed)
    override fun fail(error: Throwable, stage: String) = native.fail(error, stage)
    override fun timeout(error: Throwable, stage: String) = native.timeout(error, stage)
    override fun cancel(error: Throwable?) = native.cancel(error)
    override fun stopObservation(reason: String) = native.stopObservation(reason)
}
