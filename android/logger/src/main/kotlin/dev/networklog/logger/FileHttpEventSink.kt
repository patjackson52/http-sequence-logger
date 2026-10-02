package dev.networklog.logger

import org.json.JSONObject
import java.io.Closeable
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.RandomAccessFile
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.BasicFileAttributes
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Canonical records are retained after ACK. Limits bound capture admission independently of delivery. */
data class TransferLimits(val spoolBytes: Long = 16L * 1024 * 1024, val batchBytes: Int = 1024 * 1024,
    val batchEvents: Int = 500, val flushDelayMs: Long = 50, val initialRetryMs: Long = 500,
    val maximumRetryMs: Long = 30_000, val queueBytes: Long = 2L * 1024 * 1024) {
    init { require(spoolBytes in 1..268435456 && batchBytes in 1..1048576 && batchEvents in 1..500)
        require(flushDelayMs in 0..250 && initialRetryMs in 1..maximumRetryMs && maximumRetryMs <= 60000 && queueBytes > 0) }
}

/** Admission is bounded and does no file/network I/O. One file owner commits groups; one sender tails synced lines. */
class FileHttpEventSink private constructor(val file: File, initial: TransferConnection?, private val limits: TransferLimits,
    private val diagnostic: (String) -> Unit, initialTransport: EventTransport?, private val diskIO: JournalDiskIO = SystemJournalDiskIO) : EventSink, Closeable {
    constructor(file: File, connection: TransferConnection?, limits: TransferLimits = TransferLimits(), diagnostic: (String) -> Unit = {}) :
        this(file, connection, limits, diagnostic, connection?.let(::HttpEventTransport))
    private val mutex = Object()
    private val routeFence = Object()
    private val disk = java.util.concurrent.ScheduledThreadPoolExecutor(1,{ Thread(it, "network-log-journal").apply { isDaemon = true } }).apply { removeOnCancelPolicy=true }
    private val network = Executors.newSingleThreadScheduledExecutor { Thread(it, "network-log-sender").apply { isDaemon = true } }
    private val lockFile = RandomAccessFile(File(file.path + ".writer.lock").apply { parentFile?.mkdirs() }, "rw")
    private val writerLock = try { lockFile.channel.tryLock() ?: throw IOException("Journal already open") }
        catch (_: Exception) { lockFile.close(); throw IOException("Journal already open") }
    private val output: FileOutputStream
    private var connection = initial
    private var transport = initialTransport
    private var generation = 0L
    private var queuedBytes = 0L
    private var admittedBytes = 0L
    private var durableBytes = 0L
    private var offset = 0L
    private var identity = ""
    private var failed = false
    private var closed = false
    private var rejected = false
    private var sending = false
    private var timer: java.util.concurrent.ScheduledFuture<*>? = null
    private var flushTimer: java.util.concurrent.ScheduledFuture<*>? = null
    private var publicationTimer:java.util.concurrent.ScheduledFuture<*>?=null
    private var publishedBytes=0L
    private var publishedAt=System.nanoTime()
    private var failures = 0
    private data class Pending(val text:String?,val event:JSONObject?,val reserved:Long,val position:Long)
    private val queue = java.util.ArrayDeque<Pending>()
    private var admittedPosition=0L
    private var durablePosition=0L
    private val barriers = mutableListOf<Pair<Long, CompletableFuture<Unit>>>()
    val journalId: String = requireNotNull(file.parentFile).name
    @Volatile var droppedEvents: Long = 0; private set
    init {
        var openedOutput:FileOutputStream?=null
        try {
            requireNotNull(file.parentFile).mkdirs()
            // Only this journal owner's fixed publication temps are disposable after lock acquisition.
            for(temp in listOf(File(file.parentFile,"journal.json.tmp"),File(file.path+".cursor.json.tmp"))) {
                if(Files.isRegularFile(temp.toPath(),java.nio.file.LinkOption.NOFOLLOW_LINKS)) Files.delete(temp.toPath())
            }
            RandomAccessFile(file, "rw").use { f ->
                var end=f.length();val buffer=ByteArray(65536);var inspected=0L;var complete=0L
                while(end>0) {
                    val count=minOf(end,buffer.size.toLong()).toInt();f.seek(end-count);f.readFully(buffer,0,count)
                    val newline=(count-1 downTo 0).firstOrNull { buffer[it].toInt()==10 }
                    if(newline!=null) { complete=end-count+newline+1;break }
                    inspected+=count;if(inspected>1048576) throw IOException("Journal final tail exceeds event limit")
                    end-=count
                }
                if(f.length()-complete>1048576) throw IOException("Journal final tail exceeds event limit")
                if(complete!=f.length()) f.setLength(complete)
                f.fd.sync()
            }
            require(file.length() <= limits.spoolBytes)
            output = FileOutputStream(file, true);openedOutput=output
            durableBytes = file.length(); admittedBytes = durableBytes; identity = fileIdentity()
            restore(); publish(); synchronized(mutex) { schedule(0) }
        } catch (error: Exception) { runCatching { openedOutput?.close() };runCatching { writerLock.release() };runCatching { lockFile.close() };disk.shutdown();network.shutdown();throw IOException("Journal initialization failed", error) }
    }
    override fun append(line: String) {
        val size=line.toByteArray(Charsets.UTF_8).size+1L
        if(line.contains('\n') || line.contains('\r') || size>limits.batchBytes) throw IOException("Invalid capture line")
        enqueue(line,null,size)
    }
    override fun appendEvent(event:JSONObject) {
        // Recorder owns this fresh immutable sanitized object. Serialization occurs on the disk owner.
        enqueue(null,event,eventBudget(event))
    }
    private fun enqueue(text:String?,event:JSONObject?,reservation:Long) {
        synchronized(mutex) {
            if(closed || failed) throw IOException("Journal unavailable")
            if(queuedBytes+reservation>limits.queueBytes || admittedBytes+reservation>limits.spoolBytes) {
                droppedEvents++;throw IOException("Journal capacity exceeded")
            }
            queue.add(Pending(text,event,reservation,++admittedPosition));queuedBytes+=reservation;admittedBytes+=reservation
            if(flushTimer==null) flushTimer=disk.schedule(::commit,limits.flushDelayMs,TimeUnit.MILLISECONDS)
            if(queuedBytes>=65536 || queue.size>=500) { flushTimer?.cancel(false);flushTimer=disk.schedule(::commit,0,TimeUnit.MILLISECONDS) }
        }
    }
    /** Persistence through the current admission position, independent of uploads and future events. */
    fun flush():CompletableFuture<Unit> {
        val future=CompletableFuture<Unit>()
        var immediate=false;var error:Exception?=null
        synchronized(mutex) {
            when {
                failed -> { immediate=true;error=IOException("Journal write failed") }
                admittedPosition==durablePosition -> immediate=true
                !JournalCompletions.reserve() -> { immediate=true;error=IOException("Journal barrier capacity exceeded") }
                else -> { barriers.add(admittedPosition to future);flushTimer?.cancel(false);flushTimer=disk.schedule(::commit,0,TimeUnit.MILLISECONDS) }
            }
        }
        // A fresh future has no listeners yet. Never complete a subscribed future under a lock/on the disk owner.
        if(immediate) { if(error==null) future.complete(Unit) else future.completeExceptionally(error!!) }
        return future
    }
    /** Internal owner barrier has no subscriber callbacks or completion admission of its own. */
    internal fun flushInternal():java.util.concurrent.Future<*> = disk.submit {
        commit()
        synchronized(mutex) { if(failed) throw IOException("Journal write failed") }
    }
    private fun failWriter() {
        val pending=synchronized(mutex) { failed=true;val all=barriers.map { it.second };barriers.clear();mutex.notifyAll();all }
        pending.forEach { JournalCompletions.finish(it,IOException("Journal write failed")) }
        report("Journal write failed; retained capture needs inspection")
    }
    private fun commit() {
        val lines=synchronized(mutex) { flushTimer=null;if(failed) return;val group=queue.toList();queue.clear();group }
        if(lines.isEmpty()) return
        try {
            val serialized=lines.map { it.text ?: it.event!!.toString() }
            if(serialized.any { it.toByteArray(Charsets.UTF_8).size+1>limits.batchBytes }) throw IOException("Capture event exceeds limit")
            val bytes=(serialized.joinToString("\n")+"\n").toByteArray(Charsets.UTF_8)
            val reserved=lines.sumOf { it.reserved }
            diskIO.append(output,bytes);diskIO.sync(output)
            val ready=synchronized(mutex) {
                durableBytes+=bytes.size;queuedBytes-=reserved;admittedBytes-=reserved-bytes.size;durablePosition=lines.last().position
                val complete=barriers.filter { it.first<=durablePosition }.map { it.second }
                barriers.removeAll { it.first<=durablePosition };schedule(0);mutex.notifyAll();complete
            }
            ready.forEach { JournalCompletions.finish(it,null) }
            publishCoalesced()
        } catch(_:Exception) { failWriter() }
    }
    private fun publishCoalesced() {
        val elapsed=System.nanoTime()-publishedAt
        if(durableBytes-publishedBytes>=1048576 || elapsed>=TimeUnit.MILLISECONDS.toNanos(250)) { publicationTimer?.cancel(false);publicationTimer=null;publish() }
        else if(publicationTimer==null) publicationTimer=disk.schedule({ publicationTimer=null;if(!failed) runCatching { publish() }.onFailure { failWriter() } },250-TimeUnit.NANOSECONDS.toMillis(elapsed),TimeUnit.MILLISECONDS)
    }
    private fun publish() {
        atomic(File(file.parentFile,"journal.json"),obj("version" to 2,"journal_id" to journalId,"generation" to journalId,
            "capture" to file.name,"durable_bytes" to durableBytes).toString(),diskIO)
        publishedBytes=durableBytes;publishedAt=System.nanoTime()
    }
    internal fun queuedSize():Long=synchronized(mutex) { queuedBytes }
    internal fun admittedSize():Long=synchronized(mutex) { admittedBytes }
    private fun schedule(delay: Long) {
        if (!closed && !rejected && !sending && transport != null && timer == null) timer = network.schedule(::send, delay, TimeUnit.MILLISECONDS)
    }
    private data class Batch(val bytes: ByteArray, val ids: List<String>, val start: Long, val end: Long, val generation: Long, val identity: String, val boundary: String)
    private data class ReadScope(val offset:Long,val durable:Long,val generation:Long,val identity:String)
    private fun batch(scope:ReadScope): Batch? {
        val offset=scope.offset;val durableBytes=scope.durable
        if (offset >= durableBytes) return null
        val body = java.io.ByteArrayOutputStream(); val ids = mutableListOf<String>()
        RandomAccessFile(file,"r").use { input ->
            input.seek(offset)
            val line=java.io.ByteArrayOutputStream();val buffer=ByteArray(65536)
            var remaining=durableBytes-offset
            read@ while(remaining>0 && ids.size<limits.batchEvents) {
                val count=input.read(buffer,0,minOf(remaining,buffer.size.toLong()).toInt())
                if(count<0) throw IOException("Journal changed")
                remaining-=count
                for(index in 0 until count) {
                    val byte=buffer[index].toInt() and 255
                    line.write(byte)
                    if(line.size()>limits.batchBytes) throw IOException("Event too large")
                    if(byte==10) {
                        if(body.size()+line.size()>limits.batchBytes) break@read
                        val bytes=line.toByteArray();ids.add(JSONObject(bytes.toString(Charsets.UTF_8)).getString("event_id"));body.write(bytes);line.reset()
                        if(ids.size==limits.batchEvents) break@read
                    }
                }
            }
        }
        if (ids.isEmpty()) return null
        return Batch(body.toByteArray(), ids, offset, offset + body.size(), scope.generation, scope.identity, boundary(offset+body.size()))
    }
    private fun send() {
        val (scope,route) = synchronized(mutex) {
            timer=null
            if(closed || rejected || sending || connection==null || transport==null) return
            sending=true
            ReadScope(offset,durableBytes,generation,identity) to (connection!! to transport!!)
        }
        val batch=runCatching { disk.submit<Batch?> { batch(scope) }.get() }.getOrElse {
            synchronized(mutex) { sending=false;rejected=true;mutex.notifyAll() };report("Journal invalid; capture retained");return
        }
        if(batch==null) { synchronized(mutex) { sending=false;if(offset<durableBytes) schedule(0);mutex.notifyAll() };return }
        val response = runCatching { route.second.upload(batch.bytes) }.getOrNull()
        val ackOK = response?.status == 200 && validAck(response.body, batch.ids, route.first)
        val replaced=java.util.concurrent.atomic.AtomicBoolean(false)
        val saved = if (ackOK) runCatching { disk.submit { synchronized(routeFence) {
            if (synchronized(mutex) { closed || generation != batch.generation }) throw IOException("Stale route")
            if (fileIdentity() != batch.identity || file.length() < batch.end || boundary(batch.end)!=batch.boundary) { replaced.set(true);throw IOException("Journal replaced") }
            persist(batch.end, route.first)
        } }.get() }.isSuccess else false
        synchronized(mutex) {
            sending = false
            if (closed || generation != batch.generation) { schedule(0); mutex.notifyAll(); return }
            if (ackOK) {
                try {
                    if (!saved && !replaced.get()) throw IOException("Cursor failed")
                    if (replaced.get()) { offset=0;durableBytes=file.length();admittedBytes=durableBytes;identity=fileIdentity() }
                    else offset = batch.end
                    failures = 0; schedule(0)
                } catch (_: Exception) { rejected = true; report("Cursor persistence failed; replay retained") }
            } else if (response != null && response.status in 400..499 && response.status !in listOf(408,429)) { rejected = true; report("Collector rejected capture; retained") }
            else { failures++; schedule(minOf(limits.maximumRetryMs, limits.initialRetryMs * (1L shl minOf(failures - 1, 16)))) }
            mutex.notifyAll()
        }
    }
    private fun validAck(bytes: ByteArray, ids: List<String>, route: TransferConnection): Boolean = runCatching {
        require(bytes.size <= MAX_ACK_BYTES); val ack = JSONObject(bytes.toString(Charsets.UTF_8))
        require(ack.getInt("version") == 2 && ack.getString("collector_id") == route.collectorId && ack.getString("source_id") == route.sourceId)
        require(ack.getInt("accepted") + ack.getInt("duplicates") == ids.size && ack.getLong("cursor") >= 0)
        val list = ack.getJSONArray("acknowledged_event_ids")
        require(list.length() == ids.size); (0 until list.length()).map(list::getString).toSet() == ids.toSet()
    }.getOrDefault(false)
    private fun persist(position: Long, route: TransferConnection) = atomic(File(file.path + ".cursor.json"), obj("version" to 2,
        "scope" to route.scope, "journal_id" to journalId, "identity" to identity, "offset" to position,
        "boundary" to boundary(position)).toString(),diskIO)
    private fun boundary(position: Long): String = RandomAccessFile(file,"r").use { f ->
        val size = minOf(position,64).toInt(); f.seek(position-size); val bytes=ByteArray(size); f.readFully(bytes); sha256(bytes) }
    private fun restoredOffset(route:TransferConnection?):Long {
        if(route==null) return 0
        return runCatching {
            val state=File(file.path+".cursor.json");require(state.length()<=16384);val v=JSONObject(state.readText())
            val candidate=v.getLong("offset");val end=synchronized(mutex) { durableBytes }
            require(v.getInt("version")==2 && v.getString("scope")==route.scope && v.getString("journal_id")==journalId && v.getString("identity")==identity && candidate in 0..end && v.getString("boundary")==boundary(candidate));candidate
        }.getOrDefault(0L)
    }
    private fun restore() { offset=restoredOffset(connection) }
    private fun fileIdentity() = Files.readAttributes(file.toPath(),BasicFileAttributes::class.java).let { "${it.fileKey()}:${it.creationTime().toMillis()}" }
    /** Rebind preserves the canonical writer; late ACKs cannot advance the new route. */
    fun rebind(next:TransferConnection?) { synchronized(routeFence) {
        synchronized(mutex) {
            generation++;timer?.cancel(false);timer=null;transport?.cancel();connection=next;transport=next?.let(::HttpEventTransport)
            rejected=false;failures=0;offset=0
        }
        // Config/cursor reads can stall this worker, never the capture admission lock.
        val restored=restoredOffset(next)
        synchronized(mutex) { offset=restored;schedule(0) }
    } }
    fun retryNow() = synchronized(mutex) { rejected=false; timer?.cancel(false); timer=null; schedule(0) }
    fun pendingBytes(): Long = synchronized(mutex) { admittedBytes-offset }
    fun awaitUploaded(timeoutMs: Long): Boolean {
        flush().get(timeoutMs,TimeUnit.MILLISECONDS)
        val end=System.nanoTime()+TimeUnit.MILLISECONDS.toNanos(timeoutMs)
        synchronized(mutex) { schedule(0); while (!closed && !rejected && offset < durableBytes) { val left=end-System.nanoTime(); if(left<=0) return false; TimeUnit.NANOSECONDS.timedWait(mutex,left) }; return offset==durableBytes }
    }
    override fun close() {
        synchronized(mutex) { if(closed) return; closed=true; generation++; timer?.cancel(false); transport?.cancel() }
        // No lock is released while queued file jobs are still alive.
        val failure=runCatching { flushInternal().get() }.exceptionOrNull()
        val publicationFailure=try {
            runCatching { disk.submit {
                try { publicationTimer?.cancel(false);publicationTimer=null;publish() }
                finally { try { output.close() } finally { writerLock.release();lockFile.close() } }
            }.get() }.exceptionOrNull()
        } finally { disk.shutdown();network.shutdownNow() }
        if(failure!=null || publicationFailure!=null) throw IOException("Journal close failed; retained capture needs inspection")
    }
    private fun report(message:String) { runCatching { diagnostic(message) } }
    internal companion object {
        internal fun eventBudget(event:JSONObject):Long {
            fun budget(value:Any?):Long=when(value) {
                null,JSONObject.NULL -> 4
                is String -> 2+value.sumOf { c -> when { c=='"' || c=='\\' || c=='/' -> 2L;c.code<32 || c.code in 0x80..0x9f || c.code in 0x2000..0x20ff -> 6L;c.code<128 -> 1L;c.code<2048 -> 2L;else -> 3L } }
                is JSONObject -> 2+value.keys().asSequence().sumOf { budget(it)+budget(value.opt(it))+2 }
                is org.json.JSONArray -> 2+(0 until value.length()).sumOf { budget(value.opt(it))+1 }
                else -> value.toString().length.toLong()+1
            }
            return budget(event)+1
        }
        fun atomic(file:File,value:String,diskIO:JournalDiskIO=SystemJournalDiskIO) {
            val temp=File(file.path+".tmp")
            if(Files.exists(temp.toPath(),java.nio.file.LinkOption.NOFOLLOW_LINKS) && !Files.isRegularFile(temp.toPath(),java.nio.file.LinkOption.NOFOLLOW_LINKS)) throw IOException("Unsafe journal publication temp")
            FileOutputStream(temp).use {
                it.write(value.toByteArray());diskIO.atomicBoundary(file,AtomicPublicationBoundary.TEMP_WRITTEN)
                it.fd.sync();diskIO.atomicBoundary(file,AtomicPublicationBoundary.TEMP_SYNCED)
            }
            Files.move(temp.toPath(),file.toPath(),StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING)
            diskIO.atomicBoundary(file,AtomicPublicationBoundary.RENAMED)
            java.nio.channels.FileChannel.open(requireNotNull(file.parentFile).toPath(),java.nio.file.StandardOpenOption.READ).use { it.force(true) }
            diskIO.atomicBoundary(file,AtomicPublicationBoundary.DIRECTORY_SYNCED)
        }
        fun testing(file:File,connection:TransferConnection?,transport:EventTransport?,limits:TransferLimits=TransferLimits(),diskIO:JournalDiskIO=SystemJournalDiskIO,diagnostic:(String)->Unit={}) = FileHttpEventSink(file,connection,limits,diagnostic,transport,diskIO)
    }
}
