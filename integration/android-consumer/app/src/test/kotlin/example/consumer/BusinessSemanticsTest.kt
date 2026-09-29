package example.consumer

import dev.networklog.api.NoOpLogger
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.net.SocketTimeoutException
import java.util.concurrent.CancellationException

class BusinessSemanticsTest {
    @Test fun noOpStillCallsHandlerAndClientExactlyOnce() {
        var calls = 0
        val expected = BusinessResponse(401, emptyList(), null, null, "https://example.test/submit")
        val actual = runBusinessFlow(NoOpLogger, BusinessHttpClient { calls++; expected }, "external-id")
        assertSame(expected, actual)
        assertEquals(1, calls)
    }
    @Test fun noOpPreservesTransportTimeoutAndCancellation() {
        for (expected in listOf(IOException("offline"), SocketTimeoutException("timeout"), CancellationException("cancelled"))) {
            var calls = 0
            try {
                runBusinessFlow(NoOpLogger, BusinessHttpClient { calls++; throw expected }, "external-id")
                fail("Expected original failure")
            } catch (actual: Exception) { assertSame(expected, actual) }
            assertEquals(1, calls)
        }
    }
}
