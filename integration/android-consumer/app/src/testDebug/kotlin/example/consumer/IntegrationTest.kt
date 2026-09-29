package example.consumer

import dev.networklog.logger.CaptureClock
import dev.networklog.logger.EventSink
import dev.networklog.logger.NetworkLog
import dev.networklog.logger.RecordingLogger
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class IntegrationTest {
    @Test fun syntheticHandlerCaptureValidatesAndRedacts() {
        val lines = mutableListOf<String>()
        val logger = RecordingLogger(NetworkLog(EventSink { lines.add(it) }, "example.consumer",
            namespace = "example.consumer/integration-test", osVersion = "synthetic",
            clock = object : CaptureClock {
                private var tick = 0L
                override fun monotonicNanos() = ++tick
                override fun timestamp() = "2026-09-29T00:00:00.000Z"
            }))
        var calls = 0
        val result = runBusinessFlow(logger, BusinessHttpClient { request ->
            calls++
            BusinessResponse(201, listOf("Content-Type" to "application/json"), "{\"ok\":true}".toByteArray(),
                "application/json", request.url)
        }, "synthetic-consumer-session")
        assertEquals(1, calls)
        assertEquals(201, result.status)
        val text = lines.joinToString("\n", postfix = "\n")
        assertFalse(text.contains("synthetic-secret"))
        assertFalse(text.contains("synthetic-password"))
        val events = lines.map(::JSONObject)
        val handler = events.single { it.getString("event_type") == "operation.started" && it.getJSONObject("data").has("invocation") }
        val handlerId = handler.getJSONObject("context").getString("span_id")
        val request = events.single { it.getString("event_type") == "http.request.started" }
        assertEquals(handlerId, request.getJSONObject("context").getString("parent_span_id"))
        val returned = events.single { it.getString("event_type") == "operation.ended" && it.getJSONObject("context").getString("span_id") == handlerId }
        assertEquals("returned", returned.getJSONObject("data").getString("completion"))
        val target = File("build/outputs/integration/synthetic-consumer.ndjson")
        requireNotNull(target.parentFile).mkdirs()
        target.writeText(text)
    }
}
