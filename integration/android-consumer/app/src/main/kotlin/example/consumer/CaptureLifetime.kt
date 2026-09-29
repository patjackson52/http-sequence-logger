package example.consumer

import dev.networklog.api.Logger
import dev.networklog.api.NoOpLogger
import java.io.Closeable

/** The application owns a recording lifetime, independently of Activity instances. */
interface CaptureLifetime : Closeable {
    val logger: Logger
    val capturePath: String?
}

internal object NoOpCapture : CaptureLifetime {
    override val logger = NoOpLogger
    override val capturePath: String? = null
    override fun close() = Unit
}
