import AgentSwitchKit
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

// Changing the Mac's files from the phone (docs/files-v0.md §12.3, §12.8): a new folder or file, a new name, the Mac's
// Trash (asked first: the Trash is on the Mac, the phone cannot take it back), files of this phone's sent into a
// folder, and a file of the Mac's fetched to share on — the system's share sheet, whose Save to Files keeps it on this
// phone where you choose (HIG Activity views: the Share button, no saving of our own).

// MARK: - uploads

extension FilesStore {
    /// `files` (copies on this phone) into `dir` on the Mac. A name taken there (`taken`) waits to be asked about: its
    /// uploads' ids come back, for one question about all of them. A file over the limit is not sent.
    func send(_ files: [URL], to dir: String, taken: Set<String>, source: @escaping @MainActor () -> (any MacFileSource)?) -> [UUID] {
        var asking: [UUID] = []
        for file in files {
            let size = Int64((try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
            var up = Upload(name: file.lastPathComponent, size: size, dir: dir, file: file)
            if size > AgentSwitchAPI.maxFileShare {
                up.state = .failed("文件超过 200 MB，未上传。")
            } else if taken.contains(where: { $0.caseInsensitiveCompare(up.name) == .orderedSame }) {
                up.state = .asking
                asking.append(up.id)
            }
            uploads.append(up)
        }
        pump(source)
        return asking
    }

    /// The answer about names taken: `Keep Both`, `Replace`, or nil for `Stop` (those are let go, the others go on).
    func answer(_ ids: [UUID], _ conflict: UploadConflict?, source: @escaping @MainActor () -> (any MacFileSource)?) {
        for id in ids {
            guard let at = uploads.firstIndex(where: { $0.id == id }) else { continue }
            if let conflict { uploads[at].conflict = conflict; uploads[at].state = .waiting } else { drop(at) }
        }
        pump(source)
    }

    /// `×` on one: stopped if it is going, let go either way.
    func stop(_ id: UUID) {
        if sending?.id == id { sending?.task.cancel() }
        if let at = uploads.firstIndex(where: { $0.id == id }) { drop(at) }
    }

    func retry(_ id: UUID, source: @escaping @MainActor () -> (any MacFileSource)?) {
        guard let at = uploads.firstIndex(where: { $0.id == id }) else { return }
        uploads[at].state = .waiting
        uploads[at].progress = 0
        pump(source)
    }

    private func drop(_ at: Int) {
        try? FileManager.default.removeItem(at: uploads[at].file.deletingLastPathComponent())
        uploads.remove(at: at)
    }

    /// One at a time, while any waits. The system is asked for the time to finish one when the phone leaves the app.
    private func pump(_ source: @escaping @MainActor () -> (any MacFileSource)?) {
        guard !pumping else { return }
        pumping = true
        Task { @MainActor in
            defer { pumping = false }
            while let next = uploads.first(where: { $0.state == .waiting }) {
                guard let api = source() else { break }
                set(next.id) { $0.state = .sending; $0.progress = 0 }
                let id = next.id
                let background = UIApplication.shared.beginBackgroundTask(withName: "upload \(next.name)")
                let task = Task { try await api.upload(next.file, to: next.path, conflict: next.conflict) { p in Task { @MainActor in self.set(id) { $0.progress = p } } } }
                sending = (id, task)
                do {
                    let landed = try await task.value
                    if let at = uploads.firstIndex(where: { $0.id == id }) { drop(at) }
                    lit = landed.path
                    changed += 1
                } catch is CancellationError {
                    // Stopped with `×`: already let go.
                } catch {
                    let said: String
                    if let e = error as? FileChangeError, e.refusal == .exists { said = "此位置已有“\(next.name)”。" }
                    else if let e = error as? FileChangeError, let r = e.refusal { said = r == .tooLarge ? "文件超过 200 MB，未上传。" : r.sentence(mac: macName) }
                    else if case APIError.transport = error, task.isCancelled { said = "" }
                    else { said = error.localizedDescription }
                    if said.isEmpty { if let at = uploads.firstIndex(where: { $0.id == id }) { drop(at) } } else { set(id) { $0.state = .failed(said) } }
                }
                sending = nil
                UIApplication.shared.endBackgroundTask(background)
            }
        }
    }

    private func set(_ id: UUID, _ change: (inout Upload) -> Void) {
        guard let at = uploads.firstIndex(where: { $0.id == id }) else { return }
        change(&uploads[at])
    }

    /// A folder of its own under the app's temporary folder for each file picked, so a name is kept as it was.
    nonisolated static func holder() -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("uploads", isDirectory: true).appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// Files picked in the Files app, copied while their security scope is open.
    nonisolated static func copies(of urls: [URL]) -> [URL] {
        urls.compactMap { url in
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let to = holder().appendingPathComponent(url.lastPathComponent)
            return (try? FileManager.default.copyItem(at: url, to: to)) != nil ? to : nil
        }
    }

    /// A photo the camera took, as the file it is sent as (`Photo 2026-10-18 at 12.30.45.jpg`).
    nonisolated static func cameraFile(_ jpeg: Data) -> URL? {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd 'at' HH.mm.ss"
        let to = holder().appendingPathComponent("Photo \(f.string(from: Date())).jpg")
        return (try? jpeg.write(to: to)) != nil ? to : nil
    }
}

/// Photos and videos as the files they are (HEIC stays HEIC, as AirDrop sends them; files-v0 §12.8), named as the
/// library names them (`IMG_0412.HEIC`). The system's picker: no access to the library is asked for.
struct PhotoFilesPicker: UIViewControllerRepresentable {
    let onDone: ([URL]) -> Void

    func makeUIViewController(context: Context) -> PHPickerViewController {
        var config = PHPickerConfiguration(photoLibrary: .shared())
        config.selectionLimit = 20
        config.preferredAssetRepresentationMode = .current
        config.filter = .any(of: [.images, .videos, .livePhotos])
        let picker = PHPickerViewController(configuration: config)
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: PHPickerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onDone: onDone) }

    final class Coordinator: NSObject, PHPickerViewControllerDelegate {
        let onDone: ([URL]) -> Void
        init(onDone: @escaping ([URL]) -> Void) { self.onDone = onDone }

        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            let done = onDone
            Task {
                var files: [URL] = []
                for result in results { if let url = await Self.file(result.itemProvider) { files.append(url) } }
                await MainActor.run { done(files) }
            }
        }

        /// The item's own file (its first image or movie type), copied out before the provider lets it go.
        private static func file(_ provider: NSItemProvider) async -> URL? {
            guard let type = provider.registeredTypeIdentifiers.first(where: { UTType($0)?.conforms(to: .image) == true || UTType($0)?.conforms(to: .movie) == true }) else { return nil }
            let suggested = provider.suggestedName
            return await withCheckedContinuation { cont in
                _ = provider.loadFileRepresentation(forTypeIdentifier: type) { url, _ in
                    guard let url else { cont.resume(returning: nil); return }
                    let ext = url.pathExtension.isEmpty ? (UTType(type)?.preferredFilenameExtension ?? "") : url.pathExtension
                    let name = (suggested ?? url.deletingPathExtension().lastPathComponent) + (ext.isEmpty ? "" : ".\(ext)")
                    let to = FilesStore.holder().appendingPathComponent(name)
                    cont.resume(returning: (try? FileManager.default.copyItem(at: url, to: to)) != nil ? to : nil)
                }
            }
        }
    }
}

/// A file on its way: on top of its folder's list, how far it has gone, `×` to stop it; a failed one says why and has
/// `Retry` (files-v0 §12.8).
struct UploadRow: View {
    let upload: FilesStore.Upload
    let stop: () -> Void
    let retry: () -> Void
    @Environment(\.interfaceLook) private var look

    private var said: String {
        switch upload.state {
        case .waiting, .asking: return "Waiting"
        case .sending: return "Uploading \(Int(upload.progress * 100))%"
        case .failed(let why): return why
        }
    }

    private var failed: Bool { if case .failed = upload.state { return true } else { return false } }

    var body: some View {
        HStack(spacing: look.isClassic ? 12 : 0) {
            if look.isClassic {
                Image(systemName: FileIcon.symbol(for: upload.name)).font(.system(size: 21, weight: .light)).foregroundStyle(Theme.secondaryInk).frame(width: 30)
            } else {
                Text("├─ ").code(13).foregroundStyle(Theme.inkDim)
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(upload.name).font(look.isClassic ? .system(size: 16) : .system(size: 13.5, design: .monospaced)).foregroundStyle(Theme.ink).lineLimit(1).truncationMode(.middle)
                if look.isClassic {
                    Text("\(said) · \(FileSize.short(upload.size))").font(.system(size: 12.5)).foregroundStyle(failed ? Theme.failed : .secondary).lineLimit(2)
                    if !failed { ProgressView(value: upload.progress).tint(Theme.signal) }
                } else {
                    let cells = 10, on = Int((upload.progress * Double(cells)).rounded())
                    Text(failed ? said : "[\(String(repeating: "█", count: on))\(String(repeating: "░", count: cells - on))] \(upload.state == .sending ? "\(Int(upload.progress * 100))%" : said)")
                        .mono(11).foregroundStyle(failed ? Theme.failed : Theme.secondaryInk).lineLimit(2)
                }
            }
            Spacer(minLength: 8)
            if failed {
                Button(action: retry) { if look.isClassic { Text("Retry") } else { Text("Retry").mono(12) } }.buttonStyle(.plain).foregroundStyle(Theme.signal)
                    .padding(.trailing, 10)
            }
            Button(action: stop) { LookGlyph(glyph: "×", symbol: "xmark").foregroundStyle(.secondary).frame(minWidth: 30, minHeight: 30) }
                .buttonStyle(.plain)
                .accessibilityLabel("Stop")
        }
        .padding(.vertical, look.isClassic ? 9 : 6)
        .padding(.horizontal, Theme.Space.l)
        .overlay(alignment: .bottom) { if look.isClassic { Theme.line.frame(height: 0.5).padding(.leading, 58) } else { HairRule() } }
    }
}

// MARK: - the questions, and what they do

extension FilesSession {
    /// The terminals running in `path` or under it, as the phone knows them (asked about before it moves).
    @MainActor
    static func runningIn(_ path: String, _ terminals: [TerminalInfo]) -> TerminalInfo? {
        terminals.first { $0.isRunning && ($0.workdir == path || $0.workdir.hasPrefix(path == "/" ? "/" : path + "/")) }
    }
}

/// One of the questions on screen (FilesSession): the system's alert with a field for a name, the confirmation before
/// the Mac's Trash, the one about names taken, what the Mac refused; and the share sheet once what is shared is here.
struct FileChangeQuestions: ViewModifier {
    let session: FilesSession
    @Environment(AppModel.self) private var model

    private var mac: String { model.profile?.name ?? "Mac" }

    func body(content: Content) -> some View {
        content
            .alert(session.naming?.title ?? "", isPresented: Binding(get: { session.naming != nil && session.naming?.error == nil }, set: { _ in })) {
                TextField("名称", text: Binding(get: { session.naming?.value ?? "" }, set: { session.naming?.value = $0 }))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button("Cancel", role: .cancel) { session.naming = nil }
                Button(session.naming?.renaming == true ? "Rename" : "Create") { Task { await commitName() } }
                    .disabled((session.naming?.value ?? "").trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .alert(session.naming?.title ?? "", isPresented: Binding(get: { session.naming?.error != nil }, set: { _ in }), presenting: session.naming?.error) { _ in
                Button("OK") { session.naming?.error = nil }
            } message: { Text($0) }
            .confirmationDialog(trashTitle, isPresented: Binding(get: { session.trashing != nil }, set: { if !$0 { session.trashing = nil } }), titleVisibility: .visible, presenting: session.trashing) { t in
                Button(t.permanent ? "Delete Permanently" : "Move to Trash", role: .destructive) { Task { await trash(t) } }
                Button("Cancel", role: .cancel) { session.trashing = nil }
            } message: { t in Text(trashMessage(t)) }
            .confirmationDialog(clashTitle, isPresented: Binding(get: { session.clashing != nil }, set: { if !$0 { answerClash(nil) } }), titleVisibility: .visible, presenting: session.clashing) { _ in
                Button("Keep Both") { answerClash(.keep) }
                Button("Replace") { answerClash(.replace) }
                Button("Stop", role: .cancel) { answerClash(nil) }
            } message: { _ in Text("原来的会移到 \(mac) 的废纸篓。") }
            .confirmationDialog(renameTitle, isPresented: Binding(get: { session.renameAsk != nil }, set: { if !$0 { session.renameAsk = nil } }), titleVisibility: .visible, presenting: session.renameAsk) { r in
                Button("Rename", role: .destructive) { Task { await rename(r) } }
                Button("Cancel", role: .cancel) { session.renameAsk = nil }
            } message: { r in Text("终端“\(r.terminal)”正在此文件夹中运行。改名后，其中的 agent 仍会使用原来的路径，可能出错。") }
            .alert("Error", isPresented: Binding(get: { session.refused != nil }, set: { if !$0 { session.refused = nil } }), presenting: session.refused) { _ in
                Button("OK") { session.refused = nil }
            } message: { Text($0) }
            .overlay(alignment: .bottom) { if let s = session.sharing, s.files == nil { fetching(s) } }
            .sheet(item: Binding(get: { session.sharing?.files == nil ? nil : session.sharing }, set: { if $0 == nil { endSharing() } })) { s in
                ActivitySheet(items: s.files ?? []) { endSharing() }
                    .presentationDetents([.medium, .large])
                    .ignoresSafeArea()
            }
    }

    // MARK: names

    @MainActor
    private func commitName() async {
        guard let n = session.naming, let source = model.fileSource else { return }
        let renamingName: String? = { if case .rename(let p) = n.kind { return MacPath.name(p) } else { return nil } }()
        let check = FileNames.check(n.value, taken: n.taken, renaming: renamingName)
        if case .error(let why) = check { session.naming?.error = why; return }
        let name = n.value.trimmingCharacters(in: .whitespaces)
        do {
            switch n.kind {
            case .folder(let dir): model.files.lit = try await source.newFolder(MacPath.join(dir, name)).top
            case .file(let dir): model.files.lit = try await source.newFile(MacPath.join(dir, name)).top
            case .rename(let path):
                guard name != MacPath.name(path) else { session.naming = nil; return }
                // A folder a terminal runs in: said before it is renamed (files-v0 §12.2).
                if let t = FilesSession.runningIn(path, model.terminals.terminals) {
                    session.naming = nil
                    session.renameAsk = FilesSession.RenameAsk(path: path, name: name, terminal: t.name)
                    return
                }
                let to = try await source.rename(path, to: name, force: false)
                moved(path, to: to)
                model.files.lit = to
            }
            session.naming = nil
            model.files.changed += 1
        } catch let e as FileChangeError where e.refusal == .exists {
            session.naming?.error = "此位置已有“\(name.split(separator: "/").first.map(String.init) ?? name)”。请换一个名称。"
        } catch let e as FileChangeError where e.refusal == .inUse {
            session.naming = nil
            if case .rename(let path) = n.kind { session.renameAsk = FilesSession.RenameAsk(path: path, name: name, terminal: e.terminals.first?.name ?? "") }
        } catch {
            session.naming = nil
            session.refused = said(error)
        }
    }

    private var renameTitle: String { session.renameAsk.map { "将“\(MacPath.name($0.path))”改名为“\($0.name)”？" } ?? "" }

    /// Once asked: renamed, and the Mac told it was asked.
    @MainActor
    private func rename(_ r: FilesSession.RenameAsk) async {
        session.renameAsk = nil
        guard let source = model.fileSource else { return }
        do {
            let to = try await source.rename(r.path, to: r.name, force: true)
            moved(r.path, to: to)
            model.files.lit = to
            model.files.changed += 1
        } catch {
            session.refused = said(error)
        }
    }

    // MARK: the Trash

    private var trashTitle: String {
        guard let t = session.trashing else { return "" }
        let what = t.paths.count == 1 ? "“\(MacPath.name(t.paths[0]))”" : " \(t.paths.count) 项"
        return t.permanent ? "要永久删除\(what)吗？" : "将\(what)移到 \(mac) 的废纸篓？"
    }

    private func trashMessage(_ t: FilesSession.Trashing) -> String {
        if t.permanent { return "无法将它们移到 \(mac) 的废纸篓。此操作无法撤销。" }
        if let terminal = t.terminal { return "终端“\(terminal)”正在此文件夹中运行。移到废纸篓后，其中的 agent 仍会使用原来的路径，可能出错。" }
        return "可在 \(mac) 的废纸篓中恢复。"
    }

    @MainActor
    private func trash(_ t: FilesSession.Trashing) async {
        session.trashing = nil
        guard let source = model.fileSource else { return }
        do {
            _ = try await source.trash(t.paths, force: t.terminal != nil, permanent: t.permanent)
            gone(t.paths)
        } catch let e as FileChangeError where e.refusal == .inUse {
            session.trashing = FilesSession.Trashing(paths: t.paths, terminal: e.terminals.first?.name ?? "")
        } catch let e as FileChangeError where e.refusal == .noTrash {
            // What went, went; what the Trash would not take is asked about again, for good this time.
            gone(t.paths.filter { !e.paths.contains($0) })
            session.trashing = FilesSession.Trashing(paths: e.paths, permanent: true)
        } catch {
            session.refused = said(error)
        }
    }

    /// Gone from the Mac: out of the picks, and off the page that showed one of them.
    @MainActor
    private func gone(_ paths: [String]) {
        for p in paths where session.isPicked(p) { session.togglePick(MacPick(path: p, isFolder: false)) }
        if let last = session.stack.last, case .file(let p) = last, paths.contains(p) { session.stack.removeLast() }
        session.stack.removeAll { if case .folder(let p) = $0 { return paths.contains { p == $0 || p.hasPrefix($0 + "/") } } else { return false } }
        model.files.changed += 1
    }

    /// Renamed: a page open on it follows it.
    @MainActor
    private func moved(_ from: String, to: String) {
        session.stack = session.stack.map {
            switch $0 {
            case .file(let p) where p == from: return .file(to)
            case .folder(let p) where p == from || p.hasPrefix(from + "/"): return .folder(to + p.dropFirst(from.count))
            default: return $0
            }
        }
    }

    // MARK: names taken by an upload

    private var clashTitle: String {
        guard let c = session.clashing else { return "" }
        return c.names.count == 1 ? "此位置已有名为“\(c.names[0])”的项目。要替换它吗？" : "此位置已有 \(c.names.count) 个同名的项目。要替换它们吗？"
    }

    @MainActor
    private func answerClash(_ conflict: UploadConflict?) {
        guard let c = session.clashing else { return }
        session.clashing = nil
        model.files.answer(c.uploads, conflict) { model.fileSource }
    }

    // MARK: sharing

    private func fetching(_ s: FilesSession.Sharing) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if let failed = s.failed {
                HStack {
                    Text(failed).font(.footnote).foregroundStyle(Theme.failed)
                    Spacer()
                    Button("OK") { session.sharing = nil }.font(.footnote)
                }
            } else {
                HStack {
                    Text("Downloading \(Int(s.progress * 100))%").mono(11).foregroundStyle(.secondary)
                    Spacer()
                    Button { session.sharing = nil } label: { Text("Cancel").font(.footnote) }
                }
                ProgressView(value: s.progress).tint(Theme.signal)
            }
        }
        .padding(Theme.Space.m)
        .background(Theme.raised, in: RoundedRectangle(cornerRadius: 12))
        .padding(Theme.Space.l)
        .padding(.bottom, 60)
    }

    @MainActor
    private func endSharing() {
        // The copies were for the share sheet only (files-v0 §12.3): what was saved is in the Files app now.
        for f in session.sharing?.files ?? [] { try? FileManager.default.removeItem(at: f.deletingLastPathComponent()) }
        session.sharing = nil
    }

    private func said(_ error: Error) -> String {
        if let e = error as? FileChangeError, let r = e.refusal { return r.sentence(mac: mac) }
        return error.localizedDescription
    }
}

extension View {
    func fileChangeQuestions(_ session: FilesSession) -> some View { modifier(FileChangeQuestions(session: session)) }
}

extension FilesSession {
    /// `Share…`: each file fetched to this phone (one folder each, its name kept), then the system's share sheet.
    @MainActor
    func share(_ paths: [String], _ source: (any MacFileSource)?) {
        guard let source, !paths.isEmpty else { return }
        let started = Sharing(paths: paths)
        sharing = started
        Task { @MainActor in
            var files: [URL] = []
            for (i, path) in paths.enumerated() {
                guard sharing?.id == started.id else { return }
                if let size = try? await source.fileDetails(path).size, size > AgentSwitchAPI.maxFileShare {
                    sharing?.failed = "文件超过 200 MB，无法在手机上分享。"
                    return
                }
                let to = FilesStore.holder().appendingPathComponent(MacPath.name(path))
                do {
                    try await source.downloadFile(path, to: to) { p in
                        Task { @MainActor in if self.sharing?.id == started.id { self.sharing?.progress = (Double(i) + p) / Double(paths.count) } }
                    }
                    files.append(to)
                } catch {
                    if sharing?.id == started.id { sharing?.failed = (error as? FileChangeError).flatMap(\.refusal)?.sentence(mac: "Mac") ?? error.localizedDescription }
                    return
                }
            }
            if sharing?.id == started.id { sharing?.files = files } else { for f in files { try? FileManager.default.removeItem(at: f.deletingLastPathComponent()) } }
        }
    }
}

/// The system's share sheet for files on this phone; `done` once it closes, whatever was chosen.
struct ActivitySheet: UIViewControllerRepresentable {
    let items: [URL]
    let done: () -> Void

    func makeUIViewController(context: Context) -> UIActivityViewController {
        let controller = UIActivityViewController(activityItems: items, applicationActivities: nil)
        controller.completionWithItemsHandler = { _, _, _, _ in done() }
        return controller
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
