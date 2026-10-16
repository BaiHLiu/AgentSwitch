import AgentSwitchKit
import Foundation
import SwiftUI

/// The Files tab across its visits (docs/files-v0.md §5): where it was last on each Mac, a folder another page asked it to
/// show (`Show in Files`), and the files picked on it for a terminal, until that terminal's page takes them.
@MainActor
@Observable
final class FilesStore {
    private static let lastKey = "files.last"
    /// Where the tab was last, by the Mac's fingerprint.
    private var last: [String: String]
    /// A folder to show on the Files tab; the tab takes it.
    var openRequest: String?
    /// Files picked on the Files tab for a terminal: its page takes them as it opens.
    var handoff: Handoff?
    /// The Mac's home folder, as its last answer said (`~` in the terminals' folders).
    var home: String?

    struct Handoff: Equatable {
        let terminal: String
        let picks: [MacPick]
    }

    init() {
        let data = UserDefaults.standard.data(forKey: Self.lastKey)
        last = data.flatMap { try? JSONDecoder().decode([String: String].self, from: $0) } ?? [:]
    }

    func lastPlace(on mac: String?) -> String? { mac.flatMap { last[$0] } }

    func remember(_ path: String, on mac: String?) {
        guard let mac, last[mac] != path else { return }
        last[mac] = path
        if let data = try? JSONEncoder().encode(last) { UserDefaults.standard.set(data, forKey: Self.lastKey) }
    }
}

/// `⋯`'s choices, kept on this phone for every Mac.
enum FilesPrefs {
    static let hiddenKey = "files.hidden"
    static let sortKey = "files.sort"
}

/// One folder's page: its level from the Mac, asked again every few seconds while it is on screen (an unchanged level
/// is a 304), and, in the pixel look, the folders opened in place under it (one level each).
@MainActor
@Observable
final class FolderModel {
    /// The folder asked for; nil, where the Mac starts this phone (home, or the first folder of its scope).
    let asked: String?
    private(set) var folder: MacFolder?
    private(set) var refusal: FileRefusal?
    /// A failure that is not the Mac refusing (the network): said over what is shown.
    private(set) var failure: String?
    private(set) var loading = false
    private var etag: String?
    private var hiddenAsked: Bool?
    /// Folders opened in place (pixel), by path, with their entries once read.
    private(set) var opened: [String: [MacFileEntry]] = [:]

    static let pollInterval: Duration = .seconds(3)

    init(asked: String?) { self.asked = asked }

    var path: String? { folder?.path ?? asked }

    func load(_ source: (any MacFileSource)?, hidden: Bool) async {
        guard let source else { return }
        if hiddenAsked != hidden { etag = nil; hiddenAsked = hidden }
        loading = folder == nil
        defer { loading = false }
        do {
            if let got = try await source.folder(asked ?? folder?.path, hidden: hidden, etag: etag) {
                folder = got.folder
                etag = got.etag
            }
            refusal = nil
            failure = nil
        } catch {
            if let r = FileRefusal.of(error) { refusal = r; folder = nil; etag = nil } else { failure = error.localizedDescription }
        }
    }

    /// While the page is on screen.
    func follow(_ source: @escaping () -> (any MacFileSource)?, hidden: @escaping () -> Bool) async {
        while !Task.isCancelled {
            await load(source(), hidden: hidden())
            for path in opened.keys { await readOpened(path, source(), hidden: hidden()) }
            try? await Task.sleep(for: Self.pollInterval)
        }
    }

    func isOpen(_ path: String) -> Bool { opened[path] != nil }

    /// A folder's `▸`: open it in place one level, or close it.
    func toggle(_ path: String, _ source: (any MacFileSource)?, hidden: Bool) async {
        if opened[path] != nil { opened[path] = nil; return }
        opened[path] = []
        await readOpened(path, source, hidden: hidden)
    }

    private func readOpened(_ path: String, _ source: (any MacFileSource)?, hidden: Bool) async {
        guard let source, opened[path] != nil else { return }
        if let got = try? await source.folder(path, hidden: hidden, etag: nil) { opened[path] = got.folder.entries }
    }
}

/// Where the browser leads by value: a folder's page or a file's.
enum FilesRoute: Hashable {
    case folder(String)
    case file(String)
}

/// One browser (the Files tab, or `+` › Files on Mac over a terminal): the pages it has open, what is picked, and the
/// question asked before a file that may hold a password lands.
@MainActor
@Observable
final class FilesSession {
    enum Mode: Equatable {
        /// The Files tab: nobody to give to yet (`Add to Reply…` asks which terminal).
        case tab
        /// Over a terminal's page: what is picked lands in its reply box.
        case sheet(terminal: String)
    }

    let mode: Mode
    /// The first page's folder; nil, where the Mac starts this phone.
    var root: String?
    var stack: [FilesRoute] = []
    var selecting = false
    private(set) var picked: [MacPick] = []
    /// The picks being looked at on the Mac (which may hold a password) before they go on.
    private(set) var checking = false
    /// Picks that may hold a password, asked about before they land (`then` is where they go).
    var asking: Asking?
    /// The Files tab: picks checked and waiting for a terminal to go to.
    var choosing: [MacPick]?

    struct Asking: Identifiable {
        let id = UUID()
        let picks: [MacPick]
        let then: ([MacPick]) -> Void
        var names: [String] { picks.filter(\.sensitive).map(\.name) }
    }

    init(mode: Mode, root: String?) {
        self.mode = mode
        self.root = root
    }

    var inTab: Bool { mode == .tab }

    /// A level of the path row: back to it if it is open, else a new first page.
    func go(to path: String) {
        if path == root { stack = []; return }
        if let at = stack.lastIndex(of: .folder(path)) { stack = Array(stack.prefix(at + 1)); return }
        root = path
        stack = []
    }

    func isPicked(_ path: String) -> Bool { picked.contains { $0.path == path } }

    func togglePick(_ pick: MacPick) {
        if let at = picked.firstIndex(where: { $0.path == pick.path }) { picked.remove(at: at) } else if picked.count < Self.maxPicks { picked.append(pick) }
    }

    func endSelecting() {
        selecting = false
        picked = []
    }

    /// At most what one reply carries (docs/simple-view-v0.md §5.1).
    static let maxPicks = 10

    /// Each file asked about on the Mac (`/files/stat`): whether it may hold a password.
    func checked(_ picks: [MacPick], _ source: (any MacFileSource)?) async -> [MacPick] {
        guard let source else { return picks }
        checking = true
        defer { checking = false }
        var out: [MacPick] = []
        for var pick in picks {
            if !pick.isFolder, let d = try? await source.fileDetails(pick.path) { pick.sensitive = d.sensitive != nil }
            out.append(pick)
        }
        return out
    }

    /// Picks to land: asked about first when any may hold a password; `Cancel` keeps the others.
    func land(_ picks: [MacPick], then: @escaping ([MacPick]) -> Void) {
        if picks.contains(where: \.sensitive) { asking = Asking(picks: picks, then: then) } else { then(picks) }
    }
}

extension View {
    /// The system's question before files that may hold a password go to an agent (docs/files-v0.md §5): `Add` lands
    /// them all, `Cancel` the others only.
    func sensitiveQuestion(_ session: FilesSession) -> some View {
        @Bindable var session = session
        return alert(SensitiveWarning.title, isPresented: Binding(get: { session.asking != nil }, set: { if !$0 { session.asking = nil } }),
                     presenting: session.asking) { ask in
            Button("Cancel", role: .cancel) {
                let rest = ask.picks.filter { !$0.sensitive }
                session.asking = nil
                if !rest.isEmpty { ask.then(rest) }
            }
            Button("Add") {
                session.asking = nil
                ask.then(ask.picks)
            }
        } message: { ask in
            Text(SensitiveWarning.message(ask.names))
        }
    }
}
