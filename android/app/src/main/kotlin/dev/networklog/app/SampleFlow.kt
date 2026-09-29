package dev.networklog.app

import dev.networklog.demoauth.DemoAuthSdk
import dev.networklog.logger.*
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL

/** Runs entirely on the caller's worker thread. Same flow is exercised by the UI and device test. */
object SampleFlow {
    data class Result(val name: String, val task: String, val sessionId: String)
    fun run(logger: NetworkLog, sessionId: String? = null, recovery: Boolean = false, progress: (String) -> Unit = {}): Result {
        val session = logger.startSession(if (recovery) "Sign in with 401 recovery" else "Successful sign in", sessionId)
        val operation = session.startOperation("SampleApp.signIn", Actor("integrator", "SampleApp", "signIn"))
        try {
            val sdk = DemoAuthSdk(session, progress)
            val identity = sdk.authenticate(operation.context, recovery)
            progress("Load sample task · customer manual logging · JSONPlaceholder")
            val task = manuallyRecordedTask(session, operation.context)
            sdk.completeDemo(identity, operation.context)
            operation.complete()
            return Result(identity.displayName, task, session.sessionId)
        } catch (error: Exception) { operation.complete("error", error); throw error }
        finally { session.end() }
    }

    // This is deliberately the customer's own HttpURLConnection code, not LoggingHttpClient.
    // Only the exchange.* calls were added for instrumentation.
    private fun manuallyRecordedTask(session: Session, parent: CaptureContext): String {
        val url = "https://jsonplaceholder.typicode.com/todos/1"
        val exchange = session.startRequest("GET", url, parent,
            Actor("integrator", "CustomerTaskClient", "loadTask"), headers = HeaderCapture.partial(emptyList(), "application_configured_only"))
        var connection: HttpURLConnection? = null
        var stage = "unknown"
        try {
            exchange.captureRequestBody(BodyCapture.none())
            connection = (URL(url).openConnection() as HttpURLConnection).apply {
                connectTimeout = 15_000; readTimeout = 15_000; instanceFollowRedirects = false
            }
            val status = connection.responseCode
            stage = "read"
            exchange.receiveResponseHeaders(status, HeaderCapture.fromConnection(connection), connection.url.toString())
            val stream = if (status >= 400) connection.errorStream else connection.inputStream
            val bytes = stream?.use { input ->
                val out = java.io.ByteArrayOutputStream()
                val buffer = ByteArray(4096)
                while (true) {
                    val count = input.read(buffer); if (count < 0) break
                    if (out.size() + count > 65_536) throw IOException("Demo task response too large")
                    out.write(buffer, 0, count)
                }
                out.toByteArray()
            }
            exchange.completeResponse(body = bytes?.let { BodyCapture.bytes(it, connection.contentType ?: "application/json") }
                ?: BodyCapture.unavailable("native_stream_unavailable"))
            check(status == 200) { "Task endpoint HTTP $status" }
            return JSONObject(requireNotNull(bytes).toString(Charsets.UTF_8)).getString("title")
        } catch (error: SocketTimeoutException) { exchange.timeout(error, stage); throw error }
        catch (error: IOException) { exchange.fail(error); throw error }
        finally { exchange.stopObservation("customer_scope_exited"); connection?.disconnect() }
    }
}
