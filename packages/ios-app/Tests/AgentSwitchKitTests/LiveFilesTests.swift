#if os(macOS)
import XCTest
@testable import AgentSwitchKit

/// Changing the Mac's files from the phone's own client code (docs/files-v0.md §12), against a real daemon over the
/// pinned channel. Opt-in: `AGENTSWITCH_E2E_LINK` is a fresh pairing link and `AGENTSWITCH_E2E_FILES_DIR` an empty
/// folder inside that daemon's home (a throw-away daemon whose HOME is throw-away too). Nothing is moved to a Trash here:
/// that is the Mac's own and the tests of the daemon cover it.
final class LiveFilesTests: XCTestCase {
    func testMakeRenameAndSendFilesIntoAFolder() async throws {
        guard let link = ProcessInfo.processInfo.environment["AGENTSWITCH_E2E_LINK"], !link.isEmpty,
              let dir = ProcessInfo.processInfo.environment["AGENTSWITCH_E2E_FILES_DIR"], !dir.isEmpty else {
            throw XCTSkip("set AGENTSWITCH_E2E_LINK and AGENTSWITCH_E2E_FILES_DIR")
        }
        let payload = try PairingLink.parse(link)
        let transport = PinnedSessionTransport(fingerprint: payload.fp)
        let outcome = try await PairingService(transport: transport, discovery: nil).pair(payload, deviceName: "e2e files")
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(outcome.endpoint), transport: transport, token: outcome.token)

        // New: the folders on the way made too; the same name again is refused as taken.
        let made = try await api.newFolder("\(dir)/fixtures/users")
        XCTAssertEqual(made, MacMade(path: "\(dir)/fixtures/users", top: "\(dir)/fixtures"))
        _ = try await api.newFile("\(dir)/notes.md")
        do { _ = try await api.newFile("\(dir)/notes.md"); XCTFail("taken") } catch let e as FileChangeError { XCTAssertEqual(e.refusal, .exists) }
        // A new name, a change of case alone included.
        let renamed = try await api.rename("\(dir)/notes.md", to: "NOTES.md", force: false)
        XCTAssertEqual(renamed, "\(dir)/NOTES.md")

        // A file of this phone's into the folder, as its bytes, telling how far it has gone; the name taken: refused,
        // or kept as the second of two.
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("e2e-\(UUID().uuidString)").appendingPathComponent("IMG_0412.HEIC")
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        let bytes = Data((0..<3_000_000).map { UInt8($0 % 251) })
        try bytes.write(to: file)
        defer { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
        let seen = LockedBox<[Double]>([])
        let landed = try await api.upload(file, to: "\(dir)/IMG_0412.HEIC", conflict: .fail) { p in seen.withLock { $0.append(p) } }
        XCTAssertEqual(landed, MacUploaded(path: "\(dir)/IMG_0412.HEIC", name: "IMG_0412.HEIC", size: Int64(bytes.count)))
        // How far it has gone is told (over a loopback the bytes may all go in one step).
        XCTAssertEqual(seen.value.last, 1, "progress told as the bytes go")
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: "\(dir)/IMG_0412.HEIC")), bytes)
        do { _ = try await api.upload(file, to: "\(dir)/IMG_0412.HEIC", conflict: .fail) { _ in }; XCTFail("taken") } catch let e as FileChangeError { XCTAssertEqual(e.refusal, .exists) }
        let second = try await api.upload(file, to: "\(dir)/IMG_0412.HEIC", conflict: .keep) { _ in }
        XCTAssertEqual(second.name, "IMG_0412 2.HEIC")

        // What the folder lists now; nothing half-sent left beside it.
        let level = try await api.folder(dir, hidden: true, etag: nil)
        XCTAssertEqual(level?.folder.entries.map(\.name).sorted(), ["IMG_0412 2.HEIC", "IMG_0412.HEIC", "NOTES.md", "fixtures"].sorted())
        // AgentSwitch's own place and the folder holding it: not changed from here.
        let home = try XCTUnwrap(level?.folder.home)
        do { _ = try await api.rename(home, to: "elsewhere", force: false); XCTFail("fixed") } catch let e as FileChangeError { XCTAssertEqual(e.refusal, .locked) }
    }
}
#endif
