import Foundation

// What the Files column draws, without AppKit (docs/files-v0.md §3): the path's levels and the ones folded into `…`,
// the tree's rows from the levels read so far, the order of a level, and the words for sizes, times and kinds.

public enum FilesPath {
    /// One level of the path row: its name (`/` for the disk) and where it leads.
    public struct Level: Equatable, Sendable {
        public let name: String
        public let path: String
        public init(name: String, path: String) { self.name = name; self.path = path }
    }

    /// Every level of `path` from `/`.
    public static func levels(of path: String) -> [Level] {
        let parts = path.split(separator: "/").map(String.init)
        var out = [Level(name: "/", path: "/")]
        for (i, name) in parts.enumerated() { out.append(Level(name: name, path: "/" + parts[0...i].joined(separator: "/"))) }
        return out
    }

    /// The levels as the row shows them in `budget` points, `width` saying what one takes: whole if they fit; else the
    /// disk, `…` for the middle, and as many of the last ones as fit — the current one and its parent at least (Apple's
    /// path control: the names between the first and the last are the ones let go).
    public static func fitted(_ levels: [Level], budget: Double, width: (Level) -> Double, fold: Double) -> (shown: [Level], folded: [Level]) {
        let total = levels.map(width).reduce(0, +)
        guard total > budget, levels.count > 3 else { return (levels, []) }
        var kept = 2
        while kept < levels.count - 1 {
            let tail = levels.suffix(kept + 1)
            if width(levels[0]) + fold + tail.map(width).reduce(0, +) > budget { break }
            kept += 1
        }
        let tail = Array(levels.suffix(kept))
        return ([levels[0]] + tail, Array(levels[1..<(levels.count - kept)]))
    }

    /// The parent of `path`; nil for `/`.
    public static func parent(of path: String) -> String? {
        guard path != "/" else { return nil }
        let up = (path as NSString).deletingLastPathComponent
        return up.isEmpty ? "/" : up
    }

    public static func join(_ folder: String, _ name: String) -> String { folder == "/" ? "/" + name : folder + "/" + name }

    /// `path` from `base` (a terminal's folder), or nil when it is not under it.
    public static func relative(_ path: String, to base: String) -> String? {
        if path == base { return "." }
        let prefix = base.hasSuffix("/") ? base : base + "/"
        return path.hasPrefix(prefix) ? String(path.dropFirst(prefix.count)) : nil
    }

    /// `path` is `folder` or inside it.
    public static func contains(_ folder: String, _ path: String) -> Bool { path == folder || relative(path, to: folder) != nil }
}

/// How a level is ordered (`⋯` › `Sort By`). Folders first in each.
public enum FilesSort: String, CaseIterable, Sendable {
    case name, modified, size, kind

    public var word: String {
        switch self {
        case .name: "Name"
        case .modified: "Date Modified"
        case .size: "Size"
        case .kind: "Kind"
        }
    }

    private static func key(_ name: String) -> String { String(name.drop { $0 == "." }) }

    public func sorted(_ entries: [FileEntry]) -> [FileEntry] {
        entries.sorted { a, b in
            if a.isFolder != b.isFolder { return a.isFolder }
            let byName = Self.key(a.name).localizedStandardCompare(Self.key(b.name))
            switch self {
            case .name: return byName == .orderedAscending
            case .modified: return a.mtime != b.mtime ? a.mtime > b.mtime : byName == .orderedAscending
            case .size: return a.size != b.size ? a.size > b.size : byName == .orderedAscending
            case .kind:
                let ka = (a.name as NSString).pathExtension.lowercased(), kb = (b.name as NSString).pathExtension.lowercased()
                return ka != kb ? ka < kb : byName == .orderedAscending
            }
        }
    }
}

/// The tree's rows (the pixel look's `tree -F`, the classic look's `As Tree`): a level's entries, and under each open
/// folder whose level has been read, its own, deeper by one.
public struct FilesTreeRow: Equatable, Identifiable, Sendable {
    public let entry: FileEntry
    public let path: String
    public let depth: Int
    /// For each folder above it in the tree, whether that one was the last of its level (`   ` then, else `│  `).
    public let stems: [Bool]
    /// The last of its level (`└─`, else `├─`).
    public let last: Bool
    public let open: Bool
    /// Open, its level not read yet.
    public let waiting: Bool
    public var id: String { path }

    /// The stems drawn before it: `│  ` or `   ` for each folder above, then `├─` or `└─`.
    public var twig: String { stems.map { $0 ? "   " : "│  " }.joined() + (last ? "└─" : "├─") }
}

public enum FilesTree {
    /// `root`'s rows. `levels`: what has been read, by path; `open`: the folders shown open; `order` and `hidden` as the
    /// column has them.
    public static func rows(root: String, levels: [String: FileLevel], open: Set<String>, order: FilesSort, hidden: Bool) -> [FilesTreeRow] {
        var out: [FilesTreeRow] = []
        func walk(_ folder: String, _ stems: [Bool]) {
            guard let level = levels[folder] else { return }
            let entries = order.sorted(level.entries.filter { hidden || !$0.hidden })
            for (i, entry) in entries.enumerated() {
                let path = FilesPath.join(folder, entry.name)
                let isOpen = entry.isFolder && !entry.locked && open.contains(path)
                // A link to a folder opens on the folder it names.
                let inner = entry.kind == .link ? entry.link?.target ?? path : path
                let last = i == entries.count - 1
                out.append(FilesTreeRow(entry: entry, path: path, depth: stems.count, stems: stems, last: last, open: isOpen, waiting: isOpen && levels[inner] == nil))
                if isOpen { walk(inner, stems + [last]) }
            }
        }
        walk(root, [])
        return out
    }

    /// The folder whose level a row's children come from (a link's target).
    public static func inner(of row: FilesTreeRow) -> String { row.entry.kind == .link ? row.entry.link?.target ?? row.path : row.path }
}

/// The words the column writes (ui-v0 §7: short words in English, numbers with their units).
public enum FilesText {
    /// `2.1K`, `120B`, `48M` (the pixel look's), or `2.1 KB`, `120 bytes` (the classic look's and the info line's): in
    /// thousands, as Finder counts, both of them.
    public static func size(_ bytes: Int64, short: Bool) -> String {
        let b = Double(bytes)
        if short {
            if bytes < 1000 { return "\(bytes)B" }
            if b < 1_000_000 { return b < 10_000 ? String(format: "%.1fK", b / 1000) : "\(Int((b / 1000).rounded()))K" }
            if b < 1_000_000_000 { return b < 10_000_000 ? String(format: "%.1fM", b / 1_000_000) : "\(Int((b / 1_000_000).rounded()))M" }
            return String(format: "%.1fG", b / 1_000_000_000)
        }
        if bytes < 1000 { return bytes == 1 ? "1 byte" : "\(bytes) bytes" }
        if b < 1_000_000 { return String(format: "%.1f KB", b / 1000) }
        if b < 1_000_000_000 { return String(format: "%.1f MB", b / 1_000_000) }
        return String(format: "%.1f GB", b / 1_000_000_000)
    }

    /// `Today 13:02`, `Yesterday`, `10/14` (this year), `2025/10/14`.
    public static func date(_ date: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
        if calendar.isDate(date, inSameDayAs: now) {
            let c = calendar.dateComponents([.hour, .minute], from: date)
            return String(format: "Today %02d:%02d", c.hour ?? 0, c.minute ?? 0)
        }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) { return "Yesterday" }
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        let year = calendar.component(.year, from: now)
        return c.year == year ? "\(c.month ?? 0)/\(c.day ?? 0)" : "\(c.year ?? 0)/\(c.month ?? 0)/\(c.day ?? 0)"
    }

    /// What kind of file, by its name, as the info line says it.
    public static func kind(of name: String, isFolder: Bool, type: FileKind?) -> String {
        if isFolder { return "Folder" }
        let ext = (name as NSString).pathExtension.lowercased()
        if let word = kinds[ext] { return word }
        if name.hasPrefix(".env") { return "Environment" }
        switch type {
        case .text: return "Plain Text"
        case .image: return "\(ext.uppercased()) Image"
        case .pdf: return "PDF Document"
        case .audio: return "Audio"
        case .video: return "Movie"
        case .archive: return "Archive"
        case .binary, nil: return "Document"
        }
    }

    private static let kinds: [String: String] = [
        "ts": "TypeScript", "tsx": "TypeScript JSX", "js": "JavaScript", "mjs": "JavaScript", "jsx": "JavaScript JSX", "json": "JSON",
        "md": "Markdown", "swift": "Swift", "py": "Python", "rb": "Ruby", "go": "Go", "rs": "Rust", "java": "Java", "kt": "Kotlin",
        "c": "C", "h": "C Header", "cpp": "C++", "m": "Objective-C", "sh": "Shell Script", "zsh": "Shell Script", "yml": "YAML", "yaml": "YAML",
        "toml": "TOML", "html": "HTML", "css": "CSS", "sql": "SQL", "txt": "Plain Text", "log": "Log", "csv": "CSV", "xml": "XML", "svg": "SVG Image",
        "png": "PNG Image", "jpg": "JPEG Image", "jpeg": "JPEG Image", "gif": "GIF Image", "webp": "WebP Image", "heic": "HEIC Image",
        "pdf": "PDF Document", "zip": "ZIP Archive", "gz": "Gzip Archive", "tar": "Tar Archive", "dmg": "Disk Image",
        "mp4": "MPEG-4 Movie", "mov": "QuickTime Movie", "mp3": "MP3 Audio", "m4a": "MPEG-4 Audio", "wav": "WAV Audio",
        "docx": "Word Document", "xlsx": "Excel Workbook", "pptx": "PowerPoint Presentation", "pem": "Certificate", "key": "Key",
    ]

    /// The info line under a selected file's name: `TypeScript · 2.1 KB · 14 Lines · Today 13:02`.
    public static func info(_ d: FileDetails, now: Date = Date()) -> String {
        let folder = d.entry.isFolder
        var parts = [kind(of: d.entry.name, isFolder: folder, type: d.type)]
        if folder { parts.append("\(d.items ?? 0) Items") } else { parts.append(size(d.entry.size, short: false)) }
        if let lines = d.lines, !folder { parts.append(lines == 1 ? "1 Line" : "\(lines) Lines") }
        parts.append(date(d.entry.modified, now: now))
        return parts.joined(separator: " · ")
    }
}

/// Typing in the list goes to the next entry whose name starts so (WAI-ARIA's tree typeahead), from after `from`.
public enum FilesTypeahead {
    public static func next(_ prefix: String, in names: [String], after from: Int?) -> Int? {
        guard !names.isEmpty, !prefix.isEmpty else { return nil }
        let key = prefix.lowercased()
        let start = (from ?? -1) + 1
        for k in 0..<names.count {
            let i = (start + k) % names.count
            if names[i].drop(while: { $0 == "." }).lowercased().hasPrefix(key) { return i }
        }
        return nil
    }
}
