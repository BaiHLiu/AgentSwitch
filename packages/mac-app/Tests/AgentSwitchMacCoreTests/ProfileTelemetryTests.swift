import XCTest
@testable import AgentSwitchMacCore

/// Claude Code's telemetry under a profile (docs/profiles-v0.md §3.7): what the service says of it.
final class ProfileTelemetryTests: XCTestCase {
    func testOffOnlyWhenTheServiceSaysFalse() throws {
        let json = #"[{"id":"a1b2c3","name":"Quiet","kind":"subscription","telemetry":false},{"id":"d4e5f6","name":"Loud","kind":"subscription"}]"#
        let profiles = try JSONDecoder().decode([AgentProfile].self, from: Data(json.utf8))
        XCTAssertEqual(profiles.map(\.telemetryOff), [true, false])
    }
}
