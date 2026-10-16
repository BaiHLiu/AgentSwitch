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
}
#endif
