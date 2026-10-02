package dev.networklog.logger

import java.io.FileOutputStream
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import java.util.concurrent.Semaphore
import java.util.concurrent.SynchronousQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/** Explicit bounded barrier admission: user continuations may wait for further disk work without owning its thread. */
internal object JournalCompletions {
    private val permits=Semaphore(64)
    private val executor=ThreadPoolExecutor(0,128,30,TimeUnit.SECONDS,SynchronousQueue(),{ Thread(it,"network-log-completion").apply { isDaemon=true } })
    fun reserve()=permits.tryAcquire()
    fun finish(future:CompletableFuture<Unit>,error:Exception?) {
        executor.execute { try { if(error==null) future.complete(Unit) else future.completeExceptionally(error) } finally { permits.release() } }
    }
}
internal enum class AtomicPublicationBoundary { TEMP_WRITTEN, TEMP_SYNCED, RENAMED, DIRECTORY_SYNCED }
internal interface JournalDiskIO {
    fun append(output:FileOutputStream,bytes:ByteArray)
    fun sync(output:FileOutputStream)
    fun atomicBoundary(target:java.io.File,boundary:AtomicPublicationBoundary) {}
}
internal object SystemJournalDiskIO:JournalDiskIO {
    override fun append(output:FileOutputStream,bytes:ByteArray) { output.write(bytes) }
    override fun sync(output:FileOutputStream) { output.flush();output.fd.sync() }
}
