package example.consumer

import android.content.Context

object CaptureFactory {
    @Suppress("UNUSED_PARAMETER")
    fun open(context: Context): CaptureLifetime = NoOpCapture
}
