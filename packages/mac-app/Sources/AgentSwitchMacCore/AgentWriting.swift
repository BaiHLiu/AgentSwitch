import Foundation

/// What an agent is writing at the moment (docs/simple-view-v0.md §5.14): the part of its answer being written, its
/// whole text so far, and whether it is what it thinks on the way. Shown while it is written and gone once the part is
/// in the record (a terminal) or the task's events (a task); never stored. The service sends it as a `writing` event:
/// `{text, thinking?}`, or `{done: true}` once nothing is being written.
public struct AgentWriting: Equatable, Sendable {
    public let text: String
    public let thinking: Bool

    public init(text: String, thinking: Bool = false) {
        self.text = text
        self.thinking = thinking
    }

    /// A `writing` event's data: what is written now, or nil when nothing is (`done`, or not one).
    public static func decode(_ data: String) -> AgentWriting? {
        struct Body: Decodable { let text: String?; let thinking: Bool?; let done: Bool? }
        guard let body = try? JSONDecoder().decode(Body.self, from: Data(data.utf8)), body.done != true, let text = body.text, !text.isEmpty else { return nil }
        return AgentWriting(text: text, thinking: body.thinking ?? false)
    }
}
