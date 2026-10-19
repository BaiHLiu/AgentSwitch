#if DEBUG
import AgentSwitchMacCore
import AppKit
import SwiftUI

/// The Files column for `-designPreview <dir> -designPreviewOnly files` (debug builds only; docs/files-v0.md §8): the
/// main window as it is built — the bar, the rail, the native Terminals page from made-up work (TerminalsPagePreview),
/// the status bar — with the column over a made-up disk, nothing asked of a service. In the look in force
/// (`-appearance pixel|classic`), it writes:
/// - `files-home`: the column first opened, at home;
/// - `files-tree`: a project with a folder open (the pixel look's tree, the classic look's folders);
/// - `files-preview`: a file selected, its preview and its two buttons (another node's text, as the service gives it);
/// - `files-preview-long`: a minified file, its one long line wrapped to the column, cut at 64 KB;
/// - `files-quicklook`: a file of this Mac's in Quick Look's own picture (a real file in a temporary folder);
/// - `files-several`: two selected, and the status bar's count;
/// - `files-hidden`: hidden files shown, the locked places with their lock;
/// - `files-ask`: a `.env` given to the pane's reply — the question over its reply box; `files-asked`: added, its chip
///   marked; `files-ask-terminal`: the same question over a terminal's screen;
/// - `files-float`: the column over the page; `files-narrow`: a narrow window, where it floats by itself;
/// - `files-wide`: 500 points wide (the classic look's folders as Finder's two last columns);
/// - `files-panes`: two panes, each with its folder icon, the one shown lit;
/// - `files-scoped`: another node's level above this Mac's scope — only the way in, and the line that says so;
/// - `files-refused`: a folder the service will not read for this device (out of its scope).
@MainActor
enum FilesDesignPreview {
    static let size = NSSize(width: 1280, height: 820)
    private static let home = "/Users/you"

    static func render(model: AppModel, into directory: URL) async throws {
        func picture(_ name: String) -> URL { directory.appendingPathComponent("\(name).png") }
        let lumen = "\(home)/Projects/lumen"
        try await shot(model, to: picture("files-home")) { files, _ in files.stage(root: home, levels: levels) }
        try await shot(model, to: picture("files-tree")) { files, _ in files.stage(root: lumen, levels: levels, expanded: ["\(lumen)/src"]) }
        try await shot(model, node: "7f3a19c2e804", to: picture("files-preview")) { files, _ in
            files.stage(root: lumen, levels: levels, expanded: ["\(lumen)/src"], selection: ["\(lumen)/src/app.ts"], details: [appDetails])
            files.stageRemote(text: FileTextPreview(text: appText, truncated: false, lines: 14, size: 2140), image: nil)
        }
        try await shot(model, node: "7f3a19c2e804", to: picture("files-preview-long")) { files, _ in
            files.stage(root: lumen, levels: levels, expanded: ["\(lumen)/src"], selection: ["\(lumen)/src/app.ts"], details: [appDetails])
            files.stageRemote(text: FileTextPreview(text: minified, truncated: true, lines: 1, size: 1_480_000), image: nil)
        }
        try await quickLook(model, to: picture("files-quicklook"))
        try await shot(model, to: picture("files-several")) { files, _ in
            files.stage(root: lumen, levels: levels, expanded: ["\(lumen)/src", "\(lumen)/docs"], selection: ["\(lumen)/src/store.ts", "\(lumen)/docs/design.md"])
        }
        try await shot(model, to: picture("files-hidden")) { files, _ in
            files.showHidden = true
            files.stage(root: home, levels: levels, expanded: ["\(home)/.agentswitch"])
        }
        try await shot(model, light: true, to: picture("files-ask")) { files, terminals in
            TerminalsPagePreview.stageRecord(terminals, working: false)
            files.stage(root: lumen, levels: levels, selection: ["\(lumen)/.env"])
            files.showHidden = true
            terminals.focused?.offer([FilesPick(path: "\(lumen)/.env", name: ".env", folder: false, sensitive: true), FilesPick(path: "\(lumen)/src/store.ts", name: "store.ts", folder: false, sensitive: false)])
        }
        try await shot(model, light: true, to: picture("files-asked")) { files, terminals in
            TerminalsPagePreview.stageRecord(terminals, working: false)
            files.stage(root: lumen, levels: levels, selection: ["\(lumen)/.env"])
            files.showHidden = true
            terminals.focused?.offer([FilesPick(path: "\(lumen)/.env", name: ".env", folder: false, sensitive: true), FilesPick(path: "\(lumen)/src/store.ts", name: "store.ts", folder: false, sensitive: false)])
            terminals.focused?.answer(add: true)
        }
        try await shot(model, to: picture("files-ask-terminal")) { files, terminals in
            files.stage(root: "\(home)/.ssh", levels: levels, selection: ["\(home)/.ssh/id_ed25519"])
            terminals.focused?.offer([FilesPick(path: "\(home)/.ssh/id_ed25519", name: "id_ed25519", folder: false, sensitive: true)])
        }
        try await shot(model, to: picture("files-float")) { files, _ in
            files.floating = true
            files.stage(root: lumen, levels: levels, expanded: ["\(lumen)/src"], selection: ["\(lumen)/src/store.ts"])
        }
        try await shot(model, size: NSSize(width: 900, height: 700), to: picture("files-narrow")) { files, _ in
            files.stage(root: lumen, levels: levels, expanded: ["\(lumen)/src"])
        }
        try await shot(model, to: picture("files-wide")) { files, _ in
            files.width = 500
            files.stage(root: "\(lumen)/src", levels: levels, expanded: ["\(lumen)/src/components"], selection: ["\(lumen)/src/store.ts"])
        }
        try await shot(model, to: picture("files-panes")) { files, terminals in
            terminals.split(.right)
            terminals.select("t2")
            let folder = terminals.focused?.session?.info?.workdir ?? lumen
            files.stage(root: folder, levels: levels + [FileLevel(path: folder, parent: FilesPath.parent(of: folder), home: home, entries: [Self.dir("src"), Self.file("package.json", 410), Self.file("README.md", 62)])])
        }
        try await shot(model, node: "7f3a19c2e804", to: picture("files-scoped")) { files, _ in
            files.stage(root: home, levels: [FileLevel(path: home, parent: "/Users", home: home, entries: [Self.dir("Documents"), Self.dir("Projects")], scoped: true)])
        }
        try await shot(model, node: "7f3a19c2e804", to: picture("files-refused")) { files, _ in
            files.stage(root: "\(home)/Desktop", levels: [], refused: .scope)
        }
    }

    /// One picture of the window on Terminals, the column open; `stage` sets the column and the page up.
    private static func shot(_ model: AppModel, node: String? = nil, light: Bool = false, size: NSSize = size, onScreen: Bool = false, to file: URL,
                             stage: (FilesColumn, TerminalsModel) -> Void) async throws {
        let terminals = TerminalsPagePreview.demoModel()
        terminals.area = CGSize(width: size.width - 44 - 300, height: size.height - 60)
        let state = MainWindowState(page: .terminals, railHidden: false)
        if let node, let status = DemoData.nodeList.nodes.first(where: { $0.id == node }) { state.use(node: status) }
        let head = TerminalHead()
        head.name = "AgentSwitch"
        head.git = "main ±42 ↑2"
        head.sideWidth = terminals.sideWidth + 1
        let files = FilesColumn(node: node, nodeName: node == nil ? "这台 Mac" : "Mac mini", client: { DaemonClient(port: 1) }, defaults: nil)
        files.target = { [weak terminals] in terminals?.filesTarget() }
        terminals.files = files
        let window = PreviewWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                                   backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.titlebarSeparatorStyle = .none
        let page = NSHostingView(rootView: TerminalsPageView(model: terminals))
        page.sizingOptions = []
        let container = PageContainer(pages: [.terminals: page])
        let host = NSHostingController(rootView: MainWindowRoot(state: state, head: head, model: model, content: container, actions: MainBarActions(), files: files))
        host.sizingOptions = []
        window.contentViewController = host
        window.setContentSize(size)
        state.barHeight = max(28, window.frame.height - window.contentLayoutRect.height)
        state.lightsEnd = window.standardWindowButton(.zoomButton)?.frame.maxX ?? 70
        container.show(.terminals)
        // Quick Look draws in a process of its own: only a window on screen (behind every other) shows what it drew.
        if onScreen { window.setFrameOrigin(NSPoint(x: 40, y: 40)); window.orderBack(nil) }
        try await DesignPreview.settle()
        terminals.select("t1")
        stage(files, terminals)
        head.folder = terminals.focused?.session?.info?.workdir
        head.light = terminals.focusedLight
        head.simple = terminals.focusedSimple
        MainWindowController.dress(window, for: .terminals, system: NSAppearance(named: light ? .aqua : .darkAqua), record: head.light)
        try await DesignPreview.settle()
        for pane in terminals.panes.values where pane.session != nil && !pane.simple {
            pane.screen.view.feed(text: "\u{1b}[35m✻\u{1b}[0m Welcome back\r\n\r\n\u{1b}[2m❯\u{1b}[0m 登录后跳回原来的页面，别总回首页\r\n\r\n⏺ 我先看一下登录页现在怎么处理 next 参数。\r\n")
        }
        try await DesignPreview.settle()
        if onScreen {
            try await Task.sleep(for: .seconds(2))
            if let image = CGWindowListCreateImage(.null, .optionIncludingWindow, CGWindowID(window.windowNumber), [.boundsIgnoreFraming, .bestResolution]) {
                try NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])?.write(to: file)
            }
        } else {
            try DesignPreview.write(window.contentView?.superview ?? window.contentView!, to: file)
        }
        terminals.stop()
        files.stop()
        window.close()
    }

    /// A picture of this Mac's, as Quick Look draws it in the column: a real one, in a temporary folder.
    private static func quickLook(_ model: AppModel, to file: URL) async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("agentswitch-files-preview").appendingPathComponent("docs")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder.deletingLastPathComponent()) }
        let logo = folder.appendingPathComponent("logo.png")
        let image = NSImage(size: NSSize(width: 240, height: 160), flipped: false) { rect in
            NSColor(srgbRed: 0.08, green: 0.08, blue: 0.08, alpha: 1).setFill(); rect.fill()
            for (i, color) in [NSColor.systemPink, .white, .gray].enumerated() {
                color.setFill(); NSRect(x: 60, y: 110 - CGFloat(i) * 28, width: 120 - CGFloat(i) * 24, height: 14).fill()
            }
            return true
        }
        if let tiff = image.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) { try png.write(to: logo) }
        let mtime = Date().timeIntervalSince1970 * 1000
        let entry = FileEntry(name: "logo.png", kind: .file, size: 24_600, mtime: mtime)
        try await shot(model, to: file) { files, _ in
            files.stage(root: folder.path, levels: [FileLevel(path: folder.path, parent: folder.deletingLastPathComponent().path, home: home, entries: [entry])],
                        selection: [logo.path], details: [FileDetails(entry: entry, path: logo.path, type: .image)])
        }
    }

    // MARK: the made-up disk (the demo page's, docs/design/concepts/files-data.js)

    private static let now = Date().timeIntervalSince1970 * 1000
    private static func dir(_ name: String, hidden: Bool? = nil, dim: Bool = false, locked: Bool = false, ago: Double = 3_600_000) -> FileEntry {
        FileEntry(name: name, kind: .dir, mtime: locked ? 0 : now - ago, hidden: hidden, dim: dim, locked: locked)
    }
    private static func file(_ name: String, _ size: Int64, ago: Double = 7_200_000, locked: Bool = false) -> FileEntry {
        FileEntry(name: name, kind: .file, size: locked ? 0 : size, mtime: locked ? 0 : now - ago, locked: locked)
    }

    private static let minified = String(repeating: "(()=>{\"use strict\";var e={812:(e,t,n)=>{n.d(t,{A:()=>r});const r=function(e){return e.split(\"/\").filter(Boolean)}}};", count: 40)
    private static let appText = """
    import { createStore } from "./store";
    import { List } from "./components/List";

    // The list, most recently used first; pinned rows stay on top.
    export function mountApp(root: HTMLElement) {
      const store = createStore();
      const list = new List(root, {
        rows: () => store.sorted(),
        onOpen: (row) => store.touch(row.id),
      });
      store.subscribe(() => list.render());
      list.render();
      return () => list.dispose();
    }

    """
    private static let appDetails = FileDetails(entry: file("app.ts", 2140, ago: 600_000), path: "\(home)/Projects/lumen/src/app.ts", type: .text, lines: 14)

    private static var levels: [FileLevel] {
        let lumen = "\(home)/Projects/lumen"
        return [
            FileLevel(path: home, parent: "/Users", home: home, entries: [
                dir(".agentswitch", hidden: true), dir(".secret-gate", hidden: true, locked: true), dir(".ssh", hidden: true), file(".zshrc", 640),
                dir("Desktop"), dir("Documents"), dir("Downloads"), dir("Projects"),
            ]),
            FileLevel(path: "\(home)/.agentswitch", parent: home, home: home, entries: [dir("nodes", locked: true), file("local-token", 64, locked: true), dir("terminals"), file("agentswitch.db", 18_400_000)]),
            FileLevel(path: "\(home)/.ssh", parent: home, home: home, entries: [file("config", 320), file("id_ed25519", 411), file("id_ed25519.pub", 98)]),
            FileLevel(path: "\(home)/Projects", parent: home, home: home, entries: [dir("harbor-api"), dir("lumen"), dir("notes"),
                FileEntry(name: "current", kind: .link, mtime: now - 86_400_000, link: FileEntry.Link(target: lumen, kind: .dir))]),
            FileLevel(path: lumen, parent: "\(home)/Projects", home: home, entries: [
                FileEntry(name: ".env", kind: .file, size: 48, mtime: now - 86_400_000 * 14), dir(".git", hidden: true, dim: true), dir("docs", ago: 86_400_000 * 2),
                dir("node_modules", dim: true), dir("src", ago: 600_000), dir("tests", ago: 900_000), file("package.json", 410, ago: 86_400_000 * 15),
                file("README.md", 520, ago: 86_400_000 * 2), file("tsconfig.json", 210, ago: 86_400_000 * 17),
            ]),
            FileLevel(path: "\(lumen)/src", parent: lumen, home: home, entries: [dir("components", ago: 900_000), file("app.ts", 2140, ago: 600_000), file("main.ts", 120, ago: 86_400_000 * 14), file("store.ts", 3980, ago: 600_000)]),
            FileLevel(path: "\(lumen)/src/components", parent: "\(lumen)/src", home: home, entries: [file("Button.tsx", 180), file("List.tsx", 560)]),
            FileLevel(path: "\(lumen)/docs", parent: lumen, home: home, entries: [file("design.md", 380), file("logo.png", 24_600)]),
        ]
    }
}
#endif
