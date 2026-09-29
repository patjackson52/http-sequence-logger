package dev.networklog.logger

import android.content.Context
import android.content.pm.ApplicationInfo
import java.io.Closeable
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/** The debug factory never activates transfer in a non-debuggable app. */
object DebugTransfer {
    private fun enabled(context: Context) = context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
    fun configurationFile(context: Context) = File(context.filesDir, "network-log/connection.json")

    fun readConnection(context: Context): TransferConnection? {
        if (!enabled(context)) return null
        val file = configurationFile(context)
        if (!file.exists()) return null
        require(file.length() <= 16_384) { "Collector configuration exceeds limit" }
        return TransferConnection.parse(file.readText(Charsets.UTF_8))
    }

    /** Call on a worker thread. The private app file is never copied into a capture. */
    fun saveConnection(context: Context, json: String) {
        check(enabled(context)) { "Collector pairing requires a debuggable application" }
        val pairing = TransferConnection.parse(json)
        val file = configurationFile(context)
        file.parentFile?.mkdirs()
        val temporary = File(file.path + ".tmp")
        FileOutputStream(temporary).use { it.write(pairing.json().toByteArray(Charsets.UTF_8)); it.fd.sync() }
        Files.move(temporary.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
    }

    fun removeConnection(context: Context) { check(enabled(context)); configurationFile(context).delete() }

    /** Configuration errors fall back to local capture and never expose the pasted credential. */
    fun open(context: Context, file: File, diagnostic: (String) -> Unit = {}): DevelopmentCaptureSink {
        val pairing = try { readConnection(context) } catch (_: Exception) {
            runCatching { diagnostic("Collector configuration invalid; using local capture") }; null
        }
        return if (pairing == null) DevelopmentCaptureSink(NdjsonFileSink(file), null)
        else {
            val sink = FileHttpEventSink(file, pairing, diagnostic = diagnostic)
            DevelopmentCaptureSink(sink, sink)
        }
    }

    /** Reopen retained files after a restart. Caller owns returned senders and closes them before re-pairing. */
    fun resumePending(context: Context, directory: File, maximumFiles: Int = 16, diagnostic: (String) -> Unit = {}): List<FileHttpEventSink> {
        require(maximumFiles in 1..64)
        val pairing = try { readConnection(context) } catch (_: Exception) { return emptyList() } ?: return emptyList()
        return directory.listFiles().orEmpty().filter { it.isFile && it.extension == "ndjson" }
            .sortedBy { it.lastModified() }.takeLast(maximumFiles).mapNotNull { file ->
                try {
                    FileHttpEventSink(file, pairing, diagnostic = diagnostic).let { sink ->
                        if (sink.pendingBytes() == 0L) { sink.close(); null } else sink
                    }
                } catch (_: Exception) { runCatching { diagnostic("A retained capture could not be opened for transfer") }; null }
            }
    }
}

class DevelopmentCaptureSink internal constructor(private val delegate: EventSink, private val transfer: FileHttpEventSink?) : EventSink, Closeable {
    val uploadsEnabled: Boolean get() = transfer != null
    override fun append(line: String) = delegate.append(line)
    fun awaitUploaded(timeoutMs: Long): Boolean = transfer?.awaitUploaded(timeoutMs) ?: true
    override fun close() = (delegate as Closeable).close()
}
