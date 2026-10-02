package dev.networklog.app

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.networklog.logger.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Opt-in live test. Makes 17 total requests to three public demo services; no customer data. */
@RunWith(AndroidJUnit4::class)
class LiveFlowTest {
    @Test fun successfulAndRecoverySessionsProduceRealLogs() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val file = File(instrumentationFixtureDirectory(context), "live/capture.ndjson")
        check(!file.exists()) { "Use a fresh fixture ID; retained captures must not be deleted" }
        FileHttpEventSink(file,null).use { sink ->
            val logger = NetworkLog(sink, context.packageName)
            assertEquals("Emily", SampleFlow.run(RecordingLogger(logger)).name)
            assertEquals("Emily", SampleFlow.run(RecordingLogger(logger), "demo-reused-session", recovery = true).name)
        }
        val lines = file.readLines()
        val events = lines.map(::JSONObject)
        fun typed(type: String) = events.filter { it.getString("event_type") == type }
        assertEquals(2, typed("session.started").size)
        assertEquals(2, typed("session.ended").size)
        assertEquals(17, typed("http.request.started").size)
        assertEquals(17, typed("http.ended").size)
        assertEquals(16, typed("http.ended").count { it.getJSONObject("data").getString("outcome") == "success" })
        assertEquals(1, typed("http.ended").count { it.getJSONObject("data").getInt("status_code") == 401 })
        assertEquals(2, typed("http.request.started").count { it.getJSONObject("data").getJSONObject("adapter").getString("name") == "customer.manual" })
        assertEquals(3, typed("http.request.started").map { java.net.URI(it.getJSONObject("data").getJSONObject("request").getString("url")).host }.toSet().size)
        val handlers = typed("operation.started").filter { it.getJSONObject("data").has("invocation") }
        assertEquals(2, handlers.size)
        for (handler in handlers) {
            val spanId = handler.getJSONObject("context").getString("span_id")
            val end = typed("operation.ended").single { it.getJSONObject("context").getString("span_id") == spanId }
            assertEquals("returned", end.getJSONObject("data").getString("completion"))
            val child = typed("http.request.started").single { it.getJSONObject("context").optString("parent_span_id") == spanId }
            assertEquals("customer.manual", child.getJSONObject("data").getJSONObject("adapter").getString("name"))
            val resumed = typed("operation.started").single { it.getString("recording_id") == handler.getString("recording_id") && it.getJSONObject("data").getString("name") == "DemoAuthSdk.acceptTask" }
            assertTrue(end.getLong("sequence") < resumed.getLong("sequence"))
        }
        assertFalse(file.readText().contains("emilyspass"))
        assertFalse(file.readText().contains("eyJhbGci"))
    }
}
