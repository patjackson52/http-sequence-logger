package dev.networklog.logger

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class TransferTest {
    private val limits = TransferLimits(flushDelayMs = 5, initialRetryMs = 20, maximumRetryMs = 40)
    private fun connection(id: String = "collector-a", endpoint: String = "http://127.0.0.1:4319") =
        TransferConnection.parse("""{"version":2,"endpoint":"$endpoint","source_token":"do-not-log-this-token","source_id":"source-test","collector_id":"$id","certificate_sha256":null}""")
    private fun file() = File(Files.createTempDirectory("network-transfer-test").toFile().apply { deleteOnExit() }, "capture.ndjson")
    private fun line(id: String) = JSONObject().put("event_id", id).put("test", true).toString()
    private fun ack(body: ByteArray, collector: String = "collector-a"): UploadResponse {
        val ids = body.toString(Charsets.UTF_8).trim().lines().map { JSONObject(it).getString("event_id") }
        return UploadResponse(200, JSONObject().put("version", 2).put("source_id", "source-test").put("collector_id", collector).put("accepted", ids.size)
            .put("duplicates", 0).put("acknowledged_event_ids", JSONArray(ids)).put("cursor", ids.size).toString().toByteArray())
    }
    private fun sender(block: (ByteArray) -> UploadResponse) = object : EventTransport { override fun upload(body: ByteArray) = block(body) }

    @Test fun acceptsLargeValidAckBeyondOldLimitAndRejectsOversizedAck() {
        val spool = file()
        val ids = (0 until 500).map { "event-$it-".padEnd(512, 'e') }
        spool.writeText(ids.joinToString("\n", postfix = "\n") { line(it) })
        FileHttpEventSink.testing(spool, connection(), sender { bytes ->
            val result = JSONObject(ack(bytes).body.toString(Charsets.UTF_8))
            result.put("recordings", JSONArray(ids.map { id -> JSONObject().put("recording_id", id).put("highest_contiguous_sequence", 1) }))
            val response = result.toString().toByteArray()
            assertTrue(response.size > 512 * 1024)
            assertTrue(response.size < MAX_ACK_BYTES)
            UploadResponse(200, response)
        }, limits).use { assertTrue(it.awaitUploaded(3_000)); assertEquals(0, it.pendingBytes()) }
        val oversized = file()
        val firstAttempt = CountDownLatch(1)
        FileHttpEventSink.testing(oversized, connection(), sender { bytes ->
            firstAttempt.countDown()
            val value = JSONObject(ack(bytes).body.toString(Charsets.UTF_8)).put("padding", "x".repeat(MAX_ACK_BYTES))
            UploadResponse(200, value.toString().toByteArray())
        }, limits).use {
            it.append(line("retained")); assertTrue(firstAttempt.await(2, TimeUnit.SECONDS))
            assertFalse(it.awaitUploaded(100)); assertTrue(it.pendingBytes() > 0)
        }
    }

    @Test fun rejectsNonLoopbackHttpAndSecretsInEndpoint() {
        for (endpoint in listOf("http://192.168.1.2:4319", "http://example.com", "https://user:pass@example.com", "https://example.com/?token=secret", "https://example.com/events", "file:///tmp/spool")) {
            try { connection(endpoint = endpoint); fail("configuration should fail") } catch (error: IllegalArgumentException) { assertFalse(error.message!!.contains(endpoint)) }
        }
        assertFalse(connection().toString().contains("do-not-log"))
        assertEquals("https://example.com", connection(endpoint = "https://example.com/").endpoint)
    }

    @Test fun uploadRunsOffCallerAndDurableCursorAvoidsReplayAfterRestart() {
        val spool = file(); val calls = AtomicInteger(); val caller = Thread.currentThread()
        val transport = sender { bytes -> assertNotSame(caller, Thread.currentThread()); calls.incrementAndGet(); ack(bytes) }
        FileHttpEventSink.testing(spool, connection(), transport, limits).use {
            it.append(line("one")); it.append(line("two")); assertTrue(it.awaitUploaded(3_000))
            assertEquals(2, spool.readLines().size)
        }
        val previousCalls = calls.get()
        FileHttpEventSink.testing(spool, connection(), transport, limits).use { assertEquals(0, it.pendingBytes()); assertTrue(it.awaitUploaded(1_000)) }
        assertEquals(previousCalls, calls.get())
    }

    @Test fun offlineAppendPersistsAndReopensWithOriginalEventIds() {
        val spool = file(); val attempted = CountDownLatch(1)
        FileHttpEventSink.testing(spool, connection(), sender { attempted.countDown(); throw IOException("do-not-log-this-token") }, limits).use {
            it.append(line("original")); assertTrue(attempted.await(2, TimeUnit.SECONDS)); assertTrue(it.pendingBytes() > 0)
        }
        val bytes = spool.readBytes()
        FileHttpEventSink.testing(spool, connection(), sender { assertArrayEquals(bytes, it); ack(it) }, limits).use { assertTrue(it.awaitUploaded(3_000)) }
    }

    @Test fun retriesLostAcknowledgmentAndRejectsWrongCollectorOrMissingIds() {
        val spool = file(); val attempt = AtomicInteger(); val diagnostics = mutableListOf<String>()
        val transport = sender { bytes -> when (attempt.incrementAndGet()) {
            1 -> throw IOException("do-not-log-this-token")
            2 -> ack(bytes, "other-collector")
            3 -> UploadResponse(200, """{"version":2,"collector_id":"collector-a","source_id":"source-test","accepted":1,"duplicates":0,"cursor":1,"acknowledged_event_ids":[]}""".toByteArray())
            else -> ack(bytes)
        } }
        FileHttpEventSink.testing(spool, connection(), transport, limits) { synchronized(diagnostics) { diagnostics.add(it) } }.use {
            it.append(line("same-id")); assertTrue(it.awaitUploaded(3_000)); assertEquals(4, attempt.get())
        }
        assertFalse(diagnostics.joinToString().contains("do-not-log-this-token"))
    }

    @Test fun permanentRejectionRetainsSpoolUntilExplicitRetry() {
        val spool = file(); val calls = AtomicInteger()
        FileHttpEventSink.testing(spool, connection(), sender { if (calls.incrementAndGet() == 1) UploadResponse(409, byteArrayOf()) else ack(it) }, limits).use {
            it.append(line("conflict")); assertFalse(it.awaitUploaded(3_000)); assertTrue(it.pendingBytes() > 0)
            it.retryNow(); assertTrue(it.awaitUploaded(3_000)); assertEquals(2, calls.get())
        }
    }

    @Test fun changedCollectorReplaysSameFile() {
        val spool = file()
        FileHttpEventSink.testing(spool, connection(), sender { ack(it) }, limits).use { it.append(line("one")); assertTrue(it.awaitUploaded(3_000)) }
        val calls = AtomicInteger()
        FileHttpEventSink.testing(spool, connection("collector-b"), sender { calls.incrementAndGet(); ack(it, "collector-b") }, limits).use { assertTrue(it.awaitUploaded(3_000)) }
        assertEquals(1, calls.get())
    }

    @Test fun staleAcknowledgmentCannotSkipReplacedSpool() {
        val spool = file(); val sent = CountDownLatch(1); val proceed = CountDownLatch(1); val ids = mutableListOf<String>()
        val transport = sender { bytes ->
            synchronized(ids) { ids.add(JSONObject(bytes.toString(Charsets.UTF_8).trim()).getString("event_id")) }
            if (ids.size == 1) { sent.countDown(); assertTrue(proceed.await(3, TimeUnit.SECONDS)) }
            ack(bytes)
        }
        FileHttpEventSink.testing(spool, connection(), transport, limits).use {
            it.append(line("before")); assertTrue(sent.await(3, TimeUnit.SECONDS))
            spool.writeText(line("after") + "\n")
            proceed.countDown(); assertTrue(it.awaitUploaded(3_000))
        }
        assertEquals(listOf("before", "after"), ids)
    }

    @Test fun replacedAcknowledgedPrefixReplaysFromBeginning() {
        val spool = file()
        FileHttpEventSink.testing(spool, connection(), sender { ack(it) }, limits).use { it.append(line("before")); assertTrue(it.awaitUploaded(3_000)) }
        spool.writeText(line("after") + "\n")
        val calls = AtomicInteger()
        FileHttpEventSink.testing(spool, connection(), sender { calls.incrementAndGet(); ack(it) }, limits).use { assertTrue(it.awaitUploaded(3_000)) }
        assertEquals(1, calls.get())
    }

    @Test fun eventBatchAndSpoolLimitsAreBounded() {
        val spool = file(); val bodies = mutableListOf<ByteArray>()
        val small = limits.copy(spoolBytes = 200, batchBytes = 100, batchEvents = 2)
        FileHttpEventSink.testing(spool, connection(), sender { synchronized(bodies) { bodies.add(it) }; ack(it) }, small).use {
            repeat(5) { n -> it.append(line("$n")) }
            assertTrue(it.awaitUploaded(3_000))
            try { it.append(line("x".repeat(100))); fail("oversized event") } catch (_: IOException) { }
            try { repeat(10) { n -> it.append(line("extra-$n")) }; fail("full spool") } catch (_: IOException) { }
        }
        assertTrue(spool.length() <= 200)
        assertTrue(bodies.all { it.size <= 100 && it.toString(Charsets.UTF_8).trim().lines().size <= 2 })
    }

    @Test fun interruptedTailIsDiscardedAndCompleteLinesReplay() {
        val spool = file(); spool.writeText(line("complete") + "\n{\"event_id\":\"interrupted")
        FileHttpEventSink.testing(spool, connection(), sender { ack(it) }, limits).use { assertTrue(it.awaitUploaded(3_000)) }
        assertEquals(listOf(line("complete")), spool.readLines())
    }

    @Test fun rebindIgnoresLateAckAndPreservesCaptureDuringStall() {
        val file=file();val entered=CountDownLatch(1);val release=CountDownLatch(1)
        val transport=sender { bytes -> entered.countDown();assertTrue(release.await(3,TimeUnit.SECONDS));ack(bytes) }
        FileHttpEventSink.testing(file,connection(),transport,limits).use { sink ->
            sink.append(line("old"));assertTrue(entered.await(3,TimeUnit.SECONDS))
            sink.rebind(null)
            sink.append(line("during-rebind"));sink.flush().get(2,TimeUnit.SECONDS)
            assertEquals(2,file.readLines().size)
            release.countDown();Thread.sleep(50)
            assertTrue(sink.pendingBytes()>0)
            assertFalse(File(file.path+".cursor.json").exists())
        }
    }
    @Test fun concurrentAdmissionsFlushAndCloseRetainWholeLines() {
        val file=file();val sink=FileHttpEventSink(file,null)
        val workers=Executors.newFixedThreadPool(4)
        try { val jobs=(0 until 1000).map { n -> workers.submit { sink.append(line("parallel-$n")) } };jobs.forEach { it.get() }
            sink.flush().get(3,TimeUnit.SECONDS);sink.close()
            assertEquals(1000,file.readLines().size);assertEquals(1000,file.readLines().toSet().size)
            try { sink.append(line("late"));fail("Closed writer admitted an event") } catch (_:IOException) { }
        } finally { workers.shutdownNow();sink.close() }
    }

    @Test fun flushContinuationCanAppendWaitAndCloseWithoutOwningDiskThread() {
        val file=file();val entered=CountDownLatch(1);val release=CountDownLatch(1)
        val io=object:JournalDiskIO {
            override fun append(output:java.io.FileOutputStream,bytes:ByteArray)=SystemJournalDiskIO.append(output,bytes)
            override fun sync(output:java.io.FileOutputStream) { entered.countDown();assertTrue(release.await(3,TimeUnit.SECONDS));SystemJournalDiskIO.sync(output) }
        }
        val sink=FileHttpEventSink.testing(file,null,null,limits,diskIO=io)
        sink.append(line("first"));assertTrue(entered.await(2,TimeUnit.SECONDS))
        val done=sink.flush().thenRun { sink.append(line("second"));sink.flush().get(2,TimeUnit.SECONDS);sink.close() }
        release.countDown();done.get(3,TimeUnit.SECONDS)
        assertEquals(2,file.readLines().size)
    }
    @Test fun stalledSyncBoundsAdmissionAndRetainsLockThroughClose() {
        val file=file();val entered=CountDownLatch(1);val release=CountDownLatch(1)
        val io=object:JournalDiskIO {
            override fun append(output:java.io.FileOutputStream,bytes:ByteArray)=SystemJournalDiskIO.append(output,bytes)
            override fun sync(output:java.io.FileOutputStream) { entered.countDown();assertTrue(release.await(3,TimeUnit.SECONDS));SystemJournalDiskIO.sync(output) }
        }
        val sink=FileHttpEventSink.testing(file,null,null,limits.copy(queueBytes=100),diskIO=io)
        sink.append(line("first"));assertTrue(entered.await(2,TimeUnit.SECONDS))
        sink.append(line("second"));val barrier=sink.flush();assertFalse(barrier.isDone)
        val closer=Executors.newSingleThreadExecutor();val closed=closer.submit { sink.close() }
        try { FileHttpEventSink(file,null);fail("Writer lock released while sync stalled") } catch(_:IOException) { }
        release.countDown();closed.get(3,TimeUnit.SECONDS);barrier.get(3,TimeUnit.SECONDS);closer.shutdownNow()
        assertEquals(2,file.readLines().size)
    }
    @Test fun partialWriteAndFailedSyncPoisonAllQueuedCommitsUntilReopen() {
        for(partial in listOf(true,false)) {
            val file=file();val entered=CountDownLatch(1);val release=CountDownLatch(1);val writes=AtomicInteger()
            val io=object:JournalDiskIO {
                override fun append(output:java.io.FileOutputStream,bytes:ByteArray) {
                    writes.incrementAndGet();entered.countDown();assertTrue(release.await(3,TimeUnit.SECONDS))
                    if(partial) { output.write(bytes,0,bytes.size/2);throw IOException("Injected partial append") }
                    output.write(bytes)
                }
                override fun sync(output:java.io.FileOutputStream) { throw IOException("Injected sync failure") }
            }
            val sink=FileHttpEventSink.testing(file,null,null,limits,diskIO=io)
            sink.append(line("first"));assertTrue(entered.await(2,TimeUnit.SECONDS));sink.append(line("queued-after-stall"))
            val barrier=sink.flush();release.countDown()
            try { barrier.get(2,TimeUnit.SECONDS);fail("Uncertain write marked durable") } catch(_:java.util.concurrent.ExecutionException) { }
            try { sink.append(line("after-failure"));fail("Poisoned writer accepted append") } catch(_:IOException) { }
            try { sink.close() } catch(_:IOException) { }
            assertEquals(1,writes.get());assertFalse(file.readText().contains("queued-after-stall"))
            FileHttpEventSink(file,null).use { reopened -> reopened.append(line("reopened"));reopened.flush().get(2,TimeUnit.SECONDS) }
            assertTrue(file.readText().contains("reopened"));assertTrue(file.readText().endsWith("\n"))
        }
    }
    @Test fun stalledDiskAdmissionReportsLatencyAndQueueHighWater() {
        val file=file();val entered=CountDownLatch(1);val release=CountDownLatch(1)
        val io=object:JournalDiskIO {
            override fun append(output:java.io.FileOutputStream,bytes:ByteArray)=SystemJournalDiskIO.append(output,bytes)
            override fun sync(output:java.io.FileOutputStream) { entered.countDown();assertTrue(release.await(5,TimeUnit.SECONDS));SystemJournalDiskIO.sync(output) }
        }
        val sink=FileHttpEventSink.testing(file,null,null,limits,diskIO=io)
        sink.append(line("first"));assertTrue(entered.await(2,TimeUnit.SECONDS))
        var accepted=0;var maximum=0L
        while(true) {
            val record=line("queue-$accepted-"+"x".repeat(4096));val started=System.nanoTime()
            try { sink.append(record);accepted++ } catch(_:IOException) { break }
            maximum=maxOf(maximum,System.nanoTime()-started)
        }
        val highWater=sink.queuedSize();assertTrue(highWater<=limits.queueBytes);assertTrue(highWater>limits.queueBytes-8192)
        println("NATIVE_ADMISSION_METRICS android accepted=$accepted maximum_ns=$maximum queue_high_water_bytes=$highWater queue_limit_bytes=${limits.queueBytes}")
        release.countDown();sink.close()
    }
    @Test fun durablePublicationIsCoalescedAndForcedOnClose() {
        val file=file();val sink=FileHttpEventSink(file,null)
        sink.append(line("one"));sink.flush().get(2,TimeUnit.SECONDS)
        val metadata=File(file.parentFile,"journal.json")
        assertEquals(0L,JSONObject(metadata.readText()).getLong("durable_bytes"))
        sink.close();assertEquals(file.length(),JSONObject(metadata.readText()).getLong("durable_bytes"))
    }

    @Test fun nativeTransportUsesBearerAndDoesNotFollowRedirects() {
        val server = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
        val worker = java.util.concurrent.Executors.newSingleThreadExecutor()
        val handled = worker.submit {
            server.accept().use { socket ->
                socket.soTimeout = 2_000
                val input = socket.getInputStream().bufferedReader(Charsets.US_ASCII)
                assertEquals("POST /api/v2/events HTTP/1.1", input.readLine())
                val headers = mutableMapOf<String, String>()
                while (true) {
                    val line = input.readLine()
                    if (line.isEmpty()) break
                    headers[line.substringBefore(':').lowercase()] = line.substringAfter(':').trim()
                }
                assertEquals("Bearer do-not-log-this-token", headers["authorization"])
                repeat(headers.getValue("content-length").toInt()) { assertTrue(input.read() >= 0) }
                socket.getOutputStream().write("HTTP/1.1 307 Temporary Redirect\r\nLocation: /should-not-run\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray())
            }
        }
        try {
            val result = HttpEventTransport(connection(endpoint = "http://127.0.0.1:${server.localPort}")).upload((line("one") + "\n").toByteArray())
            assertEquals(307, result.status); handled.get(3, TimeUnit.SECONDS)
        } finally { server.close(); worker.shutdownNow() }
    }
}
