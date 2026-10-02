#if os(macOS)
import XCTest
import Foundation
import Darwin
@testable import NetworkLogTransfer

private let atomicCrashBoundaries=["temp_written","temp_synced","renamed","directory_synced"]
private let atomicCrashStages=["metadata","cursor"].flatMap { kind in atomicCrashBoundaries.map { kind+"_"+$0 } }
private let cursorUncommitted=["cursor_temp_written","cursor_temp_synced"]
private let cursorCommitted=["cursor_renamed","cursor_directory_synced"]
private let crashStages=["enqueue","append_partial","append_complete","synced_unpublished","published","cursor_committed","cursor_lost"]+atomicCrashStages
private func crashLine(_ id:String)->String { "{\"schema_version\":\"1.2\",\"event_type\":\"session.started\",\"event_id\":\"\(id)\",\"data\":{}}" }
private func crashBytes(_ id:String)->Data { Data((crashLine(id)+"\n").utf8) }
private var crashAllBytes:Data { crashBytes("baseline")+crashBytes("candidate") }
private func stopCrashFixture(_ root:URL,_ stage:String) throws {
    try Data(stage.utf8).write(to:root.appendingPathComponent("stage.marker"))
    DispatchSemaphore(value:0).wait()
}
private final class CrashDiskIO:JournalDiskIO,@unchecked Sendable {
    let root:URL;let stage:String;private let gate=NSLock();private var active=false
    init(root:URL,stage:String){self.root=root;self.stage=stage}
    func arm(){gate.withLock { active=true }}
    func atomicBoundary(_ target:URL,_ boundary:AtomicPublicationBoundary) throws {
        let kind=target.lastPathComponent=="journal.json" ? "metadata":target.lastPathComponent=="cursor.json" ? "cursor":"other"
        if gate.withLock({active}),stage==kind+"_"+boundary.rawValue { try stopCrashFixture(root,stage) }
    }
    func append(_ bytes:Data,to file:FileHandle) throws {
        if stage=="enqueue" { try stopCrashFixture(root,stage) }
        if stage=="append_partial" { try file.write(contentsOf:bytes.prefix(bytes.count/2));try stopCrashFixture(root,stage) }
        try SystemJournalDiskIO().append(bytes,to:file)
        if stage=="append_complete" { try stopCrashFixture(root,stage) }
    }
    func sync(_ file:FileHandle) throws {
        try SystemJournalDiskIO().sync(file)
        if stage=="synced_unpublished" { try stopCrashFixture(root,stage) }
    }
}

/// Executable host subprocess fixtures only. This file is excluded when Xcode builds iOS simulator tests.
final class NativeCrashTests:XCTestCase,@unchecked Sendable {
    func testCrashFixtureProcess() async throws {
        guard let stage=ProcessInfo.processInfo.environment["NATIVE_CRASH_STAGE"],
            let path=ProcessInfo.processInfo.environment["NATIVE_CRASH_ROOT"] else { return }
        XCTAssertTrue(crashStages.contains(stage))
        let root=URL(fileURLWithPath:path),directory=root.appendingPathComponent("journal")
        let disk=CrashDiskIO(root:root,stage:stage)
        let spool=try DurableSpool(directory:directory,collectorID:"collector",sourceID:"source",limits:TransferLimits(),diskIO:disk)
        disk.arm()
        try spool.append(EventLine.parse(crashLine("candidate"),maximumBytes:1024));try await spool.flushPersistence()
        if stage=="published" || ["metadata_renamed","metadata_directory_synced"].contains(stage) {
            let deadline=Date().addingTimeInterval(3)
            while try published(directory) != crashAllBytes.count {
                guard Date()<deadline else { XCTFail("Publication was not observed");return }
                try await Task.sleep(nanoseconds:5_000_000)
            }
        } else if stage.hasPrefix("cursor_") {
            let next=try await spool.nextBatch();let batch=try XCTUnwrap(next)
            // A durable test receipt models a successful collector ACK before the producer cursor commit.
            try atomicWrite(JSONSerialization.data(withJSONObject:["event_ids":batch.ids]),to:root.appendingPathComponent("collector-receipt.json"))
            try await spool.acknowledge(batch)
        }
        if atomicCrashStages.contains(stage) { while true { try await Task.sleep(nanoseconds:1_000_000_000) } } else { try stopCrashFixture(root,stage) }
    }

    func testHardKillStageMatrixRetainsCompletePrefixesAndReplaysLostCursors() async throws {
        guard ProcessInfo.processInfo.environment["NATIVE_CRASH_STAGE"]==nil else { return }
        for stage in crashStages {
            let root=FileManager.default.temporaryDirectory.appendingPathComponent("native-crash-ios-\(stage)-\(UUID().uuidString)")
            try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
            let directory=root.appendingPathComponent("journal")
            let original=try DurableSpool(directory:directory,collectorID:"collector",sourceID:"source",limits:TransferLimits())
            try original.append(EventLine.parse(crashLine("baseline"),maximumBytes:1024));try await original.close()
            let retained=root.appendingPathComponent("retained")
            let history=try DurableSpool(directory:retained,collectorID:"collector",sourceID:"source",limits:TransferLimits())
            try history.append(EventLine.parse(crashLine("retained-history"),maximumBytes:1024));try await history.close()
            let historyBytes=try Data(contentsOf:history.fileURL),historyMetadata=try Data(contentsOf:retained.appendingPathComponent("journal.json"))
            let log=root.appendingPathComponent("child.log");FileManager.default.createFile(atPath:log.path,contents:nil)
            let output=try FileHandle(forWritingTo:log)
            let child=Process();child.executableURL=URL(fileURLWithPath:CommandLine.arguments[0])
            child.arguments=["-XCTest","NetworkLogTransferTests.NativeCrashTests/testCrashFixtureProcess",Bundle(for:NativeCrashTests.self).bundleURL.path]
            var environment=ProcessInfo.processInfo.environment.filter { ["PATH","TMPDIR","DYLD_FRAMEWORK_PATH","DYLD_LIBRARY_PATH"].contains($0.key) }
            environment["NATIVE_CRASH_ROOT"]=root.path;environment["NATIVE_CRASH_STAGE"]=stage
            child.environment=environment;child.standardOutput=output;child.standardError=output
            defer {
                if child.isRunning { Darwin.kill(child.processIdentifier,SIGKILL) }
                try? output.close();try? FileManager.default.removeItem(at:root)
            }
            try child.run()
            let marker=root.appendingPathComponent("stage.marker"),deadline=Date().addingTimeInterval(8)
            while (try? String(contentsOf:marker,encoding:.utf8)) != stage {
                guard child.isRunning,Date()<deadline else {
                    XCTFail("Fixture failed before \(stage): \(((try? String(contentsOf:log,encoding:.utf8)) ?? "").prefix(1000))")
                    return
                }
                try await Task.sleep(nanoseconds:5_000_000)
            }
            let before=try published(directory)
            if ["enqueue","append_partial","append_complete","synced_unpublished","metadata_temp_written","metadata_temp_synced"].contains(stage) { XCTAssertEqual(before,crashBytes("baseline").count) }
            if stage=="published" || ["metadata_renamed","metadata_directory_synced"].contains(stage) { XCTAssertEqual(before,crashAllBytes.count) }
            let cursorBefore=(try? JSONSerialization.jsonObject(with:Data(contentsOf:directory.appendingPathComponent("cursor.json"))) as? [String:Any])?["offset"] as? Int ?? 0
            if cursorUncommitted.contains(stage) { XCTAssertEqual(cursorBefore,0) }
            if cursorCommitted.contains(stage) { XCTAssertEqual(cursorBefore,crashAllBytes.count) }
            XCTAssertEqual(Darwin.kill(child.processIdentifier,SIGKILL),0)
            let exitDeadline=Date().addingTimeInterval(3)
            while child.isRunning,Date()<exitDeadline { try await Task.sleep(nanoseconds:5_000_000) }
            XCTAssertFalse(child.isRunning,"Killed fixture must terminate before recovery")
            XCTAssertEqual(child.terminationReason,.uncaughtSignal);XCTAssertEqual(child.terminationStatus,SIGKILL)
            let expected=["enqueue","append_partial"].contains(stage) ? crashBytes("baseline") : crashAllBytes
            if stage=="cursor_lost" { try FileManager.default.removeItem(at:directory.appendingPathComponent("cursor.json")) }
            let recovered=try DurableSpool(directory:directory,collectorID:"collector",sourceID:"source",limits:TransferLimits())
            XCTAssertEqual(try Data(contentsOf:recovered.fileURL),expected)
            XCTAssertEqual(try published(directory),expected.count)
            if stage=="cursor_committed" || cursorCommitted.contains(stage) { XCTAssertEqual(recovered.pendingBytes,0);let batch=try await recovered.nextBatch();XCTAssertNil(batch) }
            if stage=="cursor_lost" || cursorUncommitted.contains(stage) {
                let next=try await recovered.nextBatch();let batch=try XCTUnwrap(next);XCTAssertEqual(batch.bytes,expected)
                XCTAssertEqual(batch.ids,["baseline","candidate"]);try await recovered.acknowledge(batch)
            }
            try await recovered.close();XCTAssertEqual(try Data(contentsOf:recovered.fileURL),expected)
            if stage.hasPrefix("cursor_") {
                let receipt=try JSONSerialization.jsonObject(with:Data(contentsOf:root.appendingPathComponent("collector-receipt.json"))) as! [String:[String]]
                XCTAssertEqual(receipt["event_ids"],["baseline","candidate"])
            }
            XCTAssertEqual(try Data(contentsOf:history.fileURL),historyBytes);XCTAssertEqual(try Data(contentsOf:retained.appendingPathComponent("journal.json")),historyMetadata)
            var repeatKills=0
            if stage=="metadata_temp_written" {
                var accumulated=expected
                for _ in 0..<2 {
                    try FileManager.default.removeItem(at:marker)
                    let repeated=Process();repeated.executableURL=child.executableURL;repeated.arguments=child.arguments;repeated.environment=environment;repeated.standardOutput=output;repeated.standardError=output
                    defer { if repeated.isRunning { Darwin.kill(repeated.processIdentifier,SIGKILL) } }
                    try repeated.run();let until=Date().addingTimeInterval(8)
                    while (try? String(contentsOf:marker,encoding:.utf8)) != stage { guard repeated.isRunning,Date()<until else { XCTFail("Repeated atomic stage not reached");return };try await Task.sleep(nanoseconds:5_000_000) }
                    XCTAssertEqual(try published(directory),accumulated.count)
                    let temps=try FileManager.default.contentsOfDirectory(at:directory,includingPropertiesForKeys:nil).filter { $0.lastPathComponent.hasPrefix(".journal.json.") && $0.lastPathComponent.hasSuffix(".tmp") };XCTAssertEqual(temps.count,1)
                    XCTAssertEqual(Darwin.kill(repeated.processIdentifier,SIGKILL),0);let exitBy=Date().addingTimeInterval(3)
                    while repeated.isRunning,Date()<exitBy { try await Task.sleep(nanoseconds:5_000_000) };XCTAssertFalse(repeated.isRunning);XCTAssertEqual(repeated.terminationStatus,SIGKILL);repeatKills+=1
                    accumulated+=crashBytes("candidate")
                    let reopened=try DurableSpool(directory:directory,collectorID:"collector",sourceID:"source",limits:TransferLimits());XCTAssertEqual(try Data(contentsOf:reopened.fileURL),accumulated);XCTAssertEqual(try published(directory),accumulated.count)
                    XCTAssertTrue(try FileManager.default.contentsOfDirectory(at:directory,includingPropertiesForKeys:nil).allSatisfy { !$0.lastPathComponent.hasPrefix(".journal.json.") || !$0.lastPathComponent.hasSuffix(".tmp") });try await reopened.close()
                }
            }
            let evidence:[String:Any]=["platform":"ios-swift-host","stage":stage,"hard_kill":true,"recovered_bytes":expected.count,"published_before_kill":before,"cursor_before_recovery":cursorBefore,"repeated_atomic_kills":repeatKills,"cursor_replayed":stage=="cursor_lost" || cursorUncommitted.contains(stage),"retained_history_unchanged":true,"passed":true]
            print("NATIVE_CRASH_STAGE "+String(decoding:try JSONSerialization.data(withJSONObject:evidence,options:.sortedKeys),as:UTF8.self))
        }
    }
    func testPublicationTempCleanupPreservesUnrelatedSymlinksAndDirectories() async throws {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("native-temp-sentinels-"+UUID().uuidString);try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true);defer { try? FileManager.default.removeItem(at:root) }
        let target=root.appendingPathComponent("sentinel"),symlink=root.appendingPathComponent(".journal.json."+UUID().uuidString+".tmp"),directory=root.appendingPathComponent(".cursor.json."+UUID().uuidString+".tmp"),unrelated=root.appendingPathComponent(".journal.json.not-a-uuid.tmp")
        try Data("preserve".utf8).write(to:target);try FileManager.default.createSymbolicLink(at:symlink,withDestinationURL:target);try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:false);try Data("unrelated".utf8).write(to:unrelated)
        let spool=try DurableSpool(directory:root,collectorID:"collector",sourceID:"source",limits:TransferLimits());try await spool.close()
        XCTAssertEqual(try Data(contentsOf:target),Data("preserve".utf8));XCTAssertEqual(try FileManager.default.destinationOfSymbolicLink(atPath:symlink.path),target.path);XCTAssertTrue(FileManager.default.fileExists(atPath:directory.path));XCTAssertEqual(try Data(contentsOf:unrelated),Data("unrelated".utf8))
    }
    func testAtomicPublicationCannotSucceedWhenParentDirectoryOpenFails() throws {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("native-parent-open-"+UUID().uuidString);try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true);defer { try? FileManager.default.removeItem(at:root) }
        let parent=root.appendingPathComponent("parent"),held=root.appendingPathComponent("held");try FileManager.default.createDirectory(at:parent,withIntermediateDirectories:false)
        struct MoveParent:JournalDiskIO {
            let parent:URL;let held:URL
            func append(_ bytes:Data,to file:FileHandle) throws { try file.write(contentsOf:bytes) }
            func sync(_ file:FileHandle) throws { try file.synchronize() }
            func atomicBoundary(_ target:URL,_ boundary:AtomicPublicationBoundary) throws { if boundary == .renamed { try FileManager.default.moveItem(at:parent,to:held) } }
        }
        XCTAssertThrowsError(try atomicWrite(Data("complete".utf8),to:parent.appendingPathComponent("journal.json"),diskIO:MoveParent(parent:parent,held:held))) { XCTAssertEqual($0 as? TransferError,.storageFailure) }
        XCTAssertEqual(try Data(contentsOf:held.appendingPathComponent("journal.json")),Data("complete".utf8))
    }
    func testRepeatedPublicationConstructionFailureClosesHandlesAndReleasesLease() async throws {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("native-unsafe-construction-"+UUID().uuidString);try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true);defer { try? FileManager.default.removeItem(at:root) }
        struct RejectMetadata:JournalDiskIO {
            func append(_ bytes:Data,to file:FileHandle) throws { try file.write(contentsOf:bytes) }
            func sync(_ file:FileHandle) throws { try file.synchronize() }
            func atomicBoundary(_ target:URL,_ boundary:AtomicPublicationBoundary) throws { if target.lastPathComponent=="journal.json",boundary == .tempWritten { throw TransferError.storageFailure } }
        }
        func rejected() { XCTAssertThrowsError(try DurableSpool(directory:root,collectorID:"collector",sourceID:"source",limits:TransferLimits(),diskIO:RejectMetadata())) }
        rejected();let before=(0..<1024).filter { Darwin.fcntl(Int32($0),F_GETFD) != -1 }.count
        for _ in 0..<5 { rejected() };XCTAssertEqual((0..<1024).filter { Darwin.fcntl(Int32($0),F_GETFD) != -1 }.count,before)
        let retry=try DurableSpool(directory:root,collectorID:"collector",sourceID:"source",limits:TransferLimits());try retry.append(EventLine.parse(crashLine("retry"),maximumBytes:1024));try await retry.close();XCTAssertEqual(try Data(contentsOf:retry.fileURL),crashBytes("retry"))
    }
    private func published(_ directory:URL) throws ->Int {
        let value=try JSONSerialization.jsonObject(with:Data(contentsOf:directory.appendingPathComponent("journal.json"))) as! [String:Any]
        return try XCTUnwrap(value["durable_bytes"] as? Int)
    }
}
#endif
