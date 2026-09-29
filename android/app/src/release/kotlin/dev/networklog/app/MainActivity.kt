package dev.networklog.app

import android.app.Activity
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import dev.networklog.api.NoOpLogger
import java.util.concurrent.Executors

/** Retain only process state through rotation, never an Activity in the worker. Access UI state on main. */
private object SignIn {
    private val worker = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    val listeners = mutableSetOf<() -> Unit>()
    var busy = false; private set
    var status = "Public demo sign in"; private set
    fun start() {
        if (busy) return
        busy = true; status = "Signing in…"; notifyUi()
        worker.execute {
            val result = runCatching { SampleFlow.run(NoOpLogger) }
            main.post {
                status = result.fold({ "Hello, ${it.name}. Task: ${it.task}" }, { "Sign in failed. Please retry." })
                busy = false; notifyUi()
            }
        }
    }
    private fun notifyUi() { listeners.toList().forEach { it() } }
}

/** Same business flow and SDK; production injects only the small API's no-op implementation. */
class MainActivity : Activity() {
    private lateinit var run: Button
    private lateinit var status: TextView
    private val render: () -> Unit = { status.text = SignIn.status; run.isEnabled = !SignIn.busy }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val layout = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(32, 64, 32, 32) }
        status = TextView(this).apply { textSize = 22f }
        run = Button(this).apply { text = "Sign in"; setOnClickListener { SignIn.start() } }
        layout.addView(status); layout.addView(run); setContentView(layout)
    }
    override fun onStart() { super.onStart(); SignIn.listeners.add(render); render() }
    override fun onStop() { SignIn.listeners.remove(render); super.onStop() }
}
