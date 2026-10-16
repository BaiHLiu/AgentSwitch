import AgentSwitchKit
import CryptoKit
import QuickLook
import SwiftUI

/// A file of the Mac's, opened from the browser (docs/files-v0.md §5 预览): a text file's first 64 KB shown here
/// (monospaced, sideways to read a long line, numbered in the pixel look); a picture's small copy, then `Open Preview`
/// fetches the whole of it for the system's Quick Look, as for a PDF and the rest; a file over 25 MB is not fetched.
/// Under it `Add to Reply` (`Add to Reply…` on the Files tab) and `Copy Path`.
struct FilePreviewPage: View {
    let path: String
    let session: FilesSession
    var onPick: ([MacPick]) -> Void
    @Environment(AppModel.self) private var model
    @Environment(\.interfaceLook) private var look
    @State private var details: MacFileDetails?
    @State private var preview: MacFilePreview?
    @State private var thumbnail: UIImage?
    @State private var refusal: FileRefusal?
    @State private var failure: String?
    /// How far the whole file has come for Quick Look.
    @State private var downloading: Double?
    @State private var quickLook: URL?
    @State private var copied = false

    private var mac: String { model.profile?.name ?? "Mac" }
    private var tooLarge: Bool { (details?.size ?? 0) > AgentSwitchAPI.maxFileDownload }

    var body: some View {
        content
            .background { Theme.base.ignoresSafeArea() }
            .safeAreaInset(edge: .bottom, spacing: 0) { bar }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar(session.inTab ? .hidden : .automatic, for: .tabBar)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 1) {
                        Text(MacPath.name(path)).font(.headline).lineLimit(1).truncationMode(.middle)
                        if let details { Text(Self.facts(details)).mono(11).foregroundStyle(.secondary).lineLimit(1) }
                    }
                }
            }
            .quickLookPreview($quickLook)
            .task { await load() }
    }

    @ViewBuilder private var content: some View {
        if let refusal {
            note(refusal.sentence(mac: mac))
        } else if let failure, details == nil {
            note(failure)
        } else if let preview {
            textView(preview)
        } else if let details {
            other(details)
        } else {
            HStack(spacing: 8) { BrailleSpinner(color: .secondary); Text("Loading").mono(12).foregroundStyle(.secondary) }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func note(_ words: String) -> some View {
        Text(words).font(.subheadline).foregroundStyle(.secondary).padding(Theme.Space.l)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    /// The text and, in the pixel look, its line numbers beside it: two columns of the same type, so they keep in line.
    private func textView(_ p: MacFilePreview) -> some View {
        let body = p.text.hasSuffix("\n") ? String(p.text.dropLast()) : p.text
        let count = body.split(separator: "\n", omittingEmptySubsequences: false).count
        return ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 0) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(alignment: .top, spacing: 12) {
                        if !look.isClassic {
                            Text((1...max(1, count)).map(String.init).joined(separator: "\n")).code(11.5).foregroundStyle(Theme.inkDim)
                                .multilineTextAlignment(.trailing).fixedSize()
                        }
                        Text(body.isEmpty ? " " : body).code(11.5).foregroundStyle(Theme.ink).fixedSize().textSelection(.enabled)
                    }
                    .padding(Theme.Space.m)
                }
                if p.truncated {
                    Text("仅显示前 64 KB（共 \(FileSize.short(p.size))）。").font(.footnote).foregroundStyle(.secondary)
                        .padding(.horizontal, Theme.Space.m).padding(.bottom, Theme.Space.m)
                }
            }
        }
    }

    private func other(_ d: MacFileDetails) -> some View {
        VStack(spacing: Theme.Space.l) {
            if let thumbnail {
                // The frame on the picture itself, not on the room it is given.
                Image(uiImage: thumbnail).resizable().scaledToFit()
                    .overlay(Rectangle().strokeBorder(Theme.line, lineWidth: look.isClassic ? 0 : 1))
                    .clipShape(RoundedRectangle(cornerRadius: look.isClassic ? 10 : 0))
                    .frame(maxHeight: 360)
            } else {
                Image(systemName: FileIcon.symbol(for: d.name)).font(.system(size: 54, weight: .ultraLight)).foregroundStyle(Theme.secondaryInk)
            }
            Text(Self.facts(d)).mono(12).foregroundStyle(.secondary)
            if tooLarge {
                Text(FileRefusal.tooLarge.sentence(mac: mac)).font(.footnote).foregroundStyle(.secondary)
            } else if let downloading {
                VStack(spacing: 6) {
                    ProgressView(value: downloading).tint(Theme.signal).frame(maxWidth: 220)
                    Text("Downloading \(Int(downloading * 100))%").mono(11).foregroundStyle(.secondary)
                }
            } else {
                Button { Task { await openPreview() } } label: { ButtonWord("Open Preview") }
                    .buttonStyle(SquareButtonStyle(expand: false))
            }
            if let failure { Text(failure).font(.footnote).foregroundStyle(Theme.failed) }
        }
        .padding(Theme.Space.l)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var bar: some View {
        VStack(spacing: 0) {
            HairRule()
            HStack(spacing: Theme.Space.m) {
                Button { give() } label: { ButtonWord(session.inTab ? "Add to Reply…" : "Add to Reply") }
                    .buttonStyle(SquareButtonStyle(prominent: true, expand: false))
                    .disabled(details == nil || session.checking)
                Button { copyPath() } label: { ButtonWord(copied ? "Copied" : "Copy Path") }
                    .buttonStyle(SquareButtonStyle(expand: false))
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Theme.Space.l)
            .padding(.vertical, 10)
        }
        .background(Theme.base)
    }

    /// What kind, how big, how many lines.
    static func facts(_ d: MacFileDetails) -> String {
        let kind: String
        switch d.type {
        case .text: kind = "Text"
        case .image: kind = "Image"
        case .pdf: kind = "PDF"
        case .audio: kind = "Audio"
        case .video: kind = "Video"
        case .archive: kind = "Archive"
        case .binary, .none: kind = "Document"
        }
        let size = FileSize.short(d.size)
        return [kind, size, d.lines.map { "\($0) Lines" }].compactMap { $0 }.joined(separator: " · ")
    }

    private func load() async {
        guard let source = model.fileSource else { return }
        do {
            let d = try await source.fileDetails(path)
            details = d
            switch d.type {
            case .text: preview = try await source.filePreview(path)
            case .image: thumbnail = (try? await source.fileThumbnail(path)).flatMap(UIImage.init(data:))
            default: break
            }
        } catch {
            if let r = FileRefusal.of(error), r != .notText { refusal = r } else { failure = error.localizedDescription }
        }
    }

    /// The whole file into the app's caches (emptied at each start), then the system's Quick Look.
    private func openPreview() async {
        guard let source = model.fileSource, !tooLarge else { return }
        do {
            let file = try Self.cacheURL(path)
            if FileManager.default.fileExists(atPath: file.path) { quickLook = file; return }
            downloading = 0
            defer { downloading = nil }
            try await source.downloadFile(path, to: file) { p in Task { @MainActor in downloading = p } }
            failure = nil
            quickLook = file
        } catch {
            failure = FileRefusal.of(error)?.sentence(mac: mac) ?? error.localizedDescription
        }
    }

    static func cacheURL(_ path: String) throws -> URL {
        let digest = SHA256.hash(data: Data(path.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
        let dir = try FileCache.root().appendingPathComponent("mac", isDirectory: true).appendingPathComponent(digest, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent(MacPath.name(path))
    }

    private func give() {
        let pick = MacPick(path: path, isFolder: false, sensitive: details?.sensitive != nil)
        if session.inTab { session.choosing = [pick]; return }
        session.land([pick]) { landed in onPick(landed) }
    }

    private func copyPath() {
        UIPasteboard.general.string = path
        copied = true
        Task { try? await Task.sleep(for: .seconds(1.5)); copied = false }
    }
}
