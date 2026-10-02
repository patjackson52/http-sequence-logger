#if DEBUG
import Foundation

public struct CollectorCandidate:Sendable,Equatable {
    public let serviceName:String;public let collectorID:String;public let hostname:String;public let port:Int
}
/// Call start only after an explicit user discovery action. DNS-SD candidates never authorize enrollment or TLS trust.
@MainActor public final class CollectorBrowser:NSObject,@preconcurrency NetServiceBrowserDelegate,@preconcurrency NetServiceDelegate {
    private var browser:NetServiceBrowser?
    private var active=false
    private var services:[String:NetService]=[:]
    private var candidates:[String:CollectorCandidate]=[:]
    public var changed:([CollectorCandidate])->Void = { _ in }
    public var diagnostic:(String)->Void = { _ in }
    public override init() { super.init() }
    public func start() { stop();active=true;let next=NetServiceBrowser();browser=next;next.delegate=self;next.schedule(in:.main,forMode:.default);next.searchForServices(ofType:"_nlog._tcp.",inDomain:"local.") }
    public func stop() { active=false;browser?.delegate=nil;browser?.stop();browser?.remove(from:.main,forMode:.default);browser=nil;for service in services.values { service.delegate=nil;service.stop() };services.removeAll();candidates.removeAll();changed([]) }
    public func netServiceBrowser(_ browser:NetServiceBrowser,didFind service:NetService,moreComing:Bool) {
        guard active,self.browser===browser,services.count<100 else { return };services[service.name]?.stop();services[service.name]=service;service.delegate=self;service.schedule(in:.main,forMode:.default);service.resolve(withTimeout:5)
    }
    public func netServiceBrowser(_ browser:NetServiceBrowser,didRemove service:NetService,moreComing:Bool) {
        guard active,self.browser===browser,services[service.name]===service else { return }
        services.removeValue(forKey:service.name)?.stop();candidates.removeValue(forKey:service.name);changed(Array(candidates.values))
    }
    public func netServiceBrowser(_ browser:NetServiceBrowser,didNotSearch errorDict:[String:NSNumber]) { guard active,self.browser===browser else { return };diagnostic("Local discovery unavailable; use manual pairing") }
    public func netServiceDidResolveAddress(_ service:NetService) {
        guard active,services[service.name]===service,let data=service.txtRecordData() else { return };let txt=NetService.dictionary(fromTXTRecord:data)
        guard let version=txt["version"],String(decoding:version,as:UTF8.self)=="2",let id=txt["collector_id"],id.count>0,id.count<=512,
            let host=txt["hostname"],host.count>0,host.count<=253,(1...65535).contains(service.port) else { return }
        let hostname=String(decoding:host,as:UTF8.self)
        guard hostname.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0=="-" || $0==".") }) else { return }
        candidates[service.name]=CollectorCandidate(serviceName:service.name,collectorID:String(decoding:id,as:UTF8.self),hostname:hostname,port:service.port)
        changed(Array(candidates.values))
    }
    public func netService(_ sender:NetService,didNotResolve errorDict:[String:NSNumber]) { guard active,services[sender.name]===sender else { return };diagnostic("Collector resolution failed; use manual pairing") }
}
#endif
