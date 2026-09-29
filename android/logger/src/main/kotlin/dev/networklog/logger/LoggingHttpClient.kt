package dev.networklog.logger

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL

/** Small opt-in, synchronous client. Call on a worker thread. Redirects are deliberately disabled. */
class LoggingHttpClient(
    private val session: Session,
    private val initiator: Actor,
    private val executor: Actor,
    private val parent: CaptureContext? = null,
    private val connectTimeoutMs: Int = 15_000,
    private val readTimeoutMs: Int = 15_000,
    private val openConnection: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection }
) {
    fun execute(method: String, url: String, headers: List<Pair<String, String>> = emptyList(),
                body: ByteArray? = null, retryOf: Exchange? = null): HttpResult {
        require(method != "GET" || body == null) { "HttpURLConnection rewrites GET with a body to POST; use explicit POST" }
        val exchange = session.startRequest(method, url, parent, initiator, executor,
            HeaderCapture.partial(headers, "application_configured_only"), "httpurlconnection", retryOf, "auth_challenge")
        var connection: HttpURLConnection? = null
        var stage = "unknown"
        val received = ByteArrayOutputStream()
        var mediaType = "application/json"
        try {
            connection = openConnection(URL(url)).apply {
                requestMethod = method
                instanceFollowRedirects = false
                connectTimeout = connectTimeoutMs; readTimeout = readTimeoutMs
                useCaches = false
                headers.forEach { (key, value) -> addRequestProperty(key, value) }
            }
            if (body != null) {
                connection.doOutput = true
                connection.setFixedLengthStreamingMode(body.size)
                val type = headers.firstOrNull { it.first.equals("content-type", true) }?.second ?: "application/octet-stream"
                exchange.captureRequestBody(BodyCapture.bytes(body, type))
                val upload = connection.outputStream // May connect; the phase is not exposed.
                stage = "write"
                upload.use { it.write(body) }
            } else exchange.captureRequestBody(BodyCapture.none())
            stage = "unknown"
            val status = connection.responseCode
            stage = "read"
            exchange.receiveResponseHeaders(status, HeaderCapture.fromConnection(connection), connection.url.toString())
            mediaType = connection.contentType ?: "application/octet-stream"
            val noBody = method == "HEAD" || status == 204 || status == 304
            if (noBody) exchange.captureResponseBody(BodyCapture.none("http_semantics"))
            else {
                val stream = if (status >= 400) connection.errorStream else connection.inputStream
                if (stream == null) exchange.captureResponseBody(BodyCapture.unavailable("native_stream_unavailable"))
                else stream.use { input ->
                    val buffer = ByteArray(8192)
                    while (true) {
                        val count = input.read(buffer)
                        if (count == -1) break
                        if (received.size() + count > MAX_RESPONSE_BYTES) throw IOException("Demo client response limit exceeded")
                        received.write(buffer, 0, count)
                    }
                    exchange.captureResponseBody(BodyCapture.bytes(received.toByteArray(), mediaType))
                }
            }
            exchange.completeResponse()
            return HttpResult(status, received.toByteArray(), exchange)
        } catch (error: SocketTimeoutException) {
            exchange.captureResponseBody(BodyCapture.prefix(received.toByteArray(), mediaType = mediaType))
            exchange.timeout(error, stage); throw error
        } catch (error: IOException) {
            exchange.captureResponseBody(BodyCapture.prefix(received.toByteArray(), mediaType = mediaType))
            exchange.fail(error, stage); throw error
        } finally {
            exchange.stopObservation("execute_exited")
            connection?.disconnect()
        }
    }
    companion object { const val MAX_RESPONSE_BYTES = 1_048_576 }
}

data class HttpResult(val status: Int, val body: ByteArray, val exchange: Exchange) {
    fun requireSuccess(): HttpResult { check(status in 200..299) { "HTTP $status" }; return this }
    fun json() = org.json.JSONObject(body.toString(Charsets.UTF_8))
}
