#if DEBUG
import Foundation
import Darwin

struct EventLine: Sendable {
    let id: String; let bytes: Data
    static func parse(_ line: String, maximumBytes: Int) throws -> EventLine {
        var text=line; if text.hasSuffix("\n") { text.removeLast(); if text.hasSuffix("\r") { text.removeLast() } }
        guard text.utf8.count+1<=maximumBytes else { throw TransferError.eventTooLarge }
        guard !text.contains("\n"), !text.contains("\r"), let raw=text.data(using:.utf8),
            let object=(try? JSONSerialization.jsonObject(with:raw)) as? [String:Any], object["schema_version"] as? String == "1.3",
            let id=object["event_id"] as? String, !id.isEmpty, object["event_type"] is String, object["data"] is [String:Any] else { throw TransferError.invalidEvent }
        return EventLine(id:id,bytes:raw+Data([10]))
    }
}

/// One canonical journal, a bounded admission queue, one serial disk owner. ACK never deletes records.
final class DurableSpool: @unchecked Sendable {
    struct Batch: Sendable { let bytes:Data; let ids:[String]; let endOffset:Int }
    struct Cursor: Codable { let version:Int; let scope:String; let journal:String; let identity:String; let offset:Int; let boundary:String }
    let fileURL:URL
    let journalID:String
    private let cursorURL:URL; private let metadataURL:URL; private var scope:String; private let limits:TransferLimits
    private let io=DispatchQueue(label:"NetworkLogTransfer.journal")
    private let gate=NSLock()
    private var pending:[EventLine]=[]; private var admitted=0; private var queued=0; private var isClosed=false
    private var failed=false; private var scheduled=false;private var immediateScheduled=false;private var controls=0
    private let diskIO:any JournalDiskIO
    private var publication:DispatchWorkItem?
    private var publishedBytes=0
    private var publishedAt=DispatchTime.now().uptimeNanoseconds
    private var durable=0; private var acknowledged=0; private var identity=""
    private var lockFD:Int32 = -1
    private var handle:FileHandle!
    var queuedBytes:Int { gate.withLock { queued } }
    var pendingBytes:Int { gate.withLock { admitted-acknowledged } }
    init(directory:URL,collectorID:String,sourceID:String,limits:TransferLimits,diskIO:any JournalDiskIO=SystemJournalDiskIO()) throws {
        self.diskIO=diskIO;self.limits=limits; scope=collectorID+"\n"+sourceID; journalID=directory.lastPathComponent
        fileURL=directory.appendingPathComponent("capture.ndjson"); cursorURL=directory.appendingPathComponent("cursor.json"); metadataURL=directory.appendingPathComponent("journal.json")
        do {
            try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
            lockFD=Darwin.open(directory.appendingPathComponent("writer.lock").path,O_CREAT|O_RDWR,0o600)
            guard lockFD>=0 else { throw TransferError.storageFailure }
            guard flock(lockFD,LOCK_EX|LOCK_NB)==0 else { throw TransferError.spoolBusy }
            // After exclusive ownership, remove only our atomic journal/cursor regular-file remnants.
            for temp in try FileManager.default.contentsOfDirectory(at:directory,includingPropertiesForKeys:nil) {
                let name=temp.lastPathComponent
                let prefix=name.hasPrefix(".journal.json.") ? ".journal.json.":name.hasPrefix(".cursor.json.") ? ".cursor.json.":nil
                guard let prefix,name.hasSuffix(".tmp"),UUID(uuidString:String(name.dropFirst(prefix.count).dropLast(4))) != nil else { continue }
                var info=stat();guard lstat(temp.path,&info)==0,info.st_mode&S_IFMT==S_IFREG else { continue }
                guard unlink(temp.path)==0 else { throw TransferError.storageFailure }
            }
            if !FileManager.default.fileExists(atPath:fileURL.path) { try atomicWrite(Data(),to:fileURL) }
            handle=try FileHandle(forUpdating:fileURL)
            let size=try handle.seekToEnd(); guard size<=limits.maximumSpoolBytes else { throw TransferError.spoolFull }
            // Scan only the unfinished final tail. Never truncate complete lines to a stale watermark.
            var end=size;var complete:UInt64=0;var inspected=0
            while end>0 {
                let count=min(65536,Int(end));try handle.seek(toOffset:end-UInt64(count));let bytes=try handle.read(upToCount:count) ?? Data()
                if let newline=bytes.lastIndex(of:10) { complete=end-UInt64(count)+UInt64(newline)+1;break }
                inspected+=count;guard inspected<=1_048_576 else { throw TransferError.invalidEvent };end-=UInt64(count)
            }
            guard size-complete<=1_048_576 else { throw TransferError.invalidEvent }
            if complete != size { try handle.truncate(atOffset:complete) };end=complete
            try handle.synchronize(); durable=Int(end); admitted=durable
            let attrs=try FileManager.default.attributesOfItem(atPath:fileURL.path)
            identity="\(attrs[.systemFileNumber] ?? "unknown"):\(attrs[.creationDate] ?? "unknown")"
            if let data=try? Data(contentsOf:cursorURL),data.count<=16384,let c=try? JSONDecoder().decode(Cursor.self,from:data),
                c.version==2,c.scope==scope,c.journal==journalID,c.identity==identity,c.offset>=0,c.offset<=durable,
                try boundary(c.offset)==c.boundary { acknowledged=c.offset }
            try publish()
        } catch { try? handle?.close();handle=nil;if lockFD>=0 { Darwin.close(lockFD);lockFD = -1 }; throw (error as? TransferError) ?? .storageFailure }
    }
    deinit { try? handle?.close(); if lockFD>=0 { Darwin.close(lockFD) } }
    func append(_ event:EventLine) throws {
        try gate.withLock {
            guard !isClosed else { throw TransferError.closed }; guard !failed else { throw TransferError.storageFailure }
            guard admitted+event.bytes.count<=limits.maximumSpoolBytes else { throw TransferError.spoolFull }
            guard queued+event.bytes.count<=2*1024*1024 else { throw TransferError.spoolFull }
            pending.append(event); admitted+=event.bytes.count; queued+=event.bytes.count
            if !scheduled { scheduled=true; io.asyncAfter(deadline:.now()+0.05) { [self] in try? commit() } }
            if (queued>=65536 || pending.count>=500) && !immediateScheduled { immediateScheduled=true;io.async { [self] in try? commit() } }
        }
    }
    private func commit(through target:Int?=nil) throws {
        let records:[EventLine]=try gate.withLock {
            immediateScheduled=false
            guard !failed else { throw TransferError.storageFailure }
            var end=durable;var count=0
            for event in pending { if let target,end+event.bytes.count>target { break };end+=event.bytes.count;count+=1 }
            let group=Array(pending.prefix(count));pending.removeFirst(count);if pending.isEmpty { scheduled=false };return group
        }
        if records.isEmpty { if gate.withLock({failed}) { throw TransferError.storageFailure };return }
        do {
            var bytes=Data();for record in records { bytes.append(record.bytes) }
            try handle.seekToEnd();try diskIO.append(bytes,to:handle);try diskIO.sync(handle)
            gate.withLock { durable+=bytes.count;queued-=bytes.count }
            try publishCoalesced()
        } catch { gate.withLock { failed=true };throw TransferError.storageFailure }
    }
    func flushPersistence() async throws { let target=gate.withLock { admitted };try await perform { try self.commit(through:target) } }
    func nextBatch() async throws -> Batch? { try await perform {
        try self.commit(); let start=self.gate.withLock { self.acknowledged }; let end=self.gate.withLock { self.durable }
        if start==end { return nil }
        try self.handle.seek(toOffset:UInt64(start))
        var result=Data();var line=Data();var ids:[String]=[];var consumed=start
        while consumed<end && ids.count<self.limits.maximumBatchEvents {
            let chunk=try self.handle.read(upToCount:min(65536,end-consumed)) ?? Data();if chunk.isEmpty { throw TransferError.storageFailure }
            for byte in chunk {
                line.append(byte); consumed+=1
                guard line.count<=self.limits.maximumBatchBytes else { throw TransferError.eventTooLarge }
                if byte==10 {
                    if result.count+line.count>self.limits.maximumBatchBytes { return Batch(bytes:result,ids:ids,endOffset:start+result.count) }
                    let event=try EventLine.parse(String(decoding:line,as:UTF8.self),maximumBytes:self.limits.maximumBatchBytes)
                    result.append(event.bytes);ids.append(event.id);line.removeAll(keepingCapacity:true)
                    if ids.count==self.limits.maximumBatchEvents { break }
                }
            }
        }
        return Batch(bytes:result,ids:ids,endOffset:start+result.count)
    } }
    func acknowledge(_ batch:Batch) async throws { try await perform {
        let cursor=Cursor(version:2,scope:self.scope,journal:self.journalID,identity:self.identity,offset:batch.endOffset,boundary:try self.boundary(batch.endOffset))
        try atomicWrite(JSONEncoder().encode(cursor),to:self.cursorURL,diskIO:self.diskIO)
        self.gate.withLock { self.acknowledged=batch.endOffset }
    } }
    func rebind(collectorID:String,sourceID:String) async throws { try await perform {
        self.scope=collectorID+"\n"+sourceID
        self.gate.withLock { self.acknowledged=0 }
        if let data=try? Data(contentsOf:self.cursorURL),let c=try? JSONDecoder().decode(Cursor.self,from:data),c.version==2,c.scope==self.scope,c.journal==self.journalID,c.identity==self.identity,c.offset>=0,c.offset<=self.durable,try self.boundary(c.offset)==c.boundary {
            self.gate.withLock { self.acknowledged=c.offset }
        }
    } }
    func exportData() async -> Data { (try? await perform { try self.commit();return try Data(contentsOf:self.fileURL) }) ?? Data() }
    func close() async throws {
        gate.withLock { isClosed=true }
        try await perform(reserve:false) {
            defer { self.publication?.cancel();self.publication=nil;try? self.handle.close();if self.lockFD>=0 { Darwin.close(self.lockFD);self.lockFD = -1 } }
            try self.commit();try self.publish()
        }
    }
    private func boundary(_ position:Int) throws -> String {
        try handle.seek(toOffset:UInt64(max(0,position-64)));return sha256(try handle.read(upToCount:min(position,64)) ?? Data())
    }
    private func publishCoalesced() throws {
        let now=DispatchTime.now().uptimeNanoseconds
        if durable-publishedBytes>=1_048_576 || now-publishedAt>=250_000_000 { publication?.cancel();publication=nil;try publish() }
        else if publication==nil {
            let work=DispatchWorkItem { [self] in
                publication=nil
                guard !gate.withLock({ isClosed || failed }) else { return }
                do { try publish() } catch { gate.withLock { failed=true } }
            }
            publication=work;io.asyncAfter(deadline:.now() + .milliseconds(Int((250_000_000-(now-publishedAt))/1_000_000)),execute:work)
        }
    }
    var admittedBytes:Int { gate.withLock { admitted } }
    private func publish() throws {
        let value:[String:Any] = ["version":2,"journal_id":journalID,"generation":journalID,"capture":"capture.ndjson","durable_bytes":gate.withLock { durable }]
        try atomicWrite(JSONSerialization.data(withJSONObject:value),to:metadataURL,diskIO:diskIO)
        publishedBytes=gate.withLock { durable };publishedAt=DispatchTime.now().uptimeNanoseconds
    }
    private func perform<T:Sendable>(reserve:Bool=true,_ operation:@escaping @Sendable () throws -> T) async throws -> T {
        if reserve { try gate.withLock { guard controls<64 else { throw TransferError.spoolFull };controls+=1 } }
        return try await withCheckedThrowingContinuation { continuation in io.async {
            defer { if reserve { self.gate.withLock { self.controls-=1 } } }
            do { continuation.resume(returning:try operation()) } catch { continuation.resume(throwing:error) }
        } }
    }
}

enum AtomicPublicationBoundary:String,Sendable { case tempWritten="temp_written",tempSynced="temp_synced",renamed,directorySynced="directory_synced" }
protocol JournalDiskIO:Sendable {
    func append(_ bytes:Data,to file:FileHandle) throws
    func sync(_ file:FileHandle) throws
    func atomicBoundary(_ target:URL,_ boundary:AtomicPublicationBoundary) throws
}
extension JournalDiskIO { func atomicBoundary(_ target:URL,_ boundary:AtomicPublicationBoundary) throws {} }
struct SystemJournalDiskIO:JournalDiskIO {
    func append(_ bytes:Data,to file:FileHandle) throws { try file.write(contentsOf:bytes) }
    func sync(_ file:FileHandle) throws { try file.synchronize() }
}

func atomicWrite(_ bytes:Data,to url:URL,diskIO:any JournalDiskIO=SystemJournalDiskIO()) throws {
    let temp=url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString).tmp")
    defer { try? FileManager.default.removeItem(at:temp) }
    guard FileManager.default.createFile(atPath:temp.path,contents:nil,attributes:[.posixPermissions:0o600]) else { throw TransferError.storageFailure }
    let handle=try FileHandle(forWritingTo:temp);defer { try? handle.close() };try handle.write(contentsOf:bytes);try diskIO.atomicBoundary(url,.tempWritten);try handle.synchronize();try diskIO.atomicBoundary(url,.tempSynced)
    guard Darwin.rename(temp.path,url.path)==0 else { throw TransferError.storageFailure };try diskIO.atomicBoundary(url,.renamed)
    let parent=Darwin.open(url.deletingLastPathComponent().path,O_RDONLY);guard parent>=0 else { throw TransferError.storageFailure };defer { Darwin.close(parent) };guard fsync(parent)==0 else { throw TransferError.storageFailure };try diskIO.atomicBoundary(url,.directorySynced)
}
#endif
