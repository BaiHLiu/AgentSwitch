import AppKit

/// Copies something short-lived that grants access (the pairing link pairs a phone for five minutes): on this Mac
/// only, so Universal Clipboard does not hand it to the user's other devices; marked transient and concealed
/// (nspasteboard.org) so clipboard managers that honour the markers neither keep nor show it; and cleared once it
/// expires, if nothing else has been copied since.
public enum SensitiveClipboard {
    public static let transientType = NSPasteboard.PasteboardType("org.nspasteboard.TransientType")
    public static let concealedType = NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType")

    /// Writes `text` and returns the change count that identifies this write for `clear(_:ifStill:)`.
    @discardableResult
    /// `shared`: not held to this Mac — Universal Clipboard may hand it to the user's other devices, which is how a
    /// pairing link reaches their other Mac.
    public static func copy(_ text: String, to pasteboard: NSPasteboard = .general, shared: Bool = false) -> Int {
        pasteboard.prepareForNewContents(with: shared ? [] : .currentHostOnly)
        pasteboard.setString(text, forType: .string)
        pasteboard.setData(Data(), forType: transientType)
        pasteboard.setData(Data(), forType: concealedType)
        return pasteboard.changeCount
    }

    /// Empties the pasteboard when it still holds our write; true when it did.
    @discardableResult
    public static func clear(_ pasteboard: NSPasteboard = .general, ifStill changeCount: Int) -> Bool {
        guard pasteboard.changeCount == changeCount else { return false }
        pasteboard.clearContents()
        return true
    }
}
