package dev.networklog.logger

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Host SIGKILL checks, confined to a new disposable journal per stage. No device or public injection API. */
class NativeCrashTest {
    @Test fun hardKillStageMatrixRetainsCompletePrefixesAndReplaysLostCursors() {
        val urls=listOf(NativeCrashTest::class.java,FileHttpEventSink::class.java,EventSink::class.java,
            JSONObject::class.java,org.junit.Assert::class.java,kotlin.Unit::class.java)
            .map { File(it.protectionDomain.codeSource.location.toURI()).path }.distinct()
        assertTrue("Test runtime classpath unavailable",urls.isNotEmpty())
        val classpath=urls.joinToString(File.pathSeparator)
        for(stage in STAGES) {
            val root=Files.createTempDirectory("native-crash-android-$stage-").toFile()
            var child:Process?=null
            try {
                val directory=File(root,"journal").apply { mkdir() };val file=File(directory,"capture.ndjson")
                FileHttpEventSink(file,null).use { it.append(line("baseline"));it.flush().get(3,TimeUnit.SECONDS) }
                val retained=File(root,"retained/capture.ndjson")
                FileHttpEventSink(retained,null).use { it.append(line("retained-history"));it.flush().get(3,TimeUnit.SECONDS) }
                val history=retained.readBytes();val historyMetadata=File(retained.parentFile,"journal.json").readBytes()
                val marker=File(root,"stage.marker");val log=File(root,"child.log")
                val process=ProcessBuilder(File(System.getProperty("java.home"),"bin/java").path,"-cp",classpath,
                    NativeCrashTest::class.java.name,root.path,stage).redirectErrorStream(true).redirectOutput(log).start()
                child=process
                val deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(8)
                while(marker.takeIf { it.exists() }?.readText()!=stage) {
                    assertTrue("Fixture exited before $stage: ${log.takeIf { it.exists() }?.readText()}",process.isAlive)
                    assertTrue("Fixture did not reach $stage: ${log.takeIf { it.exists() }?.readText()}",System.nanoTime()<deadline)
                    Thread.sleep(5)
                }
                val before=JSONObject(File(directory,"journal.json").readText()).getLong("durable_bytes")
                if(stage in UNPUBLISHED || stage in METADATA_UNCOMMITTED) assertEquals(bytes("baseline").size.toLong(),before)
                if(stage=="published" || stage in METADATA_COMMITTED) assertEquals(allBytes().size.toLong(),before)
                val cursorBefore=File(file.path+".cursor.json").takeIf { it.exists() }?.let { JSONObject(it.readText()).getLong("offset") } ?: 0L
                if(stage in CURSOR_UNCOMMITTED) assertEquals(0L,cursorBefore)
                if(stage in CURSOR_COMMITTED) assertEquals(allBytes().size.toLong(),cursorBefore)
                process.destroyForcibly();assertTrue(process.waitFor(3,TimeUnit.SECONDS));assertEquals(137,process.exitValue())
                val expected=if(stage in listOf("enqueue","append_partial")) bytes("baseline") else allBytes()
                val cursor=File(file.path+".cursor.json")
                if(stage=="cursor_lost") assertTrue(cursor.delete())
                val replay=mutableListOf<ByteArray>()
                val route=if(stage.startsWith("cursor_")) connection() else null
                val recovered=FileHttpEventSink.testing(file,route,object:EventTransport {
                    override fun upload(body:ByteArray):UploadResponse { synchronized(replay) { replay.add(body) };return ack(body,duplicates=true) }
                })
                try {
                    assertArrayEquals(expected,file.readBytes())
                    assertEquals(expected.size.toLong(),JSONObject(File(directory,"journal.json").readText()).getLong("durable_bytes"))
                    if(stage=="cursor_committed" || stage in CURSOR_COMMITTED) {
                        assertEquals(0,recovered.pendingBytes());assertTrue(replay.isEmpty())
                    }
                    if(stage=="cursor_lost" || stage in CURSOR_UNCOMMITTED) {
                        assertTrue(recovered.awaitUploaded(3000));assertArrayEquals(expected,synchronized(replay) { replay.single() })
                    }
                } finally { recovered.close() }
                assertArrayEquals(expected,file.readBytes())
                if(stage.startsWith("cursor_")) {
                    val receipt=JSONObject(File(root,"collector-receipt.json").readText()).getJSONArray("event_ids")
                    assertEquals(setOf("baseline","candidate"),(0 until receipt.length()).map(receipt::getString).toSet())
                }
                assertArrayEquals(history,retained.readBytes());assertArrayEquals(historyMetadata,File(retained.parentFile,"journal.json").readBytes())
                var repeatKills=0
                if(stage=="metadata_temp_written") {
                    var accumulated=expected
                    repeat(2) {
                        assertTrue(marker.delete())
                        val repeatChild=ProcessBuilder(File(System.getProperty("java.home"),"bin/java").path,"-cp",classpath,
                            NativeCrashTest::class.java.name,root.path,stage).redirectErrorStream(true).redirectOutput(log).start();child=repeatChild
                        val repeatDeadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(8)
                        while(marker.takeIf { it.exists() }?.readText()!=stage) { assertTrue(repeatChild.isAlive);assertTrue(System.nanoTime()<repeatDeadline);Thread.sleep(5) }
                        assertEquals(accumulated.size.toLong(),JSONObject(File(directory,"journal.json").readText()).getLong("durable_bytes"))
                        val orphan=File(directory,"journal.json.tmp");assertTrue(orphan.isFile);assertTrue(orphan.length()<=16384)
                        repeatChild.destroyForcibly();assertTrue(repeatChild.waitFor(3,TimeUnit.SECONDS));assertEquals(137,repeatChild.exitValue());repeatKills++
                        accumulated+=bytes("candidate")
                        FileHttpEventSink(file,null).use { assertArrayEquals(accumulated,file.readBytes());assertFalse(orphan.exists());assertEquals(accumulated.size.toLong(),JSONObject(File(directory,"journal.json").readText()).getLong("durable_bytes")) }
                    }
                }
                println("NATIVE_CRASH_STAGE "+JSONObject().put("platform","android-jvm").put("stage",stage)
                    .put("hard_kill",true).put("recovered_bytes",expected.size).put("published_before_kill",before)
                    .put("cursor_before_recovery",cursorBefore).put("repeated_atomic_kills",repeatKills).put("cursor_replayed",stage=="cursor_lost" || stage in CURSOR_UNCOMMITTED).put("retained_history_unchanged",true).put("passed",true))
            } finally {
                child?.takeIf { it.isAlive }?.let { it.destroyForcibly();it.waitFor(3,TimeUnit.SECONDS) }
                root.deleteRecursively()
            }
        }
    }

    @Test fun publicationTempsPreserveSentinelsAndRejectUnsafeWrites() {
        val root=Files.createTempDirectory("native-temp-sentinels-").toFile()
        try {
            val target=File(root,"sentinel").apply { writeText("preserve") }
            for(kind in listOf("symlink","directory")) {
                val file=File(root,"$kind/capture.ndjson");file.parentFile.mkdirs()
                val temp=File(file.path+".cursor.json.tmp")
                if(kind=="symlink") Files.createSymbolicLink(temp.toPath(),target.toPath()) else temp.mkdir()
                val unrelated=File(file.parentFile,"unrelated.tmp").apply { writeText("unrelated") }
                FileHttpEventSink(file,null).use { it.append(line("safe"));it.flush().get(3,TimeUnit.SECONDS) }
                assertTrue(Files.exists(temp.toPath(),java.nio.file.LinkOption.NOFOLLOW_LINKS));assertEquals("unrelated",unrelated.readText())
                try { FileHttpEventSink.atomic(File(file.path+".cursor.json"),"unsafe");fail("Unsafe publication temp accepted") } catch(_:java.io.IOException) {}
                assertFalse(File(file.path+".cursor.json").exists());assertEquals("preserve",target.readText())
            }
        } finally { root.deleteRecursively() }
    }

    @Test fun repeatedUnsafePublicationConstructionReleasesHandleAndLease() {
        val root=Files.createTempDirectory("native-unsafe-construction-").toFile()
        try {
            val file=File(root,"capture.ndjson");val target=File(root,"sentinel").apply { writeText("preserve") };val temp=File(root,"journal.json.tmp")
            Files.createSymbolicLink(temp.toPath(),target.toPath())
            fun rejected() { try { FileHttpEventSink(file,null).close();fail("Unsafe metadata temp accepted") } catch(_:java.io.IOException) {} }
            rejected()
            val bean=Class.forName("java.lang.management.ManagementFactory").getMethod("getOperatingSystemMXBean").invoke(null)
            val count=Class.forName("com.sun.management.UnixOperatingSystemMXBean").getMethod("getOpenFileDescriptorCount")
            val before=count.invoke(bean) as Long
            repeat(5) { rejected() }
            assertEquals(before,count.invoke(bean) as Long)
            assertEquals("preserve",target.readText());assertTrue(Files.isSymbolicLink(temp.toPath()));Files.delete(temp.toPath())
            FileHttpEventSink(file,null).use { it.append(line("retry"));it.flush().get(3,TimeUnit.SECONDS) };assertArrayEquals(bytes("retry"),file.readBytes())
        } finally { root.deleteRecursively() }
    }

    companion object {
        private val BOUNDARIES=AtomicPublicationBoundary.values().map { it.name.lowercase() }
        private val METADATA_UNCOMMITTED=setOf("metadata_temp_written","metadata_temp_synced")
        private val METADATA_COMMITTED=setOf("metadata_renamed","metadata_directory_synced")
        private val CURSOR_UNCOMMITTED=setOf("cursor_temp_written","cursor_temp_synced")
        private val CURSOR_COMMITTED=setOf("cursor_renamed","cursor_directory_synced")
        private val ATOMIC_STAGES=listOf("metadata","cursor").flatMap { kind -> BOUNDARIES.map { "$kind"+"_"+it } }
        private val STAGES=listOf("enqueue","append_partial","append_complete","synced_unpublished","published","cursor_committed","cursor_lost")+ATOMIC_STAGES
        private val UNPUBLISHED=setOf("enqueue","append_partial","append_complete","synced_unpublished")
        private fun line(id:String)="""{"schema_version":"1.2","event_type":"session.started","event_id":"$id","data":{}}"""
        private fun bytes(id:String)=(line(id)+"\n").toByteArray(Charsets.UTF_8)
        private fun allBytes()=bytes("baseline")+bytes("candidate")
        private fun connection()=TransferConnection.parse("""{"version":2,"endpoint":"http://127.0.0.1:4319","source_token":"test-fixture-token","source_id":"source","collector_id":"collector","certificate_sha256":null}""")
        private fun ack(body:ByteArray,duplicates:Boolean=false):UploadResponse {
            val ids=body.toString(Charsets.UTF_8).trim().lines().map { JSONObject(it).getString("event_id") }
            return UploadResponse(200,JSONObject().put("version",2).put("source_id","source").put("collector_id","collector")
                .put("accepted",if(duplicates) 0 else ids.size).put("duplicates",if(duplicates) ids.size else 0)
                .put("cursor",ids.size).put("acknowledged_event_ids",JSONArray(ids)).toString().toByteArray(Charsets.UTF_8))
        }
        @JvmStatic fun main(args:Array<String>) {
            try {
                val root=File(args[0]);val stage=args[1];require(stage in STAGES)
                val file=File(root,"journal/capture.ndjson")
                fun stop() { File(root,"stage.marker").writeText(stage);CountDownLatch(1).await() }
                val armed=java.util.concurrent.atomic.AtomicBoolean(false)
                val disk=object:JournalDiskIO {
                    override fun atomicBoundary(target:File,boundary:AtomicPublicationBoundary) {
                        val kind=if(target.name=="journal.json") "metadata" else if(target.name=="capture.ndjson.cursor.json") "cursor" else return
                        if(armed.get() && stage==kind+"_"+boundary.name.lowercase()) stop()
                    }
                    override fun append(output:FileOutputStream,bytes:ByteArray) {
                        if(stage=="enqueue") stop()
                        if(stage=="append_partial") { output.write(bytes,0,bytes.size/2);stop() }
                        SystemJournalDiskIO.append(output,bytes)
                        if(stage=="append_complete") stop()
                    }
                    override fun sync(output:FileOutputStream) {
                        SystemJournalDiskIO.sync(output)
                        if(stage=="synced_unpublished") stop()
                    }
                }
                val delivered=mutableSetOf<String>()
                val transport=object:EventTransport {
                    override fun upload(body:ByteArray):UploadResponse {
                        val ids=body.toString(Charsets.UTF_8).trim().lines().map { JSONObject(it).getString("event_id") }
                        if(ids.toSet()!=setOf("baseline","candidate")) return UploadResponse(503,byteArrayOf())
                        delivered.addAll(ids)
                        FileHttpEventSink.atomic(File(root,"collector-receipt.json"),JSONObject().put("event_ids",JSONArray(delivered.toList())).toString())
                        return ack(body)
                    }
                }
                val sink=FileHttpEventSink.testing(file,if(stage.startsWith("cursor_")) connection() else null,transport,diskIO=disk)
                armed.set(true);sink.append(line("candidate"));sink.flush().get()
                if(stage=="published") {
                    val deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(3)
                    while(JSONObject(File(file.parentFile,"journal.json").readText()).getLong("durable_bytes")!=allBytes().size.toLong()) {
                        check(System.nanoTime()<deadline);Thread.sleep(5)
                    }
                } else if(stage.startsWith("cursor_")) check(sink.awaitUploaded(3000))
                if(stage in ATOMIC_STAGES) CountDownLatch(1).await() else stop()
            } catch(e:Throwable) { e.printStackTrace();System.exit(2) }
        }
    }
}
