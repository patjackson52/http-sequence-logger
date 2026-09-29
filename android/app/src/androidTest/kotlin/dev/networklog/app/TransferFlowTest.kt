package dev.networklog.app

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.networklog.logger.*
import org.junit.Assert.*
import org.junit.Test
import org.json.JSONObject
import org.junit.runner.RunWith
import java.io.File

/** Opt-in: configure files/network-log/connection.json and forward the collector port first. */
@RunWith(AndroidJUnit4::class)
class TransferFlowTest {
    @Test fun factoryDoesNotReadPairingInNonDebuggableApplication() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val releaseContext = object : android.content.ContextWrapper(context) {
            override fun getApplicationInfo() = android.content.pm.ApplicationInfo(context.applicationInfo).apply {
                flags = flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE.inv()
            }
        }
        assertNull(DebugTransfer.readConnection(releaseContext))
        DebugTransfer.open(releaseContext, File(context.cacheDir, "non-debug-local.ndjson")).use { assertFalse(it.uploadsEnabled) }
    }
    @Test fun pairedCollectorReceivesCaptureAndRetainsLocalExport() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val connection = requireNotNull(DebugTransfer.readConnection(context)) { "Pair a debug collector before running TransferFlowTest" }
        val file = File(context.filesDir, "captures/transfer-e2e-${System.currentTimeMillis()}.ndjson")
        FileHttpEventSink(file, connection).use { sink ->
            val logger = NetworkLog(sink, context.packageName)
            if (InstrumentationRegistry.getArguments().getString("transferLiveFlow") == "true") {
                assertEquals("Emily", SampleFlow.run(RecordingLogger(logger), "android-transfer-live", recovery = true).name)
            } else {
                val session = logger.startSession("Android transfer instrumentation", "android-transfer-probe")
                session.invokeHandler("Probe.handler", Actor("sdk", "TransferProbe"), Actor("integrator", "ProbeHandler")) { }
                session.end()
            }
            assertTrue("Collector did not acknowledge capture; local file retained", sink.awaitUploaded(15_000))
            assertEquals(0, sink.pendingBytes())
        }
        assertTrue(file.length() > 0)
        assertFalse(file.readText().contains("Bearer "))
        FileHttpEventSink(file, connection).use { sink -> assertEquals(0, sink.pendingBytes()) }
    }

    @Test fun offlineSpoolSurvivesCloseAndResumesWithoutNewIds() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val connection = requireNotNull(DebugTransfer.readConnection(context))
        val file = File(context.filesDir, "captures/transfer-offline-e2e.ndjson")
        val phase = InstrumentationRegistry.getArguments().getString("transferOfflinePhase")
        require(phase == "write" || phase == "resume") { "Select write with collector disconnected, then resume after reconnect" }
        if (phase == "write") {
            file.delete(); File(file.path + ".transfer.json").delete()
            FileHttpEventSink(file, connection).use { sink ->
                val session = NetworkLog(sink, context.packageName).startSession("Offline transfer probe", "android-offline-transfer")
                session.startOperation("Persist while offline").complete(); session.end()
                assertFalse(sink.awaitUploaded(500)); assertTrue(sink.pendingBytes() > 0)
            }
            assertTrue(file.length() > 0)
        } else {
            val original = file.readBytes()
            FileHttpEventSink(file, connection).use { sink -> assertTrue(sink.awaitUploaded(15_000)); assertEquals(0, sink.pendingBytes()) }
            assertArrayEquals(original, file.readBytes())
        }
    }

    @Test fun pinnedTlsAcceptsPairedLeafAndRejectsDifferentPin() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val raw = File(context.filesDir, "network-log/connection-tls.json").readText()
        val paired = TransferConnection.parse(raw)
        require(paired.certificateSha256 != null)
        val file = File(context.filesDir, "captures/transfer-tls-${System.currentTimeMillis()}.ndjson")
        FileHttpEventSink(file, paired).use { sink ->
            val session = NetworkLog(sink, context.packageName).startSession("Paired TLS transfer", "android-pinned-transfer")
            session.end(); assertTrue("Paired TLS certificate was not accepted", sink.awaitUploaded(10_000))
        }
        val wrongPin = TransferConnection.parse(JSONObject(raw).put("certificate_sha256", "0".repeat(64)).toString())
        val rejectedFile = File(context.filesDir, "network-log/rejected-pin.ndjson")
        rejectedFile.delete(); File(rejectedFile.path + ".transfer.json").delete()
        FileHttpEventSink(rejectedFile, wrongPin).use { sink ->
            val session = NetworkLog(sink, context.packageName).startSession("Wrong pin must remain local")
            session.end(); assertFalse(sink.awaitUploaded(1_500)); assertTrue(sink.pendingBytes() > 0)
        }
    }
}
