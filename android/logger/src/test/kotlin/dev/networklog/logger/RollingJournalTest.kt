package dev.networklog.logger

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files
import java.util.concurrent.TimeUnit

class RollingJournalTest {
    private fun line(n:Int)=JSONObject().put("event_id","event-$n").put("value","safe").toString()
    @Test fun transparentRotationRetainsEveryCanonicalEventAndPublishesSealedPrefixes() {
        val root=Files.createTempDirectory("rolling-journal").toFile()
        val journal=RollingJournal(root,JournalLimits(generationBytes=128,installationBytes=1024,maximumGenerations=16))
        repeat(10) { journal.append(line(it)) }
        journal.flush().get(3,TimeUnit.SECONDS);journal.close()
        val files=journal.files
        assertTrue(files.size>1)
        val ids=files.flatMap { it.readLines() }.map { JSONObject(it).getString("event_id") }
        assertEquals((0 until 10).map { "event-$it" },ids)
        assertTrue(files.all { it.length()<=128 })
        for(file in files) assertEquals(file.length(),JSONObject(java.io.File(file.parentFile,"journal.json").readText()).getLong("durable_bytes"))
    }
    @Test fun outerBarrierCapacityDoesNotConsumeTheInnerOwnerBarrier() {
        val root=Files.createTempDirectory("rolling-barriers").toFile()
        val journal=RollingJournal(root)
        journal.append(line(1))
        val barriers=(0 until 64).map { journal.flush() }
        barriers.forEach { it.get(3,TimeUnit.SECONDS) }
        journal.close();assertEquals(1,journal.files.flatMap { it.readLines() }.size)
    }
    @Test fun reservationRemainsOwnedUntilTheWriterAcquiresItsLease() {
        val root=Files.createTempDirectory("rolling-reservation").toFile()
        val limits=JournalLimits(generationBytes=128,installationBytes=128)
        val first=InstallationJournalBudget(root,limits);val second=InstallationJournalBudget(root,limits)
        val entered=java.util.concurrent.CountDownLatch(1);val release=java.util.concurrent.CountDownLatch(1)
        val threads=java.util.concurrent.Executors.newFixedThreadPool(2)
        val owner=threads.submit<FileHttpEventSink> { first.openGeneration { path -> entered.countDown();release.await();FileHttpEventSink(path,null,TransferLimits(spoolBytes=128,batchBytes=128)) } }
        assertTrue(entered.await(2,TimeUnit.SECONDS))
        val follower=threads.submit { second.openGeneration { path -> FileHttpEventSink(path,null,TransferLimits(spoolBytes=128,batchBytes=128)) } }
        assertFalse(follower.isDone);release.countDown()
        val sink=owner.get(2,TimeUnit.SECONDS)
        try { follower.get(2,TimeUnit.SECONDS);fail("An unowned reservation was reclaimed") } catch(_:java.util.concurrent.ExecutionException) { }
        sink.close();threads.shutdownNow()
    }
    @Test fun installationCapacityRejectsWithoutDeletingHistory() {
        val root=Files.createTempDirectory("rolling-capacity").toFile()
        val journal=RollingJournal(root,JournalLimits(generationBytes=128,installationBytes=128,maximumGenerations=1))
        repeat(10) { journal.append(line(it)) }
        try { journal.flush().get(3,TimeUnit.SECONDS);fail("Capacity overflow accepted") } catch(_:java.util.concurrent.ExecutionException) { }
        try { journal.close() } catch(_:Exception) { }
        assertEquals(1,journal.files.size)
        assertTrue(journal.files[0].length()>0)
        assertTrue(journal.files[0].length()<=128)
        assertTrue(journal.droppedEvents>0)
    }
    @Test fun missingReservedGenerationOrCaptureRejectsReopenAndSealWithoutRewritingInventory() {
        for(removeDirectory in listOf(true,false)) {
            val root=Files.createTempDirectory("rolling-missing-generation").toFile()
            try {
                val first=RollingJournal(root);first.append(line(1));first.flush().get(3,TimeUnit.SECONDS);first.close()
                val second=RollingJournal(root);second.append(line(2));second.flush().get(3,TimeUnit.SECONDS);second.close()
                val missing=first.file;val retained=second.file.readBytes()
                val state=java.io.File(root,"journal-budget.json");val original=state.readBytes()
                if(removeDirectory) assertTrue(missing.parentFile.deleteRecursively()) else assertTrue(missing.delete())
                val remaining=java.io.File(root,"journals").list().orEmpty().sorted()
                try { RollingJournal(root);fail("Missing retained generation was silently discarded") }
                catch(e:java.io.IOException) { assertTrue(e.message!!.contains(missing.parentFile.name));assertTrue(e.message!!.contains("export remaining captures")) }
                try { InstallationJournalBudget(root,JournalLimits()).seal(second.file);fail("Seal masked missing history") }
                catch(_:java.io.IOException) { }
                assertArrayEquals(original,state.readBytes());assertArrayEquals(retained,second.file.readBytes())
                assertEquals(remaining,java.io.File(root,"journals").list().orEmpty().sorted())
            } finally { root.deleteRecursively() }
        }
    }
    @Test fun invalidOrOversizedInventoryRejectsBeforeAllocatingOrRewriting() {
        val invalid=listOf(
            JSONObject().put("version",1).put("reservations",JSONObject()).toString(),
            JSONObject().put("version",2).put("reservations",JSONObject().put("../escape",0)).toString(),
            JSONObject().put("version",2).put("reservations",JSONObject().put("_invalid",0)).toString(),
            JSONObject().put("version",2).put("reservations",JSONObject().put("safe",-1)).toString(),
            JSONObject().put("version",2).put("reservations",JSONObject().put("safe","1")).toString(),
            JSONObject().put("version",2).put("reservations",JSONObject().put("safe",true)).toString(),
            JSONObject().put("version",2).put("reservations",JSONObject().put("safe",1.5)).toString(),
            JSONObject().put("version",2).put("reservations",JSONObject().also { values -> repeat(129) { values.put("generation-$it",0) } }).toString(),
            " ".repeat(16385)
        )
        for(json in invalid) {
            val root=Files.createTempDirectory("rolling-invalid-budget").toFile()
            try {
                val budget=InstallationJournalBudget(root,JournalLimits());val state=java.io.File(root,"journal-budget.json");state.writeText(json)
                val original=state.readBytes()
                try { budget.openGeneration { fail("Invalid inventory allocated a writer") };fail("Invalid inventory accepted") }
                catch(e:java.io.IOException) { assertTrue(e.message!!.contains("restore retained journal state")) }
                assertArrayEquals(original,state.readBytes());assertTrue(java.io.File(root,"journals").list().orEmpty().isEmpty())
            } finally { root.deleteRecursively() }
        }
    }
    @Test fun initializedZeroEventInstallationWithoutBudgetCanStartAndSeal() {
        val root=Files.createTempDirectory("rolling-empty-installation").toFile()
        try {
            java.io.File(root,"journals").mkdir();java.io.File(root,"source.json").writeText("{\"version\":2}")
            assertFalse(java.io.File(root,"journal-budget.json").exists())
            val journal=RollingJournal(root);journal.close()
            assertEquals(1,journal.files.size);assertTrue(journal.file.isFile);assertEquals(0,journal.file.length())
            assertEquals(0,JSONObject(java.io.File(root,"journal-budget.json").readText()).getJSONObject("reservations").getLong(journal.file.parentFile.name))
        } finally { root.deleteRecursively() }
    }
    @Test fun missingHistoryDuringCloseStillReleasesCurrentAndHistoricalWriterLeases() {
        val root=Files.createTempDirectory("rolling-close-missing-history").toFile()
        // A bound listener that never supplies an ACK keeps retained history pending deterministically.
        val server=java.net.ServerSocket(0,16,java.net.InetAddress.getByName("127.0.0.1"))
        var active:RollingJournal?=null
        fun leaseAvailable(file:java.io.File):Boolean=java.io.RandomAccessFile(java.io.File(file.path+".writer.lock"),"rw").use { fd ->
            try { val lock=fd.channel.tryLock();if(lock==null) false else { lock.release();true } }
            catch(_:java.nio.channels.OverlappingFileLockException) { false }
        }
        try {
            val first=RollingJournal(root);first.append(line(1));first.flush().get(3,TimeUnit.SECONDS);first.close()
            val second=RollingJournal(root);second.append(line(2));second.flush().get(3,TimeUnit.SECONDS);second.close()
            val journal=RollingJournal(root);active=journal;journal.append(line(3));journal.flush().get(3,TimeUnit.SECONDS)
            journal.rebind(TransferConnection.parse("""{"version":2,"endpoint":"http://127.0.0.1:${server.localPort}","source_token":"test","source_id":"source","collector_id":"collector","certificate_sha256":null}"""))
            val history=listOf(first.file,second.file);val deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(3)
            var held=history.firstOrNull { !leaseAvailable(it) }
            while(held==null && System.nanoTime()<deadline) { Thread.sleep(5);held=history.firstOrNull { !leaseAvailable(it) } }
            assertNotNull("Historical sender must acquire its writer lease",held)
            val retainedHistory=requireNotNull(held);val missing=history.first { it!=retainedHistory }
            val state=java.io.File(root,"journal-budget.json");val original=state.readBytes()
            val historyBytes=retainedHistory.readBytes();val currentBytes=journal.file.readBytes()
            assertTrue(missing.parentFile.deleteRecursively())
            try { journal.close();fail("Close ignored missing retained history") }
            catch(e:java.util.concurrent.ExecutionException) { assertTrue(e.cause!!.message!!.contains(missing.parentFile.name)) }
            assertTrue("Current writer lease leaked",leaseAvailable(journal.file))
            assertTrue("Historical writer lease leaked",leaseAvailable(retainedHistory))
            assertArrayEquals(original,state.readBytes());assertArrayEquals(historyBytes,retainedHistory.readBytes());assertArrayEquals(currentBytes,journal.file.readBytes())
        } finally { runCatching { active?.close() };server.close();root.deleteRecursively() }
    }
    @Test fun invalidUtf8InventoryIsRejectedWithoutReplacementOrAllocation() {
        val root=Files.createTempDirectory("rolling-invalid-utf8").toFile()
        try {
            val budget=InstallationJournalBudget(root,JournalLimits());val state=java.io.File(root,"journal-budget.json")
            // A malformed byte in an ignored JSON field would otherwise decode to U+FFFD and be accepted.
            val bytes="{\"version\":2,\"reservations\":{},\"ignored\":\"".toByteArray()+byteArrayOf(0xff.toByte())+"\"}".toByteArray()
            state.writeBytes(bytes)
            try { budget.openGeneration { fail("Invalid UTF-8 allocated a writer") };fail("Invalid UTF-8 accepted") }
            catch(e:java.io.IOException) { assertTrue(e.cause is java.nio.charset.CharacterCodingException) }
            assertArrayEquals(bytes,state.readBytes());assertTrue(java.io.File(root,"journals").list().orEmpty().isEmpty())
        } finally { root.deleteRecursively() }
    }
}
