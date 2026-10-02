package dev.networklog.logger

import android.content.Context
import android.content.ContextWrapper
import android.content.pm.ApplicationInfo
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.nio.file.Files
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class DebugTransferTest {
    private fun context(root:File)=object:ContextWrapper(null) {
        override fun getNoBackupFilesDir()=root
        override fun getPackageName()="example.enrollment"
        override fun getApplicationInfo()=ApplicationInfo().apply { flags=ApplicationInfo.FLAG_DEBUGGABLE }
        override fun getApplicationContext():Context=this
    }
    @Test fun configurationAndGenerationOperationsShareTheSameJvmInstallationGate() {
        val context=context(Files.createTempDirectory("configuration-generation-concurrency").toFile())
        DebugTransfer.initialize(context)
        val journal=RollingJournal(DebugTransfer.directory(context),JournalLimits(generationBytes=128,installationBytes=8192,maximumGenerations=64))
        val threads=Executors.newFixedThreadPool(2)
        val writes=threads.submit { repeat(100) { journal.append(JSONObject().put("event_id","event-$it").toString()) };journal.flush().get(5,TimeUnit.SECONDS) }
        val configurations=threads.submit { repeat(100) {
            DebugTransfer.saveConnection(context,"""{"version":2,"endpoint":"http://127.0.0.1:1","collector_id":"collector-test","source_id":"s","source_token":"test-secret"}""")
        } }
        writes.get(8,TimeUnit.SECONDS);configurations.get(8,TimeUnit.SECONDS);journal.close();threads.shutdownNow()
        assertEquals(100,journal.files.flatMap { it.readLines() }.size)
    }
    @Test fun registrationPromotesInstallationCredentialAndManualSelectionWinsLocalProposal() {
        val context=context(Files.createTempDirectory("enrollment-relaunch").toFile())
        val server=ServerSocket(0,1,InetAddress.getByName("127.0.0.1"));val endpoint="http://127.0.0.1:${server.localPort}"
        val executor=Executors.newSingleThreadExecutor()
        val request=executor.submit {
            server.accept().use { socket ->
                val input=socket.getInputStream().bufferedReader();var contentLength=0
                var line=input.readLine();assertTrue(line.startsWith("POST /api/v2/register"))
                while(true) { line=input.readLine();if(line.isEmpty()) break;if(line.startsWith("Content-Length:",true)) contentLength=line.substringAfter(':').trim().toInt() }
                val body=CharArray(contentLength);var read=0;while(read<body.size) read+=input.read(body,read,body.size-read)
                val metadata=JSONObject(String(body));assertEquals("example.enrollment",metadata.getString("app_id"));assertEquals(2,metadata.getInt("version"))
                val result="""{"version":2,"endpoint":"$endpoint","collector_id":"collector-test","source_id":"registered-installation","source_token":"registered-source-secret"}"""
                socket.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${result.toByteArray().size}\r\nConnection: close\r\n\r\n$result".toByteArray())
            }
        }
        try {
            val installation=DebugTransfer.initialize(context)
            DebugTransfer.saveConnection(context,"""{"version":2,"endpoint":"$endpoint","collector_id":"collector-test","enrollment_token":"short-lived-ticket"}""")
            val journal=UUID.randomUUID().toString();File(DebugTransfer.directory(context),"journals/$journal").mkdirs()
            val enrolled=DebugTransfer.resolve(context,installation,journal,"instance-one")!!
            request.get(3,TimeUnit.SECONDS);server.close()
            assertEquals("registered-installation",enrolled.sourceId)
            assertFalse(DebugTransfer.configurationFile(context).readText().contains("short-lived-ticket"))
            val relaunched=DebugTransfer.resolve(context,installation,UUID.randomUUID().toString(),"instance-two")!!
            assertEquals(enrolled.json(),relaunched.json())
            File(DebugTransfer.directory(context),"pairing-local.json").writeText("""{"version":2,"endpoint":"http://127.0.0.1:1","collector_id":"automatic-other","source_id":"other","source_token":"other-secret"}""")
            assertEquals("collector-test",DebugTransfer.readConnection(context)!!.collectorId)
            DebugTransfer.removeConnection(context)
            assertEquals("automatic-other",DebugTransfer.readConnection(context)!!.collectorId)
        } finally { server.close();executor.shutdownNow() }
    }
}
