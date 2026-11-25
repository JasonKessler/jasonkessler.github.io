import AppKit

final class JoinRequestBanner: NSObject {
    private let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 390, height: 52),
                               styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    private let message = NSTextField(labelWithString: "")
    private var waitingIDs = Set<UUID>()
    private var wantsBanner = false
    var onReview: (() -> Void)?

    override init() {
        super.init()
        panel.title = "Debate join requests"
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.hidesOnDeactivate = true
        panel.hasShadow = true
        panel.backgroundColor = .windowBackgroundColor

        message.font = .systemFont(ofSize: 13, weight: .semibold)
        message.lineBreakMode = .byTruncatingTail
        message.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let review = NSButton(title: "Review", target: self, action: #selector(reviewRequests))
        let dismiss = NSButton(title: "Dismiss", target: self, action: #selector(dismissBanner))
        let row = NSStackView(views: [message, review, dismiss])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 8
        row.translatesAutoresizingMaskIntoConstraints = false
        let content = NSView()
        content.addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 12),
            row.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -12),
            row.centerYAnchor.constraint(equalTo: content.centerYAnchor)
        ])
        panel.contentView = content

        let notifications = NotificationCenter.default
        notifications.addObserver(self, selector: #selector(reposition(_:)),
                                  name: NSApplication.didBecomeActiveNotification, object: NSApp)
        for name in [NSWindow.didBecomeKeyNotification, NSWindow.didMoveNotification, NSWindow.didResizeNotification] {
            notifications.addObserver(self, selector: #selector(reposition(_:)), name: name, object: nil)
        }
    }

    func update(_ pending: [SharingHost.Viewer]) {
        let ids = Set(pending.map(\.id))
        let hasNewRequest = !ids.isSubset(of: waitingIDs)
        waitingIDs = ids
        guard let first = pending.first else { dismissBanner(); return }

        message.stringValue = pending.count == 1
            ? "\(first.name) wants to join."
            : "\(pending.count) people want to join."
        if hasNewRequest { wantsBanner = true }
        showIfActive()
    }

    @objc private func reposition(_ notification: Notification) {
        if let window = notification.object as? NSWindow, window === panel { return }
        showIfActive()
    }

    private func showIfActive() {
        guard wantsBanner, NSApp.isActive,
              let parent = NSApp.keyWindow ?? NSApp.mainWindow,
              parent !== panel, let screen = parent.screen else { return }
        let bounds = screen.visibleFrame.insetBy(dx: 8, dy: 8)
        let size = panel.frame.size
        let x = min(max(parent.frame.maxX - size.width - 12, bounds.minX), bounds.maxX - size.width)
        let y = min(max(parent.frame.maxY - size.height - 42, bounds.minY), bounds.maxY - size.height)
        panel.setFrameOrigin(NSPoint(x: x, y: y))
        panel.orderFront(nil)
    }

    @objc private func reviewRequests() {
        dismissBanner()
        onReview?()
    }

    @objc private func dismissBanner() {
        wantsBanner = false
        panel.orderOut(nil)
    }
}
