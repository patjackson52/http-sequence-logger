package dev.networklog.logger

import android.content.Context
import android.content.pm.ApplicationInfo
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import java.io.Closeable

/** Untrusted DNS-SD labels only. Selecting a candidate still requires an explicitly supplied pairing/ticket and TLS pin. */
data class CollectorCandidate(val serviceName:String,val collectorId:String,val hostname:String,val port:Int)
class CollectorDiscovery(context:Context,private val changed:(List<CollectorCandidate>)->Unit,private val diagnostic:(String)->Unit={}) : Closeable {
    private val manager=context.getSystemService(Context.NSD_SERVICE) as NsdManager
    private val gate=Any();private val candidates=linkedMapOf<String,CollectorCandidate>()
    private var closed=false;private var resolving=false
    private val discovered=linkedMapOf<String,NsdServiceInfo>()
    private val pending=java.util.ArrayDeque<NsdServiceInfo>()
    private val listener=object:NsdManager.DiscoveryListener {
        override fun onDiscoveryStarted(type:String) { }
        override fun onDiscoveryStopped(type:String) { }
        override fun onStartDiscoveryFailed(type:String,error:Int) { synchronized(gate) { if(!closed) diagnostic("Local discovery unavailable; use manual pairing") } }
        override fun onStopDiscoveryFailed(type:String,error:Int) { }
        override fun onServiceFound(info:NsdServiceInfo) { synchronized(gate) { if(!closed && pending.size+candidates.size<100) { discovered[info.serviceName]=info;pending.removeAll { it.serviceName==info.serviceName };pending.add(info);resolveNext() } } }
        override fun onServiceLost(info:NsdServiceInfo) { synchronized(gate) { if(closed) return;discovered.remove(info.serviceName);pending.removeAll { it.serviceName==info.serviceName };candidates.remove(info.serviceName);emit() } }
    }
    init { check(context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
        manager.discoverServices("_nlog._tcp.",NsdManager.PROTOCOL_DNS_SD,listener) }
    @Suppress("DEPRECATION") private fun resolveNext() {
        if(closed || resolving || pending.isEmpty()) return
        resolving=true
        val discoveredService=pending.removeFirst()
        manager.resolveService(discoveredService,object:NsdManager.ResolveListener {
            override fun onResolveFailed(info:NsdServiceInfo,error:Int) { synchronized(gate) { resolving=false;resolveNext() } }
            override fun onServiceResolved(info:NsdServiceInfo) { synchronized(gate) {
                resolving=false
                val version=info.attributes["version"]?.toString(Charsets.UTF_8)
                val id=info.attributes["collector_id"]?.toString(Charsets.UTF_8)
                val hostname=info.attributes["hostname"]?.toString(Charsets.UTF_8)
                if(!closed && discovered[discoveredService.serviceName]===discoveredService && version=="2" && id!=null && id.length in 1..512 && hostname!=null && hostname.matches(Regex("[A-Za-z0-9.-]{1,253}")) && info.port in 1..65535) {
                    candidates[info.serviceName]=CollectorCandidate(info.serviceName,id,hostname,info.port);emit()
                }
                resolveNext()
            } }
        })
    }
    private fun emit() { runCatching { changed(candidates.values.toList()) } }
    override fun close() { synchronized(gate) { if(closed) return;closed=true;pending.clear();candidates.clear();discovered.clear() };runCatching { manager.stopServiceDiscovery(listener) } }
}
