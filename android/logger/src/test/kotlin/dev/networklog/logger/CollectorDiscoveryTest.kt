package dev.networklog.logger

import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import org.junit.Assert.*
import org.junit.Test
import java.util.IdentityHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class CollectorDiscoveryTest {
    private class Port : NsdOperations {
        lateinit var discovery: NsdManager.DiscoveryListener
        val resolutions = mutableListOf<Pair<NsdServiceInfo, NsdManager.ResolveListener>>()
        private val metadata = IdentityHashMap<NsdServiceInfo, Pair<String, CollectorCandidate?>>()
        var startupFailure: RuntimeException? = null
        var resolveFailure: RuntimeException? = null
        var stopCount = 0
        var decodeCount = 0
        var decoded: ((NsdServiceInfo) -> Unit)? = null
        override fun discover(listener: NsdManager.DiscoveryListener) {
            discovery = listener
            startupFailure?.let { throw it }
        }
        override fun resolve(info: NsdServiceInfo, listener: NsdManager.ResolveListener) {
            synchronized(resolutions) { resolutions.add(info to listener) }
            resolveFailure?.let { throw it }
        }
        override fun stop(listener: NsdManager.DiscoveryListener) { stopCount++ }
        override fun name(info: NsdServiceInfo): String = synchronized(metadata) { metadata.getValue(info).first }
        override fun candidate(info: NsdServiceInfo): CollectorCandidate? = synchronized(metadata) {
            decodeCount++
            decoded?.invoke(info)
            metadata.getValue(info).second
        }
        fun service(name: String, resolvedName: String = name, valid: Boolean = true): NsdServiceInfo =
            NsdServiceInfo().also { info -> synchronized(metadata) {
                metadata[info] = name to if (valid) CollectorCandidate(resolvedName, "collector", "mac.local", 4320) else null
            } }
        fun found(info: NsdServiceInfo) = discovery.onServiceFound(info)
        fun resolved(index: Int) { val (info, callback) = synchronized(resolutions) { resolutions[index] }; callback.onServiceResolved(info) }
        fun failed(index: Int) { val (info, callback) = synchronized(resolutions) { resolutions[index] }; callback.onResolveFailed(info, 7) }
    }

    // Inspect the actual retained inventory, rather than a separate modeled counter.
    private fun retained(discovery: CollectorDiscovery): Int {
        val field = CollectorDiscovery::class.java.getDeclaredField("discovered")
        field.isAccessible = true
        return (field.get(discovery) as Map<*, *>).size
    }

    @Test fun startupSecurityFailureAndThrowingDiagnosticLeaveManualFallbackUsable() {
        val port = Port().apply { startupFailure = SecurityException("permission") }
        var diagnostics = 0
        val discovery = CollectorDiscovery(port, { fail("No candidate expected") }, { diagnostics++; throw IllegalStateException("app callback") })
        assertEquals(1, diagnostics)
        port.found(port.service("late"))
        assertEquals(0, port.resolutions.size)
        discovery.close(); discovery.close()
        assertEquals(1, port.stopCount)
    }

    @Test fun asynchronousStartupFailureCodeSevenAlsoContainsDiagnosticExceptions() {
        val port = Port()
        var diagnostics = 0
        val discovery = CollectorDiscovery(port, {}, { diagnostics++; throw IllegalStateException() })
        port.found(port.service("first"))
        port.discovery.onStartDiscoveryFailed("_nlog._tcp.", 7)
        port.resolved(0)
        port.found(port.service("late"))
        assertEquals(1, diagnostics)
        assertEquals(0, retained(discovery))
        assertEquals(1, port.resolutions.size)
        assertEquals(0, port.decodeCount)
        discovery.close()
    }

    @Test fun synchronousResolveSecurityFailuresReleaseInventoryAndContainDiagnostic() {
        val port = Port().apply { resolveFailure = SecurityException("permission") }
        var diagnostics = 0
        val discovery = CollectorDiscovery(port, {}, { diagnostics++; throw IllegalStateException() })
        repeat(300) { port.found(port.service("denied-$it")); assertEquals(0, retained(discovery)) }
        assertEquals(300, diagnostics)
        port.resolveFailure = null
        // A normal subsequent resolve demonstrates that the resolver slot is not poisoned.
        port.found(port.service("allowed")); port.resolved(300)
        assertEquals(1, retained(discovery))
        discovery.close()
    }

    @Test fun retainedCapIncludesActiveAndPendingAndFailedGenerationsAreReleased() {
        val port = Port()
        val discovery = CollectorDiscovery(port, {}, {})
        repeat(150) { port.found(port.service("service-$it")) }
        assertEquals(100, retained(discovery))
        assertEquals(1, port.resolutions.size)
        repeat(100) { port.failed(it); assertTrue(retained(discovery) <= 100) }
        assertEquals(100, port.resolutions.size)
        assertEquals(0, retained(discovery))
        port.found(port.service("after-failures"))
        assertEquals(101, port.resolutions.size)
        discovery.close()
    }

    @Test fun replacementAndDuplicateOldCompletionCannotReleaseCurrentResolver() {
        val port = Port()
        val snapshots = mutableListOf<List<CollectorCandidate>>()
        val discovery = CollectorDiscovery(port, { snapshots.add(it) }, {})
        port.found(port.service("same"))
        val replacement = port.service("same")
        port.found(replacement)
        port.failed(0)
        assertSame(replacement, port.resolutions[1].first)
        port.found(port.service("next"))
        port.failed(0); port.resolved(0)
        assertEquals(2, port.resolutions.size)
        assertTrue(snapshots.isEmpty())
        port.resolved(1)
        assertEquals(listOf("same"), snapshots.last().map { it.serviceName })
        assertEquals(3, port.resolutions.size)
        discovery.close()
    }

    @Test fun mismatchedResolvedNameCannotEscapeAdmittedInventory() {
        val port = Port()
        val discovery = CollectorDiscovery(port, { fail("Mismatched candidate published") }, {})
        port.found(port.service("admitted", resolvedName = "different"))
        port.resolved(0)
        assertEquals(0, retained(discovery))
        discovery.close()
    }

    @Test fun lostServiceAndCloseFenceLateSuccessFailureAndFoundCallbacks() {
        val port = Port()
        val snapshots = mutableListOf<List<CollectorCandidate>>()
        var diagnostics = 0
        val discovery = CollectorDiscovery(port, { snapshots.add(it) }, { diagnostics++ })
        val first = port.service("lost")
        port.found(first); port.discovery.onServiceLost(first); port.resolved(0)
        assertTrue(snapshots.isEmpty())
        port.found(port.service("pending"))
        discovery.close()
        val decodes = port.decodeCount
        port.resolved(1); port.failed(1); port.found(port.service("closed"))
        port.discovery.onServiceLost(first); port.discovery.onStartDiscoveryFailed("_nlog._tcp.", 7)
        assertTrue(snapshots.isEmpty())
        assertEquals(0, diagnostics)
        assertEquals(decodes, port.decodeCount)
        assertEquals(0, retained(discovery))
    }

    @Test fun throwingChangedCallbackCannotStrandPendingResolve() {
        val port = Port()
        var publications = 0
        val discovery = CollectorDiscovery(port, { publications++; throw IllegalStateException() }, {})
        port.found(port.service("first")); port.found(port.service("second"))
        port.resolved(0); port.resolved(1)
        assertEquals(2, publications)
        assertEquals(2, port.resolutions.size)
        discovery.close()
    }

    @Test fun applicationCallbackDoesNotHoldStateMutexAcrossAnotherThread() {
        val port = Port()
        var callbackUnblocked = false
        val discovery = CollectorDiscovery(port, {
            val done = CountDownLatch(1)
            Thread { port.found(port.service("from-another-thread")); done.countDown() }.start()
            callbackUnblocked = done.await(1, TimeUnit.SECONDS)
        }, {})
        port.found(port.service("first")); port.resolved(0)
        assertTrue("Callback held discovery state lock", callbackUnblocked)
        assertEquals(2, port.resolutions.size)
        discovery.close()
    }

    @Test fun concurrentFindAndCloseRemainBoundedAndLateCallbacksCannotRestart() {
        val port = Port()
        val discovery = CollectorDiscovery(port, {}, {})
        val begin = CountDownLatch(1)
        val done = CountDownLatch(8)
        repeat(8) { worker -> Thread { begin.await(); repeat(100) { port.found(port.service("$worker-$it")) }; done.countDown() }.start() }
        begin.countDown()
        assertTrue(done.await(3, TimeUnit.SECONDS))
        assertEquals(100, retained(discovery))
        assertEquals(1, port.resolutions.size)
        discovery.close()
        port.resolved(0); port.failed(0)
        assertEquals(1, port.resolutions.size)
        assertEquals(0, retained(discovery))
    }

    @Test fun blockedPublicationCannotArriveAfterNewerPublication() {
        val port = Port()
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val finished = CountDownLatch(2)
        val newerEntered = CountDownLatch(1)
        val newerReturned = CountDownLatch(1)
        val snapshots = mutableListOf<List<String>>()
        val discovery = CollectorDiscovery(port, {
            if (it.size == 1) { entered.countDown(); assertTrue(release.await(2, TimeUnit.SECONDS)) }
            synchronized(snapshots) { snapshots.add(it.map { candidate -> candidate.serviceName }) }
        }, {})
        port.found(port.service("first"))
        Thread { port.resolved(0); finished.countDown() }.start()
        assertTrue(entered.await(1, TimeUnit.SECONDS))
        port.found(port.service("second"))
        port.decoded = { if (port.name(it) == "second") newerEntered.countDown() }
        Thread { port.resolved(1); newerReturned.countDown(); finished.countDown() }.start()
        assertTrue(newerEntered.await(1, TimeUnit.SECONDS))
        assertFalse("Newer callback returned while older publication was blocked", newerReturned.await(100, TimeUnit.MILLISECONDS))
        release.countDown()
        assertTrue(finished.await(2, TimeUnit.SECONDS))
        assertEquals(listOf(listOf("first"), listOf("first", "second")), snapshots)
        discovery.close()
    }

    @Test fun closeWaitsForCurrentCallbackAndSuppressesLateCallbacks() {
        val port = Port()
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val closed = CountDownLatch(1)
        var publications = 0
        val discovery = CollectorDiscovery(port, {
            entered.countDown(); assertTrue(release.await(2, TimeUnit.SECONDS)); publications++
        }, {})
        port.found(port.service("first"))
        Thread { port.resolved(0) }.start()
        assertTrue(entered.await(1, TimeUnit.SECONDS))
        Thread { discovery.close(); closed.countDown() }.start()
        assertFalse(closed.await(100, TimeUnit.MILLISECONDS))
        release.countDown()
        assertTrue(closed.await(2, TimeUnit.SECONDS))
        port.resolved(0); port.failed(0); port.found(port.service("late"))
        assertEquals(1, publications)
    }

    @Test fun reentrantChangedCloseAndSynchronousStopCallbackDoNotDeadlock() {
        val base = Port()
        val port = object : NsdOperations by base {
            override fun stop(listener: NsdManager.DiscoveryListener) {
                base.stop(listener)
                listener.onDiscoveryStopped("_nlog._tcp.")
            }
        }
        lateinit var discovery: CollectorDiscovery
        discovery = CollectorDiscovery(port, { discovery.close() }, {})
        base.found(base.service("first")); base.resolved(0)
        assertEquals(1, base.stopCount)
        assertEquals(0, retained(discovery))
    }
}
