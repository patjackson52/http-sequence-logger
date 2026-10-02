package example.consumer

import android.content.Context
import android.util.Log
import dev.networklog.logger.DebugTransfer
import dev.networklog.logger.NetworkLog
import dev.networklog.logger.RecordingLogger

object CaptureFactory {
    /** Bootstrap on a worker; capture admission enqueues without disk or networking. */
    fun open(context: Context): CaptureLifetime = openDevelopmentCapture(create = {
        val app = context.applicationContext
        val sink = DebugTransfer.open(app)
        object : CaptureLifetime {
            override val logger = RecordingLogger(NetworkLog(sink, app.packageName,
                namespace = "${app.packageName}/development"))
            override val capturePath = sink.file.absolutePath
            override fun close() = sink.close()
        }
    }, diagnostic = { Log.w("NetworkLog", "Development capture unavailable; application behavior preserved") })
}

/** Capture setup/cleanup failures must not prevent a request or replace its result/error. */
internal fun openDevelopmentCapture(create: () -> CaptureLifetime, diagnostic: () -> Unit): CaptureLifetime {
    fun report() { try { diagnostic() } catch (_: Exception) { /* Diagnostics are observation-only too. */ } }
    return try {
        val capture = create()
        object : CaptureLifetime {
            override val logger = capture.logger
            override val capturePath = capture.capturePath
            override fun close() { try { capture.close() } catch (_: Exception) { report() } }
        }
    } catch (_: Exception) { report(); NoOpCapture }
}
