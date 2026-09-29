package dev.networklog.logger

import dev.networklog.api.Actor
import dev.networklog.api.BodyCapture
import dev.networklog.api.HeaderCapture
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class RecordingLoggerTest {
    private fun recorder(lines: MutableList<String>) = RecordingLogger(NetworkLog(EventSink { lines.add(it) }, "test",
        clock = object : CaptureClock {
            var now = 0L
            override fun monotonicNanos() = ++now
            override fun timestamp() = "2026-09-29T00:00:00.000Z"
        }, osVersion = "test"))
    @Test fun sharedApiRecordsHandlerHttpAndReturnWithRedaction() {
        val lines = mutableListOf<String>()
        val logger = recorder(lines)
        val session = logger.startSession("checkout", "external")
        val op = session.startOperation("sdk", Actor("sdk", "SDK"))
        var bodies = 0
        val result = session.invokeHandler("customer", Actor("sdk", "SDK"), Actor(), op.context) { parent ->
            val exchange = session.startRequest("POST", "https://example.test", parent,
                headers = { HeaderCapture.partial(listOf("Authorization" to "private-token")) })
            exchange.captureRequestBody { bodies++; BodyCapture.bytes("{\"password\":\"secret\"}".toByteArray()) }
            exchange.completeResponse(200, { HeaderCapture.library(emptyList()) }, { BodyCapture.bytes("{}".toByteArray()) })
            "returned value"
        }
        op.complete(); session.end()
        assertTrue(logger.enabled)
        assertEquals("returned value", result)
        assertEquals(1, bodies)
        assertFalse(lines.joinToString().contains("private-token"))
        assertFalse(lines.joinToString().contains("secret"))
        val events = lines.map(::JSONObject)
        val handler = events.single { it.getString("event_type") == "operation.started" && it.getJSONObject("data").has("invocation") }
        val context = handler.getJSONObject("context")
        val request = events.single { it.getString("event_type") == "http.request.started" }
        assertEquals(context.getString("span_id"), request.getJSONObject("context").getString("parent_span_id"))
        val end = events.single { it.getString("event_type") == "operation.ended" && it.getJSONObject("context").getString("span_id") == context.getString("span_id") }
        assertEquals("returned", end.getJSONObject("data").getString("completion"))
    }
    @Test fun badMetadataSupplierDoesNotReplaceRequestOutcome() {
        val lines = mutableListOf<String>()
        val session = recorder(lines).startSession("bad metadata")
        val exchange = session.startRequest("GET", "https://example.test", headers = { error("supplier failed") })
        exchange.captureRequestBody { error("supplier failed") }
        exchange.completeResponse(200, body = { error("supplier failed") })
        session.end()
        val events = lines.map(::JSONObject)
        assertEquals("success", events.single { it.getString("event_type") == "http.ended" }.getJSONObject("data").getString("outcome"))
        assertTrue(lines.joinToString().contains("metadata_supplier_failed"))
        assertFalse(lines.joinToString().contains("supplier failed"))
    }
}
