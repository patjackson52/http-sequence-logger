package dev.networklog.logger

import org.json.JSONObject
import java.net.URI
import java.security.MessageDigest

/** Explicit development pairing. toString deliberately excludes the bearer credential. */
class TransferConnection private constructor(
    val endpoint: String,
    internal val token: String,
    val collectorId: String,
    val sourceId: String,
    val certificateSha256: String?
) {
    override fun toString() = "TransferConnection(paired=true)"
    internal fun json() = obj("version" to 2, "endpoint" to endpoint, "source_token" to token,
        "collector_id" to collectorId, "source_id" to sourceId, "certificate_sha256" to certificateSha256).toString()
    internal val scope: String get() = sha256("$collectorId\n$sourceId".toByteArray(Charsets.UTF_8))

    companion object {
        /** Invalid configurations fail with a static message that never quotes the input. */
        fun parse(json: String): TransferConnection = try {
            require(json.toByteArray(Charsets.UTF_8).size <= 16_384)
            val value = JSONObject(json)
            require(value.get("version") == 2)
            val uri = URI(value.getString("endpoint"))
            require(uri.scheme in listOf("http", "https") && uri.host != null)
            require(uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null)
            require(uri.rawPath.isNullOrEmpty() || uri.rawPath == "/")
            require(uri.port == -1 || uri.port in 1..65535)
            val host = uri.host.removePrefix("[").removeSuffix("]").lowercase()
            val ipv4 = host.split('.')
            val loopback = host == "localhost" || host == "::1" || host == "0:0:0:0:0:0:0:1" ||
                (ipv4.size == 4 && ipv4[0] == "127" && ipv4.all { it.isNotEmpty() && it.all(Char::isDigit) && (it.toIntOrNull() ?: -1) in 0..255 })
            require(uri.scheme == "https" || loopback)
            val token = value.getString("source_token")
            require(token.length in 1..4096 && token.all { it.code in 33..126 })
            val collector = value.getString("collector_id")
            require(collector.length in 1..512 && collector.none { it.isISOControl() })
            val pin = if (value.isNull("certificate_sha256")) null else value.getString("certificate_sha256")
            require(pin == null || uri.scheme == "https" && pin.matches(Regex("[0-9a-f]{64}")))
            TransferConnection("${uri.scheme}://${uri.rawAuthority}", token, collector, value.getString("source_id").also { require(it.length in 1..512 && it.none(Char::isISOControl)) }, pin)
        } catch (_: Exception) { throw IllegalArgumentException("Invalid collector connection configuration") }
    }
}

internal fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
    .digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }
