import AppKit
import WebKit

final class SharingWindow: NSObject, NSWindowDelegate {
    var readNotebook: ((Bool, @escaping (Result<SharedNotebook, Error>) -> Void) -> Void)?
    var onPendingViewers: (([SharingHost.Viewer]) -> Void)?
    private var host: SharingHost?
    private var viewer: SharingViewer?
    private var videoCall: VideoCallWindow?
    private var viewerCallButton: NSButton?
    private var internetTunnel: InternetHostTunnel?
    private var pendingBrowserLink: Bool?
    private var liveTimer: Timer?
    private var activeRound: String?
    private var viewerIDs: [UUID] = []
    private var reading = false
    private var displayedNotebook: SharedNotebook?
    private let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 790, height: 670),
                                  styleMask: [.titled, .closable, .resizable, .miniaturizable],
                                  backing: .buffered, defer: false)
    private let body = NSStackView()
    private let status = NSTextField(wrappingLabelWithString: "")
    private let scope = NSPopUpButton()
    private let automatic = NSButton(checkboxWithTitle: "Publish automatically", target: nil, action: nil)
    private let people = NSPopUpButton()
    private let inviteField = NSTextField()
    private let nameField = NSTextField()
    private let transcript = NSTextView.scrollableTextView()
    private var publishButton: NSButton?
    private var pauseButton: NSButton?

    override init() {
        super.init()
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.minSize = NSSize(width: 515, height: 410)
        window.center()
        body.orientation = .vertical
        body.alignment = .leading
        body.spacing = 12
        body.edgeInsets = NSEdgeInsets(top: 20, left: 22, bottom: 20, right: 22)
        body.translatesAutoresizingMaskIntoConstraints = false
        let root = NSView()
        root.addSubview(body)
        NSLayoutConstraint.activate([
            body.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            body.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            body.topAnchor.constraint(equalTo: root.topAnchor),
            body.bottomAnchor.constraint(equalTo: root.bottomAnchor)
        ])
        window.contentView = root
        status.preferredMaxLayoutWidth = 450
        status.maximumNumberOfLines = 3
        status.setContentCompressionResistancePriority(.required, for: .vertical)
        scope.addItems(withTitles: ["Points only", "Points and transcript"])
        automatic.target = self
        automatic.action = #selector(autoChanged)
        nameField.stringValue = Host.current().localizedName ?? "Viewer"
        nameField.placeholderString = "Your display name"
        inviteField.placeholderString = "Paste the moderator’s invite"
        if let text = transcript.documentView as? NSTextView {
            text.isEditable = false
            text.isSelectable = true
            text.isRichText = false
            text.textContainerInset = NSSize(width: 14, height: 14)
            text.font = .systemFont(ofSize: 15)
        }
    }

    func showShare() {
        if viewer != nil { showWindow(); return }
        configureHostWindow()
        showWindow()
    }

    func reviewJoinRequests() {
        guard let waiting = host?.viewers.first(where: { !$0.approved }) else { return }
        showShare()
        if let index = viewerIDs.firstIndex(of: waiting.id) { people.selectItem(at: index) }
    }

    func showJoin() {
        if host != nil || viewer != nil { showWindow(); return }
        layout(title: "Join Debate", state: "Paste the moderator’s invite. An internet invite works from another network.")
        addField("Display name", nameField)
        addField("Invite", inviteField)
        add(button("Join", #selector(join)))
        addSpacer()
        showWindow()
    }

    func windowWillClose(_ notification: Notification) { end() }

    func end() {
        videoCall?.close()
        videoCall = nil
        viewerCallButton = nil
        liveTimer?.invalidate()
        liveTimer = nil
        internetTunnel?.stop()
        internetTunnel = nil
        pendingBrowserLink = nil
        host?.stop()
        host = nil
        onPendingViewers?([])
        viewer?.stop()
        viewer = nil
        activeRound = nil
        automatic.state = .off
        reading = false
    }

    private func showWindow() { window.makeKeyAndOrderFront(nil) }

    private func layout(title: String, state: String) {
        for view in body.arrangedSubviews {
            body.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
        window.title = title
        let heading = NSTextField(labelWithString: title)
        heading.font = .systemFont(ofSize: 28, weight: .semibold)
        add(heading)
        status.stringValue = state
        add(status, fill: true)
    }

    private func add(_ view: NSView, fill: Bool = false) {
        body.addArrangedSubview(view)
        if fill {
            view.widthAnchor.constraint(equalTo: body.widthAnchor, constant: -44).isActive = true
        }
    }

    private func addField(_ label: String, _ field: NSTextField) {
        add(NSTextField(labelWithString: label))
        add(field, fill: true)
    }

    private func addSpacer() {
        let spacer = NSView()
        spacer.setContentHuggingPriority(.init(1), for: .vertical)
        add(spacer)
    }

    private func button(_ title: String, _ action: Selector) -> NSButton {
        NSButton(title: title, target: self, action: action)
    }

    private func configureHostWindow() {
        layout(title: "Share Debate", state: host == nil
               ? "Choose what viewers can read. Recordings stay on this Mac."
               : "Share the invite with your viewers. Invites expire after an hour.")
        if host == nil {
            add(scope)
            add(automatic)
            add(button("Start Sharing", #selector(startHosting)))
        } else {
            let active = NSStackView(views: [button("Copy Local Invite", #selector(copyInvite)),
                                            button("Copy VPN Invite…", #selector(copyRemoteInvite)),
                                            button("End Sharing", #selector(endSharing))])
            add(active)
            add(NSStackView(views: [button("Copy Internet Invite", #selector(copyInternetInvite)),
                                    button("Copy Browser Guest Link", #selector(copyBrowserLink)),
                                    button("Open video call", #selector(openVideoCall))]))
            add(NSTextField(labelWithString: scope.titleOfSelectedItem ?? "Points only"))
            add(automatic)
            let publish = button("Publish Notebook", #selector(publish))
            let pause = button(host?.paused == true ? "Resume Updates" : "Pause Updates", #selector(togglePause))
            publish.isEnabled = host?.paused != true
            publishButton = publish
            pauseButton = pause
            add(NSStackView(views: [publish, pause]))
            add(NSTextField(labelWithString: "Viewers"))
            add(people, fill: true)
            add(NSStackView(views: [button("Approve", #selector(approveViewer)),
                                    button("Decline or Remove", #selector(removeViewer))]))
            updatePeople()
        }
        addSpacer()
    }

    @objc private func startHosting() {
        guard host == nil else { return }
        let includeTranscript = scope.indexOfSelectedItem == 1
        status.stringValue = "Preparing sharing…"
        guard let readNotebook else { return }
        readNotebook(includeTranscript) { [weak self] result in
            guard let self, self.host == nil, self.viewer == nil, self.window.isVisible else { return }
            do {
                let notebook = try result.get()
                let host = try SharingHost()
                self.host = host
                self.activeRound = notebook.roundID
                host.onChange = { [weak self] in self?.updatePeople() }
                host.onStatus = { [weak self] message in self?.status.stringValue = message }
                self.configureHostWindow()
                host.start()
                self.autoChanged()
            } catch {
                self.status.stringValue = error.localizedDescription
            }
        }
    }

    @objc private func autoChanged() {
        liveTimer?.invalidate()
        liveTimer = nil
        guard host != nil, automatic.state == .on else { return }
        publish()
        liveTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.publish() }
    }

    @objc private func publish() {
        guard let host, !host.paused, !reading, let readNotebook else { return }
        reading = true
        readNotebook(scope.indexOfSelectedItem == 1) { [weak self, weak host] result in
            guard let self, let host, self.host === host else { return }
            self.reading = false
            do {
                let notebook = try result.get()
                guard notebook.roundID == self.activeRound else {
                    self.endSharing()
                    self.status.stringValue = "The original round ended. Start sharing again for the new round."
                    return
                }
                try host.publish(notebook)
                self.status.stringValue = "Notebook published. \(host.viewers.filter(\.approved).count) connected."
            } catch {
                if (error as? SharingUIError) == .noRound {
                    self.endSharing()
                }
                self.status.stringValue = error.localizedDescription
            }
        }
    }

    private func activeInvite() -> ShareInvite? {
        guard let invite = host?.invite else { return nil }
        guard invite.expires > Date() else {
            status.stringValue = "The invite expired. Start a new sharing session to invite more viewers."
            return nil
        }
        return invite
    }

    private func copy(_ invite: ShareInvite) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(invite.text, forType: .string)
        status.stringValue = "Invite copied. New viewers need your approval."
    }

    @objc private func copyInvite() {
        if let invite = activeInvite() { copy(invite) }
    }

    @objc private func copyRemoteInvite() {
        guard let host, let invite = activeInvite() else { return }
        guard let port = host.port else {
            status.stringValue = "The sharing listener is starting. Try again in a moment."
            return
        }

        let prompt = NSAlert()
        prompt.messageText = "Copy a remote invite"
        prompt.informativeText = "Enter this Mac’s Tailscale IP or full DNS name. Viewers must be able to reach TCP port \(port.rawValue) on this Mac."
        prompt.addButton(withTitle: "Copy Invite")
        prompt.addButton(withTitle: "Cancel")
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 330, height: 25))
        field.placeholderString = "Tailscale IP or full DNS name"
        prompt.accessoryView = field
        prompt.window.initialFirstResponder = field
        prompt.beginSheetModal(for: window) { [weak self, weak host] response in
            guard let self, let host, self.host === host, response == .alertFirstButtonReturn,
                  self.activeInvite() != nil else { return }
            let input = field.stringValue
            guard let remote = invite.remote(host: input, port: port) else {
                self.status.stringValue = "Enter a valid IP address or DNS name and try again."
                return
            }
            self.copy(remote)
        }
    }

    @objc private func copyInternetInvite() { requestInternetLink(browser: false) }
    @objc private func copyBrowserLink() { requestInternetLink(browser: true) }

    private func copyInternetLink(_ url: URL, browser: Bool) {
        guard let invite = activeInvite() else { return }
        if browser, let link = host?.browserLink(for: url) {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(link.absoluteString, forType: .string)
            status.stringValue = "Browser guest link copied. Guests enter their debate names and wait for approval."
        } else if !browser, let internet = invite.internet(url: url) {
            copy(internet)
        }
    }

    private func requestInternetLink(browser: Bool) {
        guard let host, activeInvite() != nil else { return }
        if let url = internetTunnel?.url {
            copyInternetLink(url, browser: browser)
            return
        }
        let starting = pendingBrowserLink != nil
        pendingBrowserLink = browser
        status.stringValue = "Opening an internet tunnel. The link will be copied when it’s ready."
        guard !starting else { return }
        guard let port = host.port else {
            pendingBrowserLink = nil
            status.stringValue = "The sharing listener is starting. Try again in a moment."
            return
        }
        do {
            try host.startBrowserListener { [weak self, weak host] result in
                guard let self, let host, self.host === host else { return }
                do {
                    let tunnel = try InternetHostTunnel(port: port.rawValue, browserPort: result.get())
                    self.internetTunnel = tunnel
                    tunnel.onReady = { [weak self, weak tunnel] url in
                        guard let self, let tunnel, self.internetTunnel === tunnel,
                              let browser = self.pendingBrowserLink else { return }
                        self.pendingBrowserLink = nil
                        self.copyInternetLink(url, browser: browser)
                    }
                    tunnel.onFailure = { [weak self, weak tunnel] message in
                        guard let self, let tunnel, self.internetTunnel === tunnel else { return }
                        self.internetTunnel = nil
                        self.pendingBrowserLink = nil
                        self.status.stringValue = message
                    }
                    try tunnel.start()
                } catch {
                    self.internetTunnel = nil
                    self.pendingBrowserLink = nil
                    self.status.stringValue = error.localizedDescription
                }
            }
        } catch {
            pendingBrowserLink = nil
            status.stringValue = error.localizedDescription
        }
    }

    @objc private func togglePause() {
        guard let host else { return }
        host.setPaused(!host.paused)
        pauseButton?.title = host.paused ? "Resume Updates" : "Pause Updates"
        publishButton?.isEnabled = !host.paused
        status.stringValue = host.paused ? "Sharing paused. Published notes stay visible." : "Sharing resumed."
        if !host.paused, automatic.state == .on { publish() }
    }

    @objc private func endSharing() {
        end()
        configureHostWindow()
    }

    private func updatePeople() {
        let selected = selectedViewer()
        let viewers = host?.viewers ?? []
        viewerIDs = viewers.map(\.id)
        people.removeAllItems()
        for person in viewers {
            // NSMenu supports identical display names as separate items.
            people.menu?.addItem(NSMenuItem(title: "\(person.name) · \(person.approved ? "Connected" : "Waiting")",
                                            action: nil, keyEquivalent: ""))
        }
        if viewers.isEmpty { people.addItem(withTitle: "No viewers yet") }
        if let selected, let index = viewerIDs.firstIndex(of: selected) { people.selectItem(at: index) }
        else { people.selectItem(at: 0) }
        onPendingViewers?(viewers.filter { !$0.approved })
    }

    private func selectedViewer() -> UUID? {
        let index = people.indexOfSelectedItem
        return viewerIDs.indices.contains(index) ? viewerIDs[index] : nil
    }

    @objc private func approveViewer() { if let id = selectedViewer() { host?.approve(id) } }
    @objc private func removeViewer() { if let id = selectedViewer() { host?.remove(id) } }

    @objc private func join() {
        let name = nameField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { status.stringValue = "Enter a display name."; return }
        guard let invite = ShareInvite(text: inviteField.stringValue) else {
            status.stringValue = "This invite is invalid, expired, or requires a newer Debate Room version."
            return
        }
        let viewer = SharingViewer(invite: invite, name: String(name.prefix(80)))
        self.viewer = viewer
        inviteField.stringValue = ""
        displayedNotebook = nil
        (transcript.documentView as? NSTextView)?.string = ""
        layout(title: "Shared Debate", state: "Connecting…")
        let callButton = button("Open video call", #selector(openVideoCall))
        callButton.isEnabled = false
        viewerCallButton = callButton
        add(NSStackView(views: [button("Leave", #selector(leave)), callButton]))
        add(transcript, fill: true)
        transcript.setContentHuggingPriority(.init(1), for: .vertical)
        transcript.hasVerticalScroller = true
        viewer.onStatus = { [weak self] message in self?.status.stringValue = message }
        viewer.onNotebook = { [weak self] notebook in self?.display(notebook) }
        viewer.onCallEvent = { [weak self] event in
            if event.kind == .availability { self?.viewerCallButton?.isEnabled = event.enabled == true }
            self?.videoCall?.deliver(event)
        }
        viewer.start()
    }

    func recordCall(action: String, speaker: String, useLocal: Bool,
                    reply: @escaping (Any?, String?) -> Void) {
        guard host != nil, let videoCall else {
            reply(nil, "Start sharing and open the video call on the debate host’s Mac.")
            return
        }
        videoCall.record(action: action, speaker: speaker, useLocal: useLocal, reply: reply)
    }

    @objc private func openVideoCall() {
        if let videoCall { videoCall.show(); return }
        guard host != nil || viewer?.callAvailable == true else { return }
        do {
            let call = try VideoCallWindow()
            videoCall = call
            if let host {
                host.onCallEvent = { [weak call] event in call?.deliver(event) }
                let name = Host.current().localizedName ?? "Host"
                call.onSignal = { [weak host] signal in host?.handleHostCall(signal, name: name) }
                host.enableCall()
            } else if let viewer {
                call.onSignal = { [weak viewer] signal in viewer?.sendCall(signal) }
            }
            call.onClose = { [weak self, weak call] in
                if self?.videoCall === call { self?.videoCall = nil }
            }
            call.show()
        } catch {
            status.stringValue = "Couldn’t open the video call: \(error.localizedDescription)"
        }
    }

    @objc private func leave() {
        end()
        showJoin()
    }

    private func display(_ notebook: SharedNotebook) {
        guard let text = transcript.documentView as? NSTextView else { return }
        let old = displayedNotebook
        displayedNotebook = notebook
        guard old?.entries != notebook.entries || old?.proposition != notebook.proposition else { return }

        // Replace only the changed text, then restore this viewer's local scroll and selection.
        let clip = transcript.contentView
        let scrollOrigin = clip.bounds.origin
        let selection = text.selectedRange()
        var sections = [notebook.proposition]
        var lastTurn: Int?
        for entry in notebook.entries {
            let heading = "\(entry.speaker) · \(entry.stage)"
            let points = entry.points.map { point in
                let quote = point.quote.map { "\n    “\($0)”" } ?? ""
                return "• \(point.kind.capitalized): \(point.point)\(quote)"
            }.joined(separator: "\n")
            let contribution = [heading, entry.summary, points.isEmpty ? nil : points, entry.text]
                .compactMap { $0 }.joined(separator: "\n\n")
            if let turn = entry.turn, turn == lastTurn {
                sections[sections.count - 1] += "\n\n" + contribution
            } else if let turn = entry.turn {
                sections.append("Turn \(turn) · \(entry.turnTitle ?? entry.stage)\n\n" + contribution)
            } else {
                sections.append(contribution)
            }
            lastTurn = entry.turn
        }
        let updated = sections.joined(separator: "\n\n────────────────────\n\n")
        let previous = text.string as NSString
        let replacement = updated as NSString
        // Work at Character boundaries so Unicode accents and emoji survive incremental edits.
        var prefix = 0
        for (a, b) in zip(text.string, updated) {
            guard a.utf16.elementsEqual(b.utf16) else { break }
            prefix += a.utf16.count
        }
        text.textStorage?.replaceCharacters(in: NSRange(location: prefix, length: previous.length - prefix),
                                            with: replacement.substring(from: prefix))
        if selection.location != NSNotFound {
            let location = min(selection.location, replacement.length)
            text.setSelectedRange(NSRange(location: location, length: min(selection.length, replacement.length - location)))
        }
        if let container = text.textContainer { text.layoutManager?.ensureLayout(for: container) }
        clip.scroll(to: clip.constrainBoundsRect(NSRect(origin: scrollOrigin, size: clip.bounds.size)).origin)
        transcript.reflectScrolledClipView(clip)
    }
}

enum SharingUIError: LocalizedError {
    case noRound
    var errorDescription: String? { "Create a debate round before sharing." }
}
