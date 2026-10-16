import AgentSwitchMacCore
import AppKit
import SwiftUI

// The Files column (docs/files-v0.md; demo docs/design/concepts/files.html): the main window's own column on its right,
// above every page — open or not, beside the page or floating over it, where it is and what is open in it, by node.
// What it lists is the service's (`/files…`), on the node the window is on; the rules (locked places, a paired
// device's scope) are the service's too.

/// One file of the column given to an agent (Add to Reply, a drag): where it is on the node, and what the reply needs
/// to know of it.
struct FilesPick: Equatable, Sendable {
    let path: String
    let name: String
    let folder: Bool
    /// It may hold a password or a key (files-v0 §4): asked about before it goes in.
    let sensitive: Bool
    /// `path` is on the node the terminals are on (the Files column's); false: this Mac's, dropped from Finder.
    var onNode = true

    var image: Bool { !folder && TerminalDraft.isImage(name: name) }
}

/// Where `Add to Reply` puts what is selected (files-v0 §4): the pane in focus's reply box or its terminal, Dispatch's
/// input. Nil: the page has no reply box (Browser, Clash).
struct FilesTarget {
    /// What it is, for the button's help: the terminal's name, `Dispatch`.
    let name: String
    let give: ([FilesPick]) -> Void
}

@MainActor
@Observable
final class FilesColumn {
    enum Arrangement: String { case tree, folders }

    /// Bounds of the column's width (files-v0 §2), and the page's least width beside it before it floats.
    static let widths: ClosedRange<CGFloat> = 240...560
    static let leastPage: CGFloat = 520
    /// From this width the classic look's folders are Finder's columns (files-v0 §3.3).
    static let columnsFrom: CGFloat = 460
    /// How often the folders on screen are asked again (the terminals' list's pace).
    static let poll: Duration = .seconds(3)

    // What is remembered, by node.
    private(set) var open = false
    var floating = false { didSet { keep("floating", floating) } }
    var width: CGFloat = 300 { didSet { keep("width", Double(width)) } }
    /// `As Tree` / `As Folders`; nil: the look's own (the pixel look's tree, the classic look's folders).
    var arrangement: Arrangement? { didSet { keep("arrangement", arrangement?.rawValue) } }
    var showHidden = false { didSet { keep("hidden", showHidden); refreshAll() } }
    var showPreview = true { didSet { keep("preview", showPreview) } }
    var previewShare: CGFloat = 0.45 { didSet { keep("previewShare", Double(previewShare)) } }
    var sort: FilesSort = .name { didSet { keep("sort", sort.rawValue) } }
    /// The folder shown (the tree's root, the level the folders show). Nil until the column first opens: home then.
    private(set) var root: String?
    private(set) var expanded: Set<String> = []
    private(set) var recent: [String] = []

    // What is on screen now.
    private(set) var levels: [String: FileLevel] = [:]
    private var versions: [String: String] = [:]
    private(set) var refusals: [String: FilesRefusal] = [:]
    private(set) var selection: [String] = []
    private var anchor: String?
    private(set) var back: [String] = []
    private(set) var forward: [String] = []
    /// The details of what is selected, once read (`/files/stat`).
    private(set) var details: [String: FileDetails] = [:]
    /// A text file's start, as the service gives it (every node's: Quick Look takes `.ts` for a video and draws its
    /// icon); another node's picture's small copy.
    private(set) var remoteText: FileTextPreview?
    private(set) var remoteImage: NSImage?
    /// The home folder the service says (the levels name it).
    private(set) var home: String?
    /// The path row being typed into (`Go to Folder…`).
    var going: String?
    /// Something went wrong that is not one folder's (a file could not be opened).
    private(set) var notice: String?

    /// The node the window is on (nil: this Mac) and its name, for what is said of its rules.
    let node: String?
    let nodeName: String
    private let client: () -> DaemonClient
    private let defaults: UserDefaults?
    /// Where `Add to Reply` lands now (the window says).
    var target: () -> FilesTarget? = { nil }
    /// The folder of the pane in focus (the window says): where `Copy Relative Path` starts and the bar's icon goes.
    var paneFolder: () -> String? = { nil }
    /// `New Terminal Here`.
    var newTerminal: (String) -> Void = { _ in }
    /// The keyboard back to the page (esc in the column beside the page).
    var focusPage: () -> Void = {}
    /// The view the list's keys come to (FilesKeyView): Quick Look and the keyboard go through it.
    @ObservationIgnored weak var keys: NSView?
    @ObservationIgnored private var polling: Task<Void, Never>?
    @ObservationIgnored private var detailing: Task<Void, Never>?
    @ObservationIgnored private var active = false
    /// Where another node's files are fetched to for Quick Look and Open (removed when the column goes).
    @ObservationIgnored private lazy var downloads: URL = FileManager.default.temporaryDirectory.appendingPathComponent("agentswitch-files-\(UUID().uuidString.prefix(8))")

    init(node: String?, nodeName: String, client: @escaping () -> DaemonClient, defaults: UserDefaults?) {
        self.node = node
        self.nodeName = nodeName
        self.client = client
        self.defaults = defaults
        restore()
    }

    var local: Bool { node == nil }

    // MARK: remembered

    private func key(_ name: String) -> String { "files.\(node ?? "local").\(name)" }
    private func keep(_ name: String, _ value: Any?) { defaults?.set(value, forKey: key(name)) }

    private func restore() {
        guard let d = defaults else { return }
        open = d.bool(forKey: key("open"))
        floating = d.bool(forKey: key("floating"))
        if let w = d.object(forKey: key("width")) as? Double { width = min(max(CGFloat(w), Self.widths.lowerBound), Self.widths.upperBound) }
        arrangement = d.string(forKey: key("arrangement")).flatMap(Arrangement.init(rawValue:))
        showHidden = d.bool(forKey: key("hidden"))
        if d.object(forKey: key("preview")) != nil { showPreview = d.bool(forKey: key("preview")) }
        if let share = d.object(forKey: key("previewShare")) as? Double { previewShare = min(max(CGFloat(share), 0.15), 0.85) }
        sort = d.string(forKey: key("sort")).flatMap(FilesSort.init(rawValue:)) ?? .name
        root = d.string(forKey: key("root"))
        expanded = Set(d.stringArray(forKey: key("expanded")) ?? [])
        recent = d.stringArray(forKey: key("recent")) ?? []
    }

    private func keepPlace() {
        keep("root", root)
        keep("expanded", Array(expanded.prefix(200)))
        keep("recent", recent)
    }

    // MARK: open, closed, where

    /// The window shows the column, or another page of it: what is on screen is asked again while it is seen.
    func setActive(_ seen: Bool) {
        let was = active
        active = seen
        guard seen, open else { polling?.cancel(); polling = nil; return }
        if !was { if root == nil { go(to: nil) } else { refreshAll() } }
        watch()
    }

    /// The bar's icon, a pane's, ⌘⇧F: open at `folder` (or where it was, home the first time); open there already,
    /// closed.
    func toggle(at folder: String?) {
        if open, folder == nil || folder == root { close() } else { show(folder: folder) }
    }

    /// `Show in Files`: open at `folder`, or where it was.
    func show(folder: String?) {
        if !open {
            open = true
            keep("open", true)
        }
        if let folder { go(to: folder) } else if root == nil { go(to: nil) } else { refreshAll() }
        if active { watch() }
    }

    /// The list takes the keyboard (a row clicked): its keys, and Quick Look's panel, go through it.
    func focusKeys() {
        guard let keys, let window = keys.window, window.firstResponder !== keys else { return }
        window.makeFirstResponder(keys)
    }

    /// The list has the keyboard.
    var hasKeys: Bool { keys.map { $0.window?.firstResponder === $0 } ?? false }

    func close() {
        open = false
        keep("open", false)
        polling?.cancel()
        polling = nil
        endQuickLook()
        focusPage()
    }

    /// The view in force: as asked, else the look's own.
    func shown(classic: Bool) -> Arrangement { arrangement ?? (classic ? .folders : .tree) }

    /// Finder's columns: the classic look's folders, wide.
    func columns(classic: Bool) -> Bool { classic && shown(classic: classic) == .folders && width >= Self.columnsFrom }

    /// A folder as the shown one (the path row, `../`, a double click, `Open`). Nil: where this viewer starts.
    func go(to folder: String?, history: Bool = true) {
        if folder == root, folder != nil { return refresh(folder!) }
        if history, let root { back.append(root); forward = [] }
        root = folder
        selection = []
        anchor = nil
        notice = nil
        if let folder {
            recent = Array(([folder] + recent.filter { $0 != folder }).prefix(5))
            refresh(folder)
        } else {
            Task { await load(nil) }
        }
        keepPlace()
    }

    func goHome() { go(to: home ?? (local ? NSHomeDirectory() : nil)) }
    func goUp() { if let root, let up = levels[root]?.parent ?? FilesPath.parent(of: root) { go(to: up) } }
    func goBack() { guard let last = back.popLast() else { return }; if let root { forward.append(root) }; go(to: last, history: false) }
    func goForward() { guard let next = forward.popLast() else { return }; if let root { back.append(root) }; go(to: next, history: false) }

    /// `Go to Folder…`: the path row becomes a field; a path or `~/…`.
    func goTyped(_ text: String) {
        going = nil
        let raw = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return }
        let base = home ?? NSHomeDirectory()
        let path = raw == "~" ? base : raw.hasPrefix("~/") ? base + raw.dropFirst(1) : raw
        guard path.hasPrefix("/") else { notice = "请输入以 / 或 ~ 开头的路径。"; return }
        go(to: (path as NSString).standardizingPath)
    }

    // MARK: the tree

    /// A folder's `▸` / `▾`; `all` (⌥-click): every folder under it too, as far as their levels have been read.
    func twist(_ path: String, all: Bool = false) {
        if expanded.contains(path) {
            expanded = all ? expanded.filter { !FilesPath.contains(path, $0) } : expanded.subtracting([path])
        } else {
            expanded.insert(path)
            refresh(innerOf(path))
            if all, let level = levels[innerOf(path)] {
                for entry in level.entries where entry.isFolder && !entry.locked { let p = FilesPath.join(path, entry.name); expanded.insert(p); refresh(innerOf(p)) }
            }
        }
        keepPlace()
    }

    /// The folder a path's children come from: a link's target.
    func innerOf(_ path: String) -> String {
        guard let parent = FilesPath.parent(of: path), let entry = levels[parent]?.entries.first(where: { $0.name == (path as NSString).lastPathComponent }),
              entry.kind == .link, let target = entry.link?.target else { return path }
        return target
    }

    func treeRows() -> [FilesTreeRow] {
        guard let root else { return [] }
        return FilesTree.rows(root: root, levels: levels, open: expanded, order: sort, hidden: showHidden)
    }

    /// A level's entries as shown: ordered, hidden ones only when asked.
    func entries(of folder: String) -> [FileEntry] {
        sort.sorted((levels[folder]?.entries ?? []).filter { showHidden || !$0.hidden })
    }

    /// What the keyboard walks, in order.
    func visible(classic: Bool) -> [String] {
        guard let root else { return [] }
        if shown(classic: classic) == .tree { return treeRows().map(\.path) }
        return entries(of: root).map { FilesPath.join(root, $0.name) }
    }

    func entry(_ path: String) -> FileEntry? {
        guard let parent = FilesPath.parent(of: path) else { return FileEntry(name: "/", kind: .dir) }
        let name = (path as NSString).lastPathComponent
        return (levels[parent] ?? levels[innerOf(parent)])?.entries.first { $0.name == name }
    }

    // MARK: selection

    /// A click: one; ⌘: one more or one less; ⇧: the run from the last one clicked.
    func select(_ path: String, command: Bool = false, shift: Bool = false, classic: Bool) {
        guard let entry = entry(path), !entry.locked else { return }
        if command {
            selection = selection.contains(path) ? selection.filter { $0 != path } : selection + [path]
            anchor = path
        } else if shift, let anchor {
            let order = visible(classic: classic)
            if let a = order.firstIndex(of: anchor), let b = order.firstIndex(of: path) {
                selection = order[min(a, b)...max(a, b)].filter { !(self.entry($0)?.locked ?? true) }
            }
        } else {
            selection = [path]
            anchor = path
        }
        selected()
    }

    func selectAll(classic: Bool) {
        selection = visible(classic: classic).filter { !(entry($0)?.locked ?? true) }
        selected()
    }

    func clearSelection() { selection = []; selected() }

    /// ↑ ↓: the one before or after the last selected (⇧: the run grows).
    func move(_ step: Int, extend: Bool, classic: Bool) {
        let order = visible(classic: classic).filter { !(entry($0)?.locked ?? true) }
        guard !order.isEmpty else { return }
        let at = selection.last.flatMap { order.firstIndex(of: $0) }
        let next = at.map { min(max($0 + step, 0), order.count - 1) } ?? (step > 0 ? 0 : order.count - 1)
        if extend { select(order[next], shift: true, classic: classic) } else { selection = [order[next]]; anchor = order[next]; selected() }
    }

    func jump(toFirst first: Bool, classic: Bool) {
        let order = visible(classic: classic).filter { !(entry($0)?.locked ?? true) }
        guard let path = first ? order.first : order.last else { return }
        selection = [path]; anchor = path; selected()
    }

    /// Typed letters: the next entry whose name starts so.
    func typeahead(_ prefix: String, classic: Bool) {
        let order = visible(classic: classic)
        let names = order.map { ($0 as NSString).lastPathComponent }
        guard let i = FilesTypeahead.next(prefix, in: names, after: selection.last.flatMap { order.firstIndex(of: $0) }) else { return }
        selection = [order[i]]; anchor = order[i]; selected()
    }

    /// What is selected changed: its details, and another node's file's preview, are asked for.
    private func selected() {
        detailing?.cancel()
        remoteText = nil
        remoteImage = nil
        guard selection.count == 1, let path = selection.first else { return refreshQuickLook() }
        let client = client
        let remote = !local
        detailing = Task { [weak self] in
            guard let d = try? await client().fileDetails(path: path), !Task.isCancelled, let self else { return }
            self.details[path] = d
            if d.type == .text { self.remoteText = try? await client().fileTextPreview(path: path) }
            if remote, d.type == .image, let data = try? await client().fileThumbnail(path: path) { self.remoteImage = NSImage(data: data) }
        }
        refreshQuickLook()
    }

    var selectedSize: Int64 { selection.compactMap { entry($0)?.size }.reduce(0, +) }

    // MARK: reading

    /// The shown folder and the folders open under it on screen, asked again.
    private func refreshAll() {
        guard let root else { return }
        refresh(root)
        for row in treeRows() where row.open { refresh(FilesTree.inner(of: row)) }
    }

    func refresh(_ folder: String) { Task { await load(folder) } }

    /// One level read (again): unchanged since the version held, nothing more.
    private func load(_ folder: String?) async {
        do {
            let version = folder.flatMap { versions[$0] }
            guard let answer = try await client().fileLevel(path: folder, hidden: true, version: levels[folder ?? ""] == nil ? nil : version) else { return }
            let level = answer.value
            levels[level.path] = level
            versions[level.path] = answer.version
            refusals[level.path] = nil
            if home == nil { home = level.home }
            if folder == nil {
                // Where this viewer starts: the shown folder now.
                root = level.path
                recent = Array(([level.path] + recent.filter { $0 != level.path }).prefix(5))
                keepPlace()
            }
            // A selected entry that is gone goes from the selection.
            let gone = selection.filter { FilesPath.parent(of: $0) == level.path && entry($0) == nil }
            if !gone.isEmpty { selection.removeAll { gone.contains($0) } }
        } catch {
            guard let folder else { return }
            let refusal = FilesRefusal(error)
            // The service not answering once (a poll in a hiccup) leaves what is shown; its own refusal replaces it.
            if case .other = refusal, levels[folder] != nil { return }
            refusals[folder] = refusal
            levels[folder] = nil
            versions[folder] = nil
        }
    }

    private func watch() {
        polling?.cancel()
        polling = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: Self.poll)
                guard let self, !Task.isCancelled, self.open, self.active else { return }
                self.refreshAll()
            }
        }
    }

    // MARK: what is done to them

    /// The picks as `Add to Reply` gives them: the reason one may hold a password from the service where it said, else
    /// this Mac's own table for this Mac's files.
    func picks(_ paths: [String]) -> [FilesPick] {
        paths.compactMap { path in
            guard let e = entry(path), !e.locked else { return nil }
            let sensitive = details[path]?.sensitive != nil || (local && FilesSensitive.reason(path) != nil)
            return FilesPick(path: path, name: e.name, folder: e.isFolder, sensitive: sensitive)
        }
    }

    /// `Add to Reply` (the button, the menu, ⌥↩): what is selected (or `paths`) to the reply where it lands now.
    func addToReply(_ paths: [String]? = nil) {
        let chosen = picks(paths ?? selection)
        guard !chosen.isEmpty, let target = target() else { return }
        // Another node's files not told of yet: asked for first, so that one that may hold a password is asked about.
        let unknown = local ? [] : chosen.filter { details[$0.path] == nil }.map(\.path)
        guard !unknown.isEmpty else { return target.give(chosen) }
        let client = client
        Task { [weak self] in
            for path in unknown { if let d = try? await client().fileDetails(path: path) { self?.details[path] = d } }
            guard let self else { return }
            target.give(self.picks(chosen.map(\.path)))
        }
    }

    /// `Open`: a folder as the shown one; a file to its own application (another node's is fetched first).
    func open(_ path: String) {
        guard let e = entry(path), !e.locked else { return }
        if e.isFolder { return go(to: e.kind == .link ? e.link?.target ?? path : path) }
        if local { NSWorkspace.shared.open(URL(fileURLWithPath: path)); return }
        Task { [weak self] in
            guard let url = await self?.fetched(path) else { return }
            NSWorkspace.shared.open(url)
        }
    }

    func openSelection() { for path in selection { open(path) } }

    func showInFinder(_ paths: [String]) {
        guard local else { return }
        NSWorkspace.shared.activateFileViewerSelecting(paths.map { URL(fileURLWithPath: $0) })
    }

    func copyPaths(_ paths: [String], relative: Bool = false) {
        let base = paneFolder()
        let text = paths.map { p in relative ? base.flatMap { FilesPath.relative(p, to: $0) } ?? p : p }.joined(separator: "\n")
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    /// Every path is under the pane in focus's folder: `Copy Relative Path` means something.
    func relativeAvailable(_ paths: [String]) -> Bool {
        guard let base = paneFolder() else { return false }
        return paths.allSatisfy { FilesPath.relative($0, to: base) != nil }
    }

    /// Another node's file on this Mac, for Quick Look and Open: fetched into the column's own folder.
    private func fetched(_ path: String) async -> URL? {
        let size = entry(path)?.size ?? 0
        guard size <= 25 * 1024 * 1024 else { notice = FilesRefusal.tooLarge.sentence(); return nil }
        let to = downloads.appendingPathComponent(UUID().uuidString.prefix(8).description).appendingPathComponent((path as NSString).lastPathComponent)
        do { return try await client().downloadFile(path: path, to: to) } catch {
            notice = FilesRefusal(error).sentence(node: nodeName)
            return nil
        }
    }

    // MARK: Quick Look

    /// What the Quick Look panel shows, in the order selected: this Mac's files as they are, another node's fetched.
    private(set) var lookItems: [URL] = []

    var quickLooking: Bool { QLPanelHost.isOpen(for: self) }

    func toggleQuickLook() {
        if quickLooking { return endQuickLook() }
        let files = selection.filter { !(entry($0)?.isFolder ?? true) }
        guard !files.isEmpty else { return }
        Task { [weak self] in
            guard let self else { return }
            var urls: [URL] = []
            for path in files { if self.local { urls.append(URL(fileURLWithPath: path)) } else if let url = await self.fetched(path) { urls.append(url) } }
            self.lookItems = urls
            QLPanelHost.open(for: self)
        }
    }

    private func refreshQuickLook() {
        guard quickLooking else { return }
        let files = selection.filter { !(entry($0)?.isFolder ?? true) }
        if local {
            lookItems = files.map { URL(fileURLWithPath: $0) }
            QLPanelHost.reload()
        }
    }

    func endQuickLook() { QLPanelHost.close(for: self) }

    func stop() {
        polling?.cancel()
        detailing?.cancel()
        endQuickLook()
        try? FileManager.default.removeItem(at: downloads)
    }

    #if DEBUG
    /// A design preview's column: levels as given, nothing asked of a service.
    func stage(root: String, levels: [FileLevel], expanded: Set<String> = [], selection: [String] = [], details: [FileDetails] = [], open: Bool = true, refused: FilesRefusal? = nil) {
        self.open = open
        self.root = root
        if let refused { refusals[root] = refused }
        for level in levels { self.levels[level.path] = level }
        self.expanded = expanded
        self.selection = selection
        self.home = levels.first?.home
        for d in details { self.details[d.path] = d }
    }

    func stageRemote(text: FileTextPreview?, image: NSImage?) { remoteText = text; remoteImage = image }
    #endif
}
