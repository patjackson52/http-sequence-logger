package example.consumer

import android.app.Application
import java.util.concurrent.Executors

/** A consumer hook, not a second demo app. Host code supplies its existing business HTTP client. */
class ConsumerApplication : Application() {
    private val worker = Executors.newSingleThreadExecutor()
    fun submit(client: BusinessHttpClient, sessionId: String, completed: (Result<BusinessResponse>) -> Unit) {
        worker.execute {
            completed(runCatching {
                CaptureFactory.open(this).use { capture ->
                    runBusinessFlow(capture.logger, client, sessionId)
                }
            })
        }
    }
}
