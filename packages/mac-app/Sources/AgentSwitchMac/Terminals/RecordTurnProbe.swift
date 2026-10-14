#if DEBUG
import AgentSwitchMacCore
import AppKit
import SwiftUI

/// `-designPreview <dir> -designPreviewOnly record-turn` (debug builds; no service): a long record in its pane, at its
/// end, while what a session does to it happens — a turn ends (the status goes still, the last run of work closes, an
/// answer is added; in one step or two); the session not known for a moment; the record read again whole, or under
/// other names, or much shorter; the reader a little way up, then `↓ Latest` clicked; `Earlier` clicked at its start
/// and the session going on meanwhile; a run of work opened by a click; a long reply typed; an answer growing.
/// After each step `turn.txt` gets a line — where the record's scroller stands in its document, how much of what it
/// shows is drawn on (a pane left blank reads 0%), how many items are shown — and the page's picture is
/// `turn-<scene>-<step>.png`. `-probeOnScreen YES` puts the window on screen behind the others, which the clicks need
/// (and where the page is drawn as the display asks, not as the probe does); `-probeScene <name>` plays one scene.
/// `-probeReal YES`: the session has the sizes a real one has (answers from a line to a few thousand characters,
/// code, tables) instead of forty like turns.
/// `-probePerf YES` instead says what a record of 60 items and one of 300 cost: to show, to add to, to read through.
@MainActor
enum RecordTurnProbe {
    static func run(into directory: URL) async throws {
        let log = Log()
        if UserDefaults.standard.bool(forKey: "probePerf") { return try await perf(into: directory, log: log) }
        let onScreen = UserDefaults.standard.bool(forKey: "probeOnScreen")
        let only = UserDefaults.standard.string(forKey: "probeScene")
        for scene in Scene.allCases where only == nil || only == scene.rawValue {
            try await TerminalsPagePreview.shot(to: directory.appendingPathComponent("turn-\(scene.rawValue)-0.png"), light: true, onScreen: onScreen, stage: { model in
                model.setSimple(true, pane: TerminalPanes.paneShowing(model.layout, "t1")?.id)
                guard let pane = model.panes.values.first(where: { $0.session?.id == "t1" }), let info = pane.session?.info else { return }
                pane.record.stage(terminal: info, items: items(turns: 40, working: true), plan: [], usage: RecordUsage(model: "gpt-5.5", used: 74_000, window: 200_000, effort: "high"), mode: nil,
                                  activity: TerminalActivity(tool: "Bash", target: "npm test"), since: Date().addingTimeInterval(-30))
            }, then: { model, host in try await play(scene, model: model, host: host, directory: directory, log: log) })
        }
        try log.lines.joined(separator: "\n").appending("\n").write(to: directory.appendingPathComponent("turn.txt"), atomically: true, encoding: .utf8)
    }

    /// What the record costs to lay out: a session of 60 items and one of 300, first shown, an answer added, its last
    /// answer growing, and the pane a little narrower.
    private static func perf(into directory: URL, log: Log) async throws {
        for count in [60, 300] {
            try await TerminalsPagePreview.shot(to: directory.appendingPathComponent("perf-\(count).png"), light: true, onScreen: true, stage: { model in
                model.setSimple(true, pane: TerminalPanes.paneShowing(model.layout, "t1")?.id)
            }, then: { model, host in try await perfPlay(count, model: model, host: host, directory: directory, log: log) })
        }
        try log.lines.joined(separator: "\n").appending("\n").write(to: directory.appendingPathComponent("perf.txt"), atomically: true, encoding: .utf8)
    }

    private static func perfPlay(_ count: Int, model: TerminalsModel, host: NSView, directory: URL, log: Log) async throws {
        guard let pane = model.panes.values.first(where: { $0.session?.id == "t1" }), let info = pane.session?.info, let window = host.window else { return }
        func timed(_ what: String, _ change: () -> Void) async {
            let start = CFAbsoluteTimeGetCurrent()
            change()
            host.layoutSubtreeIfNeeded()
            host.displayIfNeeded()
            CATransaction.flush()
            let first = (CFAbsoluteTimeGetCurrent() - start) * 1000
            // Whatever is left to the next turns of the run loop.
            var rest = 0.0
            for _ in 0..<6 {
                try? await Task.sleep(for: .milliseconds(20))
                let again = CFAbsoluteTimeGetCurrent()
                host.layoutSubtreeIfNeeded()
                host.displayIfNeeded()
                rest += (CFAbsoluteTimeGetCurrent() - again) * 1000
            }
            log.say(String(format: "%d items, %@: %.0f ms at once, %.0f ms after", count, what, first, rest))
        }
        let all = realistic(count)
        await timed("first shown") {
            pane.record.stage(terminal: info, items: Array(all.dropLast()), plan: [], usage: nil, mode: nil, activity: TerminalActivity(tool: "Bash", target: "npm test"), since: Date())
        }
        try await DesignPreview.settle()
        await timed("an answer added") { pane.record.stageItems(all, activity: TerminalActivity(tool: "Bash", target: "npm test")) }
        for n in 1...3 {
            let last = all[all.count - 1]
            let grown = RecordItem(id: last.id, kind: .answer, at: last.at, text: last.text + String(repeating: "\n\n又写了一段，说明排序在模型里做的理由。", count: n))
            await timed("its last answer longer (\(n))") { pane.record.stageItems(all.dropLast() + [grown], activity: TerminalActivity(tool: "Bash", target: "npm test")) }
        }
        await timed("the window 60 pt narrower") {
            var frame = window.frame
            frame.size.width -= 60
            window.setFrame(frame, display: false)
        }
        await timed("the same again (nothing changed)") { pane.record.stageItems(all, activity: TerminalActivity(tool: "Bash", target: "npm test")) }
        log.say(String(format: "%d items: %.0f MB in use at its end", count, footprint()))
        // Read from its end to its start and back, a screen at a time.
        if let scroll = scroller(host) {
            let start = CFAbsoluteTimeGetCurrent()
            var moves = 0
            var worst = 0.0
            for direction in [-1.0, 1.0] {
                for _ in 0..<400 {
                    let before = scroll.contentView.bounds.origin
                    let frame = CFAbsoluteTimeGetCurrent()
                    self.scroll(host, by: direction * 600)
                    host.layoutSubtreeIfNeeded()
                    host.displayIfNeeded()
                    CATransaction.flush()
                    worst = max(worst, (CFAbsoluteTimeGetCurrent() - frame) * 1000)
                    moves += 1
                    try? await Task.sleep(for: .milliseconds(4))
                    if abs(scroll.contentView.bounds.origin.y - before.y) < 1 { break }
                }
            }
            log.say(String(format: "%d items: read through and back in %d moves, %.0f ms a move on average, %.0f ms the slowest, %.0f MB in use after",
                           count, moves, (CFAbsoluteTimeGetCurrent() - start) * 1000 / Double(max(moves, 1)), worst, footprint()))
        }
        try DesignPreview.write(host, to: directory.appendingPathComponent("perf-\(count)-end.png"))
        log.say("\(count) items: \(measure(host, file: directory.appendingPathComponent("perf-\(count)-end.png")))")
    }

    /// What the process holds, in megabytes.
    private static func footprint() -> Double {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let ok = withUnsafeMutablePointer(to: &info) { $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) } }
        return ok == KERN_SUCCESS ? Double(info.phys_footprint) / 1_048_576 : -1
    }

    /// A made-up session with the sizes a real one has: short asks, answers from a line to a few thousand characters,
    /// some with code and tables, runs of work between.
    static func realistic(_ count: Int) -> [RecordItem] {
        // (kind, characters, code blocks, table rows)
        let shapes: [(RecordItem.Kind, Int, Int, Int)] = [
            (.user, 34, 0, 0), (.answer, 64, 0, 0), (.work, 2, 0, 0), (.answer, 866, 1, 0), (.user, 27, 0, 0), (.answer, 62, 0, 0), (.work, 1, 0, 0), (.answer, 478, 1, 0),
            (.user, 39, 0, 0), (.answer, 88, 0, 0), (.note, 11, 0, 0), (.user, 18, 0, 0), (.answer, 376, 0, 0), (.user, 42, 0, 0), (.answer, 60, 0, 0), (.work, 1, 0, 0),
            (.answer, 691, 0, 5), (.user, 64, 0, 0), (.answer, 479, 0, 0), (.user, 58, 0, 0), (.answer, 91, 0, 0), (.work, 5, 0, 0), (.answer, 1117, 0, 6), (.user, 39, 0, 0),
            (.answer, 1272, 1, 10), (.user, 78, 0, 0), (.answer, 160, 0, 0), (.work, 1, 0, 0), (.answer, 3782, 5, 12), (.user, 9, 0, 0), (.answer, 655, 1, 0), (.user, 6, 0, 0), (.answer, 778, 1, 0),
        ]
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let sentence = "排序放在模型里做，界面只读结果，这样列表、搜索和快捷键用的是同一份顺序。"
        return (0..<count).map { n in
            let (kind, size, code, rows) = shapes[n % shapes.count]
            let id = String(1000 + n * 977), at = now - Int64(count - n) * 30_000
            switch kind {
            case .work:
                return RecordItem(id: id, kind: .work, at: at, seconds: 20 + n % 40, steps: (0..<size).map { RecordStep(kind: $0 % 2 == 0 ? .run : .read, text: "swift test --filter ListTests\($0)") })
            case .note:
                return RecordItem(id: id, kind: .note, at: at, text: "Compacted · 899k → 15k")
            case .user:
                return RecordItem(id: id, kind: .user, at: at, text: String(String(repeating: sentence, count: 3).prefix(size)))
            case .answer:
                var parts: [String] = []
                var left = size
                for k in 0..<code { parts.append("```swift\nlet sorted = rows.sorted { $0.usedAt > $1.usedAt }   // \(k)\nreturn pinned + sorted.filter { !$0.pinned }\n```"); left -= 110 }
                if rows > 0 { parts.append((["| 项 | 现在 | 改后 |", "| --- | --- | --- |"] + (0..<rows).map { "| 第 \($0 + 1) 行 | 按名字 | 按最近使用 |" }).joined(separator: "\n")); left -= rows * 22 }
                var k = 0
                while left > 0 {
                    let take = min(left, k % 3 == 1 ? 90 : 160)
                    let text = String(String(repeating: sentence, count: 6).prefix(take))
                    parts.insert(k % 3 == 1 ? "- \(text)\n- 置顶的行保持原来的相对顺序。" : text, at: min(parts.count, k))
                    left -= take + (k % 3 == 1 ? 18 : 0)
                    k += 1
                }
                return RecordItem(id: id, kind: .answer, at: at, text: parts.joined(separator: "\n\n"))
            }
        }
    }

    final class Log {
        var lines: [String] = []
        func say(_ line: String) { lines.append(line); FileHandle.standardError.write(Data("\(line)\n".utf8)) }
    }

    private static func play(_ scene: Scene, model: TerminalsModel, host: NSView, directory: URL, log: Log) async throws {
        func pause(_ ms: Int) async { try? await Task.sleep(for: .milliseconds(ms)) }
        guard let pane = model.panes.values.first(where: { $0.session?.id == "t1" }) else { return }
        var step = 0
        func mark(_ what: String) async throws {
            step += 1
            let file = directory.appendingPathComponent("turn-\(scene.rawValue)-\(step).png")
            try DesignPreview.write(host, to: file)
            log.say("\(scene.rawValue) \(step) \(what): \(measure(host, file: file)), \(pane.record.shown(working: false).count) of \(pane.record.items.count) items shown\(pane.record.earlierWaits ? ", more before" : "")")
        }
        // A click as the pointer's, at a place in the record's pane counted from its left and its top.
        func click(_ x: CGFloat, top: CGFloat) async {
            guard let scroll = scroller(host), let window = host.window else { return }
            let at = scroll.convert(NSPoint(x: x, y: scroll.isFlipped ? top : scroll.bounds.height - top), to: nil)
            // What the window gives the press to (a text laid out by AppKit under something SwiftUI draws over it would
            // take it: ProseText).
            log.say("     the click at \(Int(at.x)),\(Int(at.y)) meets \(window.contentView?.hitTest(at).map { String(describing: type(of: $0)) } ?? "nothing")")
            for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
                guard let e = NSEvent.mouseEvent(with: type, location: at, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                                 context: nil, eventNumber: 0, clickCount: 1, pressure: type == .leftMouseUp ? 0 : 1) else { continue }
                NSApp.postEvent(e, atStart: false)
            }
            await pause(500)
        }
        // `↓ Latest`: in the middle of the pane, its foot just above what floats there.
        func latest() async {
            guard let scroll = scroller(host) else { return }
            await click(scroll.bounds.width / 2, top: scroll.bounds.height - scroll.contentInsets.bottom - 12)
        }
        func idle() { pane.session?.received(event: "status", data: #"{"status":"idle"}"#) }
        try await DesignPreview.settle()
        try await mark("at work, at its end")
        switch scene {
        case .ends:
            idle()
            pane.record.stageItems(items(turns: 40, working: false))
            await pause(50)
            try await mark("the turn ended, 0.05 s on")
        case .statusFirst:
            idle()
            await pause(120)
            try await mark("still, the record not read yet")
            pane.record.stageItems(items(turns: 40, working: false))
            await pause(50)
            try await mark("the record read")
        case .unknown:
            pane.record.stageItems([], loaded: true, session: nil)
            await pause(120)
            try await mark("no session for a moment")
            pane.record.stageItems([], loaded: false)
            await pause(120)
            try await mark("its session again, being read")
            idle()
            pane.record.stageItems(items(turns: 40, working: false))
            await pause(50)
            try await mark("read")
        case .reread:
            pane.record.stageItems([], loaded: false)
            await pause(30)
            idle()
            pane.record.stageItems(items(turns: 40, working: false))
            await pause(50)
            try await mark("read again whole")
        case .renamed:
            idle()
            pane.record.stageItems(items(turns: 40, working: false, base: 7))
            await pause(50)
            try await mark("every item under another name")
        case .shorter:
            idle()
            pane.record.stageItems(Array(items(turns: 40, working: false).suffix(12)))
            await pause(50)
            try await mark("the last 12 items alone")
        case .up:
            scroll(host, by: -900)
            await pause(300)
            try await mark("900 pt up")
            idle()
            pane.record.stageItems(items(turns: 40, working: false))
            await pause(50)
            try await mark("the turn ended")
            await latest()
            try await mark("↓ Latest clicked")
        case .earlier:
            scroll(host, by: -1_000_000)
            await pause(300)
            try await mark("at its start")
            // `Earlier`, under the header: looked for down the middle of the pane.
            let before = pane.record.start
            var top: CGFloat = 60
            while pane.record.start == before, top < 200, let scroll = scroller(host) {
                await click(scroll.bounds.width / 2, top: top)
                top += 7
            }
            try await mark("Earlier clicked (found \(Int(top - 7)) pt down)")
            pane.record.stageItems(items(turns: 41, working: true), activity: TerminalActivity(tool: "Bash", target: "npm test"))
            await pause(200)
            try await mark("another turn began meanwhile")
            scroll(host, by: 1_000_000)
            await pause(300)
            try await mark("back at its end")
            idle()
            pane.record.stageItems(items(turns: 41, working: false))
            await pause(50)
            try await mark("the turn ended")
        case .opens:
            // The last run of work, opened by a click on its line (looked for upwards from the foot): the reader's own
            // doing, so the record is not put at its end.
            guard let scroll = scroller(host) else { break }
            let before = scroll.documentView?.frame.height ?? 0
            var up: CGFloat = 24
            while (scroll.documentView?.frame.height ?? 0) == before, up < 140 {
                await click(scroll.bounds.width / 2 - 200, top: scroll.bounds.height - scroll.contentInsets.bottom - up)
                up += 6
            }
            try await mark("its last run of work opened (found \(Int(up - 6)) pt above the foot)")
            idle()
            pane.record.stageItems(items(turns: 40, working: false))
            await pause(50)
            try await mark("the turn ended")
        case .typing:
            pane.record.draft = "第一行\n第二行\n第三行\n第四行\n第五行\n第六行"
            await pause(400)
            try await mark("six lines in the reply box")
            idle()
            pane.record.stageItems(items(turns: 40, working: false))
            await pause(50)
            try await mark("the turn ended")
        case .grows:
            for n in 1...12 {
                pane.record.stageItems(items(turns: 40, working: true, grown: n), activity: TerminalActivity(tool: "Bash", target: "npm test"))
                await pause(60)
            }
            try await mark("its last answer written, 12 reads")
            idle()
            pane.record.stageItems(items(turns: 40, working: false, grown: 12))
            await pause(50)
            try await mark("the turn ended")
        }
        try await DesignPreview.settle()
        try await mark("settled")
        await pause(1500)
        try await mark("1.5 s later")
    }

    private static let began = Int64(Date().timeIntervalSince1970 * 1000)

    enum Scene: String, CaseIterable { case ends, statusFirst, unknown, reread, renamed, shorter, up, earlier, opens, typing, grows }

    /// A made-up session of `turns` turns: what was asked, a run of work, an answer of some length. `working`: the last
    /// turn is still going (its run of work open, no answer yet). `grown`: how much of the last answer is written.
    static func items(turns: Int, working: Bool, base: Int64 = 0, grown: Int? = nil) -> [RecordItem] {
        if UserDefaults.standard.bool(forKey: "probeReal") {
            var all = realistic(turns == 41 ? 52 : 50)
            if base != 0 { all = all.map { RecordItem(id: String((Int64($0.id) ?? 0) + base), kind: $0.kind, at: $0.at, text: $0.text, seconds: $0.seconds, steps: $0.steps) } }
            if working, grown == nil { return Array(all.dropLast()) }
            if let grown, let last = all.last { return all.dropLast() + [RecordItem(id: last.id, kind: .answer, at: last.at, text: String(last.text.prefix(last.text.count * grown / 12)))] }
            return all
        }
        let now = began
        var out: [RecordItem] = []
        for turn in 0..<turns {
            let at = now + Int64(turn - 40) * 90_000
            let id = { (part: Int64) in String(base + Int64(turn) * 10_000 + part) }
            let last = turn == turns - 1
            out.append(RecordItem(id: id(0), kind: .user, at: at, text: "第 \(turn + 1) 件事：把列表的排序改成按最近使用，置顶的仍然在最前。"))
            let steps = (0..<(3 + turn % 6)).map { n in
                n % 3 == 0 ? RecordStep(kind: .read, text: "packages/app/Sources/List/ListModel\(n).swift")
                    : n % 3 == 1 ? RecordStep(kind: .run, text: "swift test --filter ListTests", out: "Executed \(20 + n) tests, with 0 failures")
                    : RecordStep(kind: .edit, text: "packages/app/Sources/List/ListView.swift", added: 4 + n, removed: n)
            }
            out.append(RecordItem(id: id(1), kind: .work, at: at + 2000, seconds: last && working ? 0 : 40 + turn, steps: steps))
            if last, working, grown == nil { continue }
            let paragraphs = last ? (grown ?? 12) : 2 + (turn * 7) % 9
            let text = (0..<paragraphs).map { n in
                n % 4 == 3 ? "```swift\nlet sorted = rows.sorted { $0.usedAt > $1.usedAt }\nlet pinned = sorted.filter(\\.pinned)\nreturn pinned + sorted.filter { !$0.pinned }\n```"
                    : n % 4 == 1 ? "- 置顶的行保持原来的相对顺序。\n- 其余的行按最近一次使用的时间从新到旧。\n- 从没用过的排在最后，按名字。"
                    : "排序放在模型里做，界面只读结果；这样列表、搜索和快捷键切换用的是同一份顺序，不会出现列表里是第三个、按 ⌘3 却到了另一个的情况。第 \(n + 1) 段。"
            }.joined(separator: "\n\n")
            out.append(RecordItem(id: id(2), kind: .answer, at: at + 60_000, text: text))
        }
        return out
    }

    /// The record's scroller: the one whose document is the tallest.
    private static func scroller(_ host: NSView) -> NSScrollView? {
        var found: [NSScrollView] = []
        func walk(_ view: NSView) {
            if let scroll = view as? NSScrollView { found.append(scroll) }
            view.subviews.forEach(walk)
        }
        walk(host)
        return found.max { ($0.documentView?.frame.height ?? 0) < ($1.documentView?.frame.height ?? 0) }
    }

    private static func scroll(_ host: NSView, by: CGFloat) {
        guard let scroll = scroller(host) else { return }
        var origin = scroll.contentView.bounds.origin
        let last = (scroll.documentView?.frame.height ?? 0) + scroll.contentInsets.bottom - scroll.contentView.bounds.height
        origin.y = max(0, min(origin.y + by, last))
        scroll.contentView.scroll(to: origin)
        scroll.reflectScrolledClipView(scroll.contentView)
    }

    /// Where the scroller stands in its document, and how much of what it shows is drawn on (pixels that are not the
    /// ground's colour, of the part above what floats at its foot).
    private static func measure(_ host: NSView, file: URL) -> String {
        guard let scroll = scroller(host), let document = scroll.documentView else { return "no scroller" }
        let visible = scroll.documentVisibleRect
        let inset = scroll.contentInsets
        var drawn = "?"
        if let rep = NSImage(contentsOf: file)?.representations.first as? NSBitmapImageRep {
            let frame = scroll.convert(scroll.bounds, to: host)
            let scale = CGFloat(rep.pixelsWide) / host.bounds.width
            // The picture's rows run from the top; the host's from the bottom unless it is flipped.
            let top = host.isFlipped ? frame.minY : host.bounds.height - frame.maxY
            let x0 = Int((frame.minX + 30) * scale), x1 = Int((frame.maxX - 30) * scale)
            let y0 = Int((top + 8) * scale), y1 = Int((top + frame.height - inset.bottom - 8) * scale)
            var counts: [UInt32: Int] = [:]
            var total = 0
            var y = y0
            while y < y1 {
                var x = x0
                while x < x1 {
                    if let c = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) {
                        let key = UInt32(c.redComponent * 31) << 10 | UInt32(c.greenComponent * 31) << 5 | UInt32(c.blueComponent * 31)
                        counts[key, default: 0] += 1
                        total += 1
                    }
                    x += 3
                }
                y += 3
            }
            let ground = counts.values.max() ?? 0
            drawn = total > 0 ? String(format: "%.1f%%", Double(total - ground) * 100 / Double(total)) : "?"
        }
        return String(format: "document %.0f tall, showing %.0f…%.0f (%.0f from its end), foot inset %.0f, drawn on %@", document.frame.height, visible.minY, visible.maxY,
                      document.frame.height - visible.maxY, inset.bottom, drawn)
    }
}
#endif
