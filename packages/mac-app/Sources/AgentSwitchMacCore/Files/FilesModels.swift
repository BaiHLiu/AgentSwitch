import Foundation

// The Files column's reads (docs/files-v0.md §7.1; daemon src/files/browse.ts): one folder's level, one entry, the
// start of a text file. The service holds the rules — AgentSwitch's own credential places locked, a paired device held
// to its scope — and says them in these.

/// One entry of a folder, as `GET /files` lists it.
public struct FileEntry: Decodable, Equatable, Hashable, Sendable {
    public enum Kind: String, Decodable, Sendable { case dir, file, link, other }

    public struct Link: Decodable, Equatable, Hashable, Sendable {
        public enum Kind: String, Decodable, Sendable { case dir, file, other, missing }
        public let target: String
        public let kind: Kind
        public init(target: String, kind: Kind) { self.target = target; self.kind = kind }
    }

    public let name: String
    public let kind: Kind
    /// Bytes; a folder's is 0.
    public let size: Int64
    /// Last modified, ms since the epoch.
    public let mtime: Double
    public let hidden: Bool
    /// What tools keep (`.git`, `node_modules`, …): a step fainter.
    public let dim: Bool
    /// One of AgentSwitch's own credential places: its name and a lock, nothing more.
    public let locked: Bool
    /// Never renamed or moved to the Trash from the column (docs/files-v0.md §12.2): it holds one of AgentSwitch's
    /// places (the home folder, `~/.agentswitch`), or it is right under `/`.
    public let fixed: Bool
    public let link: Link?

    public init(name: String, kind: Kind, size: Int64 = 0, mtime: Double = 0, hidden: Bool? = nil, dim: Bool = false, locked: Bool = false, fixed: Bool = false, link: Link? = nil) {
        self.name = name
        self.kind = kind
        self.size = size
        self.mtime = mtime
        self.hidden = hidden ?? name.hasPrefix(".")
        self.dim = dim
        self.locked = locked
        self.fixed = fixed
        self.link = link
    }

    private enum Keys: String, CodingKey { case name, kind, size, mtime, hidden, dim, locked, fixed, link }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        name = try c.decode(String.self, forKey: .name)
        kind = (try? c.decode(Kind.self, forKey: .kind)) ?? .other
        size = (try? c.decode(Int64.self, forKey: .size)) ?? 0
        mtime = (try? c.decode(Double.self, forKey: .mtime)) ?? 0
        hidden = (try? c.decode(Bool.self, forKey: .hidden)) ?? name.hasPrefix(".")
        dim = (try? c.decode(Bool.self, forKey: .dim)) ?? false
        locked = (try? c.decode(Bool.self, forKey: .locked)) ?? false
        fixed = (try? c.decode(Bool.self, forKey: .fixed)) ?? false
        link = try? c.decode(Link.self, forKey: .link)
    }

    /// Renamed and moved to the Trash from the column: neither one of AgentSwitch's places nor a folder holding one.
    public var changeable: Bool { !locked && !fixed }

    /// A folder, or a link to one: it has a level of its own.
    public var isFolder: Bool { kind == .dir || (kind == .link && link?.kind == .dir) }
    /// When it was last changed.
    public var modified: Date { Date(timeIntervalSince1970: mtime / 1000) }
}

/// One folder's level (`GET /files`).
public struct FileLevel: Decodable, Equatable, Sendable {
    public let path: String
    public let parent: String?
    public let home: String
    public let entries: [FileEntry]
    /// How many more there are than the limit let through.
    public let more: Int
    /// How many hidden ones were left out.
    public let hiddenCount: Int
    /// Only the way into the device's scope is listed here (a level above its folders).
    public let scoped: Bool

    public init(path: String, parent: String?, home: String, entries: [FileEntry], more: Int = 0, hiddenCount: Int = 0, scoped: Bool = false) {
        self.path = path
        self.parent = parent
        self.home = home
        self.entries = entries
        self.more = more
        self.hiddenCount = hiddenCount
        self.scoped = scoped
    }

    private enum Keys: String, CodingKey { case path, parent, home, entries, more, hiddenCount, scoped }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        path = try c.decode(String.self, forKey: .path)
        parent = try? c.decode(String.self, forKey: .parent)
        home = (try? c.decode(String.self, forKey: .home)) ?? NSHomeDirectory()
        entries = (try? c.decode([FileEntry].self, forKey: .entries)) ?? []
        more = (try? c.decode(Int.self, forKey: .more)) ?? 0
        hiddenCount = (try? c.decode(Int.self, forKey: .hiddenCount)) ?? 0
        scoped = (try? c.decode(Bool.self, forKey: .scoped)) ?? false
    }
}

/// What kind of file, as the service tells it (by name, or by its first bytes).
public enum FileKind: String, Decodable, Sendable { case text, image, pdf, audio, video, archive, binary }

/// One entry's details (`GET /files/stat`).
public struct FileDetails: Decodable, Equatable, Sendable {
    public let entry: FileEntry
    public let path: String
    /// Where it really is, when that is not `path`.
    public let real: String?
    public let type: FileKind?
    public let lines: Int?
    /// A folder's entries, hidden ones too.
    public let items: Int?
    /// Why it may hold a password or a key (`ssh`, `env`, `login`, …); nil: nothing says so.
    public let sensitive: String?

    public init(entry: FileEntry, path: String, real: String? = nil, type: FileKind? = nil, lines: Int? = nil, items: Int? = nil, sensitive: String? = nil) {
        self.entry = entry
        self.path = path
        self.real = real
        self.type = type
        self.lines = lines
        self.items = items
        self.sensitive = sensitive
    }

    private enum Keys: String, CodingKey { case path, real, type, lines, items, sensitive }
    private struct Reason: Decodable { let reason: String }

    public init(from decoder: Decoder) throws {
        entry = try FileEntry(from: decoder)
        let c = try decoder.container(keyedBy: Keys.self)
        path = try c.decode(String.self, forKey: .path)
        real = try? c.decode(String.self, forKey: .real)
        type = try? c.decode(FileKind.self, forKey: .type)
        lines = try? c.decode(Int.self, forKey: .lines)
        items = try? c.decode(Int.self, forKey: .items)
        sensitive = (try? c.decode(Reason.self, forKey: .sensitive))?.reason
    }
}

/// The start of a text file (`GET /files/preview`).
public struct FileTextPreview: Decodable, Equatable, Sendable {
    public let text: String
    public let truncated: Bool
    public let lines: Int?
    public let size: Int64

    public init(text: String, truncated: Bool, lines: Int?, size: Int64) {
        self.text = text
        self.truncated = truncated
        self.lines = lines
        self.size = size
    }
}

/// A paired device's reach on this Mac's files (docs/files-v0.md §7.5; `PUT /devices/:id/files`).
public struct FileScope: Codable, Equatable, Hashable, Sendable {
    public enum Mode: String, Codable, CaseIterable, Sendable { case home, all, folders, none }
    public var mode: Mode
    public var folders: [String]

    public init(mode: Mode, folders: [String] = []) {
        self.mode = mode
        self.folders = folders
    }

    public static let home = FileScope(mode: .home)

    private enum Keys: String, CodingKey { case mode, folders }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        mode = (try? c.decode(Mode.self, forKey: .mode)) ?? .home
        folders = (try? c.decode([String].self, forKey: .folders)) ?? []
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(mode, forKey: .mode)
        if mode == .folders { try c.encode(folders, forKey: .folders) }
    }

    /// The pop-up menu's word (ui-v0 §7).
    public static func word(_ mode: Mode) -> String {
        switch mode {
        case .home: "Home Folder"
        case .all: "All Files"
        case .folders: "Selected Folders"
        case .none: "None"
        }
    }
}

/// Why the service would not read something, in the column's words (docs/files-v0.md §3.3, §7.5).
public enum FilesRefusal: Equatable, Sendable {
    case locked, scope, filesOff, permission, notFound, notFolder, tooLarge, other(String)

    /// From the service's `{error: <code>}`.
    public init(code: String) {
        switch code {
        case "locked": self = .locked
        case "scope": self = .scope
        case "files-off": self = .filesOff
        case "permission": self = .permission
        case "not-found": self = .notFound
        case "not-folder": self = .notFolder
        case "too-large": self = .tooLarge
        default: self = .other(code)
        }
    }

    /// From an error the client threw: the service's refusal, or what went wrong on the way.
    public init(_ error: Error) {
        if case .http(_, let message)? = error as? DaemonError { self.init(code: message) }
        else { self = .other((error as? DaemonError)?.reason ?? error.localizedDescription) }
    }

    /// The sentence the column shows. `node`: whose files these are, for a paired device's refusals.
    public func sentence(node: String = "这台 Mac") -> String {
        switch self {
        case .locked: "此处存放 AgentSwitch 的凭据，无法在此打开。"
        case .scope: "此文件夹不在 \(node) 给这台设备的授权范围内。"
        case .filesOff: "\(node) 不允许配对的设备读取文件。可在 \(node) 的“设置 › Nodes”中打开。"
        case .permission: "AgentSwitch 无权访问此文件夹。可在“系统设置 › 隐私与安全性 › 文件与文件夹”中允许。"
        case .notFound: "此文件夹已不存在。"
        case .notFolder: "这不是文件夹。"
        case .tooLarge: "文件超过 25 MB，未下载。"
        case .other(let why): why
        }
    }
}
