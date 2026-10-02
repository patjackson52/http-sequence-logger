package dev.networklog.logger

import android.content.Context
import android.content.pm.ApplicationInfo
import org.json.JSONObject
import java.io.Closeable
import java.io.File
import java.io.IOException
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Debug-only bootstrap publishes discovery even with no collector or events. Never include in release wiring. */
object DebugTransfer {
    private fun enabled(context: Context) = context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
    fun directory(context: Context) = File(context.noBackupFilesDir,"HTTPSequenceLogger")
    fun configurationFile(context: Context) = File(directory(context),"pairing.json")
    private fun selectedConfigurationFile(context:Context):File=configurationFile(context).let { if(it.exists()) it else File(directory(context),"pairing-local.json") }
    fun initialize(context: Context): String {
        check(enabled(context)) { "Collector requires debuggable application" }
        val root=directory(context); root.mkdirs()
        return InstallationLock.withRoot(root) {
            val identity=File(root,"installation-id")
            val id=if(identity.exists()) identity.readText().trim().also { require(it.matches(Regex("[a-zA-Z0-9-]{1,128}"))) }
                else UUID.randomUUID().toString().also { FileHttpEventSink.atomic(identity,it) }
            File(root,"journals").mkdirs()
            FileHttpEventSink.atomic(File(root,"source.json"),obj("version" to 2,"platform" to "android","app_id" to context.packageName,
                "installation_id" to id,"journal_directory" to "journals").toString())
            id
        }
    }
    fun readConnection(context: Context): TransferConnection? {
        if(!enabled(context)) return null
        val file=selectedConfigurationFile(context); if(!file.exists()) return null
        require(file.length()<=16384); val value=JSONObject(file.readText())
        return if(value.has("source_token")) TransferConnection.parse(value.toString()) else null
    }
    fun saveConnection(context:Context,json:String) { initialize(context); require(json.toByteArray().size<=16384)
        val value=JSONObject(json); require(value.getInt("version")==2)
        if(value.has("source_token")) TransferConnection.parse(json)
        else { require(value.getString("enrollment_token").length in 1..4096); provisional(value) }
        withInstallationLock(context) { FileHttpEventSink.atomic(configurationFile(context),json) }
    }
    fun removeConnection(context:Context) { check(enabled(context));withInstallationLock(context) { configurationFile(context).delete() } }
    private fun <T> withInstallationLock(context:Context,operation:()->T):T=InstallationLock.withRoot(directory(context),operation)
    private fun provisional(value:JSONObject): TransferConnection = TransferConnection.parse(obj("version" to 2,
        "endpoint" to value.getString("endpoint"),"collector_id" to value.getString("collector_id"),"source_id" to "enrollment",
        "source_token" to value.getString("enrollment_token"),"certificate_sha256" to value.opt("certificate_sha256")).toString())
    /** Opens one unique process journal. Retain it across sessions. Admission is safe on callback threads. */
    fun open(context:Context,journalLimits:JournalLimits=JournalLimits(),diagnostic:(String)->Unit={}): DevelopmentCaptureSink {
        val installation=initialize(context)
        return DevelopmentCaptureSink(context.applicationContext,installation,RollingJournal(directory(context),journalLimits,diagnostic=diagnostic),diagnostic)
    }
    fun resumePending(context:Context,maximumFiles:Int=16,diagnostic:(String)->Unit={}): List<FileHttpEventSink> {
        val installation=initialize(context)
        return File(this.directory(context),"journals").listFiles().orEmpty().filter { it.isDirectory }.takeLast(maximumFiles).mapNotNull {
            runCatching { val pairing=resolve(context,installation,it.name,UUID.randomUUID().toString()) ?: return@runCatching null
                FileHttpEventSink(File(it,"capture.ndjson"),pairing,diagnostic=diagnostic) }.getOrNull()
        }
    }
    internal fun resolve(context:Context,installation:String,journal:String,instance:String): TransferConnection? {
        val config=selectedConfigurationFile(context); if(!config.exists()) return null; require(config.length()<=16384)
        val input=config.readText();val value=JSONObject(input); if(value.has("source_token")) return TransferConnection.parse(value.toString())
        val provision=provisional(value); val local=File(directory(context),"journals/$journal/connection.json")
        if(local.exists()) {
            val existing=TransferConnection.parse(local.readText())
            if(existing.collectorId==provision.collectorId) {
                withInstallationLock(context) {
                    if(selectedConfigurationFile(context)!=config || !config.exists() || config.readText()!=input) throw IOException("Collector selection changed during enrollment")
                    if(config==configurationFile(context)) FileHttpEventSink.atomic(config,existing.json())
                }
                return existing
            }
        }
        val operation=File(local.parentFile,"registration-id")
        val id=if(operation.exists()) operation.readText() else UUID.randomUUID().toString().also { FileHttpEventSink.atomic(operation,it) }
        val metadata=obj("version" to 2,"registration_id" to id,"platform" to "android","environment_id" to value.optString("environment_id",installation),
            "environment_name" to value.optString("environment_name","Android"),"app_id" to context.packageName,"installation_id" to installation,
            "journal_id" to journal,"instance_id" to instance)
        val response=HttpEventTransport(provision).request("register",metadata.toString().toByteArray())
        require(response.status==200); val result=JSONObject(response.body.toString(Charsets.UTF_8)); result.put("certificate_sha256",value.opt("certificate_sha256"))
        val paired=TransferConnection.parse(result.toString())
        withInstallationLock(context) {
            if(selectedConfigurationFile(context)!=config || !config.exists() || config.readText()!=input) throw IOException("Collector selection changed during enrollment")
            FileHttpEventSink.atomic(local,paired.json());if(config==configurationFile(context)) FileHttpEventSink.atomic(config,paired.json())
        }
        return paired
    }
}

class DevelopmentCaptureSink internal constructor(private val context:Context,private val installation:String,
    private val delegate:RollingJournal,private val diagnostic:(String)->Unit) : EventSink, Closeable {
    private val manager=Executors.newSingleThreadScheduledExecutor { Thread(it,"network-log-bootstrap").apply { isDaemon=true } }
    private val instance=UUID.randomUUID().toString()
    @Volatile private var paired:TransferConnection?=null
    @Volatile private var closed=false
    private var lastPresence=0L
    val file:File get()=delegate.file
    val captureFiles:List<File> get()=delegate.files
    val uploadsEnabled:Boolean get()=paired!=null
    init { manager.scheduleWithFixedDelay({ refresh() },0,1,TimeUnit.SECONDS) }
    private fun refresh() {
        if(closed) return
        runCatching {
            val next=DebugTransfer.resolve(context,installation,delegate.registrationJournalID,instance)
            if(next?.json()!=paired?.json()) { delegate.rebind(next); paired=next }
            if(next!=null && System.currentTimeMillis()-lastPresence>=10000) {
                HttpEventTransport(next).request("presence",obj("version" to 2,"instance_id" to instance).toString().toByteArray()); lastPresence=System.currentTimeMillis()
            }
        }.onFailure { runCatching { diagnostic("Collector unavailable; backlog retained") } }
    }
    override fun append(line:String)=delegate.append(line)
    override fun appendEvent(event:JSONObject)=delegate.appendEvent(event)
    fun flush()=delegate.flush()
    fun awaitUploaded(timeoutMs:Long):Boolean=delegate.awaitUploaded(timeoutMs)
    override fun close() { closed=true; manager.shutdownNow(); manager.awaitTermination(6,TimeUnit.SECONDS); delegate.close() }
}
