import AppKit
import AVFoundation
import WebKit

final class DebateVoice: NSObject, WKScriptMessageHandler {
    private let synthesizer = AVSpeechSynthesizer()

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let text = message.body as? String, text.count <= 12_000 else { return }
        synthesizer.stopSpeaking(at: .immediate)
        if !text.isEmpty { synthesizer.speak(AVSpeechUtterance(string: text)) }
    }
}

final class DebateRoom: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandlerWithReply {
    private let origin = URL(string: "http://127.0.0.1:18767/")!
    private let window = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: 1100, height: 800),
        styleMask: [.titled, .closable, .miniaturizable, .resizable],
        backing: .buffered,
        defer: false
    )
    private var webView: WKWebView?
    private let sharing = SharingWindow()
    private lazy var joinRequests = JoinRequestBanner()
    private var service: Process?
    private var outputPipe: Pipe?
    private var serviceInput: Pipe?
    private var startupOutput = ""
    private let status = NSTextField(wrappingLabelWithString: "")
    private lazy var retryButton = NSButton(title: "Try Again", target: self, action: #selector(startService))

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        configureMenus()
        sharing.onPendingViewers = { [weak self] pending in self?.joinRequests.update(pending) }
        joinRequests.onReview = { [weak self] in self?.sharing.reviewJoinRequests() }
        sharing.readNotebook = { [weak self] includeTranscript, completion in
            guard let view = self?.webView else { completion(.failure(SharingUIError.noRound)); return }
            view.evaluateJavaScript("window.debateRoomSharedNotebook?.(\(includeTranscript)) ?? null") { value, error in
                if let error { completion(.failure(error)); return }
                guard let json = value as? String else { completion(.failure(SharingUIError.noRound)); return }
                completion(Result { try JSONDecoder().decode(SharedNotebook.self, from: Data(json.utf8)) })
            }
        }
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        window.title = "The Debate Room · v\(version)"
        window.minSize = NSSize(width: 480, height: 480)
        window.setFrameAutosaveName("DebateRoomWindow")
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        startService()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let webView else { return .terminateNow }
        webView.evaluateJavaScript("window.debateRoomIsBusy?.() ?? false") { value, _ in
            guard value as? Bool == true else {
                NSApp.reply(toApplicationShouldTerminate: true)
                return
            }
            let alert = NSAlert()
            alert.messageText = "Quit while the notebook is busy?"
            alert.informativeText = "An active recording or unfinished notes may be lost."
            alert.addButton(withTitle: "Keep Working")
            alert.addButton(withTitle: "Quit")
            NSApp.reply(toApplicationShouldTerminate: alert.runModal() == .alertSecondButtonReturn)
        }
        return .terminateLater
    }

    func applicationWillTerminate(_ notification: Notification) {
        sharing.end()
        outputPipe?.fileHandleForReading.readabilityHandler = nil
        try? serviceInput?.fileHandleForWriting.close()
    }

    private func configureMenus() {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Debate Room", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Debate Room", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        menu.addItem(appItem)

        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        menu.addItem(editItem)
        let sharingItem = NSMenuItem()
        let sharingMenu = NSMenu(title: "Sharing")
        let share = sharingMenu.addItem(withTitle: "Share Debate…", action: #selector(shareDebate), keyEquivalent: "")
        share.target = self
        let join = sharingMenu.addItem(withTitle: "Join Debate…", action: #selector(joinDebate), keyEquivalent: "")
        join.target = self
        sharingItem.submenu = sharingMenu
        menu.addItem(sharingItem)
        NSApp.mainMenu = menu
    }

    @objc private func shareDebate() { sharing.showShare() }
    @objc private func joinDebate() { sharing.showJoin() }

    private func showStatus(_ message: String, retry: Bool = false) {
        let content = NSView()
        let heading = NSTextField(labelWithString: "The Debate Room")
        heading.font = .systemFont(ofSize: 27, weight: .semibold)
        status.stringValue = message
        status.isSelectable = true
        status.alignment = .center
        status.preferredMaxLayoutWidth = 510
        retryButton.isHidden = !retry
        let stack = NSStackView(views: [heading, status, retryButton])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: content.centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: content.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: content.trailingAnchor, constant: -24)
        ])
        window.contentView = content
    }

    @objc private func startService() {
        guard service?.isRunning != true else { return }
        showStatus("Starting the local service. First launch may install the transcription tools.")
        startupOutput = ""
        webView = nil
        let process = Process()
        let pipe = Pipe()
        let input = Pipe()
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        process.arguments = [Bundle.main.url(forResource: "run-service", withExtension: "sh")!.path, String(origin.port!)]
        process.standardInput = input
        process.standardOutput = pipe
        process.standardError = pipe
        service = process
        outputPipe = pipe
        serviceInput = input

        pipe.fileHandleForReading.readabilityHandler = { [weak self, weak process] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil }
            DispatchQueue.main.async {
                guard let self, let process, self.service === process else { return }
                self.startupOutput.append(String(decoding: data, as: UTF8.self))
                if self.webView == nil, process.isRunning,
                   self.startupOutput.contains("Open \(self.origin.absoluteString)") {
                    self.showDebate()
                }
                self.startupOutput = String(self.startupOutput.suffix(4000))
                if data.isEmpty { self.serviceEnded(process) }
            }
        }
        do {
            try process.run()
        } catch {
            pipe.fileHandleForReading.readabilityHandler = nil
            serviceInput = nil
            showStatus("The local service could not start. \(error.localizedDescription)", retry: true)
        }
    }

    private func serviceEnded(_ process: Process) {
        // EOF can arrive just before Process publishes its final state.
        if process.isRunning {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
                guard let self, self.service === process else { return }
                self.serviceEnded(process)
            }
            return
        }
        serviceInput = nil
        let lastLine = startupOutput.split(separator: "\n").last.map(String.init) ?? ""
        let help = lastLine.contains("Address already in use")
            ? "Another app is listening on port \(origin.port!). Close that service and try again."
            : lastLine
        showStatus("The local service stopped.\n\(help)", retry: true)
    }

    private func showDebate() {
        let config = WKWebViewConfiguration()
        // Keep turn timers and audio running when the user focuses the other window.
        config.preferences.inactiveSchedulingPolicy = .none
        config.preferences.isElementFullscreenEnabled = true
        config.userContentController.add(DebateVoice(), name: "debateVoice")
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "debateAudio")
        config.userContentController.addUserScript(WKUserScript(
            source: "window.debateRoomMacApp = true;",
            injectionTime: .atDocumentStart, forMainFrameOnly: true
        ))
        let view = WKWebView(frame: window.contentView?.bounds ?? .zero, configuration: config)
        view.navigationDelegate = self
        view.uiDelegate = self
        view.allowsBackForwardNavigationGestures = false
        webView = view
        window.contentView = view
        view.load(URLRequest(url: origin))
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.webView === webView, message.frameInfo.isMainFrame,
              message.frameInfo.request.url.map(isLocal) == true,
              let args = message.body as? [String: Any], let action = args["action"] as? String,
              ["start", "stop"].contains(action), let speaker = args["speaker"] as? String,
              speaker.count <= 80, let useLocal = args["useLocal"] as? Bool else {
            replyHandler(nil, "Invalid call recording request.")
            return
        }
        sharing.recordCall(action: action, speaker: speaker, useLocal: useLocal, reply: replyHandler)
    }

    private func isLocal(_ url: URL) -> Bool {
        url.scheme == origin.scheme && url.host == origin.host && url.port == origin.port
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if action.shouldPerformDownload {
            decisionHandler(.cancel)
        } else if isLocal(url) {
            if action.targetFrame == nil { webView.load(action.request); decisionHandler(.cancel) }
            else { decisionHandler(.allow) }
        } else {
            if action.navigationType == .linkActivated, ["http", "https"].contains(url.scheme ?? "") {
                NSWorkspace.shared.open(url)
            }
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "Continue")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { response in
            completionHandler(response == .alertFirstButtonReturn)
        }
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor securityOrigin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        let localAudio = securityOrigin.protocol == "http"
            && securityOrigin.host == origin.host && securityOrigin.port == origin.port
            && frame.isMainFrame && type == .microphone
        decisionHandler(localAudio ? .prompt : .deny)
    }
}

@main
enum DebateRoomMain {
    static func main() {
        let app = NSApplication.shared
        let delegate = DebateRoom()
        app.delegate = delegate
        app.run()
    }
}
