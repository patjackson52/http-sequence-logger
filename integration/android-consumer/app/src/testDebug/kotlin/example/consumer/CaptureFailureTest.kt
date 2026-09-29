package example.consumer

import dev.networklog.api.NoOpLogger
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

class CaptureFailureTest {
    @Test fun failedCaptureSetupStillExecutesBusinessRequest() {
        var calls = 0
        var diagnostics = 0
        val expected = BusinessResponse(201, emptyList(), null, null, "https://example.test/submit")
        openDevelopmentCapture(create = { throw IOException("sensitive file details") }, diagnostic = { diagnostics++ }).use { capture ->
            assertNull(capture.capturePath)
            assertFalse(capture.logger.enabled)
            val actual = runBusinessFlow(capture.logger, BusinessHttpClient { calls++; expected }, "external-id")
            assertSame(expected, actual)
        }
        assertEquals(1, calls)
        assertEquals(1, diagnostics)
    }

    @Test fun failedCloseAndDiagnosticCannotReplaceBusinessResultOrException() {
        var closes = 0
        fun capture() = openDevelopmentCapture(create = {
            object : CaptureLifetime {
                override val logger = NoOpLogger
                override val capturePath = "private-capture.ndjson"
                override fun close() { closes++; throw IOException("sensitive cleanup details") }
            }
        }, diagnostic = { throw IllegalStateException("diagnostic failure") })
        val expected = BusinessResponse(200, emptyList(), null, null, "https://example.test/submit")
        val actual = capture().use { runBusinessFlow(it.logger, BusinessHttpClient { expected }, "external-id") }
        assertSame(expected, actual)
        val failure = IOException("business failure")
        try {
            capture().use { runBusinessFlow(it.logger, BusinessHttpClient { throw failure }, "external-id") }
            fail("Expected business failure")
        } catch (error: IOException) { assertSame(failure, error) }
        assertEquals(2, closes)
    }
}
