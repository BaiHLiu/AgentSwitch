import Foundation

// The Mac's Files routes (docs/files-v0.md §7.1): `GET /files` (a level, versioned: an unchanged one is a 304),
// `/files/stat`, `/files/preview`, `/files/thumbnail`, `/files/content`. A path goes as the `path` query, as written on
// the Mac. A refusal is `APIError.http` with the code as its message (`FileRefusal.of`).

extension AgentSwitchAPI: MacFileSource {
    /// The most of one file the Mac gives a phone: what is bigger is not asked for (it would answer 413).
    public static let maxFileDownload: Int64 = 25 * 1024 * 1024

    private static func pathQuery(_ path: String?) -> [URLQueryItem] { path.map { [URLQueryItem(name: "path", value: $0)] } ?? [] }

    public func folder(_ path: String?, hidden: Bool, etag: String?) async throws -> (folder: MacFolder, etag: String?)? {
        let query = Self.pathQuery(path) + (hidden ? [URLQueryItem(name: "hidden", value: "1")] : [])
        do {
            return try await versioned(["files"], query: query, etag: etag)
        } catch APIError.transport {
            return try await versioned(["files"], query: query, etag: etag)
        }
    }

    public func fileDetails(_ path: String) async throws -> MacFileDetails { try await get(["files", "stat"], query: Self.pathQuery(path)) }

    public func filePreview(_ path: String) async throws -> MacFilePreview { try await get(["files", "preview"], query: Self.pathQuery(path)) }

    public func fileThumbnail(_ path: String) async throws -> Data { try await bytes(["files", "thumbnail"], query: Self.pathQuery(path)) }

    public func downloadFile(_ path: String, to file: URL, progress: @escaping @Sendable (Double) -> Void) async throws {
        let endpoint = try await endpoints.endpoint()
        let req = request("GET", endpoint, ["files", "content"], query: Self.pathQuery(path), body: nil, accept: "*/*", timeout: Self.uploadTimeout)
        do {
            let (response, body) = try await transport.stream(req)
            guard (200..<300).contains(response.statusCode) else {
                var data = Data()
                for try await chunk in body { data.append(chunk); if data.count > 4096 { break } }
                try Self.check(data, response)
                return
            }
            let total = Double(response.expectedContentLength > 0 ? response.expectedContentLength : 0)
            FileManager.default.createFile(atPath: file.path, contents: nil, attributes: [.protectionKey: FileProtectionType.complete])
            let handle = try FileHandle(forWritingTo: file)
            defer { try? handle.close() }
            var got = 0.0
            progress(0)
            for try await chunk in body {
                try handle.write(contentsOf: chunk)
                got += Double(chunk.count)
                if total > 0 { progress(min(1, got / total)) }
            }
            progress(1)
        } catch let error as APIError {
            if error.isNetworkFailure { await endpoints.reportFailure(endpoint) }
            try? FileManager.default.removeItem(at: file)
            throw error
        } catch {
            try? FileManager.default.removeItem(at: file)
            throw error
        }
    }

    /// A JSON GET sent with the version the screen has (`If-None-Match`): nil when the Mac says it is unchanged.
    func versioned<T: Decodable>(_ path: [String], query: [URLQueryItem], etag: String?) async throws -> (folder: T, etag: String?)? {
        let endpoint = try await endpoints.endpoint()
        var req = request("GET", endpoint, path, query: query, body: nil)
        if let etag { req.setValue(etag, forHTTPHeaderField: "If-None-Match") }
        let (data, response): (Data, HTTPURLResponse)
        do {
            (data, response) = try await transport.send(req)
        } catch let error as APIError {
            if error.isNetworkFailure { await endpoints.reportFailure(endpoint) }
            throw error
        }
        if response.statusCode == 304 { return nil }
        let value: T = try Self.decode(data, response)
        return (value, response.value(forHTTPHeaderField: "ETag"))
    }

    /// A file's bytes as they are, with a query.
    func bytes(_ segments: [String], query: [URLQueryItem]) async throws -> Data {
        let endpoint = try await endpoints.endpoint()
        do {
            let (data, response) = try await transport.send(request("GET", endpoint, segments, query: query, body: nil, accept: "*/*", timeout: Self.uploadTimeout))
            try Self.check(data, response)
            return data
        } catch let error as APIError {
            if error.isNetworkFailure { await endpoints.reportFailure(endpoint) }
            throw error
        }
    }
}
