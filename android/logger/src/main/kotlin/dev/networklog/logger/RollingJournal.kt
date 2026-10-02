package dev.networklog.logger

import org.json.JSONObject
import java.io.Closeable
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Canonical installation limits. Generations reserve their capacity before opening; seal releases unused reservation. */
data class JournalLimits(val generationBytes:Long=16L*1024*1024,val installationBytes:Long=256L*1024*1024,
    val maximumGenerations:Int=128,val queueBytes:Long=2L*1024*1024) {
    init { require(generationBytes>0 && installationBytes>=generationBytes && maximumGenerations in 1..128 && queueBytes>0) }
}
internal class InstallationJournalBudget(private val root:File,private val limits:JournalLimits) {
    private val journals=File(root,"journals").apply { mkdirs() }
    fun captures():List<File> = journals.listFiles().orEmpty().filter { it.isDirectory }.sortedWith(compareBy<File> { java.nio.file.Files.readAttributes(it.toPath(),java.nio.file.attribute.BasicFileAttributes::class.java).creationTime() }.thenBy { it.name }).map { File(it,"capture.ndjson") }.filter { it.isFile }
    private fun <T> locked(block:()->T):T=InstallationLock.withRoot(root,block)
    private fun readReservations(state:File):JSONObject {
        if(!state.exists()) return JSONObject()
        try {
            val bytes=ByteArray(16385);var length=0
            state.inputStream().use { input ->
                while(length<bytes.size) { val count=input.read(bytes,length,bytes.size-length);if(count<0) break;length+=count }
            }
            if(length>16384) throw IOException("Journal budget exceeds 16 KiB")
            val text=Charsets.UTF_8.newDecoder().onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
                .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT).decode(java.nio.ByteBuffer.wrap(bytes,0,length)).toString()
            val value=JSONObject(text)
            if(value.get("version")!=2) throw IOException("Unsupported journal budget version")
            val reservations=value.getJSONObject("reservations")
            if(reservations.length()>128) throw IOException("Journal budget exceeds 128 generations")
            for(key in reservations.keys()) {
                val reserved=reservations.get(key)
                if(!key.matches(Regex("[A-Za-z0-9][A-Za-z0-9._-]{0,127}")) || (reserved !is Int && reserved !is Long) || (reserved as Number).toLong()<0)
                    throw IOException("Invalid journal budget reservation")
            }
            return reservations
        } catch(e:Exception) {
            throw IOException("Journal budget unavailable or invalid; restore retained journal state or select a new directory",e)
        }
    }
    private fun validateInventory(reservations:JSONObject) {
        for(key in reservations.keys()) {
            val directory=File(journals,key);val capture=File(directory,"capture.ndjson")
            if(!java.nio.file.Files.isDirectory(directory.toPath(),java.nio.file.LinkOption.NOFOLLOW_LINKS) ||
                !java.nio.file.Files.isRegularFile(capture.toPath(),java.nio.file.LinkOption.NOFOLLOW_LINKS))
                throw IOException("Retained journal generation $key is missing its directory or capture.ndjson; restore the missing journal or export remaining captures and select a new directory")
        }
    }
    fun <T> openGeneration(open:(File)->T):T=locked {
        val state=File(root,"journal-budget.json")
        val previous=readReservations(state)
        validateInventory(previous)
        val reservations=JSONObject();val dirs=journals.listFiles().orEmpty().filter { it.isDirectory }
        if(dirs.size>=limits.maximumGenerations) throw IOException("Installation journal count capacity exceeded")
        var used=0L
        for(dir in dirs) {
            val file=File(dir,"capture.ndjson");val reservation=previous.optLong(dir.name,file.length())
            val reserved=RandomAccessFile(File(file.path+".writer.lock"),"rw").use { fd ->
                val lock=runCatching { fd.channel.tryLock() }.getOrNull()
                if(lock==null) maxOf(reservation,file.length()) else { lock.release();file.length() }
            }
            if(reserved>limits.installationBytes-used) throw IOException("Installation journal byte capacity exceeded")
            reservations.put(dir.name,reserved);used+=reserved
        }
        if(limits.generationBytes>limits.installationBytes-used) throw IOException("Installation journal byte capacity exceeded")
        val id=UUID.randomUUID().toString();val folder=File(journals,id);if(!folder.mkdir()) throw IOException("Journal directory unavailable")
        reservations.put(id,limits.generationBytes)
        FileHttpEventSink.atomic(state,obj("version" to 2,"reservations" to reservations).toString())
        open(File(folder,"capture.ndjson"))
    }
    fun seal(file:File)=locked {
        val state=File(root,"journal-budget.json");val reservations=readReservations(state)
        validateInventory(reservations)
        reservations.put(file.parentFile.name,file.length());FileHttpEventSink.atomic(state,obj("version" to 2,"reservations" to reservations).toString())
    }

}

/** Bounded callback admission and one serial generation router. It never dual-writes canonical events. */
internal class RollingJournal(root:File,private val journalLimits:JournalLimits=JournalLimits(),
    private val transferLimits:TransferLimits=TransferLimits(),private val diagnostic:(String)->Unit={}) : EventSink,Closeable {
    private val budget=InstallationJournalBudget(root,journalLimits)
    private val gate=Object()
    private val worker=Executors.newSingleThreadScheduledExecutor { Thread(it,"network-log-rotation").apply { isDaemon=true } }
    private val allFiles=java.util.concurrent.atomic.AtomicReference(budget.captures())
    private var route:TransferConnection?=null
    private var current=makeGeneration()
    @Volatile var file:File=current.file;private set
    val registrationJournalID:String get()=allFiles.get().last().parentFile.name
    val files:List<File> get()=allFiles.get().toList()
    private var pending=0L
    @Volatile private var closed=false
    @Volatile private var failed=false
    @Volatile var droppedEvents=0L;private set
    private var historical:FileHttpEventSink?=null
    private var historicalIndex=0
    init { worker.scheduleWithFixedDelay({ if(!closed && !failed) pumpHistory() },0,250,TimeUnit.MILLISECONDS) }
    private fun makeGeneration():FileHttpEventSink {
        val sink=budget.openGeneration { path -> FileHttpEventSink(path,route,transferLimits.copy(spoolBytes=journalLimits.generationBytes),diagnostic) }
        allFiles.set(allFiles.get()+sink.file);return sink
    }
    override fun append(line:String) {
        val size=line.toByteArray(Charsets.UTF_8).size+1L
        if(size>transferLimits.batchBytes || size>journalLimits.generationBytes || line.contains('\n') || line.contains('\r')) throw IOException("Capture event exceeds generation limit")
        admit(size) { write(line,size) }
    }
    override fun appendEvent(event:JSONObject) {
        // Immutable recorder-owned object. Serialize on the router, outside the recording/callback lock.
        val reservation=FileHttpEventSink.eventBudget(event)
        if(reservation>journalLimits.queueBytes) throw IOException("Capture event exceeds queue limit")
        admit(reservation) { val line=event.toString();write(line,line.toByteArray(Charsets.UTF_8).size+1L) }
    }
    private fun admit(size:Long,operation:()->Unit) {
        synchronized(gate) {
            if(closed || failed) throw IOException("Journal unavailable")
            if(pending+current.queuedSize()+size>journalLimits.queueBytes) { droppedEvents++;throw IOException("Capture queue capacity exceeded") }
            pending+=size
            worker.execute {
                try { if(failed) throw IOException("Journal unavailable");operation() }
                catch(_:Exception) { failed=true;droppedEvents++;runCatching { diagnostic("Journal storage full or failed; admitted prefix retained") } }
                finally { synchronized(gate) { pending-=size;gate.notifyAll() } }
            }
        }
    }
    private fun write(line:String,size:Long) {
        if(size>journalLimits.generationBytes || size>transferLimits.batchBytes) throw IOException("Capture event exceeds generation limit")
        if(current.admittedSize()+size>journalLimits.generationBytes) {
            current.close();budget.seal(current.file)
            current=makeGeneration();file=current.file
        }
        current.append(line)
    }
    fun rebind(next:TransferConnection?) {
        synchronized(gate) { if(closed) return;worker.execute { if(closed) return@execute;route=next;current.rebind(next);historical?.rebind(next);historicalIndex=0 } }
    }
    fun flush():CompletableFuture<Unit> {
        val result=CompletableFuture<Unit>()
        if(!JournalCompletions.reserve()) { result.completeExceptionally(IOException("Journal barrier capacity exceeded"));return result }
        synchronized(gate) { if(closed && worker.isShutdown) { JournalCompletions.finish(result,IOException("Journal closed"));return result }
            worker.execute { val error=runCatching { if(failed) throw IOException("Journal writer failed");current.flushInternal().get() }.exceptionOrNull()
                JournalCompletions.finish(result,error?.let { IOException("Journal persistence failed") }) }
        }
        return result
    }
    private fun pumpHistory() {
        if(route==null) return
        val active=historical
        if(active!=null) {
            if(active.pendingBytes()==0L) { active.close();historical=null;historicalIndex++ } else return
        }
        val snapshots=allFiles.get()
        while(historicalIndex<snapshots.size-1) {
            val candidate=runCatching { FileHttpEventSink(snapshots[historicalIndex],route,transferLimits,diagnostic) }.getOrNull()
            if(candidate==null) { historicalIndex++;continue }
            if(candidate.pendingBytes()==0L) { candidate.close();historicalIndex++;continue }
            historical=candidate;return
        }
    }
    fun awaitUploaded(timeoutMs:Long):Boolean {
        flush().get(timeoutMs,TimeUnit.MILLISECONDS)
        val end=System.nanoTime()+TimeUnit.MILLISECONDS.toNanos(timeoutMs)
        while(System.nanoTime()<end) {
            val ready=worker.submit<Boolean> { current.pendingBytes()==0L && historical==null && historicalIndex>=allFiles.get().size-1 }.get()
            if(ready) return true
            Thread.sleep(10)
        }
        return false
    }
    override fun close() {
        synchronized(gate) { if(closed) return;closed=true }
        val result=worker.submit { var error:Exception?=null
            fun retain(e:Exception) { if(error==null) error=e else error!!.addSuppressed(e) }
            try { current.close() } catch(e:Exception) { retain(e) }
            try { budget.seal(current.file) } catch(e:Exception) { retain(e) }
            try { historical?.close() } catch(e:Exception) { retain(e) } finally { historical=null }
            error?.let { throw it }
            if(failed) throw IOException("Journal close retained a failed prefix")
        }
        try { result.get() } finally { worker.shutdown() }
    }
}

/** FileChannel locks need one JVM gate as well as the cross-process file lock. */
internal object InstallationLock {
    private val gate=Any()
    fun <T> withRoot(root:File,block:()->T):T=synchronized(gate) {
        RandomAccessFile(File(root,"installation.lock"),"rw").use { fd -> fd.channel.lock().use { block() } }
    }
}
