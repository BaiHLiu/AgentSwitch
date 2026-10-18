import Foundation

// Changing the Mac's files from the phone (docs/files-v0.md §12.3, §12.8): `POST /files/folder`, `/files/file`,
// `/files/rename`, `/files/trash`, and `PUT /files/content` — a file of this phone's sent into a folder on the Mac. A
// refusal is a `FileChangeError`: the Mac's code, and what it named with it (the terminals running in a folder, what
// the Trash would not take).

/// What `newFolder` / `newFile` made: the path asked for, and the first folder that had to be made on the way.
public struct MacMade: Decodable, Sendable, Equatable {
    public let path: String
    public let top: String
    public init(path: String, top: String) { self.path = path; self.top = top }
}

/// One item moved to the Mac's Trash: where it was, and where it went (nil when that could not be told).
public struct MacMoved: Decodable, Sendable, Equatable {
    public let path: String
    public let trashed: String?
    public init(path: String, trashed: String?) { self.path = path; self.trashed = trashed }
}

/// A file landed on the Mac: where (its name may be another, with `keep`), and how big.
public struct MacUploaded: Decodable, Sendable, Equatable {
    public let path: String
    public let name: String
    public let size: Int64
    public init(path: String, name: String, size: Int64) { self.path = path; self.name = name; self.size = size }
}

/// When a file sent in has the name of one already there (Finder's three answers, files-v0 §12.8).
public enum UploadConflict: String, Sendable, Equatable {
    /// Refused (409 `exists`).
    case fail
    /// The one there goes to the Mac's Trash.
    case replace
    /// The new one is named `x 2`.
    case keep
}

/// Why the Mac did not change what was asked.
public struct FileChangeError: Error, Equatable, LocalizedError {
    /// The terminal running in a folder that was to move.
    public struct Terminal: Decodable, Sendable, Equatable {
        public let id: String
        public let name: String
        public init(id: String, name: String) { self.id = id; self.name = name }
    }

    public let refusal: FileRefusal?
    /// The Mac's own words when they are not one of the codes.
    public let message: String
    public let terminals: [Terminal]
    /// What the Trash would not take (`no-trash`).
    public let paths: [String]
    public let status: Int

    public init(refusal: FileRefusal?, message: String = "", terminals: [Terminal] = [], paths: [String] = [], status: Int = 0) {
        self.refusal = refusal
        self.message = message
        self.terminals = terminals
        self.paths = paths
        self.status = status
    }

    public var errorDescription: String? { message.isEmpty ? refusal?.rawValue : message }
}

/// The checks a name gets as it is typed (files-v0 §12.2): the same sentences the Mac's column writes.
public enum FileNames {
    public enum Check: Equatable {
        case ok
        /// Allowed, said in amber.
        case warning(String)
        /// Not allowed, said in red.
        case error(String)

        public var allowed: Bool { if case .error = self { return false } else { return true } }
        public var sentence: String? {
            switch self {
            case .ok: return nil
            case .warning(let s), .error(let s): return s
            }
        }
    }

    /// `value` for a new item in a folder holding `taken` (its names), or as the new name of the item named `renaming`.
    /// A new item's name may have `/` (folders on the way); a new name may not.
    public static func check(_ value: String, taken: Set<String>, renaming: String? = nil) -> Check {
        let name = value.trimmingCharacters(in: .whitespaces)
        if name.isEmpty { return .error("请输入名称。") }
        if renaming != nil && name.contains("/") { return .error("名称不能包含“/”。") }
        let parts = name.split(separator: "/").map(String.init)
        if parts.contains(where: { $0 == "." || $0 == ".." }) { return .error("名称不能是“.”或“..”。") }
        if parts.contains(where: { $0.utf8.count > 255 }) || name.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f }) {
            return .error("此名称不能使用。")
        }
        // One name: taken here, case aside (a Mac's disk does not tell `Docs` from `docs`); a new name differing only in
        // case is a rename. Folders on the way (`a/b.ts`) may be there already: the Mac finds the rest.
        if parts.count == 1, let clash = taken.first(where: { $0.caseInsensitiveCompare(name) == .orderedSame }), clash != renaming {
            return .error("此位置已有“\(clash)”。请换一个名称。")
        }
        if value != value.trimmingCharacters(in: .whitespaces) { return .warning("名称前后有空格。") }
        return .ok
    }

    /// `IMG_0412 2.HEIC`: the name Finder gives the second of two (`Keep Both`).
    public static func keepBoth(_ name: String, taken: Set<String>) -> String {
        let ext = (name as NSString).pathExtension
        let stem = ext.isEmpty || name.hasPrefix(".") && !name.dropFirst().contains(".") ? name : String(name.dropLast(ext.count + 1))
        let tail = stem == name ? "" : ".\(ext)"
        var k = 2
        while taken.contains("\(stem) \(k)\(tail)") { k += 1 }
        return "\(stem) \(k)\(tail)"
    }
}

extension AgentSwitchAPI {
    /// The most of one file the phone sends to the Mac, and fetches to share on (files-v0 §12.3, §12.8).
    public static let maxFileShare: Int64 = 200 * 1024 * 1024

    private struct PathBody: Encodable { let path: String }
    private struct RenameBody: Encodable { let path: String; let name: String; let force: Bool? }
    private struct TrashBody: Encodable { let paths: [String]; let force: Bool?; let permanent: Bool? }
    private struct Renamed: Decodable { let path: String }
    private struct TrashReply: Decodable { let moved: [MacMoved] }
    private struct RefusalBody: Decodable {
        let error: String?
        let terminals: [FileChangeError.Terminal]?
        let paths: [String]?
    }

    public func newFolder(_ path: String) async throws -> MacMade { try await change(["files", "folder"], PathBody(path: path)) }

    public func newFile(_ path: String) async throws -> MacMade { try await change(["files", "file"], PathBody(path: path)) }

    public func rename(_ path: String, to name: String, force: Bool) async throws -> String {
        let r: Renamed = try await change(["files", "rename"], RenameBody(path: path, name: name, force: force ? true : nil))
        return r.path
    }

    public func trash(_ paths: [String], force: Bool, permanent: Bool) async throws -> [MacMoved] {
        let r: TrashReply = try await change(["files", "trash"], TrashBody(paths: paths, force: force ? true : nil, permanent: permanent ? true : nil))
        return r.moved
    }

    public func upload(_ file: URL, to path: String, conflict: UploadConflict, progress: @escaping @Sendable (Double) -> Void) async throws -> MacUploaded {
        let endpoint = try await endpoints.endpoint()
        let query = [URLQueryItem(name: "path", value: path), URLQueryItem(name: "conflict", value: conflict.rawValue)]
        var req = request("PUT", endpoint, ["files", "content"], query: query, body: nil, timeout: Self.fileSendTimeout)
        req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        do {
            let (data, response) = try await transport.upload(req, fromFile: file, progress: progress)
            try Self.checkChange(data, response)
            do { return try JSONDecoder().decode(MacUploaded.self, from: data) } catch { throw APIError.decoding(String(describing: error)) }
        } catch let error as APIError {
            if error.isNetworkFailure { await endpoints.reportFailure(endpoint) }
            throw error
        }
    }

    /// The longest one file may take to go (200 MB over a slow link).
    static let fileSendTimeout: TimeInterval = 30 * 60

    /// A JSON change, sent once; a refusal with what it named.
    private func change<T: Decodable, B: Encodable>(_ path: [String], _ body: B) async throws -> T {
        let endpoint = try await endpoints.endpoint()
        let data: Data
        do { data = try JSONEncoder().encode(body) } catch { throw APIError.decoding("request body: \(error)") }
        let (reply, response): (Data, HTTPURLResponse)
        do {
            (reply, response) = try await transport.send(request("POST", endpoint, path, query: [], body: data))
        } catch let error as APIError {
            if error.isNetworkFailure { await endpoints.reportFailure(endpoint) }
            throw error
        }
        try Self.checkChange(reply, response)
        do { return try JSONDecoder().decode(T.self, from: reply) } catch { throw APIError.decoding(String(describing: error)) }
    }

    /// 2xx passes; 401 is `.unauthorized`; a refusal is a `FileChangeError` (an older Mac's 404 for a route it does
    /// not have: `.unsupported`).
    static func checkChange(_ data: Data, _ response: HTTPURLResponse) throws {
        switch response.statusCode {
        case 200..<300: return
        case 401: throw APIError.unauthorized
        default:
            let body = try? JSONDecoder().decode(RefusalBody.self, from: data)
            let code = body?.error ?? ""
            let refusal = FileRefusal(rawValue: code) ?? (response.statusCode == 404 && code.isEmpty ? .unsupported : nil)
            throw FileChangeError(refusal: refusal, message: refusal == nil ? code : "", terminals: body?.terminals ?? [], paths: body?.paths ?? [], status: response.statusCode)
        }
    }
}
