package dev.networklog.app

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
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
    var transferStatus = "Local capture only · collector not paired"
    private var retained = emptyList<FileHttpEventSink>()
    private fun transferDiagnostic(message: String) { main.post { transferStatus = message; notifyUi() } }
    fun resume(context: Context) = worker.execute {
        retained.forEach { it.close() }
        retained = DebugTransfer.resumePending(context, File(context.filesDir, "captures"), diagnostic = ::transferDiagnostic)
        val paired = runCatching { DebugTransfer.readConnection(context) != null }.getOrDefault(false)
        main.post { transferStatus = if (paired) "Collector paired · captures upload automatically" else "Local capture only · collector not paired"; notifyUi() }
    }
    fun pair(context: Context, json: String?) = worker.execute {
        try {
            retained.forEach { it.close() }; retained = emptyList()
            if (json == null) DebugTransfer.removeConnection(context) else DebugTransfer.saveConnection(context, json)
            resume(context)
        } catch (_: Exception) { transferDiagnostic("Pairing failed · check the collector connection JSON") }
    }
    fun notifyUi() { main.post { listener?.invoke() } }
    fun run(context: Context, directory: File, appId: String, sessionId: String?, recovery: Boolean) {
        if (busy) return
        busy = true; title = "Running sign in"; result = "Contacting three public services…"; steps = emptyList(); file = null; notifyUi()
        worker.execute {
            val capture = File(directory, "capture-${System.currentTimeMillis()}.ndjson")
            try {
                DebugTransfer.open(context, capture, ::transferDiagnostic).use { sink ->
                    val logger = NetworkLog(sink, appId)
                    try {
                        val response = SampleFlow.run(RecordingLogger(logger), sessionId, recovery) { step -> main.post { steps = steps + step; notifyUi() } }
                        main.post { title = "Sign in complete"; result = "Hello, ${response.name}.\nTask: ${response.task}\nSession: ${response.sessionId}" }
                    } finally { sink.awaitUploaded(2_000) }
                }
            } catch (error: Exception) {
                main.post { title = "Run did not complete"; result = "${error.javaClass.simpleName}: ${error.message}\nPartial capture is available for inspection." }
            } finally { main.post { busy = false; file = capture; notifyUi() }; resume(context) }
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
    private lateinit var transfer: TextView
    private lateinit var pair: Button
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
        transfer = label("", 12f)
        pair = Button(this).apply {
            text = "Pair desktop collector"; isAllCaps = false
            setOnClickListener {
                val input = EditText(this@MainActivity).apply {
                    hint = "Paste collector connection JSON"; minLines = 3; maxLines = 6
                    inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
                }
                AlertDialog.Builder(this@MainActivity).setTitle("Pair desktop collector")
                    .setMessage("Use the connection JSON from your local collector. Capture export stays available.")
                    .setView(input).setPositiveButton("Pair") { _, _ -> Runs.pair(applicationContext, input.text.toString()) }
                    .setNeutralButton("Disconnect") { _, _ -> Runs.pair(applicationContext, null) }
                    .setNegativeButton("Cancel", null).show()
            }; content.addView(this)
        }
        label("DEVELOPMENT DEMO", 11f, Color.rgb(34, 112, 85))
        label("Public synthetic account • demonstration challenge\nNo phone verification or OAuth security claim.\nCredentials and tokens are redacted before writing.\nCaptures stay local unless you pair a collector or export.", 12f)
        Runs.resume(applicationContext)
        if (savedInstanceState == null) runFromIntent()
    }
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        Runs.resume(applicationContext)
        runFromIntent()
    }
    /** Development launcher only; consumed so rotation does not repeat a flow. */
    private fun runFromIntent() {
        val requested = intent.getStringExtra("networklog.run") ?: return
        intent.removeExtra("networklog.run")
        if (requested == "success" || requested == "recovery") begin(requested == "recovery")
    }
    private fun begin(recover: Boolean) = Runs.run(applicationContext, File(filesDir, "captures"), packageName,
        session.text.toString().takeIf { it.isNotEmpty() }, recover)
    override fun onStart() { super.onStart(); Runs.listener = { render() }; render() }
    override fun onStop() { Runs.listener = null; super.onStop() }
    override fun onSaveInstanceState(outState: Bundle) { outState.putString("session", session.text.toString()); super.onSaveInstanceState(outState) }
    private fun render() {
        state.text = Runs.title; detail.text = Runs.result
        transfer.text = Runs.transferStatus; pair.isEnabled = !Runs.busy
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
