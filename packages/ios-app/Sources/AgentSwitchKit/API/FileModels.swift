import Foundation

// The Mac's files as the Files tab and `+` › Files on Mac show them (docs/files-v0.md §5, §7): one folder's level, one
// entry's details, the start of a text file. Read only; what the phone gives an agent is a path on the Mac
// (`TerminalAttachmentRef.path`), never a copy.

/// One entry of a folder (`GET /files`).
public struct MacFileEntry: Decodable, Sendable, Equatable, Identifiable {
    public enum Kind: String, Decodable, Sendable { case dir, file, link, other }
    /// A symbolic link: where it points and what is there (`dir`, `file`, `other`, `missing`).
    public struct Link: Decodable, Sendable, Equatable {
        public let target: String
        public let kind: String
        public init(target: String, kind: String) { self.target = target; self.kind = kind }
    }

    public let name: String
    public let kind: Kind
    /// Bytes; a folder's is 0.
    public let size: Int64
    /// Last modified, ms since the epoch.
    public let mtime: Double
    public let hidden: Bool
    /// What tools keep (`.git`, `node_modules`): a step fainter.
    public let dim: Bool
    /// One of AgentSwitch's own credential places: its name only, it cannot be opened.
    public let locked: Bool
    /// Not renamed or moved to the Trash from here (docs/files-v0.md §12.2): it holds AgentSwitch's places (the home
    /// folder), or it is right under `/`. A locked one is never changed either.
    public let fixed: Bool
    public let link: Link?

    public var id: String { name }
    /// May be renamed and moved to the Trash from the phone.
    public var changeable: Bool { !locked && !fixed }
    /// A folder, or a link to one: it opens as a folder.
    public var isFolder: Bool { kind == .dir || (kind == .link && link?.kind == "dir") }

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

    private enum CodingKeys: String, CodingKey { case name, kind, size, mtime, hidden, dim, locked, fixed, link }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        kind = (try? c.decode(Kind.self, forKey: .kind)) ?? .other
        size = (try? c.decodeIfPresent(Int64.self, forKey: .size)) ?? 0
        mtime = (try? c.decodeIfPresent(Double.self, forKey: .mtime)) ?? 0
        hidden = (try? c.decodeIfPresent(Bool.self, forKey: .hidden)) ?? name.hasPrefix(".")
        dim = (try? c.decodeIfPresent(Bool.self, forKey: .dim)) ?? false
        locked = (try? c.decodeIfPresent(Bool.self, forKey: .locked)) ?? false
        fixed = (try? c.decodeIfPresent(Bool.self, forKey: .fixed)) ?? false
        link = try? c.decodeIfPresent(Link.self, forKey: .link)
    }
}

/// One folder's level.
public struct MacFolder: Decodable, Sendable, Equatable {
    public let path: String
    public let parent: String?
    /// The Mac user's home folder.
    public let home: String
    public let entries: [MacFileEntry]
    /// How many more there are than the Mac listed.
    public let more: Int
    /// Hidden entries left out (asked without them).
    public let hiddenCount: Int
    /// Only what leads into this device's scope is listed here (docs/files-v0.md §7.5).
    public let scoped: Bool

    public init(path: String, parent: String?, home: String, entries: [MacFileEntry], more: Int = 0, hiddenCount: Int = 0, scoped: Bool = false) {
        self.path = path
        self.parent = parent
        self.home = home
        self.entries = entries
        self.more = more
        self.hiddenCount = hiddenCount
        self.scoped = scoped
    }

    private enum CodingKeys: String, CodingKey { case path, parent, home, entries, more, hiddenCount, scoped }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        path = try c.decode(String.self, forKey: .path)
        parent = try c.decodeIfPresent(String.self, forKey: .parent)
        home = (try? c.decodeIfPresent(String.self, forKey: .home)) ?? "/"
        entries = try c.decode([MacFileEntry].self, forKey: .entries)
        more = (try? c.decodeIfPresent(Int.self, forKey: .more)) ?? 0
        hiddenCount = (try? c.decodeIfPresent(Int.self, forKey: .hiddenCount)) ?? 0
        scoped = (try? c.decodeIfPresent(Bool.self, forKey: .scoped)) ?? false
    }

    /// The same level with its entries in another order.
    public func with(entries: [MacFileEntry]) -> MacFolder {
        MacFolder(path: path, parent: parent, home: home, entries: entries, more: more, hiddenCount: hiddenCount, scoped: scoped)
    }
}

/// What kind of file (`GET /files/stat`'s `type`).
public enum MacFileType: String, Decodable, Sendable { case text, image, pdf, audio, video, archive, binary }

/// One entry's details (`GET /files/stat`).
public struct MacFileDetails: Decodable, Sendable, Equatable {
    public let name: String
    public let kind: MacFileEntry.Kind
    public let size: Int64
    public let mtime: Double
    public let path: String
    public let type: MacFileType?
    /// A text file's lines, when it is small enough for the Mac to count.
    public let lines: Int?
    /// A folder's entries.
    public let items: Int?
    /// Why it may hold a password or a key (`ssh`, `env`, `login`, `key`, …); nil when it is not thought to.
    public let sensitive: String?
    public let link: MacFileEntry.Link?
    /// Not renamed or moved from here (`MacFileEntry.fixed`).
    public let fixed: Bool

    public var isFolder: Bool { items != nil || kind == .dir }

    public init(name: String, kind: MacFileEntry.Kind, size: Int64, mtime: Double, path: String, type: MacFileType? = nil, lines: Int? = nil,
                items: Int? = nil, sensitive: String? = nil, link: MacFileEntry.Link? = nil, fixed: Bool = false) {
        self.fixed = fixed
        self.name = name
        self.kind = kind
        self.size = size
        self.mtime = mtime
        self.path = path
        self.type = type
        self.lines = lines
        self.items = items
        self.sensitive = sensitive
        self.link = link
    }

    private enum CodingKeys: String, CodingKey { case name, kind, size, mtime, path, type, lines, items, sensitive, link, fixed }
    private struct Sensitive: Decodable { let reason: String }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        kind = (try? c.decode(MacFileEntry.Kind.self, forKey: .kind)) ?? .other
        size = (try? c.decodeIfPresent(Int64.self, forKey: .size)) ?? 0
        mtime = (try? c.decodeIfPresent(Double.self, forKey: .mtime)) ?? 0
        path = try c.decode(String.self, forKey: .path)
        type = try? c.decodeIfPresent(MacFileType.self, forKey: .type)
        lines = try? c.decodeIfPresent(Int.self, forKey: .lines)
        items = try? c.decodeIfPresent(Int.self, forKey: .items)
        sensitive = (try? c.decodeIfPresent(Sensitive.self, forKey: .sensitive))?.reason
        link = try? c.decodeIfPresent(MacFileEntry.Link.self, forKey: .link)
        fixed = (try? c.decodeIfPresent(Bool.self, forKey: .fixed)) ?? false
    }
}

/// The start of a text file (`GET /files/preview`): up to 64 KB, cut at a whole character.
public struct MacFilePreview: Decodable, Sendable, Equatable {
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

/// Why the Mac did not give what was asked (`{error: <code>}`, docs/files-v0.md §7.1).
public enum FileRefusal: String, Sendable, Equatable {
    case badPath = "bad-path", notFolder = "not-folder", folder, notFound = "not-found", locked, scope, permission
    case filesOff = "files-off", tooLarge = "too-large", notText = "not-text", noThumbnail = "no-thumbnail"
    // Changing files (files-v0 §12.5).
    case exists, badName = "bad-name", noTrash = "no-trash", inUse = "in-use", changesOff = "changes-off", notTrash = "not-trash"
    /// The Mac has no Files routes (an AgentSwitch from before them).
    case unsupported

    /// The refusal an error stands for; nil for any other failure (the network, the pairing).
    public static func of(_ error: Error) -> FileRefusal? {
        guard case APIError.http(let status, let message) = error else { return nil }
        if let known = FileRefusal(rawValue: message) { return known }
        // The remote listener's own 404 for a route it does not list.
        return status == 404 ? .unsupported : nil
    }

    /// What the phone says, in a sentence (files-v0 §3.3, §7.5); `mac` is the Mac's name.
    public func sentence(mac: String) -> String {
        switch self {
        case .filesOff: return "\(mac) 不允许配对的设备读取文件。可在 \(mac) 的“设置 › Nodes”中打开。"
        case .scope: return "此文件夹不在 \(mac) 给这台设备的授权范围内。"
        case .permission: return "\(mac) 上的 AgentSwitch 无权访问此文件夹。可在 \(mac) 的“系统设置 › 隐私与安全性 › 文件与文件夹”中允许。"
        case .locked: return "此处存放 AgentSwitch 的凭据，无法在此打开。"
        case .notFound: return "此文件夹已不存在。"
        case .notFolder, .folder, .badPath: return "无法打开此位置。"
        case .tooLarge: return "文件超过 25 MB，未下载。"
        case .notText: return "无法预览此类文件。"
        case .noThumbnail: return "无法生成预览图。"
        case .unsupported: return "\(mac) 上的 AgentSwitch 版本不支持浏览文件，请先更新。"
        case .exists: return "此位置已有同名的项目。请换一个名称。"
        case .badName: return "此名称不能使用。"
        case .noTrash: return "无法移到废纸篓。"
        case .inUse: return "有终端正在此文件夹中运行。"
        case .changesOff: return "\(mac) 不允许配对的设备修改文件。可在 \(mac) 的“设置 › Nodes”中打开。"
        case .notTrash: return "此项目不在废纸篓中。"
        }
    }
}

/// Paths on the Mac as the phone takes them apart (they are the Mac's: always `/`, never this phone's file system).
public enum MacPath {
    /// The levels from `/` to `path`: each one's name and its path (`/` itself is named `/`).
    public static func levels(_ path: String) -> [(name: String, path: String)] {
        let parts = path.split(separator: "/").map(String.init)
        var out: [(String, String)] = [("/", "/")]
        var at = ""
        for part in parts {
            at += "/" + part
            out.append((part, at))
        }
        return out
    }

    public static func join(_ folder: String, _ name: String) -> String { folder == "/" ? "/" + name : folder + "/" + name }

    public static func name(_ path: String) -> String { path == "/" ? "/" : String(path.split(separator: "/").last ?? "/") }

    public static func parent(_ path: String) -> String? {
        guard path != "/" else { return nil }
        let up = (path as NSString).deletingLastPathComponent
        return up.isEmpty ? "/" : up
    }

    /// `path` with the home folder as `~` (lists and titles; the path row keeps the whole of it, files-v0 §3.2).
    public static func short(_ path: String, home: String) -> String {
        path == home ? "~" : path.hasPrefix(home + "/") ? "~" + path.dropFirst(home.count) : path
    }

    /// `~/x` for a path under a user's home on the Mac, when the Mac's home is not known (the paths carry it).
    public static func tilde(_ path: String) -> String {
        // `/Users/Shared` is no one's home.
        guard path.hasPrefix("/Users/"), path != "/Users/Shared", !path.hasPrefix("/Users/Shared/") else { return path }
        let rest = path.dropFirst("/Users/".count)
        guard let slash = rest.firstIndex(of: "/") else { return "~" }
        return "~" + rest[slash...]
    }
}

/// `⋯` › Sort By: folders first in every order (as the Mac lists them).
public enum FileSort: String, CaseIterable, Sendable {
    case name, modified, size, kind

    public var title: String {
        switch self {
        case .name: return "Name"
        case .modified: return "Date Modified"
        case .size: return "Size"
        case .kind: return "Kind"
        }
    }

    public func sorted(_ entries: [MacFileEntry]) -> [MacFileEntry] {
        guard self != .name else { return entries }
        // The Mac's order (by name) breaks ties.
        let index = Dictionary(uniqueKeysWithValues: entries.enumerated().map { ($1.name, $0) })
        return entries.sorted { a, b in
            if a.isFolder != b.isFolder { return a.isFolder }
            switch self {
            case .modified where a.mtime != b.mtime: return a.mtime > b.mtime
            case .size where a.size != b.size: return a.size > b.size
            case .kind:
                let ea = (a.name as NSString).pathExtension.lowercased(), eb = (b.name as NSString).pathExtension.lowercased()
                if ea != eb { return ea < eb }
            default: break
            }
            return (index[a.name] ?? 0) < (index[b.name] ?? 0)
        }
    }
}

/// A file or folder of the Mac picked for a reply: its path goes to the agent (`TerminalAttachmentRef.path`).
public struct MacPick: Sendable, Equatable, Hashable, Identifiable {
    public let path: String
    public let isFolder: Bool
    /// The Mac thinks it may hold a password (`MacFileDetails.sensitive`): asked about before it lands, marked after.
    public var sensitive: Bool

    public var id: String { path }
    public var name: String { MacPath.name(path) }

    public init(path: String, isFolder: Bool, sensitive: Bool = false) {
        self.path = path
        self.isFolder = isFolder
        self.sensitive = sensitive
    }
}

/// The question asked before a file that may hold a password goes to an agent (files-v0 §4, §5).
public enum SensitiveWarning {
    public static let title = "Add to Reply?"

    public static func message(_ names: [String]) -> String {
        let after = "交给 agent 后，它能读到其中的内容，并可能发给模型的服务商。"
        if names.count == 1 { return "\(names[0]) 可能含有密码或密钥。\(after)" }
        return "这 \(names.count) 个文件可能含有密码或密钥：\(names.joined(separator: "、"))。\(after)"
    }
}

/// How big a file is, short and in the units the Mac writes (`240 B`, `2.1 KB`, `48 MB`): a number and its unit as they
/// are (docs/ui-v0.md §7.2.7), whatever the phone's language.
public enum FileSize {
    public static func short(_ bytes: Int64) -> String {
        let b = Double(bytes)
        if bytes < 1024 { return "\(bytes) B" }
        if b < 1024 * 1024 { return b < 10 * 1024 ? String(format: "%.1f KB", b / 1024) : "\(Int((b / 1024).rounded())) KB" }
        if b < 1024 * 1024 * 1024 { return b < 10 * 1024 * 1024 ? String(format: "%.1f MB", b / 1048576) : "\(Int((b / 1048576).rounded())) MB" }
        return String(format: "%.1f GB", b / 1073741824)
    }
}

/// When a file was last changed, short: `Today 13:02`, `Yesterday`, `10/14`, or `2025/10/14` for another year.
public enum FileTime {
    public static func short(_ ms: Double, now: Date = Date(), calendar: Calendar = .current) -> String {
        guard ms > 0 else { return "" }
        let date = Date(timeIntervalSince1970: ms / 1000)
        if calendar.isDate(date, inSameDayAs: now) {
            let c = calendar.dateComponents([.hour, .minute], from: date)
            return String(format: "Today %02d:%02d", c.hour ?? 0, c.minute ?? 0)
        }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) { return "Yesterday" }
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        let year = calendar.component(.year, from: now)
        return c.year == year ? "\(c.month ?? 0)/\(c.day ?? 0)" : "\(c.year ?? 0)/\(c.month ?? 0)/\(c.day ?? 0)"
    }
}

/// The Mac's files to a screen: the API, or a made-up disk in the demo screens.
public protocol MacFileSource: Sendable {
    /// One level; `etag` the version the screen has: nil back when it has not changed.
    func folder(_ path: String?, hidden: Bool, etag: String?) async throws -> (folder: MacFolder, etag: String?)?
    func fileDetails(_ path: String) async throws -> MacFileDetails
    func filePreview(_ path: String) async throws -> MacFilePreview
    func fileThumbnail(_ path: String) async throws -> Data
    /// The bytes into `file`; `progress` from 0 to 1 as they come.
    func downloadFile(_ path: String, to file: URL, progress: @escaping @Sendable (Double) -> Void) async throws
    // Changing files (docs/files-v0.md §12.5, §12.8). A refusal is a `FileChangeError`.
    /// A new folder at `path` (and the folders on the way).
    func newFolder(_ path: String) async throws -> MacMade
    /// A new empty file at `path` (and the folders on the way).
    func newFile(_ path: String) async throws -> MacMade
    /// `path` given another name in its folder; `force` once a terminal running in it has been asked about.
    func rename(_ path: String, to name: String, force: Bool) async throws -> String
    /// To the Mac's Trash; `permanent` only after the Trash would not take them.
    func trash(_ paths: [String], force: Bool, permanent: Bool) async throws -> [MacMoved]
    /// The bytes of `file` (on this phone) into `path` on the Mac; `progress` from 0 to 1 as they go.
    func upload(_ file: URL, to path: String, conflict: UploadConflict, progress: @escaping @Sendable (Double) -> Void) async throws -> MacUploaded
}
