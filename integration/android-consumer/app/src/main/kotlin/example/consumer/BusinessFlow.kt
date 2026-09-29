package example.consumer

import dev.networklog.api.Actor
import dev.networklog.api.BodyCapture
import dev.networklog.api.CaptureContext
import dev.networklog.api.HeaderCapture
import dev.networklog.api.Logger
import dev.networklog.api.Session
import java.io.IOException
import java.net.SocketTimeoutException
import java.util.concurrent.CancellationException

data class BusinessRequest(val method: String, val url: String,
    val headers: List<Pair<String, String>>, val body: ByteArray?)
/** This existing client returns only after consuming/closing the body; streaming clients need separate boundaries. */
data class BusinessResponse(val status: Int, val headers: List<Pair<String, String>>,
    val body: ByteArray?, val mediaType: String?, val effectiveUrl: String)
fun interface BusinessHttpClient { fun execute(request: BusinessRequest): BusinessResponse }

fun recordExistingCall(session: Session, parent: CaptureContext, client: BusinessHttpClient,
    request: BusinessRequest): BusinessResponse {
    val exchange = session.startRequest(request.method, request.url, parent,
        initiator = Actor("integrator", "CustomerHandler", "submit"),
        executor = Actor("integrator", "ExistingHttpClient", "execute"),
        headers = { HeaderCapture.partial(request.headers, "application_configured_only") })
    try {
        exchange.captureRequestBody {
            request.body?.let { BodyCapture.bytes(it, "application/json") } ?: BodyCapture.none()
        }
        val response = client.execute(request)
        exchange.completeResponse(response.status,
            headers = { HeaderCapture.library(response.headers) },
            body = {
                response.body?.let { BodyCapture.bytes(it, response.mediaType ?: "application/octet-stream") }
                    ?: BodyCapture.unavailable("client_did_not_expose_body")
            }, effectiveUrl = response.effectiveUrl)
        return response // A received HTTP 4xx/5xx is still a received response.
    } catch (error: CancellationException) { exchange.cancel(error); throw error }
    catch (error: SocketTimeoutException) { exchange.timeout(error); throw error }
    catch (error: IOException) { exchange.fail(error); throw error }
    finally { exchange.stopObservation("customer_scope_exited") }
}

fun runBusinessFlow(logger: Logger, client: BusinessHttpClient, sessionId: String): BusinessResponse {
    val session = logger.startSession("External consumer smoke", sessionId)
    val operation = session.startOperation("MiniSdk.execute", Actor("sdk", "MiniSdk", "execute"))
    try {
        val response = session.invokeHandler("CustomerHandler.submit",
            caller = Actor("sdk", "MiniSdk", "execute"),
            handler = Actor("integrator", "CustomerHandler", "submit"), parent = operation.context) { parent ->
            recordExistingCall(session, parent, client, BusinessRequest("POST", "https://example.test/submit",
                listOf("Authorization" to "synthetic-secret", "Content-Type" to "application/json"),
                "{\"password\":\"synthetic-password\",\"value\":1}".toByteArray()))
        }
        operation.complete()
        return response
    } catch (error: CancellationException) { operation.complete("cancelled", error); throw error }
    catch (error: Throwable) { operation.complete("error", error); throw error }
    finally { session.end() }
}
