#if DEBUG
import AgentSwitchMacCore
import AppKit

/// `-filesProbe <dir> -probeFolder <path>` (debug builds, with `-localPort` and AGENTSWITCH_HOME of a throw-away service;
/// docs/files-v0.md): the main window's Files column against that service, behind every other window (the app is not
/// made active). It opens the column at the folder (as `Show in Files` does), opens a folder in the tree, selects a file
/// (its details and the start of its text read from the service), walks the list with the keyboard (↓ ↓ → ←, ⌘⇧.),
/// adds a file to the folder and waits for the column's next look, opens the service's own home (its credential places
/// locked), floats the column and closes it with ⇧⌘F's action. What it saw goes to `files.txt`, pictures to
/// `files-*.png`. Nothing else of the app starts.
///
/// With `-probeChanges YES` it walks the changes instead (docs/files-v0.md §12.2), through the column's own actions and
/// keys: `+`'s `New File…` with a name already there and then `probe7f3a-utils/date.ts` typed into the box and ↩, ⌘Z and ⇧⌘Z, ↩ on
/// a file and a new name, ⌘Z, ⌘⌫ on a file and ⌘Z, and ⌘⌫ on a folder holding the service's own places. It says what
/// the box held, the line under it, the line at the foot and what is on the disk, into `changes.txt`; pictures to
/// `change-*.png`.
@MainActor
enum FilesProbe {
    static var directory: URL? { UserDefaults.standard.string(forKey: "filesProbe").map { URL(fileURLWithPath: $0) } }

    static func run(_ main: MainWindowController, model: AppModel, into dir: URL) {
        model.probeServiceUp()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        MainWindowController.probing = true
        main.show(.terminals)
        var lines: [String] = []
        func say(_ line: String) {
            lines.append(line)
            try? lines.joined(separator: "\n").write(to: dir.appendingPathComponent("files.txt"), atomically: true, encoding: .utf8)
        }
        func shot(_ name: String) {
            guard let view = main.window?.contentView?.superview ?? main.window?.contentView, let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
            view.cacheDisplay(in: view.bounds, to: rep)
            try? rep.representation(using: .png, properties: [:])?.write(to: dir.appendingPathComponent("\(name).png"))
        }
        func pause(_ seconds: Double) async { try? await Task.sleep(for: .milliseconds(Int(seconds * 1000))) }
        func key(_ code: UInt16, _ chars: String, _ flags: NSEvent.ModifierFlags = []) {
            guard let files = main.probeFiles, let keys = files.keys, let window = main.window,
                  let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: 0, windowNumber: window.windowNumber, context: nil,
                                               characters: chars, charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code) else { return }
            keys.keyDown(with: event)
        }
        if UserDefaults.standard.bool(forKey: "probeChanges") { return changes(main, dir: dir, say: { line in
            lines.append(line)
            try? lines.joined(separator: "\n").write(to: dir.appendingPathComponent("changes.txt"), atomically: true, encoding: .utf8)
        }, shot: shot, pause: pause, key: key) }
        Task {
            await pause(3)
            guard let files = main.probeFiles, let folder = UserDefaults.standard.string(forKey: "probeFolder") else { say("no column"); exit(1) }
            files.show(folder: folder)
            await pause(2)
            let level = files.levels[folder]
            say("open: root \(files.root ?? "-") entries [\(level?.entries.map { $0.name + ($0.isFolder ? "/" : "") }.joined(separator: " ") ?? "none")] hidden \(level?.entries.filter(\.hidden).count ?? -1) refusal \(files.refusals[folder].map { "\($0)" } ?? "none")")
            shot("files-open")
            files.twist(folder + "/src")
            await pause(1.5)
            say("tree: " + files.treeRows().map { "\($0.twig)\($0.entry.name)" }.joined(separator: " | "))
            files.select(folder + "/src/app.ts", classic: false)
            await pause(1.5)
            let d = files.details[folder + "/src/app.ts"]
            say("selected: \(files.selection) details \(d.map { FilesText.info($0) } ?? "none") text \(files.remoteText.map { "\($0.text.split(separator: "\n").count) lines, truncated \($0.truncated)" } ?? "none")")
            shot("files-preview")
            files.focusKeys()
            say("keyboard in the list: \(files.hasKeys)")
            key(125, "\u{F701}"); key(125, "\u{F701}")
            say("↓ ↓: \(files.selection.map { ($0 as NSString).lastPathComponent })")
            files.select(folder + "/docs", classic: false)
            key(124, "\u{F703}")
            await pause(1)
            say("→ on docs: open \(files.expanded.contains(folder + "/docs"))")
            key(123, "\u{F702}")
            say("← on docs: open \(files.expanded.contains(folder + "/docs"))")
            key(47, ".", [.command, .shift])
            say("⌘⇧.: hidden shown \(files.showHidden)")
            try? "new".write(toFile: folder + "/added-later.txt", atomically: true, encoding: .utf8)
            await pause(4.5)
            say("after a poll: added-later.txt listed \(files.entries(of: folder).contains { $0.name == "added-later.txt" })")
            files.floating = true
            await pause(1)
            shot("files-float")
            if let home = ProcessInfo.processInfo.environment["AGENTSWITCH_HOME"] {
                files.show(folder: home)
                await pause(2)
                say("service home: " + (files.levels[home]?.entries.map { $0.name + ($0.locked ? " (locked)" : "") }.joined(separator: ", ") ?? "unread \(files.refusals[home].map { "\($0)" } ?? "")"))
                files.show(folder: home + "/nodes")
                await pause(1.5)
                say("its nodes folder: \(files.refusals[home + "/nodes"].map { "\($0)" } ?? "read")")
                shot("files-locked")
            }
            main.probeToggleFiles()
            await pause(0.5)
            say("⇧⌘F: open \(files.open)")
            exit(0)
        }
    }

    /// The changes' walk (`-probeChanges YES`).
    private static func changes(_ main: MainWindowController, dir: URL, say: @escaping (String) -> Void, shot: @escaping (String) -> Void,
                                pause: @escaping (Double) async -> Void, key: @escaping (UInt16, String, NSEvent.ModifierFlags) -> Void) {
        let disk = FileManager.default
        /// The box's own keyboard: what is typed goes into the field editor of the box that has it.
        func box() -> NSTextView? { main.window?.firstResponder as? NSTextView }
        func type(_ text: String, replacing all: Bool) {
            guard let editor = box() else { return say("  (no box has the keys)") }
            if all { editor.selectAll(nil) }
            editor.insertText(text, replacementRange: editor.selectedRange())
        }
        func enter() {
            guard let editor = box(), let window = main.window,
                  let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber, context: nil,
                                               characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36) else { return }
            editor.keyDown(with: event)
        }
        func line(_ files: FilesColumn) -> String { files.edit.map { "box \"\($0.text)\" · \(files.check($0).line ?? "no line")" } ?? "no box" }
        Task {
            await pause(3)
            guard let files = main.probeFiles, let folder = UserDefaults.standard.string(forKey: "probeFolder") else { say("no column"); exit(1) }
            let at = { (rel: String) in disk.fileExists(atPath: folder + "/" + rel) }
            files.show(folder: folder)
            await pause(2)
            say("open: \(files.entries(of: folder).map(\.name).joined(separator: " ")) · look \(files.classic ? "classic" : "pixel")")

            // `+` › New File…, nothing selected: a box on top of the folder shown.
            files.startNew(folder: false)
            await pause(1)
            say("+ › New File…: \(line(files)) · keys in the box \(box() != nil)")
            type("docs", replacing: true)
            await pause(0.4)
            say("typed docs: \(line(files))")
            shot("change-new-taken")
            enter()
            await pause(0.4)
            say("↩ on a name taken: still \(line(files))")
            type("probe7f3a-utils/date.ts", replacing: true)
            await pause(0.4)
            shot("change-new-box")
            enter()
            await pause(2)
            say("↩: on the disk probe7f3a-utils/date.ts \(at("probe7f3a-utils/date.ts")) · selected \(files.selection.map { ($0 as NSString).lastPathComponent }) · \(line(files))")
            shot("change-new-made")

            files.focusKeys()
            key(6, "z", [.command])
            await pause(2)
            say("⌘Z: probe7f3a-utils on the disk \(at("probe7f3a-utils")) · foot \(files.said ?? "-")")
            shot("change-undo-made")
            key(6, "z", [.command, .shift])
            await pause(2)
            say("⇧⌘Z: probe7f3a-utils/date.ts on the disk \(at("probe7f3a-utils/date.ts")) · foot \(files.said ?? "-")")

            // ↩ on a file: its name in a box, the name before the extension selected; a new one typed over it.
            files.select(folder + "/app.ts", classic: files.classic)
            files.focusKeys()
            key(36, "\r", [])
            await pause(1)
            let picked = box().map { ($0.string as NSString).substring(with: $0.selectedRange()) } ?? "-"
            say("↩ on app.ts: \(line(files)) · selected \"\(picked)\"")
            shot("change-rename-box")
            type("index", replacing: false)
            await pause(0.3)
            enter()
            await pause(2)
            say("↩: index.ts \(at("index.ts")) · app.ts \(at("app.ts")) · selected \(files.selection.map { ($0 as NSString).lastPathComponent })")
            shot("change-renamed")
            files.focusKeys()
            key(6, "z", [.command])
            await pause(2)
            say("⌘Z: app.ts \(at("app.ts")) · index.ts \(at("index.ts")) · foot \(files.said ?? "-")")

            // ⌘⌫ on a file: not asked; the line at the foot; ⌘Z puts it back.
            files.select(folder + "/probe7f3a-notes.md", classic: files.classic)
            files.focusKeys()
            key(51, "\u{7F}", [.command])
            await pause(2.5)
            say("⌘⌫ on probe7f3a-notes.md: on the disk \(at("probe7f3a-notes.md")) · asked \(files.question?.text ?? "nothing") · foot \(files.said ?? "-")")
            shot("change-trashed")
            files.focusKeys()
            key(6, "z", [.command])
            await pause(2.5)
            say("⌘Z: probe7f3a-notes.md \(at("probe7f3a-notes.md")) · selected \(files.selection.map { ($0 as NSString).lastPathComponent }) · foot \(files.said ?? "-")")
            shot("change-put-back")

            // A folder holding the service's own places: left out of the menu; ⌘⌫ says why.
            if let home = ProcessInfo.processInfo.environment["AGENTSWITCH_HOME"], let up = FilesPath.parent(of: home) {
                files.show(folder: up)
                await pause(2)
                let state = home
                say("its folder: \((home as NSString).lastPathComponent) fixed \(files.entry(state)?.fixed ?? false)")
                files.select(state, classic: files.classic)
                files.focusKeys()
                key(51, "\u{7F}", [.command])
                await pause(1)
                say("⌘⌫ on it: on the disk \(disk.fileExists(atPath: state)) · foot \(files.said ?? "-")")
                shot("change-fixed")
            }
            // The question a terminal running in a folder brings (no terminal runs here): drawn, and esc says Cancel.
            files.show(folder: folder)
            await pause(1.5)
            files.stageQuestion(FilesQuestion(kind: .trashInUse([folder + "/src"]), text: FilesWords.inUse(terminal: "refreshToken 字段", renaming: false)))
            await pause(0.8)
            shot("change-in-use")
            files.focusKeys()
            key(53, "\u{1B}", [])
            await pause(0.5)
            say("in use: esc leaves \(files.question == nil ? "no box" : "the box") · src on the disk \(at("src"))")
            exit(0)
        }
    }
}
#endif
