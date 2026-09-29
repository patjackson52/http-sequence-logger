package dev.networklog.logger

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.util.concurrent.CountDownLatch

class RecorderTest {
    private class Clock : CaptureClock {
        private var time = 0L
        @Synchronized override fun monotonicNanos(): Long { time += 10_000; return time }
        override fun timestamp() = "2026-09-28T12:00:00.000Z"
    }
    private class Fixture(policy: CapturePolicy = CapturePolicy()) {
        val lines = mutableListOf<String>()
        val logger = NetworkLog(EventSink { lines.add(it) }, "test", policy = policy, clock = Clock(), osVersion = "test")
        val session = logger.startSession("test")
        fun events(type: String) = lines.map(::JSONObject).filter { it.getString("event_type") == type }
    }
    @Test fun manualRequestWorksWithoutOperationOrBodies() {
        val f = Fixture(); f.session.startRequest("GET", "https://example.com/").completeResponse(200); f.session.end()
        assertEquals("none", f.events("http.request.started").single().getJSONObject("context").getString("parent_scope"))
        assertEquals(2, f.events("http.body.captured").size)
        assertEquals("success", f.events("http.ended").single().getJSONObject("data").getString("outcome"))
    }
    @Test fun duplicateTerminalCallsRaceSafely() {
        val f = Fixture(); val request = f.session.startRequest("GET", "https://example.com/")
        val latch = CountDownLatch(1)
        val threads = (1..24).map { Thread { latch.await(); request.completeResponse(200); request.cancel() }.apply { start() } }
        latch.countDown(); threads.forEach { it.join() }; f.session.end()
        assertEquals(1, f.events("http.ended").size)
        assertEquals(1, f.events("http.response.headers").size)
        assertEquals((1..f.lines.size).toList(), f.lines.map { JSONObject(it).getInt("sequence") })
    }
    @Test fun headerObservationDoesNotEndBodyLifecycle() {
        val f = Fixture(); val request = f.session.startRequest("GET", "https://example.com/")
        request.receiveResponseHeaders(200)
        assertTrue(f.events("http.ended").isEmpty())
        request.timeout(SocketTimeoutException(), "read")
        val end = f.events("http.ended").single().getJSONObject("data")
        assertEquals(200, end.getInt("status_code")); assertEquals("timeout", end.getString("outcome"))
    }
    @Test fun secretsAreRemovedBeforeSink() {
        val f = Fixture(); val request = f.session.startRequest("POST", "https://example.com/?token=topsecret&x=1&x=2",
            headers = HeaderCapture.partial(listOf("Authorization" to "Bearer secret-header")))
        request.captureRequestBody(BodyCapture.bytes("""{"password":"secret-password","nested":{"accessToken":"secret-token"}}""".toByteArray()))
        request.completeResponse(200, body = BodyCapture.bytes("""{"refreshToken":"secret-refresh"}""".toByteArray()))
        val output = f.lines.joinToString()
        listOf("topsecret", "secret-header", "secret-password", "secret-token", "secret-refresh").forEach { assertFalse(it, output.contains(it)) }
        assertTrue(output.contains("x=1&x=2")); assertTrue(output.contains("[REDACTED]"))
    }
    @Test fun relativeLocationSecretsAndFragmentsAreRedacted() {
        val policy = CapturePolicy()
        for (value in listOf("/callback?token=secret&x=1", "//example.com/cb?code=secret", "https://example.com/?access_token=secret", "/cb#secret", "/cb?token=%zzsecret")) {
            val result = policy.headers(HeaderCapture.library(listOf("Location" to value))).toString()
            assertFalse(value, result.contains("secret"))
        }
    }
    @Test fun optInCapturesBinaryAndPartialDataWithExactCounts() {
        val policy = CapturePolicy(allowUnstructuredBodies = true)
        val binary = policy.body(BodyCapture.bytes(byteArrayOf(0, -1, 32), "application/octet-stream"))
        assertEquals("captured", binary.getString("availability"))
        assertArrayEquals(byteArrayOf(0, -1, 32), java.util.Base64.getDecoder().decode(binary.getJSONObject("content").getString("data")))
        val partial = policy.body(BodyCapture.prefix("abc".toByteArray(), totalBytes = 12))
        assertTrue(partial.getBoolean("truncated")); assertEquals(12, partial.getInt("total_bytes")); assertEquals(3, partial.getInt("stored_bytes"))
    }
    @Test fun partialAndMalformedJsonAreWithheld() {
        val policy = CapturePolicy()
        listOf(BodyCapture.prefix("{\"password\":\"secret".toByteArray()), BodyCapture.bytes("invalid-secret".toByteArray())).forEach {
            val body = policy.body(it); assertEquals("unavailable", body.getString("availability")); assertTrue(body.isNull("content"))
        }
    }
    @Test fun multibyteLimitPreservesExactStoredByteCount() {
        val policy = CapturePolicy(bodyLimitBytes = 12)
        val body = policy.body(BodyCapture.bytes("""{"value":"🌍🌍"}""".toByteArray()))
        assertTrue(body.getBoolean("truncated"))
        assertEquals(12, java.util.Base64.getDecoder().decode(body.getJSONObject("content").getString("data")).size)
    }
    @Test fun sinkAndDiagnosticsCannotBreakNetworking() {
        val logger = NetworkLog(EventSink { throw java.io.IOException("disk full") }, "test", clock = Clock(), osVersion = "test", diagnostic = { error("broken diagnostic") })
        val session = logger.startSession("test"); session.startRequest("GET", "https://example.com/").completeResponse(200); session.end()
    }
    @Test fun stopPreservesKnownStatusAndUnknownCompletion() {
        val f = Fixture(); val request = f.session.startRequest("GET", "https://example.com/")
        request.receiveResponseHeaders(500); request.stopObservation(); request.completeResponse()
        val end = f.events("http.ended").single().getJSONObject("data")
        assertEquals("unknown", end.getString("outcome")); assertEquals(500, end.getInt("status_code"))
    }
    @Test fun omittedSnapshotsDoNotPreventLateBodyCapture() {
        val f = Fixture(); val request = f.session.startRequest("GET", "https://example.com/")
        request.receiveResponseHeaders(200); request.completeResponse(body = BodyCapture.bytes("{}".toByteArray()))
        val response = f.events("http.body.captured").single { it.getJSONObject("data").getString("direction") == "response" }
        assertEquals("captured", response.getJSONObject("data").getJSONObject("body").getString("availability"))
    }
    @Test fun retryKeepsTraceAndSiblingParent() {
        val f = Fixture(); val request = f.session.startRequest("GET", "https://example.com/"); request.completeResponse(401)
        val retry = f.session.startRequest("GET", "https://example.com/", retryOf = request)
        assertEquals(request.context.traceId, retry.context.traceId); assertEquals(request.context.parentSpanId, retry.context.parentSpanId)
        assertEquals(1, retry.attemptIndex)
    }
    @Test fun reusedSessionIdCreatesNewRecording() {
        val f = Fixture(); val a = f.logger.startSession("one", "shared"); val b = f.logger.startSession("two", "shared")
        assertEquals(a.sessionId, b.sessionId); assertNotEquals(a.recordingId, b.recordingId)
    }
    @Test fun sessionEndSettlesPendingObservation() {
        val f = Fixture(); val request = f.session.startRequest("GET", "https://example.com/"); f.session.end(); request.completeResponse(200)
        assertEquals("unknown", f.events("http.ended").single().getJSONObject("data").getString("outcome"))
        assertEquals("session.ended", JSONObject(f.lines.last()).getString("event_type"))
    }
    private class Connection(private val code: Int, private val input: InputStream) : HttpURLConnection(URL("https://example.com/")) {
        override fun getResponseCode() = code
        override fun getInputStream() = input
        override fun getErrorStream() = input
        override fun getHeaderFields(): MutableMap<String?, MutableList<String>> = mutableMapOf(null to mutableListOf("HTTP/1.1 $code"), "Content-Type" to mutableListOf("application/json"))
        override fun getContentType() = "application/json"
        override fun disconnect() {}
        override fun usingProxy() = false
        override fun connect() {}
    }
    @Test fun getBodyIsRejectedBeforeNetworkingAndLogging() {
        val f = Fixture()
        val client = LoggingHttpClient(f.session, Actor(), Actor(), openConnection = { error("must not execute") })
        try { client.execute("GET", "https://example.com/", body = "{}".toByteArray()); fail("expected argument error") }
        catch (_: IllegalArgumentException) { assertTrue(f.events("http.request.started").isEmpty()) }
    }
    @Test fun preHeaderTimeoutHasUnknownStage() {
        val f = Fixture()
        val client = LoggingHttpClient(f.session, Actor(), Actor(), openConnection = { throw SocketTimeoutException() })
        try { client.execute("GET", "https://example.com/"); fail("must fail") } catch (_: SocketTimeoutException) { }
        assertEquals("unknown", f.events("http.ended").single().getJSONObject("data").getJSONObject("error").getString("stage"))
    }
    @Test fun observationStopReasonSurvivesSerialization() {
        val f = Fixture(); f.session.startRequest("GET", "https://example.com/").stopObservation("caller_lost_handle")
        assertEquals("caller_lost_handle", f.events("http.ended").single().getJSONObject("extensions").getString("capture.observation_stop_reason"))
    }
    @Test fun adapterCapturesErrorBodyWithoutTurningItIntoTransportError() {
        val f = Fixture()
        val client = LoggingHttpClient(f.session, Actor(), Actor(), openConnection = { Connection(401, ByteArrayInputStream("{\"message\":\"denied\"}".toByteArray())) })
        assertEquals(401, client.execute("GET", "https://example.com/").status)
        assertEquals("http_error", f.events("http.ended").single().getJSONObject("data").getString("outcome"))
    }
    @Test fun adapterCapturesReadTimeoutAfter200() {
        val f = Fixture(); val error = SocketTimeoutException("sensitive error detail")
        val client = LoggingHttpClient(f.session, Actor(), Actor(), openConnection = { Connection(200, object : InputStream() { override fun read(): Int = throw error }) })
        try { client.execute("GET", "https://example.com/"); fail("must throw original error") } catch (actual: SocketTimeoutException) { assertSame(error, actual) }
        val end = f.events("http.ended").single().getJSONObject("data")
        assertEquals(200, end.getInt("status_code")); assertEquals("timeout", end.getString("outcome"))
        assertFalse(f.lines.joinToString().contains("sensitive error detail"))
    }
    private val sdkActor = Actor("sdk", "DemoSdk", "run")
    private val appHandler = Actor("integrator", "AppHandler", "handle")
    @Test fun handlerWithoutHttpRetainsCallerAndReturnsExactObject() {
        val f = Fixture(); val parent = f.session.startOperation("DemoSdk.run", sdkActor)
        val result = Any()
        assertSame(result, f.session.invokeHandler("AppHandler.handle", sdkActor, appHandler, parent.context) { result })
        val start = f.events("operation.started").last().getJSONObject("data")
        assertEquals("integrator", start.getJSONObject("origin").getString("owner"))
        assertEquals("sdk", start.getJSONObject("invocation").getJSONObject("caller").getString("owner"))
        assertEquals("returned", f.events("operation.ended").last().getJSONObject("data").getString("completion"))
        assertTrue(f.events("http.request.started").isEmpty())
    }
    @Test fun handlerExceptionUnwindsWithoutChangingItsIdentity() {
        val f = Fixture(); val original = IllegalStateException("sensitive handler message")
        try { f.session.invokeHandler("handler", sdkActor, appHandler) { throw original }; fail("expected handler error") }
        catch (actual: IllegalStateException) { assertSame(original, actual) }
        val end = f.events("operation.ended").single().getJSONObject("data")
        assertEquals("threw", end.getString("completion")); assertEquals("error", end.getString("outcome"))
        assertFalse(f.lines.joinToString().contains("sensitive handler message"))
    }
    @Test fun handlerCancellationIsNotSuccessfulReturn() {
        val f = Fixture(); val original = java.util.concurrent.CancellationException()
        try { f.session.invokeHandler("handler", sdkActor, appHandler) { throw original } }
        catch (actual: java.util.concurrent.CancellationException) { assertSame(original, actual) }
        assertEquals("cancelled", f.events("operation.ended").single().getJSONObject("data").getString("completion"))
    }
    @Test fun stoppingSessionDoesNotInventHandlerReturn() {
        val f = Fixture()
        f.session.invokeHandler("handler", sdkActor, appHandler) { f.session.end() }
        val end = f.events("operation.ended").single()
        assertEquals("observation_stopped", end.getJSONObject("data").getString("completion"))
        assertEquals("unknown", end.getJSONObject("data").getString("outcome"))
        assertEquals("session_ended", end.getJSONObject("extensions").getString("capture.observation_stop_reason"))
    }
    @Test fun handlerRunsOutsideLockAndParentsCustomerHttp() {
        val f = Fixture()
        f.session.invokeHandler("handler", sdkActor, appHandler) { context ->
            val worker = Thread { f.session.startRequest("GET", "https://example.com/", context).completeResponse(200) }
            worker.start(); worker.join(2000)
            assertFalse("Recorder must not hold a lock while running customer code", worker.isAlive)
            assertEquals(context.spanId, f.events("http.request.started").single().getJSONObject("context").getString("parent_span_id"))
        }
    }
    @Test fun repeatedAndNestedHandlerCallsHaveDistinctSpansAndCorrectNesting() {
        val f = Fixture()
        repeat(2) {
            f.session.invokeHandler("handler", sdkActor, appHandler) { outer ->
                f.session.invokeHandler("nested", appHandler, Actor("integrator", "Nested", "run"), outer) { }
            }
        }
        val starts = f.events("operation.started")
        assertEquals(4, starts.map { it.getJSONObject("context").getString("span_id") }.toSet().size)
        assertEquals(starts[0].getJSONObject("context").getString("span_id"), starts[1].getJSONObject("context").getString("parent_span_id"))
        assertEquals(4, f.events("operation.ended").size)
    }
    @Test fun handlerStillRunsWhenSinkFails() {
        val logger = NetworkLog(EventSink { throw java.io.IOException() }, "test", clock = Clock(), osVersion = "test")
        val value = logger.startSession("test").invokeHandler("handler", sdkActor, appHandler) { 42 }
        assertEquals(42, value)
    }

}
