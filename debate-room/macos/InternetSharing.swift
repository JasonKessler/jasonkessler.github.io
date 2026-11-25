import Foundation
import Network

/// The public carrier transports opaque bytes. ShareSocket's TLS still terminates at the host Mac.
final class InternetViewerBridge {
    private let listener: NWListener
    private let url: URL
    private var tcp: NWConnection?
    private var websocket: URLSessionWebSocketTask?
    var onReady: ((NWEndpoint) -> Void)?
    var onFailure: (() -> Void)?

    init(url: URL) throws {
        self.url = url
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: parameters)
    }

    func start() {
        listener.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                if let port = self.listener.port { self.onReady?(.hostPort(host: "127.0.0.1", port: port)) }
            case .failed: self.onFailure?()
            default: break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            guard let self, self.tcp == nil else { connection.cancel(); return }
            self.open(connection)
        }
        listener.start(queue: .main)
    }

    func stop() {
        listener.cancel()
        tcp?.cancel()
        websocket?.cancel(with: .goingAway, reason: nil)
        tcp = nil
        websocket = nil
    }

    private func open(_ connection: NWConnection) {
        let socket = URLSession.shared.webSocketTask(with: url)
        socket.maximumMessageSize = 65536
        tcp = connection
        websocket = socket
        socket.resume()
        connection.stateUpdateHandler = { [weak self] state in
            if case .ready = state {
                self?.sendToInternet()
                self?.readFromInternet()
            }
        }
        connection.start(queue: .main)
    }

    private func sendToInternet() {
        tcp?.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, ended, error in
            guard let self else { return }
            guard !ended, error == nil, let data else { self.stop(); return }
            self.websocket?.send(.data(data)) { [weak self] error in
                DispatchQueue.main.async {
                    guard let self else { return }
                    if error == nil { self.sendToInternet() } else { self.stop() }
                }
            }
        }
    }

    private func readFromInternet() {
        websocket?.receive { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                guard case .success(.data(let data)) = result else { self.stop(); return }
                self.tcp?.send(content: data, completion: .contentProcessed { [weak self] error in
                    guard let self else { return }
                    if error == nil { self.readFromInternet() } else { self.stop() }
                })
            }
        }
    }
}

final class InternetHostTunnel {
    private let process = Process()
    private let pipe = Pipe()
    private var buffer = ""
    private(set) var url: URL?
    var onReady: ((URL) -> Void)?
    var onFailure: ((String) -> Void)?

    init(port: UInt16, browserPort: UInt16? = nil) throws {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let candidates = [home.appendingPathComponent(".local/share/debate-room/bin/cloudflared").path,
                          "/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared"]
        guard let cloudflared = candidates.first(where: FileManager.default.isExecutableFile(atPath:)) else {
            throw SetupError("Install cloudflared on the host Mac with brew install cloudflared and try again.")
        }
        let python = home.appendingPathComponent(".local/share/debate-room/venv/bin/python")
        guard FileManager.default.isExecutableFile(atPath: python.path),
              let script = Bundle.main.url(forResource: "internet_bridge", withExtension: "py")
        else { throw SetupError("Start a debate to initialize its local service before opening an internet invite.") }
        process.executableURL = python
        process.arguments = [script.path, String(port), cloudflared]
        if let browserPort { process.arguments?.append(contentsOf: ["--browser-port", String(browserPort)]) }
        process.standardOutput = pipe
        process.standardError = pipe
    }

    func start() throws {
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil }
            DispatchQueue.main.async {
                guard let self else { return }
                self.buffer.append(String(decoding: data, as: UTF8.self))
                if let ready = self.buffer.split(separator: "\n").first(where: { $0.hasPrefix("INTERNET_READY ") }),
                   let url = URL(string: String(ready.dropFirst("INTERNET_READY ".count))),
                   ShareInvite.validTunnel(url), self.url == nil {
                    self.url = url
                    self.onReady?(url)
                }
                self.buffer = String(self.buffer.suffix(8192))
                if data.isEmpty {
                    self.onFailure?(self.buffer.contains("No module named 'websockets'")
                        ? "Install the websockets package in the Debate Room Python environment. See the setup guide."
                        : "The internet tunnel stopped. Check the connection and try again.")
                }
            }
        }
        try process.run()
        DispatchQueue.main.asyncAfter(deadline: .now() + 65) { [weak self] in
            guard let self, self.url == nil, self.process.isRunning else { return }
            self.onFailure?("Cloudflare did not open a tunnel. Check the internet connection and try again.")
            self.stop()
        }
    }

    func stop() {
        pipe.fileHandleForReading.readabilityHandler = nil
        if process.isRunning { process.terminate() }
    }

    struct SetupError: LocalizedError {
        let message: String
        init(_ message: String) { self.message = message }
        var errorDescription: String? { message }
    }
}
