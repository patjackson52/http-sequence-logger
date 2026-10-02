#if DEBUG
import Foundation
import Darwin

/// Default installation bootstrap. Wire this only in a debug target. The app supplies sanitized capture events.
public actor DebugCapture {
    public nonisolated let captureURL:URL
    public nonisolated let journalID:String
    private let root:URL;private let installation:String;private let appID:String;private let instance=UUID().uuidString
    private var sink:NDJSONTransferSink
    private let budget:InstallationJournalBudget
    private var paths:[URL]
    private var generationBytes=0
    private var queuedBytes=0
    private var tail:Task<Void,Error>?
    private var failed=false
    private var refreshingTask:Task<Void,Never>?
    private var refreshingGeneration=0
    private var refreshingSelection=0
    private var barriers=0
    private var selectionEpoch=0
    private var registrationRequest:@Sendable (TransferConnection,Data) async throws ->UploadResponse = { connection,bytes in
        let transport=CollectorTransport(connection:connection);defer { transport.close() }
        return try await transport.request("register",bytes:bytes)
    }
    func setRegistrationRequester(_ request:@escaping @Sendable (TransferConnection,Data) async throws ->UploadResponse) { registrationRequest=request }
    private var historical:NDJSONTransferSink?
    private var historyIndex=0
    private let disk=DispatchQueue(label:"NetworkLogTransfer.bootstrap")
    private var polling:Task<Void,Never>?
    private var selected:TransferConnection?
    private var lastPresence=Date.distantPast
    private var closed=false

    private init(root:URL,installation:String,appID:String,journalID:String,sink:NDJSONTransferSink,budget:InstallationJournalBudget,paths:[URL]) {
        self.root=root;self.installation=installation;self.appID=appID;self.journalID=journalID;self.sink=sink;self.budget=budget;self.paths=paths
        captureURL=root.appendingPathComponent("journals/\(journalID)/capture.ndjson")
    }
    public static func start(appID:String?=nil,directory:URL?=nil,journalLimits:NativeJournalLimits=NativeJournalLimits()) async throws -> DebugCapture {
        guard let app=appID ?? Bundle.main.bundleIdentifier,!app.isEmpty,app.utf8.count<=512 else { throw TransferError.invalidConnection }
        let root=directory ?? FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0].appendingPathComponent("HTTPSequenceLogger")
        let installation:String=try await withCheckedThrowingContinuation { c in DispatchQueue.global(qos:.utility).async {
            do {
                if !FileManager.default.fileExists(atPath:root.path) { try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700]) }
                let fd=Darwin.open(root.appendingPathComponent("installation.lock").path,O_CREAT|O_RDWR,0o600)
                guard fd>=0,flock(fd,LOCK_EX)==0 else { throw TransferError.storageFailure };defer { Darwin.close(fd) }
                if try root.resourceValues(forKeys:[.isExcludedFromBackupKey]).isExcludedFromBackup != true {
                    var excluded=root;var values=URLResourceValues();values.isExcludedFromBackup=true;try excluded.setResourceValues(values)
                }
                let identity=root.appendingPathComponent("installation-id")
                let id:String
                if FileManager.default.fileExists(atPath:identity.path) { id=try String(contentsOf:identity,encoding:.utf8);guard UUID(uuidString:id) != nil else { throw TransferError.storageFailure } }
                else { id=UUID().uuidString;try atomicWrite(Data(id.utf8),to:identity) }
                try FileManager.default.createDirectory(at:root.appendingPathComponent("journals"),withIntermediateDirectories:true)
                try atomicWrite(JSONSerialization.data(withJSONObject:["version":2,"platform":"ios","app_id":app,"installation_id":id,"journal_directory":"journals"]),to:root.appendingPathComponent("source.json"))
                let journals=try FileManager.default.contentsOfDirectory(at:root.appendingPathComponent("journals"),includingPropertiesForKeys:nil)
                guard journals.count<128 else { throw TransferError.spoolFull }
                c.resume(returning:id)
            } catch { c.resume(throwing:error) }
        } }
        let budget=try InstallationJournalBudget(root:root,limits:journalLimits)
        let opened:(NDJSONTransferSink,URL,[URL])=try await withCheckedThrowingContinuation { c in DispatchQueue.global(qos:.utility).async {
            do { let sink=try budget.openGeneration { directory in try NDJSONTransferSink(spoolDirectory:directory,limits:Self.transferLimits(journalLimits)) };c.resume(returning:(sink,sink.captureURL.deletingLastPathComponent(),try budget.captures().filter { $0.standardizedFileURL.path != sink.captureURL.standardizedFileURL.path }+[sink.captureURL])) }
            catch { c.resume(throwing:error) }
        } }
        let capture=DebugCapture(root:root,installation:installation,appID:app,journalID:opened.1.lastPathComponent,sink:opened.0,budget:budget,paths:opened.2)
        await capture.activate();return capture
    }
    private func activate() { polling=Task { [weak self] in
        while !Task.isCancelled { await self?.refresh();do { try await Task.sleep(nanoseconds:1_000_000_000) } catch { return } }
    } }
    /// All retained canonical generations, including prior launches. Export these paths together.
    public var captureURLs:[URL] { paths }
    public var currentCaptureURL:URL { sink.captureURL }
    public func appendSanitizedLine(_ line:String) throws {
        guard !closed else { throw TransferError.closed };guard !failed else { throw TransferError.storageFailure }
        let event=try EventLine.parse(line,maximumBytes:min(budget.limits.generationBytes,1_048_576))
        guard queuedBytes+sink.queuedBytes+event.bytes.count<=2*1024*1024 else { throw TransferError.spoolFull }
        queuedBytes+=event.bytes.count
        let previous=tail
        tail=Task {
            do { if let previous { try await previous.value } } catch { queuedBytes-=event.bytes.count;throw error }
            try await self.write(line,bytes:event.bytes.count)
        }
    }
    private func write(_ line:String,bytes:Int) async throws {
        defer { queuedBytes-=bytes }
        do {
            if generationBytes+bytes>budget.limits.generationBytes {
                let old=sink;await old.close();let budget=self.budget
                try await storage { try budget.seal(old.captureURL) }
                let next=try await storage { try budget.openGeneration { directory in try NDJSONTransferSink(spoolDirectory:directory,limits:Self.transferLimits(budget.limits)) } }
                sink=next;generationBytes=0;paths.append(next.captureURL)
                if let selected { try await next.rebind(selected) }
            }
            try await sink.appendSanitizedLine(line);generationBytes+=bytes
        } catch { failed=true;throw error }
    }
    private static func transferLimits(_ limits:NativeJournalLimits)->TransferLimits {
        var result=TransferLimits();result.maximumSpoolBytes=limits.generationBytes;result.maximumBatchBytes=min(1_048_576,limits.generationBytes);return result
    }
    /// Persistence barrier for records admitted before this call; collector availability is independent.
    public func flush() async throws {
        guard !closed else { throw TransferError.closed };guard barriers<64 else { throw TransferError.spoolFull }
        barriers+=1;defer { barriers-=1 };let previous=tail
        let barrier=Task { if let previous { try await previous.value };try await self.persistCurrent() }
        tail=barrier;try await barrier.value
    }
    private func persistCurrent() async throws { try await sink.flush() }
    @discardableResult public func deliverNow() async -> TransferStatus { try? await flush();return await sink.deliverNow() }
    public func status() async -> TransferStatus {
        if closed { return TransferStatus(state:.closed,pendingBytes:0,diagnostic:nil,lastHTTPStatus:nil) }
        if failed { return TransferStatus(state:.blocked,pendingBytes:queuedBytes,diagnostic:"journal_write_failed",lastHTTPStatus:nil) }
        return await sink.status()
    }
    public func savePairing(_ json:Data) async throws {
        guard json.count<=16384,let value=(try? JSONSerialization.jsonObject(with:json)) as? [String:Any],value["version"] as? Int==2 else { throw TransferError.invalidConnection }
        if value["source_token"] != nil { _=try TransferConnection.parse(json:json) }
        else { _=try Self.provisional(value) }
        guard !closed else { throw TransferError.closed };selectionEpoch+=1
        let url=root.appendingPathComponent("pairing.json");try await storage { try Self.installationLocked(root:url.deletingLastPathComponent()) { try atomicWrite(json,to:url) } };await refresh()
    }
    public func close() async {
        if closed { return };closed=true;let activePolling=polling;let activeRefresh=refreshingTask;activePolling?.cancel();activeRefresh?.cancel();polling=nil
        await activeRefresh?.value;await activePolling?.value;refreshingTask=nil
        if let tail { _=try? await tail.value }
        await sink.close();await historical?.close();historical=nil
        let budget=self.budget;let file=sink.captureURL;try? await storage { try budget.seal(file) }
    }
    /// Call on foreground resume as well as normal polling. No background delivery promise is made.
    public func refresh() async {
        while !closed {
            let task:Task<Void,Never>;let generation:Int;let epoch:Int
            if let active=refreshingTask { task=active;generation=refreshingGeneration;epoch=refreshingSelection }
            else {
                refreshingGeneration+=1;generation=refreshingGeneration;epoch=selectionEpoch;refreshingSelection=epoch
                task=Task { await self.refreshOnce(epoch:epoch) };refreshingTask=task
            }
            await task.value
            if refreshingGeneration==generation { refreshingTask=nil }
            if epoch==selectionEpoch { return }
        }
    }
    private func refreshOnce(epoch:Int) async {
        guard !closed else { return }
        do {
            let root=self.root;let journal=self.journalID
            let configuration:Data?=try await storage { let manual=root.appendingPathComponent("pairing.json");let file=FileManager.default.fileExists(atPath:manual.path) ? manual : root.appendingPathComponent("pairing-local.json");guard FileManager.default.fileExists(atPath:file.path) else { return nil };let data=try Data(contentsOf:file);guard data.count<=16384 else { throw TransferError.invalidConnection };return data }
            guard !closed,epoch==selectionEpoch else { return }
            guard let configuration else { if selected != nil { try await sink.rebind(nil);selected=nil };return }
            guard let value=(try? JSONSerialization.jsonObject(with:configuration)) as? [String:Any] else { throw TransferError.invalidConnection }
            var connection:TransferConnection
            if value["source_token"] != nil { connection=try TransferConnection.parse(json:configuration) }
            else {
                let provision=try Self.provisional(value)
                let local=root.appendingPathComponent("journals/\(journal)/connection.json")
                let retained:Data?=try await storage { try? Data(contentsOf:local) }
                if let retained,let saved=try? TransferConnection.parse(json:retained),saved.collectorID==provision.collectorID { connection=saved }
                else {
                    let operation=root.appendingPathComponent("journals/\(journal)/registration-id")
                    let id:String=try await storage { if let saved=try? String(contentsOf:operation,encoding:.utf8) { return saved };let id=UUID().uuidString;try atomicWrite(Data(id.utf8),to:operation);return id }
                    let metadata:[String:Any] = ["version":2,"registration_id":id,"platform":"ios","environment_id":value["environment_id"] ?? installation,
                        "environment_name":value["environment_name"] ?? "iOS","app_id":appID,"installation_id":installation,"journal_id":journal,"instance_id":instance]
                    let response=try await registrationRequest(provision,JSONSerialization.data(withJSONObject:metadata))
                    guard response.status==200,var result=(try? JSONSerialization.jsonObject(with:response.body)) as? [String:Any] else { throw TransferError.invalidConnection }
                    result["certificate_sha256"]=value["certificate_sha256"]
                    connection=try TransferConnection.parse(json:JSONSerialization.data(withJSONObject:result))
                    let encoded=try connection.encoded();try await storage { try atomicWrite(encoded,to:local) }
                }
            }
            guard !closed,epoch==selectionEpoch else { return }
            if value["enrollment_token"] != nil {
                let encoded=try connection.encoded()
                try await storage {
                    try Self.installationLocked(root:root) {
                        let manual=root.appendingPathComponent("pairing.json")
                        guard (try? Data(contentsOf:manual))==configuration else { throw TransferError.invalidConnection }
                        try atomicWrite(encoded,to:manual)
                    }
                }
            }
            guard !closed,epoch==selectionEpoch else { return }
            if try selected?.encoded() != connection.encoded() {
                try await sink.rebind(connection)
                if let historical { try await historical.rebind(connection) }
                guard !closed else { return }
                selected=connection
            }
            // One historical disk/network owner at a time keeps retained replay bounded.
            if historical==nil,historyIndex<paths.count-1 {
                let historicalConnection=connection;let path=paths[historyIndex].deletingLastPathComponent();let limits=Self.transferLimits(budget.limits)
                historical=try? await storage { try NDJSONTransferSink(connection:historicalConnection,spoolDirectory:path,limits:limits) }
                if historical==nil { historyIndex+=1 }
            }
            if let historical {
                let status=await historical.deliverNow()
                if closed { await historical.close();self.historical=nil;return }
                if status.pendingBytes==0 { await historical.close();self.historical=nil;historyIndex+=1 }
            }
            if Date().timeIntervalSince(lastPresence)>=10 {
                let transport=CollectorTransport(connection:connection);defer { transport.close() }
                _=try await transport.request("presence",bytes:JSONSerialization.data(withJSONObject:["version":2,"instance_id":instance]));lastPresence=Date()
            }
        } catch { /* Fixed sink diagnostics expose backlog. Never publish credentials or error payloads. */ }
    }
    private static func provisional(_ value:[String:Any]) throws -> TransferConnection {
        guard let token=value["enrollment_token"] as? String else { throw TransferError.invalidConnection }
        var wire=value;wire["source_token"]=token;wire["source_id"]="enrollment"
        return try TransferConnection.parse(json:JSONSerialization.data(withJSONObject:wire))
    }
    private static func installationLocked<T>(root:URL,_ action:() throws ->T) throws ->T {
        let fd=Darwin.open(root.appendingPathComponent("installation.lock").path,O_CREAT|O_RDWR,0o600)
        guard fd>=0,flock(fd,LOCK_EX)==0 else { if fd>=0 { Darwin.close(fd) };throw TransferError.storageFailure }
        defer { Darwin.close(fd) };return try action()
    }
    private func storage<T:Sendable>(_ action:@escaping @Sendable () throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { c in disk.async { do { c.resume(returning:try action()) } catch { c.resume(throwing:error) } } }
    }
}
#endif
