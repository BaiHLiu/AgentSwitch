import AgentSwitchMacCore
import AppKit
import SwiftUI

/// Words for something still going (what the agent is doing now, a run of work not ended): quiet, with a band of the
/// ink's full colour running across them (docs/simple-view-v0.md §5.1; 2026-10-07, user, of the agents' own apps:
/// 思考过程中的闪烁能不能加上). The classic look's band is soft; the pixel look's is a block that moves in steps. Still
/// under Reduce Motion.
///
/// The band is a layer that Core Animation moves, not a view drawn again for each of its places (2026-10-18, user:
/// cpu占用可以修一下吗): any change to the window's views costs the whole window's update — some 15 ms in a debug build,
/// however short the record — and a band moved by a timeline asked for one at each of its steps, which held a quarter of
/// a core for as long as one line was at work. Moved by the render server, it asks for none.
struct Shimmer: ViewModifier {
    let on: Bool
    @Environment(\.interfaceLook) private var look
    @Environment(\.accessibilityReduceMotion) private var still

    /// One pass across the words.
    static let lap = 1.9
    /// The pixel band's steps in a pass.
    static let steps = 18

    func body(content: Content) -> some View {
        if on, !still {
            content.overlay {
                ShimmerBand(classic: look.isClassic)
                    .mask { content }
                    .allowsHitTesting(false)
            }
        } else {
            content
        }
    }

    /// The band's width over words `width` wide.
    static func band(width: CGFloat, classic: Bool) -> CGFloat { classic ? max(44, width * 0.34) : 22 }

    /// The band's left edge `part` of the way through its pass: from just before the words to just past them.
    static func left(_ part: Double, width: CGFloat, band: CGFloat) -> CGFloat { -band + (width + band) * part }

    /// The pixel band's places in a pass, one a step.
    static func stepped(width: CGFloat, band: CGFloat) -> [CGFloat] {
        (0..<steps).map { left(Double($0) / Double(steps), width: width, band: band) }
    }

    /// How far into its pass a band is at `now`: every band on screen at the same place in its pass.
    static func phase(at now: Date) -> Double { now.timeIntervalSince(Motion.epoch).truncatingRemainder(dividingBy: lap) }
}

/// The band's layer under the words' shape.
private struct ShimmerBand: NSViewRepresentable {
    let classic: Bool

    func makeNSView(context: Context) -> ShimmerBandView { ShimmerBandView() }
    func updateNSView(_ view: ShimmerBandView, context: Context) { view.classic = classic }
}

/// A view whose one layer runs across it, again and again: the soft band sliding, the block in steps.
final class ShimmerBandView: NSView {
    var classic = false {
        didSet { if classic != oldValue { restart() } }
    }
    private let band = CAGradientLayer()
    /// The width the pass was made for.
    private var made: CGFloat = -1

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.masksToBounds = true
        band.startPoint = CGPoint(x: 0, y: 0.5)
        band.endPoint = CGPoint(x: 1, y: 0.5)
        layer?.addSublayer(band)
    }

    required init?(coder: NSCoder) { fatalError("not from a nib") }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func layout() {
        super.layout()
        if bounds.width != made { restart() }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        restart()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        colour()
    }

    private func colour() {
        var ink = NSColor.black.cgColor
        effectiveAppearance.performAsCurrentDrawingAppearance { ink = NSColor(Look.ink).cgColor }
        let clear = ink.copy(alpha: 0) ?? ink
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        band.colors = classic ? [clear, ink, clear] : [ink, ink]
        CATransaction.commit()
    }

    /// The pass made again for the view's width and look, from where every band is in its pass now.
    private func restart() {
        band.removeAnimation(forKey: "pass")
        made = bounds.width
        guard window != nil, bounds.width > 0 else { return }
        let width = Shimmer.band(width: bounds.width, classic: classic)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        // Where it rests (off the words: what a still picture of the view shows) — the pass draws it elsewhere.
        band.frame = CGRect(x: -width, y: 0, width: width, height: bounds.height)
        CATransaction.commit()
        colour()
        let pass: CAAnimation
        if classic {
            let slide = CABasicAnimation(keyPath: "position.x")
            slide.fromValue = Shimmer.left(0, width: bounds.width, band: width) + width / 2
            slide.toValue = Shimmer.left(1, width: bounds.width, band: width) + width / 2
            pass = slide
        } else {
            let steps = CAKeyframeAnimation(keyPath: "position.x")
            let places = Shimmer.stepped(width: bounds.width, band: width)
            steps.values = places.map { $0 + width / 2 }
            // Discrete: one more time than places, the last the pass's end.
            steps.keyTimes = (0...places.count).map { NSNumber(value: Double($0) / Double(places.count)) }
            steps.calculationMode = .discrete
            pass = steps
        }
        pass.duration = Shimmer.lap
        pass.repeatCount = .infinity
        pass.timeOffset = Shimmer.phase(at: Date())
        pass.isRemovedOnCompletion = false
        band.add(pass, forKey: "pass")
    }
}

extension View {
    /// A band of light across words for something still going.
    func shimmer(_ on: Bool = true) -> some View { modifier(Shimmer(on: on)) }
}
