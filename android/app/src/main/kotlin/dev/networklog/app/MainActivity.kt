package dev.networklog.app

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.*
import dev.networklog.logger.*
import java.io.File
import java.util.concurrent.Executors

/** Process-scoped worker retains a running flow through rotation without retaining an Activity. */
private object Runs {
    val worker = Executors.newSingleThreadExecutor()
    val main = Handler(Looper.getMainLooper())
    var busy = false
    var title = "Ready to trace"
    var steps = listOf<String>()
    var result = "Use the public demo account. No setup required."
    var file: File? = null
    var listener: (() -> Unit)? = null
    fun notifyUi() { main.post { listener?.invoke() } }
    fun run(directory: File, appId: String, sessionId: String?, recovery: Boolean) {
        if (busy) return
        busy = true; title = "Running sign in"; result = "Contacting three public services…"; steps = emptyList(); file = null; notifyUi()
        worker.execute {
            val capture = File(directory, "capture-${System.currentTimeMillis()}.ndjson")
            try {
                NdjsonFileSink(capture).use { sink ->
                    val logger = NetworkLog(sink, appId)
                    val response = SampleFlow.run(logger, sessionId, recovery) { step -> main.post { steps = steps + step; notifyUi() } }
                    main.post { title = "Sign in complete"; result = "Hello, ${response.name}.\nTask: ${response.task}\nSession: ${response.sessionId}" }
                }
            } catch (error: Exception) {
                main.post { title = "Run did not complete"; result = "${error.javaClass.simpleName}: ${error.message}\nPartial capture is available for inspection." }
            } finally { main.post { busy = false; file = capture; notifyUi() } }
        }
    }
}

class MainActivity : Activity() {
    private lateinit var state: TextView
    private lateinit var detail: TextView
    private lateinit var timeline: LinearLayout
    private lateinit var run: Button
    private lateinit var recovery: Button
    private lateinit var export: Button
    private lateinit var session: EditText
    private val ink = Color.rgb(24, 40, 51)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = Color.rgb(242, 245, 242)
        window.navigationBarColor = Color.rgb(242, 245, 242)
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
        val scroll = ScrollView(this).apply { setBackgroundColor(Color.rgb(242, 245, 242)); isFillViewport = true }
        val content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(24), dp(44), dp(24), dp(28)) }
        scroll.addView(content); setContentView(scroll)
        fun label(text: String, size: Float, color: Int = ink) = TextView(this).apply {
            this.text = text; textSize = size; setTextColor(color); setPadding(0, dp(5), 0, dp(9)); content.addView(this)
        }
        label("NETWORK LOG LAB", 12f, Color.rgb(34, 112, 85)).letterSpacing = 0.15f
        label("One sign in.\nThree servers.", 32f).setTypeface(null, android.graphics.Typeface.BOLD)
        label("A Kotlin SDK tracing playground", 16f)
        label("DummyJSON auth  /  httpbin challenge  /  JSONPlaceholder task", 12f)
        session = EditText(this).apply {
            hint = "Session ID (optional — generated if blank)"; textSize = 14f; isSingleLine = true
            setText(savedInstanceState?.getString("session") ?: ""); content.addView(this)
        }
        run = Button(this).apply { text = "Run successful sign in"; isAllCaps = false; setOnClickListener { begin(false) }; content.addView(this) }
        recovery = Button(this).apply { text = "Run with 401 → refresh → retry"; isAllCaps = false; setOnClickListener { begin(true) }; content.addView(this) }
        state = label("", 22f).apply { setTypeface(null, android.graphics.Typeface.BOLD) }
        detail = label("", 14f)
        timeline = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; content.addView(this) }
        export = Button(this).apply {
            text = "Export structured log (.ndjson)"; isAllCaps = false
            setOnClickListener {
                startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE); type = "application/x-ndjson"
                    putExtra(Intent.EXTRA_TITLE, Runs.file?.name ?: "capture.ndjson")
                }, 10)
            }; content.addView(this)
        }
        label("DEVELOPMENT DEMO", 11f, Color.rgb(34, 112, 85))
        label("Public synthetic account • demonstration challenge\nNo phone verification or OAuth security claim.\nCredentials and tokens are redacted before writing.\nLogs stay on this device until you export them.", 12f)
    }
    private fun begin(recover: Boolean) = Runs.run(File(filesDir, "captures"), packageName,
        session.text.toString().takeIf { it.isNotEmpty() }, recover)
    override fun onStart() { super.onStart(); Runs.listener = { render() }; render() }
    override fun onStop() { Runs.listener = null; super.onStop() }
    override fun onSaveInstanceState(outState: Bundle) { outState.putString("session", session.text.toString()); super.onSaveInstanceState(outState) }
    private fun render() {
        state.text = Runs.title; detail.text = Runs.result
        run.isEnabled = !Runs.busy; recovery.isEnabled = !Runs.busy; session.isEnabled = !Runs.busy
        export.isEnabled = Runs.file != null && !Runs.busy
        timeline.removeAllViews()
        Runs.steps.forEachIndexed { index, step -> timeline.addView(TextView(this).apply {
            text = "${index + 1}.  $step"; textSize = 13f; setTextColor(ink); setPadding(dp(8), dp(8), dp(8), dp(8))
        }) }
    }
    @Deprecated("Platform callback used to keep sample dependency-light")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != 10 || resultCode != RESULT_OK) return
        val uri = data?.data ?: return
        val source = Runs.file ?: return
        val resolver = applicationContext.contentResolver
        Runs.worker.execute {
            val success = runCatching { requireNotNull(resolver.openOutputStream(uri)).use { out -> source.inputStream().use { it.copyTo(out) } } }.isSuccess
            Runs.main.post { Toast.makeText(applicationContext, if (success) "Log exported" else "Export failed", Toast.LENGTH_SHORT).show() }
        }
    }
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
}
