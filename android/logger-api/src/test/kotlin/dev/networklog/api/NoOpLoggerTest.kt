package dev.networklog.api

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CancellationException

class NoOpLoggerTest {
    @Test fun disabledRequestsNeverEvaluateHeadersOrBodiesAndReuseHandles() {
        val session = NoOpLogger.startSession("checkout")
        assertFalse(NoOpLogger.enabled)
        assertEquals("", session.sessionId)
        val exchange = session.startRequest("GET", "https://example.test", headers = { error("metadata must remain lazy") })
        assertSame(exchange, session.startRequest("POST", "https://example.test"))
        assertNull(exchange.context.traceparent("https://example.test"))
        exchange.captureRequestBody { error("no serialization/copy in release") }
        exchange.captureResponseBody { error("no body supplier in release") }
        exchange.receiveResponseHeaders(200, { error("no headers in release") })
        exchange.completeResponse(200, { error("headers") }, { error("body") })
        exchange.fail(IllegalStateException()); exchange.timeout(IllegalStateException()); exchange.cancel(); exchange.stopObservation()
        session.end()
        assertEquals("existing", NoOpLogger.startSession("checkout", "existing").sessionId)
    }
    @Test fun handlerExecutesExactlyOnceAndReturnsSameObjectWithoutRecording() {
        var count = 0
        val expected = Any()
        val actual = NoOpLogger.startSession("checkout").invokeHandler("callback", Actor("sdk"), Actor()) { count++; expected }
        assertSame(expected, actual)
        assertEquals(1, count)
    }
    @Test fun handlerPropagatesIdenticalExceptionCancellationAndError() {
        val session = NoOpLogger.startSession("checkout")
        for (expected in listOf(IllegalStateException("failure"), CancellationException("cancel"), AssertionError("error"))) {
            var calls = 0
            try { session.invokeHandler("callback", Actor("sdk"), Actor()) { calls++; throw expected }; fail("must throw") }
            catch (actual: Throwable) { assertSame(expected, actual) }
            assertEquals(1, calls)
        }
    }
}
