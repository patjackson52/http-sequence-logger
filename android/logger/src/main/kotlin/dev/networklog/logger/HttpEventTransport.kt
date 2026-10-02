package dev.networklog.logger

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.Proxy
import java.net.URL
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

internal const val MAX_ACK_BYTES = 2 * 1024 * 1024

internal data class UploadResponse(val status: Int, val body: ByteArray)
internal interface EventTransport {
    fun upload(body: ByteArray): UploadResponse
    fun cancel() {}
}

/** Uses native networking directly; never invokes a capture adapter or a customer HTTP client. */
internal class HttpEventTransport(private val pairing: TransferConnection) : EventTransport {
    @Volatile private var active: HttpURLConnection? = null

    override fun upload(body: ByteArray): UploadResponse = request("events", body, "application/x-ndjson")
    internal fun request(path: String, body: ByteArray, contentType: String = "application/json"): UploadResponse {
        val connection = URL("${pairing.endpoint}/api/v2/$path").openConnection(Proxy.NO_PROXY) as HttpURLConnection
        active = connection
        try {
            connection.instanceFollowRedirects = false
            connection.useCaches = false
            connection.connectTimeout = 5_000
            connection.readTimeout = 5_000
            connection.requestMethod = "POST"
            connection.doOutput = true
            connection.setRequestProperty("Authorization", "Bearer ${pairing.token}")
            connection.setRequestProperty("Content-Type", contentType)
            connection.setRequestProperty("Accept", "application/json")
            connection.setFixedLengthStreamingMode(body.size)
            if (connection is HttpsURLConnection && pairing.certificateSha256 != null) {
                val context = SSLContext.getInstance("TLS")
                context.init(null, arrayOf(PairedCertificateTrust(pairing.certificateSha256)), null)
                connection.sslSocketFactory = context.socketFactory
                // Preserve the platform verifier. A pin never authorizes a different hostname.
                connection.hostnameVerifier = HttpsURLConnection.getDefaultHostnameVerifier()
            }
            connection.outputStream.use { it.write(body) }
            val status = connection.responseCode
            if (status != 200) return UploadResponse(status, byteArrayOf())
            val result = ByteArrayOutputStream()
            connection.inputStream.use { input ->
                val buffer = ByteArray(8192)
                while (true) {
                    val count = input.read(buffer)
                    if (count == -1) break
                    if (result.size() + count > MAX_ACK_BYTES) throw IOException("Collector acknowledgment exceeds limit")
                    result.write(buffer, 0, count)
                }
            }
            return UploadResponse(status, result.toByteArray())
        } finally { active = null; connection.disconnect() }
    }
    override fun cancel() { active?.disconnect() }
}

/** An explicitly paired leaf is the trust anchor; expiry and hostname checks still apply. */
internal class PairedCertificateTrust(private val pin: String) : X509TrustManager {
    override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
        val leaf = chain.firstOrNull() ?: throw CertificateException("Missing paired certificate")
        leaf.checkValidity()
        val actual = sha256(leaf.encoded).toByteArray(Charsets.US_ASCII)
        if (!MessageDigest.isEqual(actual, pin.toByteArray(Charsets.US_ASCII)))
            throw CertificateException("Collector certificate does not match pairing")
    }
    override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) { throw CertificateException("Client trust is unsupported") }
    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}
