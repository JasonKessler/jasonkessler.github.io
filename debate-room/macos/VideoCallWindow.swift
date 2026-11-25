import AppKit
import Network
import WebKit

/// Serves one bundled page on loopback so WebKit can request camera and mic access.
private final class CallPageServer {
    private let listener: NWListener
    private let pages: [String: (Data, String)]
    var onReady: ((UInt16) -> Void)?
    var onError: ((String) -> Void)?

    init() throws {
        guard let page = Bundle.main.url(forResource: "video-call", withExtension: "html"),
              let media = Bundle.main.url(forResource: "call-media", withExtension: "js") else {
            throw CocoaError(.fileNoSuchFile)
        }
        pages = [
            "/": (try Data(contentsOf: page), "text/html; charset=utf-8"),
            "/call-media.js": (try Data(contentsOf: media), "text/javascript; charset=utf-8")
        ]
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: parameters)
    }

    func start() {
        listener.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                if let port = self?.listener.port?.rawValue { self?.onReady?(port) }
            case .failed(let error): self?.onError?(error.localizedDescription)
            default: break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { connection.cancel(); return }
            connection.start(queue: .main)
            connection.receive(minimumIncompleteLength: 32, maximumLength: 8192) { data, _, _, _ in
                guard let data,
                      let request = String(decoding: data, as: UTF8.self).split(separator: "\r\n").first
                        .map({ $0.split(separator: " ") }), request.count == 3, request[0] == "GET",
                      let (body, contentType) = self.pages[String(request[1])] else {
                    connection.cancel()
                    return
                }
                let header = "HTTP/1.1 200 OK\r\nContent-Type: \(contentType)\r\n"
                    + "Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n"
                    + "Content-Length: \(body.count)\r\nConnection: close\r\n\r\n"
                connection.send(content: Data(header.utf8) + body,
                                completion: .contentProcessed { _ in connection.cancel() })
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) { connection.cancel() }
        }
        listener.start(queue: .main)
    }

    func stop() { listener.cancel() }
}

final class VideoCallWindow: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    private final class Handler: NSObject, WKScriptMessageHandler {
        weak var owner: VideoCallWindow?
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            owner?.receive(message)
        }
    }

    private let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 780, height: 655),
        styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
    private let server: CallPageServer
    private let view: WKWebView
    private var origin: URL?
    private var closed = false
    private var joined = false
    var onSignal: ((CallSignal) -> Void)?
    var onClose: (() -> Void)?

    init(call: Void = ()) throws {
        server = try CallPageServer()
        let handler = Handler()
        let config = WKWebViewConfiguration()
        // Keep turn timers and audio running when the user focuses the other window.
        config.preferences.inactiveSchedulingPolicy = .none
        config.websiteDataStore = .nonPersistent()
        config.mediaTypesRequiringUserActionForPlayback = []
        config.userContentController.add(handler, name: "debateCall")
        view = WKWebView(frame: .zero, configuration: config)
        super.init()
        handler.owner = self
        view.navigationDelegate = self
        view.uiDelegate = self
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.title = "Debate video call"
        window.minSize = NSSize(width: 430, height: 420)
        window.contentView = view
        window.center()
        server.onReady = { [weak self] port in
            guard let self, let url = URL(string: "http://127.0.0.1:\(port)/") else { return }
            self.origin = url
            self.view.load(URLRequest(url: url))
        }
        server.onError = { [weak self] message in self?.showError(message) }
        server.start()
    }

    func show() { window.makeKeyAndOrderFront(nil) }

    func record(action: String, speaker: String, useLocal: Bool,
                reply: @escaping (Any?, String?) -> Void) {
        guard !closed else { reply(nil, "The video call window closed."); return }
        view.callAsyncJavaScript("""
            try {
                return {value: await window.debateCallRecord({action, speaker, useLocal})};
            } catch (error) {
                return {error: error.message};
            }
            """, arguments: ["action": action, "speaker": speaker, "useLocal": useLocal],
             in: nil, in: .page) { result in
            switch result {
            case .success(let value):
                let response = value as? [String: Any]
                reply(response?["value"], response?["error"] as? String)
            case .failure(let error):
                reply(nil, error.localizedDescription)
            }
        }
    }

    func deliver(_ event: CallEvent) {
        guard !closed, let data = try? JSONEncoder().encode(event) else { return }
        view.evaluateJavaScript("window.debateCallReceive?.(\(String(decoding: data, as: UTF8.self)))")
        if event.kind == .error || (event.kind == .availability && event.enabled != true) { joined = false }
    }

    private func receive(_ message: WKScriptMessage) {
        guard !closed, message.frameInfo.isMainFrame,
              message.frameInfo.securityOrigin.host == origin?.host,
              message.frameInfo.securityOrigin.port == origin?.port,
              message.frameInfo.securityOrigin.protocol == "http",
              let body = message.body as? String, body.utf8.count <= 256 * 1024,
              let signal = try? JSONDecoder().decode(CallSignal.self, from: Data(body.utf8)) else { return }
        if signal.kind == .join { joined = true }
        if signal.kind == .leave { joined = false }
        onSignal?(signal)
    }

    private func showError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "Couldn’t open the video call"
        alert.informativeText = message
        alert.beginSheetModal(for: window)
    }

    func close() { if !closed { window.close() } }

    func windowWillClose(_ notification: Notification) {
        guard !closed else { return }
        closed = true
        if joined { onSignal?(CallSignal(kind: .leave)) }
        view.setCameraCaptureState(.none)
        view.setMicrophoneCaptureState(.none)
        view.stopLoading()
        view.removeFromSuperview()
        server.stop()
        onClose?()
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if joined { onSignal?(CallSignal(kind: .leave)) }
        joined = false
        showError("The video window stopped. Close it and open the call again.")
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(action.request.url == origin && action.targetFrame?.isMainFrame == true ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor securityOrigin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        let ownPage = !closed && frame.isMainFrame && securityOrigin.protocol == "http"
            && securityOrigin.host == origin?.host && securityOrigin.port == origin?.port
        decisionHandler(ownPage ? .prompt : .deny)
    }
}
