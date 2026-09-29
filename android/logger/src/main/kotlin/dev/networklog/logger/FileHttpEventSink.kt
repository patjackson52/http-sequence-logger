package dev.networklog.logger

import org.json.JSONObject
import java.io.Closeable
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.RandomAccessFile
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.BasicFileAttributes
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

data class TransferLimits(
    val spoolBytes: Long = 16L * 1024 * 1024,
    val batchBytes: Int = 1024 * 1024,
    val batchEvents: Int = 500,
    val flushDelayMs: Long = 200,
    val initialRetryMs: Long = 500,
    val maximumRetryMs: Long = 30_000
) {
    init {
        require(spoolBytes in 1..(256L * 1024 * 1024))
        require(batchBytes in 1..(1024 * 1024) && batchEvents in 1..500)
        require(flushDelayMs in 0..250 && initialRetryMs in 1..maximumRetryMs && maximumRetryMs <= 60_000)
    }
}

/** Local append+fsync is synchronous; HTTP always runs on a private worker. Reopen the same file to resume. */
class FileHttpEventSink private constructor(
    val file: File,
    private val pairing: TransferConnection,
    private val limits: TransferLimits,
    private val diagnostic: (String) -> Unit,
    private val transport: EventTransport
) : EventSink, Closeable {
    constructor(file: File, connection: TransferConnection, limits: TransferLimits = TransferLimits(), diagnostic: (String) -> Unit = {}) :
        this(file, connection, limits, diagnostic, HttpEventTransport(connection))

    private val mutex = Object()
    private val scheduler = Executors.newSingleThreadScheduledExecutor { task -> Thread(task, "network-log-transfer").apply { isDaemon = true } }
    private val stateFile = File(file.path + ".transfer.json")
    private val lockFile = RandomAccessFile(File(file.path + ".transfer.lock").apply { parentFile?.mkdirs() }, "rw")
    private val writerLock = try { lockFile.channel.tryLock() ?: throw IOException("Capture spool already open") }
        catch (_: Exception) { lockFile.close(); throw IOException("Capture spool already open") }
    private var scheduled: ScheduledFuture<*>? = null
    private var closed = false
    private var uploading = false
    private var rejected = false
    private var failures = 0
    private var offset = 0L
    private var prefixHash = sha256(byteArrayOf())
    private var identity = ""

    init {
        try {
            file.parentFile?.mkdirs()
            if (!file.exists()) FileOutputStream(file).use { it.fd.sync() }
            require(file.length() <= limits.spoolBytes) { "Capture spool exceeds configured limit" }
            repairTail()
            identity = fileIdentity()
            restore()
            synchronized(mutex) { schedule(0) }
        } catch (error: Exception) {
            writerLock.release(); lockFile.close(); scheduler.shutdownNow()
            throw IOException("Could not open capture spool", error.takeUnless { it.message?.contains(pairing.token) == true })
        }
    }

    override fun append(line: String) {
        val bytes = (line + "\n").toByteArray(Charsets.UTF_8)
        if (bytes.size > limits.batchBytes || line.contains('\n') || line.contains('\r')) throw IOException("Capture event exceeds limit or contains a line break")
        try { require(JSONObject(line).getString("event_id").isNotEmpty()) }
        catch (_: Exception) { throw IOException("Capture event requires an event ID") }
        synchronized(mutex) {
            if (closed) throw IOException("Capture spool closed")
            refreshIdentity()
            val previousSize = file.length()
            if (previousSize + bytes.size > limits.spoolBytes) { report("Capture spool full; export or rotate the file"); throw IOException("Capture spool full") }
            try {
                FileOutputStream(file, true).use { output -> output.write(bytes); output.flush(); output.fd.sync() }
            } catch (_: Exception) {
                runCatching { RandomAccessFile(file, "rw").use { it.setLength(previousSize); it.fd.sync() } }
                throw IOException("Capture spool write failed")
            }
            schedule(limits.flushDelayMs)
            mutex.notifyAll()
        }
    }

    /** Explicit retry after correcting a rejected pairing/batch; transient failures retry automatically. */
    fun retryNow() = synchronized(mutex) { rejected = false; scheduled?.cancel(false); scheduled = null; schedule(0) }

    /** For worker-thread callers/tests only. This never performs networking on the waiting thread. */
    fun awaitUploaded(timeoutMs: Long): Boolean {
        require(timeoutMs >= 0)
        val end = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)
        synchronized(mutex) {
            schedule(0)
            while (!closed && offset < file.length() && !rejected) {
                val left = end - System.nanoTime()
                if (left <= 0) return false
                TimeUnit.NANOSECONDS.timedWait(mutex, left)
            }
            return offset == file.length()
        }
    }

    fun pendingBytes(): Long = synchronized(mutex) { refreshIdentity(); (file.length() - offset).coerceAtLeast(0) }

    /** Does not wait for a network response. Unacknowledged bytes remain durable for a later reopen. */
    override fun close() {
        synchronized(mutex) {
            if (closed) return
            closed = true; scheduled?.cancel(false); scheduler.shutdownNow()
            writerLock.release(); lockFile.close(); mutex.notifyAll()
        }
        runCatching { transport.cancel() }
    }

    private data class Batch(val body: ByteArray, val ids: List<String>, val start: Long, val end: Long, val identity: String, val hash: String)
    private fun schedule(delay: Long) {
        if (!closed && !rejected && !uploading && scheduled == null)
            scheduled = scheduler.schedule(::send, delay, TimeUnit.MILLISECONDS)
    }
    private fun send() {
        val batch = synchronized(mutex) {
            scheduled = null
            if (closed || rejected) return
            try { nextBatch() } catch (_: Exception) { rejected = true; report("Capture spool needs inspection before upload"); mutex.notifyAll(); return }
                ?.also { uploading = true } ?: run { mutex.notifyAll(); return }
        }
        var response: UploadResponse? = null
        try { response = transport.upload(batch.body) } catch (_: Exception) { /* No exception details: these may contain credentials. */ }
        synchronized(mutex) {
            uploading = false
            if (closed) return
            if (response?.status == 200 && validAck(response.body, batch.ids)) {
                try {
                    if (fileIdentity() != batch.identity || file.length() < batch.end || hashPrefix(batch.end) != batch.hash || offset != batch.start) {
                        reset(); report("Capture spool changed; replaying from its beginning"); schedule(0)
                    } else {
                        persist(batch.end, batch.hash, batch.identity)
                        offset = batch.end; prefixHash = batch.hash; failures = 0
                        report("Collector acknowledged capture events")
                        schedule(0)
                    }
                } catch (_: Exception) { report("Capture acknowledgment could not be persisted; retaining events"); retry() }
            } else if (response != null && response.status in 400..499 && response.status !in listOf(408, 429)) {
                rejected = true; report("Collector rejected upload (HTTP ${response.status}); capture retained for export")
            } else {
                report(if (response?.status == 200) "Collector acknowledgment did not match; capture retained" else "Collector unavailable; retrying retained capture")
                retry()
            }
            mutex.notifyAll()
        }
    }
    private fun retry() {
        val multiplier = 1L shl minOf(failures++, 16)
        schedule(minOf(limits.maximumRetryMs, limits.initialRetryMs * multiplier))
    }
    private fun nextBatch(): Batch? {
        refreshIdentity()
        if (offset == file.length()) return null
        val output = java.io.ByteArrayOutputStream()
        val ids = mutableListOf<String>()
        RandomAccessFile(file, "r").use { input ->
            input.seek(offset)
            val line = java.io.ByteArrayOutputStream()
            while (ids.size < limits.batchEvents && input.filePointer < input.length()) {
                val byte = input.read()
                if (byte == -1) break
                line.write(byte)
                if (line.size() > limits.batchBytes) throw IOException("Capture event exceeds upload limit")
                if (byte == 10) {
                    if (output.size() + line.size() > limits.batchBytes) break
                    val bytes = line.toByteArray()
                    val id = JSONObject(bytes.toString(Charsets.UTF_8)).getString("event_id")
                    require(id.isNotEmpty())
                    output.write(bytes); ids.add(id); line.reset()
                }
            }
        }
        if (ids.isEmpty()) throw IOException("Incomplete capture event")
        val end = offset + output.size()
        return Batch(output.toByteArray(), ids, offset, end, identity, hashPrefix(end))
    }
    private fun validAck(bytes: ByteArray, ids: List<String>): Boolean = try {
        require(bytes.size <= 512 * 1024)
        val ack = JSONObject(bytes.toString(Charsets.UTF_8))
        require(ack.get("version") == 1 && ack.getString("collector_id") == pairing.collectorId)
        require(ack.getInt("accepted") >= 0 && ack.getInt("duplicates") >= 0)
        require(ack.getInt("accepted") + ack.getInt("duplicates") == ids.size && ack.getLong("cursor") >= 0)
        val acknowledged = ack.getJSONArray("acknowledged_event_ids")
        require(acknowledged.length() <= limits.batchEvents)
        (0 until acknowledged.length()).map { acknowledged.getString(it) }.toSet() == ids.toSet()
    } catch (_: Exception) { false }

    private fun restore() {
        try {
            if (!stateFile.exists() || stateFile.length() > 8192) return
            val saved = JSONObject(stateFile.readText(Charsets.UTF_8))
            val candidate = saved.getLong("offset")
            if (saved.getString("scope") == pairing.scope && saved.getString("file_identity") == identity &&
                candidate in 0..file.length() && hashPrefix(candidate) == saved.getString("prefix_sha256")) {
                if (candidate > 0) RandomAccessFile(file, "r").use { it.seek(candidate - 1); require(it.read() == 10) }
                offset = candidate; prefixHash = saved.getString("prefix_sha256")
            }
        } catch (_: Exception) { offset = 0; prefixHash = sha256(byteArrayOf()) }
    }
    private fun refreshIdentity() {
        if (!file.exists()) FileOutputStream(file).use { it.fd.sync() }
        if (file.length() > limits.spoolBytes) throw IOException("Capture spool exceeds limit")
        if (fileIdentity() != identity || file.length() < offset || hashPrefix(offset) != prefixHash) reset()
    }
    private fun reset() { offset = 0; prefixHash = sha256(byteArrayOf()); identity = fileIdentity() }
    private fun fileIdentity(): String = Files.readAttributes(file.toPath(), BasicFileAttributes::class.java).let {
        (it.fileKey()?.toString() ?: "unknown") + ":" + it.creationTime().toMillis()
    }
    private fun hashPrefix(length: Long): String {
        val digest = MessageDigest.getInstance("SHA-256")
        RandomAccessFile(file, "r").use { input ->
            val buffer = ByteArray(16 * 1024)
            var remaining = length
            while (remaining > 0) {
                val count = input.read(buffer, 0, minOf(remaining, buffer.size.toLong()).toInt())
                if (count < 0) throw IOException("Capture spool changed")
                digest.update(buffer, 0, count); remaining -= count
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) }
    }
    private fun persist(position: Long, hash: String, fileIdentity: String) {
        val value = obj("version" to 1, "scope" to pairing.scope, "file_identity" to fileIdentity,
            "offset" to position, "prefix_sha256" to hash)
        val temporary = File(stateFile.path + ".tmp")
        FileOutputStream(temporary).use { it.write(value.toString().toByteArray(Charsets.UTF_8)); it.fd.sync() }
        Files.move(temporary.toPath(), stateFile.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
    }
    private fun repairTail() {
        RandomAccessFile(file, "rw").use { input ->
            if (input.length() == 0L) return
            input.seek(input.length() - 1)
            if (input.read() == 10) return
            var end = input.length()
            var retained = 0L
            val buffer = ByteArray(16 * 1024)
            while (end > 0) {
                val count = minOf(end, buffer.size.toLong()).toInt()
                input.seek(end - count); input.readFully(buffer, 0, count)
                val newline = (count - 1 downTo 0).firstOrNull { buffer[it].toInt() == 10 }
                if (newline != null) { retained = end - count + newline + 1; break }
                end -= count
            }
            input.setLength(retained); input.fd.sync()
            report("Incomplete final capture line removed after interrupted write")
        }
    }
    private fun report(message: String) { runCatching { diagnostic(message) } }

    internal companion object {
        fun testing(file: File, connection: TransferConnection, transport: EventTransport, limits: TransferLimits = TransferLimits(), diagnostic: (String) -> Unit = {}) =
            FileHttpEventSink(file, connection, limits, diagnostic, transport)
    }
}
