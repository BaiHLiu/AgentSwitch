#if DEBUG
import AgentSwitchMacCore
import AppKit

/// `-nodesProbe <dir>` (debug builds, with `-localPort` and AGENTSWITCH_HOME of a running service that is paired with
/// another node — two throw-away `AGENTSWITCH_ROUTER=echo` daemons, as packages/daemon/scripts/mesh_smoke.sh starts
/// them): the main window behind every other window (the app is not made active), first on this node's own pages
/// (`own.png`), then on the other node's by the call the bar's node menu makes (`node-dispatch.png`,
/// `node-terminals.png`), then back (`back.png`); Settings › Nodes from the service's own answers
/// (`settings-nodes.png`); and what the calls through the other node returned (`calls.txt`), so the client's decoding
/// is checked against a real service on the far side of a real connection. Nothing else of the app starts.
@MainActor
enum NodesProbe {
    static var directory: URL? { UserDefaults.standard.string(forKey: "nodesProbe").map { URL(fileURLWithPath: $0) } }

    static func run(_ main: MainWindowController, model: AppModel, into dir: URL) {
        model.probeServiceUp()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        MainWindowController.probing = true
        Task {
            let ok = await go(main, model: model, into: dir)
            exit(ok ? 0 : 1)
        }
    }

    private static func go(_ main: MainWindowController, model: AppModel, into dir: URL) async -> Bool {
        var lines: [String] = []
        func step(_ name: String, _ body: () async throws -> String) async {
            do { lines.append("ok   \(name): \(try await body())") } catch { lines.append("FAIL \(name): \(error)") }
        }
        func write() { try? lines.joined(separator: "\n").write(to: dir.appendingPathComponent("calls.txt"), atomically: true, encoding: .utf8) }
        await model.refreshDevices()
        await model.nodes.refresh(model)
        await model.nodes.loadMesh(model)
        await step("nodes") { try await model.client.nodes().nodes.map { "\($0.name)=\($0.state.rawValue)@\($0.address ?? "-") inbound=\($0.inbound != nil)" }.joined(separator: " ") }
        await step("mesh settings") { "keyboard=\(try await model.client.meshSettings().keyboard)" }
        main.show(.dispatch)
        try? await Task.sleep(for: .seconds(4))
        shot(main.window?.contentView, dir.appendingPathComponent("own.png"))
        guard let node = model.nodes.nodes.first(where: { $0.state == .online }) else {
            lines.append("FAIL no node of this service answers")
            write()
            return false
        }
        // The call the bar's node menu makes.
        main.use(node: node)
        try? await Task.sleep(for: .seconds(5))
        shot(main.window?.contentView, dir.appendingPathComponent("node-dispatch.png"))
        let there = main.probeClient
        await step("there: is another node's") { "remote=\(there.isRemote) prefix=\(there.nodePrefix) screens=\(TerminalSizeHolder.screen(onNodeAs: there.screenOwner, unique: "x"))" }
        await step("there: node") { let i = try await there.nodeInfo(); return "\(i.name) kind=\(i.kind) has=\(i.has.joined(separator: ","))" }
        await step("there: tasks") { try await there.tasks(limit: 20).map { "\($0.id)=\($0.status.label)" }.joined(separator: " ") }
        await step("there: live") { let l = try await there.live(); return "rows=\(l.rows.count)" }
        await step("there: terminals") { "\(try await there.terminals().terminals.count) terminal(s)" }
        await step("there: what a paired node may not reach (a FAIL is right)") { _ = try await there.devices(); return "REACHED the device list" }
        await step("here: tasks") { try await model.client.tasks(limit: 20).map { "\($0.id)=\($0.status.label)" }.joined(separator: " ") }
        main.show(.terminals)
        try? await Task.sleep(for: .seconds(4))
        shot(main.window?.contentView, dir.appendingPathComponent("node-terminals.png"))
        // The strip's way back.
        main.use(node: nil)
        try? await Task.sleep(for: .seconds(3))
        main.show(.dispatch)
        try? await Task.sleep(for: .seconds(2))
        shot(main.window?.contentView, dir.appendingPathComponent("back.png"))
        let navigation = SettingsNavigation(wizardStore: SetupWizardStore(defaults: nil))
        navigation.tab = .nodes
        let settings = SettingsWindowController.makeWindow(model: model, navigation: navigation, appearance: NSAppearance(named: .darkAqua))
        try? await Task.sleep(for: .seconds(3))
        shot(settings.contentView?.superview ?? settings.contentView, dir.appendingPathComponent("settings-nodes.png"))
        write()
        return true
    }

    private static func shot(_ view: NSView?, _ file: URL) {
        guard let view, let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
        view.cacheDisplay(in: view.bounds, to: rep)
        try? rep.representation(using: .png, properties: [:])?.write(to: file)
    }
}
#endif
