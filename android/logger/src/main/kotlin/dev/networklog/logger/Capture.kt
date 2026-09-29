package dev.networklog.logger

import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.net.HttpURLConnection
import java.net.URI
import java.net.URLDecoder
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction

internal fun obj(vararg fields: Pair<String, Any?>): JSONObject = JSONObject().apply {
    fields.forEach { (key, value) -> put(key, value ?: JSONObject.NULL) }
}
internal fun array(values: Iterable<*>): JSONArray = JSONArray().apply { values.forEach { put(it) } }

/** Explicit attribution survives thread and callback changes; no stack walk is required. */
data class Actor(val owner: String = "integrator", val component: String = "Customer", val method: String? = null) {
    internal fun json() = obj("owner" to owner, "component" to component, "method" to method)
}

@ConsistentCopyVisibility
data class HeaderCapture private constructor(
    val entries: List<Pair<String, String>>, val availability: String, val reason: String?
) {
    companion object {
        fun partial(entries: List<Pair<String, String>>, reason: String = "caller_supplied_subset") =
            HeaderCapture(entries.toList(), "partial", reason)
        fun library(entries: List<Pair<String, String>>) = HeaderCapture(entries.toList(), "captured", null)
        fun unavailable(reason: String = "not_recorded") = HeaderCapture(emptyList(), "unavailable", reason)
        fun fromConnection(connection: HttpURLConnection) = library(connection.headerFields.entries
            .filter { it.key != null }.flatMap { entry -> entry.value.orEmpty().map { entry.key!! to it } })
    }
}

/** Pass bytes already owned by your application. These helpers never read a stream. */
class BodyCapture private constructor(
    internal val bytes: ByteArray?, internal val mediaType: String?, internal val complete: Boolean,
    internal val observed: Long?, internal val total: Long?, internal val reason: String?, internal val absent: Boolean
) {
    companion object {
        fun bytes(data: ByteArray, mediaType: String = "application/json") =
            BodyCapture(data.copyOf(), mediaType, true, data.size.toLong(), data.size.toLong(), null, false)
        fun prefix(data: ByteArray, observedBytes: Long = data.size.toLong(), totalBytes: Long? = null,
                   reason: String = "incomplete_transfer", mediaType: String = "application/json") =
            BodyCapture(data.copyOf(), mediaType, false, observedBytes, totalBytes, reason, false)
        fun unavailable(reason: String = "not_recorded") = BodyCapture(null, null, false, null, null, reason, false)
        fun none(reason: String = "no_body") = BodyCapture(null, null, true, 0, 0, reason, true)
    }
}

/** JSON keys are redacted recursively, before persistence. Non-JSON/partial JSON fails closed. */
data class CapturePolicy(
    val bodyLimitBytes: Int = 64 * 1024,
    val allowUnstructuredBodies: Boolean = false,
    val redactHeaders: Set<String> = setOf("authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key"),
    val redactQueryKeys: Set<String> = setOf("token", "access_token", "refresh_token", "password", "code"),
    val redactJsonKeys: Set<String> = setOf("password", "accessToken", "refreshToken", "access_token", "refresh_token", "token", "ssn", "ein", "ip", "macAddress", "bank", "crypto", "userAgent", "origin", "x-forwarded-for", "x-real-ip", "cf-connecting-ip")
) {
    init { require(bodyLimitBytes in 1..1_048_576) }
    internal fun json() = obj("profile" to "development", "body_limit_bytes" to bodyLimitBytes,
        "redact_headers" to array(redactHeaders), "redact_query_keys" to array(redactQueryKeys),
        "redact_body_paths" to array(redactJsonKeys.map { "\$..$it" }))

    internal fun url(value: String): Pair<String, Boolean> {
        val uri = URI(value)
        require(uri.scheme in listOf("http", "https") && uri.host != null) { "Absolute HTTP(S) URL required" }
        return reference(value)
    }

    // HTTP Location is a URI-reference: relative redirects need the same query redaction.
    private fun reference(value: String): Pair<String, Boolean> {
        val uri = URI(value)
        var changed = uri.rawUserInfo != null || uri.rawFragment != null
        val query = uri.rawQuery?.split('&')?.joinToString("&") { part ->
            val key = URLDecoder.decode(part.substringBefore('='), "UTF-8")
            if (redactQueryKeys.any { it.equals(key, true) }) {
                changed = true; part.substringBefore('=') + "=%5BREDACTED%5D"
            } else part
        }
        var base = value.substringBefore('#').substringBefore('?')
        if (uri.rawUserInfo != null) base = base.replace("//${uri.rawUserInfo}@", "//")
        return (base + (query?.let { "?$it" } ?: "")) to changed
    }

    internal fun headers(capture: HeaderCapture): JSONObject = obj(
        "availability" to capture.availability, "representation" to "library", "order_preserved" to false,
        "reason" to capture.reason, "entries" to array(capture.entries.map { (name, value) ->
            val secret = redactHeaders.any { it.equals(name, true) }
            // Location may itself carry a credential in a query string.
            val location = if (name.equals("location", true)) runCatching { reference(value) }.getOrElse { "[REDACTED]" to true } else null
            obj("name" to name, "value" to if (secret) "[REDACTED]" else location?.first ?: value,
                "redacted" to (secret || location?.second == true))
        }))

    internal fun body(capture: BodyCapture): JSONObject {
        fun omitted(reason: String, absent: Boolean = false) = obj(
            "availability" to if (absent) "not_applicable" else "unavailable", "representation" to "application",
            "media_type" to capture.mediaType, "charset" to null, "content_encoding" to null,
            "observed_bytes" to capture.observed, "total_bytes" to capture.total, "stored_bytes" to 0,
            "truncated" to false, "redacted" to false, "reason" to reason, "content" to null)
        if (capture.bytes == null) return omitted(capture.reason ?: "not_recorded", capture.absent)
        require(capture.observed != null && capture.observed >= capture.bytes.size)
        require(capture.total == null || capture.total >= capture.observed)
        val isJson = capture.mediaType?.substringBefore(';')?.trim()?.lowercase()?.let { it == "application/json" || it.endsWith("+json") } == true
        if (!capture.complete || !isJson) {
            if (!allowUnstructuredBodies) return omitted(if (!capture.complete) "partial_body_withheld_for_redaction" else "non_json_body_withheld_by_policy")
            val retained = capture.bytes.copyOfRange(0, minOf(bodyLimitBytes, capture.bytes.size))
            val truncated = !capture.complete || retained.size < capture.bytes.size
            return obj("availability" to "captured", "representation" to "application", "media_type" to capture.mediaType,
                "charset" to null, "content_encoding" to null, "observed_bytes" to capture.observed, "total_bytes" to capture.total,
                "stored_bytes" to retained.size, "truncated" to truncated, "redacted" to false,
                "reason" to if (truncated) capture.reason ?: "body_limit" else null,
                "content" to obj("encoding" to "base64", "data" to java.util.Base64.getEncoder().encodeToString(retained)))
        }
        if (capture.bytes.size > 1_048_576) return omitted("body_exceeds_redaction_budget")
        val original = runCatching { Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(capture.bytes)).toString() }
            .getOrElse { return omitted("invalid_utf8_withheld") }
        val tokener = JSONTokener(original)
        val parsed = runCatching { tokener.nextValue() }.getOrElse { return omitted("invalid_json_withheld") }
        if ((parsed !is JSONObject && parsed !is JSONArray) || tokener.nextClean() != '\u0000') return omitted("invalid_json_withheld")
        var redacted = false
        fun clean(value: Any?) {
            when (value) {
                is JSONObject -> value.keys().asSequence().toList().forEach { key ->
                    if (redactJsonKeys.any { it.equals(key, true) }) { value.put(key, "[REDACTED]"); redacted = true }
                    else clean(value.opt(key))
                }
                is JSONArray -> (0 until value.length()).forEach { clean(value.opt(it)) }
            }
        }
        clean(parsed)
        val sanitized = (if (redacted) parsed.toString() else original).toByteArray(Charsets.UTF_8)
        val truncated = sanitized.size > bodyLimitBytes
        // Base64 for a byte-limited prefix avoids cutting a multi-byte code point.
        val retained = sanitized.copyOfRange(0, minOf(bodyLimitBytes, sanitized.size))
        val encoding = if (truncated) "base64" else "utf-8"
        val text = if (truncated) java.util.Base64.getEncoder().encodeToString(retained) else retained.toString(Charsets.UTF_8)
        return obj("availability" to "captured", "representation" to "application", "media_type" to capture.mediaType,
            "charset" to "utf-8", "content_encoding" to null, "observed_bytes" to capture.observed,
            "total_bytes" to capture.total, "stored_bytes" to retained.size, "truncated" to truncated,
            "redacted" to redacted, "reason" to if (truncated) "body_limit" else null,
            "content" to obj("encoding" to encoding, "data" to text))
    }
}
