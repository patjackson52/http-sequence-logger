package dev.networklog.logger

import android.content.Context
import android.content.pm.ApplicationInfo
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import java.io.Closeable
import java.util.ArrayDeque

/** Untrusted DNS-SD labels only. Selecting a candidate still requires an explicitly supplied pairing/ticket and TLS pin. */
data class CollectorCandidate(val serviceName: String, val collectorId: String, val hostname: String, val port: Int)

/** Internal platform boundary; tests exercise the same Android listener callbacks as the real manager. */
internal interface NsdOperations {
    fun discover(listener: NsdManager.DiscoveryListener)
    fun resolve(info: NsdServiceInfo, listener: NsdManager.ResolveListener)
    fun stop(listener: NsdManager.DiscoveryListener)
    fun name(info: NsdServiceInfo): String
    fun candidate(info: NsdServiceInfo): CollectorCandidate?
}

private class AndroidNsdOperations(context: Context) : NsdOperations {
    // Permission failure during service acquisition is handled by the same startup boundary.
    private val manager by lazy { context.getSystemService(Context.NSD_SERVICE) as NsdManager }
    override fun discover(listener: NsdManager.DiscoveryListener) =
        manager.discoverServices("_nlog._tcp.", NsdManager.PROTOCOL_DNS_SD, listener)
    @Suppress("DEPRECATION")
    override fun resolve(info: NsdServiceInfo, listener: NsdManager.ResolveListener) = manager.resolveService(info, listener)
    override fun stop(listener: NsdManager.DiscoveryListener) = manager.stopServiceDiscovery(listener)
    override fun name(info: NsdServiceInfo): String = info.serviceName
    override fun candidate(info: NsdServiceInfo): CollectorCandidate? {
        val version = info.attributes["version"]?.toString(Charsets.UTF_8)
        val id = info.attributes["collector_id"]?.toString(Charsets.UTF_8)
        val host = info.attributes["hostname"]?.toString(Charsets.UTF_8)
        return if (version == "2" && id != null && id.length in 1..512 && host != null &&
            host.matches(Regex("[A-Za-z0-9.-]{1,253}")) && info.port in 1..65535)
            CollectorCandidate(info.serviceName, id, host, info.port) else null
    }
}

class CollectorDiscovery internal constructor(
    private val operations: NsdOperations,
    private val changed: (List<CollectorCandidate>) -> Unit,
    private val diagnostic: (String) -> Unit,
) : Closeable {
    constructor(context: Context, changed: (List<CollectorCandidate>) -> Unit, diagnostic: (String) -> Unit = {}) :
        this(debugOperations(context), changed, diagnostic)

    private class Generation(val name: String, val info: NsdServiceInfo)
    private val gate = Any()
    private val callbacks = Any()
    private val discovered = linkedMapOf<String, Generation>()
    private val candidates = linkedMapOf<String, CollectorCandidate>()
    private val pending = ArrayDeque<Generation>()
    private var active: Generation? = null
    private var closed = false
    private var accepting = true
    private var revision = 0L

    private val listener = object : NsdManager.DiscoveryListener {
        override fun onDiscoveryStarted(type: String) {}
        override fun onDiscoveryStopped(type: String) { unavailable(notify = false) }
        override fun onStartDiscoveryFailed(type: String, error: Int) { unavailable(notify = true) }
        override fun onStopDiscoveryFailed(type: String, error: Int) {}
        override fun onServiceFound(info: NsdServiceInfo) {
            val name = operations.name(info)
            if (name.length !in 1..512) return
            val publication = synchronized(gate) {
                if (closed || !accepting || (name !in discovered && discovered.size >= 100)) return
                val generation = Generation(name, info)
                discovered[name] = generation
                pending.removeAll { it.name == name }
                pending.addLast(generation)
                if (candidates.remove(name) != null) snapshot() else null
            }
            publish(publication)
            resolveNext()
        }
        override fun onServiceLost(info: NsdServiceInfo) {
            val name = operations.name(info)
            val publication = synchronized(gate) {
                if (closed || !accepting) return
                discovered.remove(name)
                pending.removeAll { it.name == name }
                if (candidates.remove(name) != null) snapshot() else null
            }
            publish(publication)
        }
    }

    init {
        try { operations.discover(listener) }
        catch (_: RuntimeException) { unavailable(notify = true) }
    }

    private fun unavailable(notify: Boolean) {
        val publication = synchronized(gate) {
            if (closed) return
            accepting = false
            discovered.clear()
            pending.clear()
            active = null
            val hadCandidates = candidates.isNotEmpty()
            candidates.clear()
            if (hadCandidates) snapshot() else null
        }
        publish(publication)
        if (notify) diagnose()
    }

    private fun resolveNext() {
        val generation = synchronized(gate) {
            if (closed || !accepting || active != null) return
            var next: Generation? = null
            while (pending.isNotEmpty() && next == null) {
                val candidate = pending.removeFirst()
                if (discovered[candidate.name] === candidate) next = candidate
            }
            if (next == null) return
            active = next
            next
        }
        val resolver = object : NsdManager.ResolveListener {
            override fun onResolveFailed(info: NsdServiceInfo, error: Int) { completed(generation, null, failed = true) }
            override fun onServiceResolved(info: NsdServiceInfo) {
                if (synchronized(gate) { closed || !accepting || active !== generation }) return
                val candidate = try { operations.candidate(info) }
                catch (_: RuntimeException) { completed(generation, null, failed = true); return }
                completed(generation, candidate?.takeIf { it.serviceName == generation.name }, failed = false)
            }
        }
        // No platform calls or application callbacks run under the state mutex.
        if (synchronized(gate) { closed || !accepting || active !== generation }) return
        try { operations.resolve(generation.info, resolver) }
        catch (_: RuntimeException) { completed(generation, null, failed = true) }
    }

    private fun completed(generation: Generation, candidate: CollectorCandidate?, failed: Boolean) {
        var currentFailure = false
        val publication = synchronized(gate) {
            // Duplicate/stale completions must not release a newer resolver's slot.
            if (active !== generation) return
            active = null
            if (closed || !accepting) return
            if (discovered[generation.name] !== generation) null
            else if (candidate == null) {
                discovered.remove(generation.name)
                currentFailure = failed
                if (candidates.remove(generation.name) != null) snapshot() else null
            } else {
                candidates[generation.name] = candidate
                snapshot()
            }
        }
        publish(publication)
        if (currentFailure) diagnose()
        resolveNext()
    }

    private data class Publication(val revision: Long, val candidates: List<CollectorCandidate>)
    private fun snapshot(): Publication = Publication(++revision, candidates.values.toList())
    private fun publish(publication: Publication?) {
        if (publication == null) return
        synchronized(callbacks) {
            if (synchronized(gate) { closed || revision != publication.revision }) return
            runCatching { changed(publication.candidates) }
        }
    }
    private fun diagnose() {
        synchronized(callbacks) {
            if (synchronized(gate) { closed }) return
            runCatching { diagnostic("Local discovery unavailable; use manual pairing") }
        }
    }

    override fun close() {
        synchronized(callbacks) {
            synchronized(gate) {
                if (closed) return
                closed = true
                accepting = false
                pending.clear()
                active = null
                candidates.clear()
                discovered.clear()
            }
        }
        runCatching { operations.stop(listener) }
    }

    private companion object {
        fun debugOperations(context: Context): NsdOperations {
            check(context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
            return AndroidNsdOperations(context)
        }
    }
}
