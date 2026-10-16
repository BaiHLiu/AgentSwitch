import XCTest
@testable import AgentSwitchKit

/// The Files tab's half in AgentSwitchKit (docs/files-v0.md §5, §7): what the Mac's `/files…` answers decode to, how they
/// are asked for, what a refusal says, and the pure parts the pages lean on. No Mac: a scripted transport.
final class FileTests: XCTestCase {
    private let lan = APIEndpoint(host: "192.168.1.5", port: 4713, kind: .lan)

    private let level = #"""
    {"path":"/Users/me/Projects/lumen","parent":"/Users/me/Projects","home":"/Users/me","more":0,"hiddenCount":2,
     "entries":[
      {"name":"docs-link","kind":"link","size":0,"mtime":1760600000000,"hidden":false,"link":{"target":"/Users/me/Documents","kind":"dir"}},
      {"name":"node_modules","kind":"dir","size":0,"mtime":1760600000000,"hidden":false,"dim":true},
      {"name":"src","kind":"dir","size":0,"mtime":1760600000000,"hidden":false},
      {"name":"token-copy","kind":"file","size":0,"mtime":0,"hidden":false,"locked":true},
      {"name":"app.ts","kind":"file","size":2140,"mtime":1760611320000,"hidden":false}
     ]}
    """#

    func testALevelDecodesAndAsksWithTheVersionItHas() async throws {
        let level = self.level
        let transport = FakeTransport { req, n in
            n == 0 ? (Data(level.utf8), HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: ["ETag": "\"v1\""])!)
                   : (Data(), httpResponse(req.url, status: 304))
        }
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: transport, token: "tok")
        let first = try await api.folder("/Users/me/Projects/lumen", hidden: true, etag: nil)
        let folder = try XCTUnwrap(first?.folder)
        XCTAssertEqual(first?.etag, "\"v1\"")
        XCTAssertEqual(folder.entries.map(\.name), ["docs-link", "node_modules", "src", "token-copy", "app.ts"])
        XCTAssertEqual(folder.entries.map(\.isFolder), [true, true, true, false, false])
        XCTAssertTrue(folder.entries[1].dim)
        XCTAssertTrue(folder.entries[3].locked)
        XCTAssertEqual(folder.hiddenCount, 2)
        XCTAssertFalse(folder.scoped)
        let url = try XCTUnwrap(transport.requests.first?.url)
        XCTAssertEqual(url.path, "/files")
        XCTAssertEqual(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems, [URLQueryItem(name: "path", value: "/Users/me/Projects/lumen"), URLQueryItem(name: "hidden", value: "1")])
        // Asked again with that version: unchanged is nil.
        let again = try await api.folder("/Users/me/Projects/lumen", hidden: true, etag: "\"v1\"")
        XCTAssertNil(again)
        XCTAssertEqual(transport.requests.last?.value(forHTTPHeaderField: "If-None-Match"), "\"v1\"")
        // No path: where the Mac starts this device (its home, or its scope's first folder).
        _ = try? await api.folder(nil, hidden: false, etag: nil)
        XCTAssertNil(transport.requests.last?.url?.query)
    }

    func testAPathWithAPlusOrASpaceReachesTheMacAsWritten() {
        let url = lan.url(["files", "stat"], query: [URLQueryItem(name: "path", value: "/Users/me/c++ notes/a&b=c.md")])
        XCTAssertEqual(url.query(percentEncoded: true), "path=/Users/me/c%2B%2B%20notes/a%26b%3Dc.md")
        XCTAssertEqual(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first?.value, "/Users/me/c++ notes/a&b=c.md")
    }

    func testDetailsSayWhatMayHoldAPassword() throws {
        let env = try JSONDecoder().decode(MacFileDetails.self, from: Data(#"{"name":".env","kind":"file","size":48,"mtime":1,"hidden":true,"path":"/Users/me/p/.env","type":"text","lines":3,"sensitive":{"reason":"env"}}"#.utf8))
        XCTAssertEqual(env.sensitive, "env")
        XCTAssertEqual(env.type, .text)
        XCTAssertEqual(env.lines, 3)
        XCTAssertFalse(env.isFolder)
        let folder = try JSONDecoder().decode(MacFileDetails.self, from: Data(#"{"name":"src","kind":"dir","size":0,"mtime":1,"hidden":false,"path":"/p/src","items":4}"#.utf8))
        XCTAssertTrue(folder.isFolder)
        XCTAssertNil(folder.sensitive)
        XCTAssertNil(folder.type)
    }

    func testPreviewThumbnailAndRefusals() async throws {
        let transport = FakeTransport { req, _ in
            switch req.url?.path {
            case "/files/preview": return (Data(#"{"text":"a\nb\n","truncated":false,"lines":2,"size":4}"#.utf8), httpResponse(req.url))
            case "/files/thumbnail": return (Data([0xFF, 0xD8]), httpResponse(req.url, contentType: "image/jpeg"))
            case "/files/stat": return (Data(#"{"error":"scope"}"#.utf8), httpResponse(req.url, status: 403))
            default: return (Data(#"{"error":"not found"}"#.utf8), httpResponse(req.url, status: 404))
            }
        }
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: transport, token: "tok")
        let preview = try await api.filePreview("/p/a.txt")
        XCTAssertEqual(preview, MacFilePreview(text: "a\nb\n", truncated: false, lines: 2, size: 4))
        let thumb = try await api.fileThumbnail("/p/a.png")
        XCTAssertEqual(thumb, Data([0xFF, 0xD8]))
        do { _ = try await api.fileDetails("/elsewhere"); XCTFail("refused") } catch {
            XCTAssertEqual(FileRefusal.of(error), .scope)
            XCTAssertEqual(FileRefusal.of(error)?.sentence(mac: "Mac mini"), "此文件夹不在 Mac mini 给这台设备的授权范围内。")
        }
        // A Mac from before the Files routes: the remote listener's own 404.
        do { _ = try await api.folder("/p", hidden: false, etag: nil); XCTFail("refused") } catch {
            XCTAssertEqual(FileRefusal.of(error), .unsupported)
        }
        XCTAssertNil(FileRefusal.of(APIError.transport("offline")))
        XCTAssertEqual(FileRefusal.filesOff.sentence(mac: "Mac mini"), "Mac mini 不允许配对的设备读取文件。可在 Mac mini 的“设置 › Nodes”中打开。")
    }

    func testADownloadWritesTheBytesAndSaysHowFarItHasCome() async throws {
        let body = Data(repeating: 7, count: 10_000)
        let transport = FakeTransport(stream: { req, _ in
            (HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Length": "10000"])!,
             [body.prefix(4000), body.dropFirst(4000)], nil)
        })
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: transport, token: "tok")
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("files-test-\(UUID().uuidString).bin")
        defer { try? FileManager.default.removeItem(at: file) }
        let seen = LockedBox<[Double]>([])
        try await api.downloadFile("/p/big.bin", to: file, progress: { p in seen.withLock { $0.append(p) } })
        XCTAssertEqual(try Data(contentsOf: file), body)
        XCTAssertEqual(seen.value.first, 0)
        XCTAssertEqual(seen.value.last, 1)
        XCTAssertTrue(seen.value.contains(0.4))
        XCTAssertEqual(transport.requests.first?.url?.path, "/files/content")
        // Refused: the error, and nothing left behind.
        let refusing = FakeTransport(stream: { req, _ in (httpResponse(req.url, status: 413), [Data(#"{"error":"too-large"}"#.utf8)], nil) })
        let api2 = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: refusing, token: "tok")
        do { try await api2.downloadFile("/p/huge.bin", to: file, progress: { _ in }); XCTFail("refused") } catch {
            XCTAssertEqual(FileRefusal.of(error), .tooLarge)
        }
    }

    func testAReplyNamesAMacFileByWhereItIs() async throws {
        let transport = FakeTransport { req, _ in (Data(#"{"ok":true,"sealed":0,"attached":2}"#.utf8), httpResponse(req.url)) }
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: transport, token: "tok")
        _ = try await api.sendTerminalInput("t1", text: "看 [File #1] 和 [Image #2]", sealed: false,
                                            attachments: [TerminalAttachmentRef(token: "[File #1]", path: "/Users/me/p/app.ts"),
                                                          TerminalAttachmentRef(token: "[Image #2]", upload: "abc123def456")])
        let body = try XCTUnwrap(transport.requests.first?.httpBody.flatMap { try JSONSerialization.jsonObject(with: $0) as? [String: Any] })
        XCTAssertEqual(body["attachments"] as? [[String: String]], [["token": "[File #1]", "path": "/Users/me/p/app.ts"], ["token": "[Image #2]", "upload": "abc123def456"]])
    }

    func testPathsAreTakenApartAsTheMacWritesThem() {
        XCTAssertEqual(MacPath.levels("/Users/me/p").map(\.name), ["/", "Users", "me", "p"])
        XCTAssertEqual(MacPath.levels("/Users/me/p").map(\.path), ["/", "/Users", "/Users/me", "/Users/me/p"])
        XCTAssertEqual(MacPath.levels("/").map(\.path), ["/"])
        XCTAssertEqual(MacPath.join("/", "Users"), "/Users")
        XCTAssertEqual(MacPath.join("/Users", "me"), "/Users/me")
        XCTAssertEqual(MacPath.parent("/Users/me"), "/Users")
        XCTAssertEqual(MacPath.parent("/Users"), "/")
        XCTAssertNil(MacPath.parent("/"))
        XCTAssertEqual(MacPath.name("/Users/me/p"), "p")
        XCTAssertEqual(MacPath.short("/Users/me/p", home: "/Users/me"), "~/p")
        XCTAssertEqual(MacPath.short("/Users/meow", home: "/Users/me"), "/Users/meow")
    }

    func testSortingKeepsFoldersFirst() {
        let entries = [MacFileEntry(name: "src", kind: .dir, mtime: 1), MacFileEntry(name: "a.ts", kind: .file, size: 10, mtime: 5),
                       MacFileEntry(name: "b.md", kind: .file, size: 300, mtime: 9), MacFileEntry(name: "c.ts", kind: .file, size: 20, mtime: 2)]
        XCTAssertEqual(FileSort.name.sorted(entries).map(\.name), ["src", "a.ts", "b.md", "c.ts"])
        XCTAssertEqual(FileSort.modified.sorted(entries).map(\.name), ["src", "b.md", "a.ts", "c.ts"])
        XCTAssertEqual(FileSort.size.sorted(entries).map(\.name), ["src", "b.md", "c.ts", "a.ts"])
        XCTAssertEqual(FileSort.kind.sorted(entries).map(\.name), ["src", "b.md", "a.ts", "c.ts"])
    }

    func testTheWarningNamesWhatMayHoldAPassword() {
        XCTAssertEqual(SensitiveWarning.message([".env"]), ".env 可能含有密码或密钥。交给 agent 后，它能读到其中的内容，并可能发给模型的服务商。")
        XCTAssertEqual(SensitiveWarning.message([".env", "id_ed25519"]), "这 2 个文件可能含有密码或密钥：.env、id_ed25519。交给 agent 后，它能读到其中的内容，并可能发给模型的服务商。")
    }

    func testSizesAreShortInTheMacsUnits() {
        XCTAssertEqual(FileSize.short(0), "0 B")
        XCTAssertEqual(FileSize.short(238), "238 B")
        XCTAssertEqual(FileSize.short(2140), "2.1 KB")
        XCTAssertEqual(FileSize.short(40_000), "39 KB")
        XCTAssertEqual(FileSize.short(1_240_000), "1.2 MB")
        XCTAssertEqual(FileSize.short(48_200_000), "46 MB")
        XCTAssertEqual(FileSize.short(3_000_000_000), "2.8 GB")
    }

    func testTimesAreShort() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Shanghai")!
        let now = calendar.date(from: DateComponents(year: 2026, month: 10, day: 16, hour: 21))!
        let ms = { (d: DateComponents) in calendar.date(from: d)!.timeIntervalSince1970 * 1000 }
        XCTAssertEqual(FileTime.short(ms(DateComponents(year: 2026, month: 10, day: 16, hour: 13, minute: 2)), now: now, calendar: calendar), "Today 13:02")
        XCTAssertEqual(FileTime.short(ms(DateComponents(year: 2026, month: 10, day: 15, hour: 9)), now: now, calendar: calendar), "Yesterday")
        XCTAssertEqual(FileTime.short(ms(DateComponents(year: 2026, month: 9, day: 2)), now: now, calendar: calendar), "9/2")
        XCTAssertEqual(FileTime.short(ms(DateComponents(year: 2025, month: 12, day: 31)), now: now, calendar: calendar), "2025/12/31")
        XCTAssertEqual(FileTime.short(0, now: now, calendar: calendar), "")
    }
}
