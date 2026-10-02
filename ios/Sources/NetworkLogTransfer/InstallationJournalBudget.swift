#if DEBUG
import Foundation
import Darwin
import CoreFoundation

private struct JournalInventoryFailure:LocalizedError {
    let reason:String
    var errorDescription:String? { "\(reason); restore missing journal state or export remaining captures and select a new directory" }
}

public struct NativeJournalLimits:Sendable {
    public let generationBytes:Int
    public let installationBytes:Int
    public let maximumGenerations:Int
    public init(generationBytes:Int=8*1024*1024,installationBytes:Int=256*1024*1024,maximumGenerations:Int=128) {
        self.generationBytes=generationBytes;self.installationBytes=installationBytes;self.maximumGenerations=maximumGenerations
    }
}
final class InstallationJournalBudget:@unchecked Sendable {
    let root:URL;let limits:NativeJournalLimits
    init(root:URL,limits:NativeJournalLimits) throws {
        guard limits.generationBytes>0,limits.installationBytes>=limits.generationBytes,(1...128).contains(limits.maximumGenerations) else { throw TransferError.invalidLimits }
        self.root=root;self.limits=limits
    }
    func captures() throws ->[URL] {
        try FileManager.default.contentsOfDirectory(at:root.appendingPathComponent("journals"),includingPropertiesForKeys:[.creationDateKey]).filter {
            FileManager.default.fileExists(atPath:$0.appendingPathComponent("capture.ndjson").path)
        }.sorted { ((try? $0.resourceValues(forKeys:[.creationDateKey]).creationDate) ?? .distantPast)<((try? $1.resourceValues(forKeys:[.creationDateKey]).creationDate) ?? .distantPast) }.map { $0.appendingPathComponent("capture.ndjson") }
    }
    private func readReservations(_ state:URL) throws ->[String:Int] {
        guard FileManager.default.fileExists(atPath:state.path) else { return [:] }
        do {
            let handle=try FileHandle(forReadingFrom:state);defer { try? handle.close() }
            var data=Data()
            while data.count<16385 {
                let chunk=try handle.read(upToCount:16385-data.count) ?? Data()
                if chunk.isEmpty { break };data.append(chunk)
            }
            guard data.count<=16384,
                let value=try JSONSerialization.jsonObject(with:data) as? [String:Any],value["version"] as? Int==2,
                let saved=value["reservations"] as? [String:Any],saved.count<=128 else {
                throw JournalInventoryFailure(reason:"Journal budget must be version 2, at most 16 KiB and 128 generations")
            }
            var reservations:[String:Int]=[:]
            for (key,raw) in saved {
                guard key.range(of:"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",options:.regularExpression) == key.startIndex..<key.endIndex,
                    let number=raw as? NSNumber,CFGetTypeID(number) != CFBooleanGetTypeID(),
                    let bytes=raw as? Int,bytes>=0 else {
                    throw JournalInventoryFailure(reason:"Invalid journal budget reservation")
                }
                reservations[key]=bytes
            }
            return reservations
        } catch let error as JournalInventoryFailure { throw error }
        catch { throw JournalInventoryFailure(reason:"Journal budget unavailable or invalid") }
    }
    private func validateInventory(_ reservations:[String:Int]) throws {
        for key in reservations.keys {
            let directory=root.appendingPathComponent("journals").appendingPathComponent(key)
            let capture=directory.appendingPathComponent("capture.ndjson")
            let folder=try? directory.resourceValues(forKeys:[.isDirectoryKey,.isSymbolicLinkKey])
            let file=try? capture.resourceValues(forKeys:[.isRegularFileKey,.isSymbolicLinkKey])
            guard folder?.isDirectory==true,folder?.isSymbolicLink==false,
                file?.isRegularFile==true,file?.isSymbolicLink==false else {
                throw JournalInventoryFailure(reason:"Retained journal generation \(key) is missing its directory or capture.ndjson")
            }
        }
    }
    func openGeneration<T>(_ open:(URL) throws ->T) throws ->T { try locked {
        let state=root.appendingPathComponent("journal-budget.json")
        let reservations=try readReservations(state)
        try validateInventory(reservations)
        let journals=root.appendingPathComponent("journals")
        let directories=try FileManager.default.contentsOfDirectory(at:journals,includingPropertiesForKeys:nil)
        guard directories.count<limits.maximumGenerations else { throw TransferError.spoolFull }
        var current:[String:Int]=[:];var used=0
        for directory in directories {
            let file=directory.appendingPathComponent("capture.ndjson")
            let size=(try? FileManager.default.attributesOfItem(atPath:file.path)[.size] as? NSNumber)?.intValue ?? 0
            let fd=Darwin.open(directory.appendingPathComponent("writer.lock").path,O_CREAT|O_RDWR,0o600)
            guard fd>=0 else { throw TransferError.storageFailure }
            let held=flock(fd,LOCK_EX|LOCK_NB) != 0
            let reserved=held ? max(reservations[directory.lastPathComponent] ?? limits.generationBytes,size) : size
            Darwin.close(fd)
            guard reserved<=limits.installationBytes-used else { throw TransferError.spoolFull }
            current[directory.lastPathComponent]=reserved;used+=reserved
        }
        guard limits.generationBytes<=limits.installationBytes-used else { throw TransferError.spoolFull }
        let id=UUID().uuidString;let directory=journals.appendingPathComponent(id)
        try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:false,attributes:[.posixPermissions:0o700])
        current[id]=limits.generationBytes
        try atomicWrite(JSONSerialization.data(withJSONObject:["version":2,"reservations":current]),to:state)
        return try open(directory)
    } }
    func seal(_ file:URL) throws { try locked {
        let state=root.appendingPathComponent("journal-budget.json")
        var reservations=try readReservations(state)
        try validateInventory(reservations)
        reservations[file.deletingLastPathComponent().lastPathComponent]=(try FileManager.default.attributesOfItem(atPath:file.path)[.size] as? NSNumber)?.intValue ?? 0
        try atomicWrite(JSONSerialization.data(withJSONObject:["version":2,"reservations":reservations]),to:state)
    } }
    private func locked<T>(_ action:() throws ->T) throws ->T {
        let fd=Darwin.open(root.appendingPathComponent("installation.lock").path,O_CREAT|O_RDWR,0o600)
        guard fd>=0,flock(fd,LOCK_EX)==0 else { if fd>=0 { Darwin.close(fd) };throw TransferError.storageFailure }
        defer { Darwin.close(fd) };return try action()
    }
}
#endif
