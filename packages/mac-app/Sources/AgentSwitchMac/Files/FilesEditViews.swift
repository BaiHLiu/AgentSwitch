import AgentSwitchMacCore
import AppKit
import SwiftUI

// Changing files from the column (docs/files-v0.md §12.2; demo docs/design/concepts/files.html ⑪–⑯): the head's `+`, a
// name typed in place with the line that judges it, the line at the foot for what was just done, and the one box the
// Mac asks with.

/// `+` (Apple's file management: an Add button): a pull-down menu, so its keys are written in it.
struct FilesNewMenu: View {
    let files: FilesColumn
    @Environment(\.interfaceLook) private var look

    var body: some View {
        Menu {
            Button("New File…  ⌥⌘N") { files.startNew(folder: false) }
            Button("New Folder…  ⇧⌘N") { files.startNew(folder: true) }
        } label: {
            Group {
                if look.isClassic {
                    Image(systemName: "plus").font(.system(size: 12)).foregroundStyle(Look.ink2).frame(width: 24, height: 22)
                } else {
                    Text("+").font(.system(size: 13, design: .monospaced)).foregroundStyle(Look.ink2).frame(width: 22, height: 22)
                }
            }
            .contentShape(Rectangle())
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .disabled(files.root == nil)
        .help("New")
        .accessibilityLabel("New")
    }
}

/// The box a name is typed in, where the name was or will be (VS Code's explorer): ↩ makes it, esc lets it go, leaving
/// it with a good name makes it too. A rename selects the name before its extension first, as Finder does.
struct FilesNameField: NSViewRepresentable {
    let files: FilesColumn
    let edit: FilesEdit
    let classic: Bool

    func makeCoordinator() -> Coordinator { Coordinator(files: files, id: edit.id) }

    func makeNSView(context: Context) -> NSTextField {
        let field = NSTextField(string: edit.text)
        field.delegate = context.coordinator
        field.isBordered = false
        field.isBezeled = false
        field.lineBreakMode = .byClipping
        field.cell?.isScrollable = true
        field.cell?.wraps = false
        field.setAccessibilityLabel(edit.folder ? "New Folder" : { if case .rename = edit.kind { return "Rename" }; return "New File" }())
        if classic {
            field.font = .systemFont(ofSize: 13)
            field.drawsBackground = true
            field.backgroundColor = .textBackgroundColor
            field.focusRingType = .exterior
        } else {
            field.font = .monospacedSystemFont(ofSize: 12.5, weight: .regular)
            field.drawsBackground = false
            field.focusRingType = .none
            field.textColor = NSColor(Look.ink)
        }
        let folder: Bool = { if case .rename(let path) = edit.kind { return files.entry(path)?.isFolder ?? false }; return true }()
        let range = edit.text.isEmpty ? NSRange(location: 0, length: 0) : FilesNameCheck.selected(edit.text, folder: folder)
        // Taken once the field is in its window: the keyboard, and the part of the name to type over.
        DispatchQueue.main.async {
            guard let window = field.window, files.edit?.id == edit.id else { return }
            window.makeFirstResponder(field)
            (field.currentEditor() as? NSTextView)?.setSelectedRange(range)
        }
        return field
    }

    func updateNSView(_ field: NSTextField, context: Context) {
        context.coordinator.files = files
        context.coordinator.id = edit.id
    }

    @MainActor
    final class Coordinator: NSObject, NSTextFieldDelegate {
        var files: FilesColumn
        var id: UUID

        init(files: FilesColumn, id: UUID) {
            self.files = files
            self.id = id
        }

        func controlTextDidChange(_ note: Notification) {
            guard let field = note.object as? NSTextField, files.edit?.id == id else { return }
            files.edit?.text = field.stringValue
            files.edit?.refused = nil
        }

        func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            guard files.edit?.id == id else { return false }
            switch selector {
            case #selector(NSResponder.insertNewline(_:)): files.commitEdit(); return true
            case #selector(NSResponder.cancelOperation(_:)): files.cancelEdit(); return true
            default: return false
            }
        }

        /// The box left (a click elsewhere): a good name is made, a bad one let go.
        func controlTextDidEndEditing(_ note: Notification) {
            guard files.edit?.id == id else { return }
            if !files.commitEdit() { files.edit = nil }
        }
    }
}

/// The box drawn in each look: the pixel look's 1 pt ink frame, the classic look's own field with the system's ring.
struct FilesNameBox: View {
    let files: FilesColumn
    let edit: FilesEdit
    @Environment(\.interfaceLook) private var look

    var body: some View {
        FilesNameField(files: files, edit: edit, classic: look.isClassic)
            .frame(height: look.isClassic ? 20 : 18)
            .padding(.horizontal, look.isClassic ? 3 : 3)
            .overlay { if !look.isClassic { Rectangle().strokeBorder(Look.ink, lineWidth: 1) } }
            .background(look.isClassic ? Color.clear : Look.ground)
            .frame(maxWidth: .infinity)
    }
}

/// What is wrong with the name typed, in red; a space before or after it, in amber (it is made all the same).
struct FilesCheckLine: View {
    let files: FilesColumn
    let edit: FilesEdit
    let indent: CGFloat

    var body: some View {
        let check = files.check(edit)
        if !edit.text.isEmpty || edit.refused != nil, let line = check.line {
            Text(line).font(.system(size: 11.5)).foregroundStyle(check.error != nil ? Color.failed : Color.waiting)
                .lineLimit(2).fixedSize(horizontal: false, vertical: true)
                .padding(.leading, indent).padding(.trailing, 10).padding(.bottom, 4)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// A new item's row while its name is typed: in the tree under its folder, drawn as its children are; at the top of the
/// level in the folders.
struct FilesNewRow: View {
    let files: FilesColumn
    let edit: FilesEdit
    /// The tree's place for it; nil in the folders.
    var slot: FilesTree.Slot?
    @Environment(\.interfaceLook) private var look

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if look.isClassic { classic } else { pixel }
            FilesCheckLine(files: files, edit: edit, indent: look.isClassic ? 14 + CGFloat(slot?.depth ?? 0) * 16 + 32 : 12 + CGFloat((slot?.depth ?? 0) * 3 + 3) * ListLook.ch)
        }
    }

    private var pixel: some View {
        HStack(spacing: 0) {
            if let slot {
                Text(slot.twig).foregroundStyle(Look.line)
                Text(edit.folder ? "▸" : "─").foregroundStyle(edit.folder ? Look.ink2 : Look.line)
                    .padding(.trailing, ListLook.ch)
            }
            FilesNameBox(files: files, edit: edit)
            if edit.folder { Text("/").foregroundStyle(Look.ink2).padding(.leading, 2) }
        }
        .font(.system(size: 12.5, design: .monospaced))
        .padding(.leading, 12).padding(.trailing, 10)
        .frame(height: 22)
    }

    private var classic: some View {
        HStack(spacing: slot == nil ? 8 : 5) {
            if slot != nil { Color.clear.frame(width: 14) }
            Image(systemName: edit.folder ? "folder" : "doc").font(.system(size: slot == nil ? 15 : 14))
                .foregroundStyle(edit.folder ? Color.signal : Look.ink2).frame(width: slot == nil ? 20 : 19)
            FilesNameBox(files: files, edit: edit)
        }
        .padding(.leading, 8 + CGFloat(slot?.depth ?? 0) * 16).padding(.trailing, 8)
        .frame(height: slot == nil ? 30 : 26)
        .padding(.horizontal, 6)
    }
}

/// The line at the column's foot for what was just done (HIG Undo: say what happened, and how to take it back).
struct FilesSaidLine: View {
    let text: String
    @Environment(\.interfaceLook) private var look

    var body: some View {
        VStack(spacing: 0) {
            Rectangle().fill(Look.line).frame(height: 1)
            Text(text).font(.system(size: 11.5)).foregroundStyle(Look.ink2)
                .lineLimit(2).fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 12).padding(.vertical, 6)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// The one box the Mac asks with before a change (files-v0 §12.2): a folder a terminal runs in, or what the Trash would
/// not take — the amber box of a thing that waits for you, the classic look's card, as `Add to Reply?` is.
struct FilesQuestionCard: View {
    let files: FilesColumn
    let question: FilesQuestion

    var body: some View {
        FloatingBox(title: question.head, waiting: true) {
            VStack(alignment: .leading, spacing: 10) {
                Text(question.text).font(.system(size: 12.5)).foregroundStyle(Look.ink).fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 12) {
                    Spacer(minLength: 0)
                    Button { files.answer(false) } label: { BracketLabel(word: "Cancel") }.buttonStyle(BracketButtonStyle(size: 12))
                    Button { files.answer(true) } label: { BracketLabel(word: question.go) }.buttonStyle(BracketButtonStyle(role: .primary, size: 12))
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(question.head)
    }
}

/// The list's empty part, right-clicked: the shown folder's menu, new items first (VS Code).
struct FilesFolderMenu: View {
    let files: FilesColumn
    let folder: String

    var body: some View {
        Button("New File…") { files.startNew(folder: false, inside: folder) }
        Button("New Folder…") { files.startNew(folder: true, inside: folder) }
        Divider()
        if files.local { Button("Show in Finder") { files.showInFinder([folder]) } }
        Button("Copy Path") { files.copyPaths([folder]) }
        Button("New Terminal Here") { files.newTerminal(folder) }
    }
}
