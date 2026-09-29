package dev.networklog.demoauth

import dev.networklog.api.Actor
import dev.networklog.api.NoOpLogger
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL

class DemoHttpClientTest {
    private class Input(bytes: ByteArray) : ByteArrayInputStream(bytes) {
        var wasClosed = false
        override fun close() { wasClosed = true; super.close() }
    }
    private class Connection(private val code: Int, private val input: InputStream?) : HttpURLConnection(URL("https://example.com/")) {
        val uploaded = ByteArrayOutputStream()
        var uploadClosed = false
        var disconnected = false
        var inputRequests = 0
        var errorRequests = 0
        var uploadFailure: IOException? = null
        val uploadLength get() = fixedContentLength
        override fun getResponseCode() = code
        override fun getInputStream(): InputStream? { inputRequests++; return input }
        override fun getErrorStream(): InputStream? { errorRequests++; return input }
        override fun getOutputStream(): OutputStream = object : OutputStream() {
            override fun write(value: Int) { uploadFailure?.let { throw it }; uploaded.write(value) }
            override fun close() { uploadClosed = true }
        }
        override fun getHeaderFields(): MutableMap<String?, MutableList<String>> = error("Disabled capture must not inspect response headers")
        override fun getContentType(): String = error("Disabled capture must not inspect the media type")
        override fun disconnect() { disconnected = true }
        override fun usingProxy() = false
        override fun connect() = Unit
    }
    private fun client(open: (URL) -> HttpURLConnection) = DemoHttpClient(
        NoOpLogger.startSession("test"), Actor(), Actor(), openConnection = open)

    @Test fun disabledRecordingStillPostsExactBodyAndReturnsResponse() {
        val body = """{"challengeId":"opaque","demo":true}""".toByteArray()
        val responseBytes = """{"accepted":true}""".toByteArray()
        val input = Input(responseBytes)
        val connection = Connection(200, input)
        var opened = 0
        val result = client { url -> assertEquals("https://example.com/", url.toString()); opened++; connection }
            .execute("POST", "https://example.com/", listOf("Content-Type" to "application/json", "Authorization" to "Bearer synthetic"), body)

        assertEquals(1, opened)
        assertEquals("POST", connection.requestMethod)
        assertEquals("Bearer synthetic", connection.getRequestProperty("Authorization"))
        assertEquals(body.size, connection.uploadLength)
        assertArrayEquals(body, connection.uploaded.toByteArray())
        assertArrayEquals(responseBytes, result.requireSuccess().body)
        assertTrue(result.json().getBoolean("accepted"))
        assertFalse(connection.instanceFollowRedirects)
        assertFalse(connection.useCaches)
        assertEquals(15_000, connection.connectTimeout)
        assertEquals(15_000, connection.readTimeout)
        assertTrue(connection.uploadClosed)
        assertTrue(input.wasClosed)
        assertTrue(connection.disconnected)
    }

    @Test fun disabledRecordingPreservesHttpErrorBodyAndAllowsRetry() {
        val denied = Connection(401, Input("""{"message":"denied"}""".toByteArray()))
        val accepted = Connection(200, Input("""{"id":1}""".toByteArray()))
        val connections = ArrayDeque(listOf(denied, accepted))
        val http = client { connections.removeFirst() }
        val first = http.execute("GET", "https://example.com/")
        assertEquals(401, first.status)
        assertEquals("denied", first.json().getString("message"))
        assertEquals(1, denied.errorRequests)
        assertEquals(0, denied.inputRequests)
        try { first.requireSuccess(); fail("HTTP error must remain an error") }
        catch (error: IllegalStateException) { assertEquals("HTTP 401", error.message) }
        assertEquals(1, http.execute("GET", "https://example.com/", retryOf = first.exchange).requireSuccess().json().getInt("id"))
        assertTrue(connections.isEmpty())
        assertTrue(denied.disconnected)
        assertTrue(accepted.disconnected)
    }

    @Test fun disabledRecordingDoesNotReadBodiesForbiddenByHttpSemantics() {
        for ((method, code) in listOf("HEAD" to 200, "GET" to 204, "GET" to 304)) {
            val connection = Connection(code, object : InputStream() {
                override fun read(): Int = error("No body may be read for $method $code")
            })
            val result = client { connection }.execute(method, "https://example.com/")
            assertEquals(code, result.status)
            assertArrayEquals(byteArrayOf(), result.body)
            assertEquals(0, connection.inputRequests + connection.errorRequests)
            assertTrue(connection.disconnected)
        }
    }

    @Test fun disabledRecordingPreservesReadFailureIdentityAndClosesResources() {
        for (original in listOf(IOException("read failure"), SocketTimeoutException("read timeout"))) {
            var inputClosed = false
            val connection = Connection(200, object : InputStream() {
                override fun read(): Int = throw original
                override fun close() { inputClosed = true }
            })
            try { client { connection }.execute("GET", "https://example.com/"); fail("Read failure must propagate") }
            catch (actual: IOException) { assertSame(original, actual) }
            assertTrue(inputClosed)
            assertTrue(connection.disconnected)
        }
    }

    @Test fun disabledRecordingPreservesUploadFailureIdentity() {
        val original = IOException("upload failure")
        val connection = Connection(200, null).apply { uploadFailure = original }
        try { client { connection }.execute("POST", "https://example.com/", body = byteArrayOf(1)); fail("Upload failure must propagate") }
        catch (actual: IOException) { assertSame(original, actual) }
        assertTrue(connection.uploadClosed)
        assertTrue(connection.disconnected)
    }

    @Test fun disabledRecordingStillEnforcesResponseLimit() {
        val input = Input(ByteArray(DemoHttpClient.MAX_RESPONSE_BYTES + 1))
        val connection = Connection(200, input)
        try { client { connection }.execute("GET", "https://example.com/"); fail("Response limit must apply") }
        catch (actual: IOException) { assertEquals("Demo client response limit exceeded", actual.message) }
        assertTrue(input.wasClosed)
        assertTrue(connection.disconnected)
    }

    @Test fun getBodyIsRejectedBeforeOpeningConnection() {
        try {
            client { error("Must not open a connection") }.execute("GET", "https://example.com/", body = byteArrayOf(1))
            fail("GET body must be rejected")
        } catch (_: IllegalArgumentException) { }
    }

    @Test fun connectionFailurePropagatesUnchanged() {
        val original = SocketTimeoutException("connection timeout")
        try { client { throw original }.execute("GET", "https://example.com/"); fail("Connection failure must propagate") }
        catch (actual: SocketTimeoutException) { assertSame(original, actual) }
    }
}
