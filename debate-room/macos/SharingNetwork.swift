import CryptoKit
import Foundation
import Network
import Security

struct ShareInvite: Codable {
    struct Address: Codable {
        let host: String
        let port: UInt16
        init?(host: String, port: UInt16) {
            let name = host.trimmingCharacters(in: .whitespacesAndNewlines)
            guard port != 0, Self.validHost(name) else { return nil }
            self.host = name
            self.port = port
        }

        private static func validHost(_ host: String) -> Bool {
            guard !host.isEmpty, host.utf8.count <= 253 else { return false }
            if IPv4Address(host) != nil || IPv6Address(host) != nil { return true }
            let labels = host.split(separator: ".", omittingEmptySubsequences: false)
            return labels.allSatisfy { label in
                !label.isEmpty && label.utf8.count <= 63 && label.first != "-" && label.last != "-"
                    && label.utf8.allSatisfy { (48...57).contains($0) || (65...90).contains($0)
                        || (97...122).contains($0) || $0 == 45 }
            }
        }

        var endpoint: NWEndpoint? {
            guard Self.validHost(host), port != 0, let networkPort = NWEndpoint.Port(rawValue: port) else { return nil }
            return .hostPort(host: NWEndpoint.Host(host), port: networkPort)
        }
    }

    let version: Int
    let room: String
    let fingerprint: Data
    let secret: String
    let expires: Date
    let address: Address?
    let tunnelURL: URL?
    static let serviceType = "_debateroom._tcp"

    var text: String { "debate-room:" + ((try? JSONEncoder().encode(self))?.base64EncodedString() ?? "") }

    init(room: String, fingerprint: Data) {
        version = 1
        self.room = room
        self.fingerprint = fingerprint
        secret = UUID().uuidString + UUID().uuidString
        expires = Date().addingTimeInterval(3600)
        address = nil
        tunnelURL = nil
    }

    func remote(host: String, port: NWEndpoint.Port) -> Self? {
        guard let address = Address(host: host, port: port.rawValue) else { return nil }
        return Self(localInvite: self, address: address, tunnelURL: nil)
    }

    func internet(url: URL) -> Self? {
        guard Self.validTunnel(url) else { return nil }
        return Self(localInvite: self, address: nil, tunnelURL: url)
    }

    static func validTunnel(_ url: URL) -> Bool {
        guard let host = url.host, url.scheme == "wss", url.path == "/debate",
              url.port == nil, url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil else { return false }
        return host.range(of: #"^[a-z0-9-]+\.trycloudflare\.com$"#, options: .regularExpression) != nil
    }

    private init(localInvite: Self, address: Address?, tunnelURL: URL?) {
        version = tunnelURL == nil ? 2 : 3
        room = localInvite.room
        fingerprint = localInvite.fingerprint
        secret = localInvite.secret
        expires = localInvite.expires
        self.address = address
        self.tunnelURL = tunnelURL
    }

    private var validTransport: Bool {
        switch version {
        case 1: return address == nil && tunnelURL == nil
        case 2: return address?.endpoint != nil && tunnelURL == nil
        case 3: return address == nil && tunnelURL.map(Self.validTunnel) == true
        default: return false
        }
    }

    init?(text: String) {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let prefix = "debate-room:"
        guard value.hasPrefix(prefix), value.count < 2048,
              let data = Data(base64Encoded: String(value.dropFirst(prefix.count))),
              let invite = try? JSONDecoder().decode(Self.self, from: data),
              invite.validTransport,
              UUID(uuidString: invite.room) != nil,
              invite.fingerprint.count == 32, !invite.secret.isEmpty, invite.expires > Date()
        else { return nil }
        self = invite
    }
}

struct SharedNotebook: Codable, Equatable {
    struct Point: Codable, Equatable {
        let kind: String
        let point: String
        let quote: String?
    }
    struct Entry: Codable, Equatable {
        let id: String
        var turn: Int? = nil
        var turnTitle: String? = nil
        let stage: String
        let speaker: String
        let text: String?
        let summary: String?
        let points: [Point]
    }
    let roundID: String
    let proposition: String
    let currentTurn: String
    let entries: [Entry]
}

struct CallPeer: Codable, Equatable {
    let id: UUID
    let name: String
}

struct CallSignal: Codable {
    enum Kind: String, Codable { case join, leave, offer, answer, ice }
    let kind: Kind
    var to: UUID? = nil
    var value: String? = nil
}

struct CallEvent: Codable {
    enum Kind: String, Codable { case availability, roster, signal, error }
    let kind: Kind
    var enabled: Bool? = nil
    var selfID: UUID? = nil
    var peers: [CallPeer]? = nil
    var from: UUID? = nil
    var signal: CallSignal? = nil
    var message: String? = nil
}

private struct ShareMessage: Codable {
    enum Kind: String, Codable { case join, approved, snapshot, rejected, ended, paused, resumed, callSignal, callEvent }
    let kind: Kind
    var name: String? = nil
    var secret: String? = nil
    var resume: String? = nil
    var notebook: SharedNotebook? = nil
    var callVersion: Int? = nil
    var callSignal: CallSignal? = nil
    var callEvent: CallEvent? = nil
}

enum ShareError: LocalizedError {
    case identity, oversized, unsupportedOS
    var errorDescription: String? {
        switch self {
        case .identity: return "Could not create the encrypted sharing session."
        case .oversized: return "The notebook is too large to send in one update."
        case .unsupportedOS: return "Hosting a shared debate requires macOS 15 or later."
        }
    }
}

private func tlsIdentity() throws -> (SecIdentity, Data) {
    guard #available(macOS 15.0, *) else { throw ShareError.unsupportedOS }
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false,
                                            attributes: [.posixPermissions: 0o700])
    defer { try? FileManager.default.removeItem(at: folder) }
    func openssl(_ arguments: [String]) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/openssl")
        process.currentDirectoryURL = folder
        process.arguments = arguments
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw ShareError.identity }
    }
    let password = UUID().uuidString
    try openssl(["req", "-new", "-x509", "-nodes", "-newkey", "rsa:2048", "-sha256", "-days", "1",
                 "-subj", "/CN=Debate Room", "-keyout", "key.pem", "-out", "cert.pem"])
    try openssl(["pkcs12", "-export", "-inkey", "key.pem", "-in", "cert.pem",
                 "-out", "identity.p12", "-passout", "pass:\(password)"])
    let data = try Data(contentsOf: folder.appendingPathComponent("identity.p12"))
    var items: CFArray?
    let result = SecPKCS12Import(data as CFData, [kSecImportExportPassphrase: password, kSecImportToMemoryOnly: true] as CFDictionary, &items)
    guard result == errSecSuccess, let record = (items as? [[String: Any]])?.first,
          let value = record[kSecImportItemIdentity as String], CFGetTypeID(value as CFTypeRef) == SecIdentityGetTypeID()
    else { throw ShareError.identity }
    let identity = value as! SecIdentity
    var cert: SecCertificate?
    guard SecIdentityCopyCertificate(identity, &cert) == errSecSuccess, let cert else { throw ShareError.identity }
    return (identity, Data(SHA256.hash(data: SecCertificateCopyData(cert) as Data)))
}

private final class ShareSocket {
    static let maxMessage = 4 * 1024 * 1024
    let connection: NWConnection
    var onMessage: ((ShareMessage) -> Void)?
    var onReady: (() -> Void)?
    var onClose: ((String) -> Void)?
    private var buffer = Data()
    private var closed = false
    private var sending = false
    private var nextSnapshot: ShareMessage?
    private let browserKey: SymmetricKey?
    private let serverSalt = BrowserShareCipher.randomSalt()
    private var browserCipher: BrowserShareCipher?
    var isBrowser: Bool { browserKey != nil }
    private var frameLimit: Int { isBrowser ? ((Self.maxMessage + 18) / 3) * 4 : Self.maxMessage }

    init(_ connection: NWConnection, browserKey: SymmetricKey? = nil) {
        self.connection = connection
        self.browserKey = browserKey
    }

    func start() {
        connection.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                if self.isBrowser {
                    self.connection.send(content: Data((self.serverSalt.base64EncodedString() + "\n").utf8),
                                    completion: .contentProcessed { [weak self] error in
                        if let error { self?.finish(error.localizedDescription) }
                    })
                }
                self.onReady?()
                self.receive()
            case .failed(let error): self.finish(error.localizedDescription)
            case .cancelled: self.finish("Disconnected")
            default: break
            }
        }
        connection.start(queue: .main)
    }

    private func receive() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, complete, error in
            guard let self, !self.closed else { return }
            if let data { self.buffer.append(data) }
            while let line = self.buffer.firstIndex(of: 10) {
                guard line - self.buffer.startIndex <= self.frameLimit else {
                    self.finish("Sharing message exceeds the limit"); return
                }
                let frame = Data(self.buffer[..<line])
                self.buffer.removeSubrange(...line)
                do {
                    if let message = try self.decode(frame) { self.onMessage?(message) }
                } catch {
                    self.finish("Invalid sharing message"); return
                }
                if self.closed { return }
            }
            if self.buffer.count > self.frameLimit { self.finish("Sharing message exceeds the limit"); return }
            if complete || error != nil { self.finish(error?.localizedDescription ?? "Disconnected") }
            else { self.receive() }
        }
    }

    private func decode(_ frame: Data) throws -> ShareMessage? {
        var plaintext = frame
        if let browserKey {
            guard let bytes = Data(base64Encoded: frame) else { throw ShareError.identity }
            if browserCipher == nil {
                guard bytes.count == BrowserShareCipher.saltSize else { throw ShareError.identity }
                browserCipher = BrowserShareCipher(key: browserKey, serverSalt: serverSalt, clientSalt: bytes)
                return nil
            }
            guard bytes.count >= 16, let decoded = try browserCipher?.open(bytes) else { throw ShareError.identity }
            plaintext = decoded
        }
        guard plaintext.count <= Self.maxMessage else { throw ShareError.oversized }
        return try JSONDecoder().decode(ShareMessage.self, from: plaintext)
    }

    func send(_ message: ShareMessage, thenClose: Bool = false) {
        guard !closed else { return }
        // A slow viewer only needs the latest full notebook.
        if message.kind == .snapshot && sending {
            nextSnapshot = message
            return
        }
        guard var data = try? JSONEncoder().encode(message), data.count <= Self.maxMessage
        else { finish("Sharing message exceeds the limit"); return }
        if isBrowser {
            guard let encrypted = try? browserCipher?.seal(data) else { finish(); return }
            data = encrypted.base64EncodedData()
        }
        data.append(10)
        if message.kind == .paused || thenClose { nextSnapshot = nil }
        if thenClose {
            connection.send(content: data, completion: .contentProcessed { _ in self.finish() })
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.finish() }
            return
        }
        if message.kind == .snapshot { sending = true }
        connection.send(content: data, completion: .contentProcessed { [weak self] error in
            guard let self, !self.closed else { return }
            if error != nil {
                self.finish(error?.localizedDescription ?? "Disconnected")
            } else if message.kind == .snapshot {
                self.sending = false
                if let next = self.nextSnapshot {
                    self.nextSnapshot = nil
                    self.send(next)
                }
            }
        })
    }

    func finish(_ reason: String = "Disconnected") {
        guard !closed else { return }
        closed = true
        connection.cancel()
        onClose?(reason)
    }
}

final class SharingHost {
    struct Viewer {
        let id: UUID
        let name: String
        let approved: Bool
    }
    private struct Peer {
        let socket: ShareSocket
        var name: String?
        var resume: String?
        var supportsCall = false
    }
    let invite: ShareInvite
    private let listener: NWListener
    private var browserListener: NWListener?
    private let browserKey = SymmetricKey(size: .bits256)
    private var peers: [UUID: Peer] = [:]
    private var approvals: [String: String] = [:]
    private var notebook: SharedNotebook?
    private var callMembers: [UUID: String] = [:]
    private let hostCallID = UUID()
    private(set) var callEnabled = false
    var onCallEvent: ((CallEvent) -> Void)?
    private(set) var paused = false
    var onChange: (() -> Void)?
    var onStatus: ((String) -> Void)?
    var viewers: [Viewer] {
        peers.compactMap { id, peer in
            peer.name.map { Viewer(id: id, name: $0, approved: peer.resume != nil) }
        }.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    init(advertise: Bool = true) throws {
        let (identity, fingerprint) = try tlsIdentity()
        invite = ShareInvite(room: UUID().uuidString.lowercased(), fingerprint: fingerprint)
        let options = NWProtocolTLS.Options()
        guard let localIdentity = sec_identity_create(identity) else { throw ShareError.identity }
        sec_protocol_options_set_local_identity(options.securityProtocolOptions, localIdentity)
        sec_protocol_options_set_min_tls_protocol_version(options.securityProtocolOptions, .TLSv12)
        listener = try NWListener(using: NWParameters(tls: options))
        if advertise { listener.service = NWListener.Service(name: invite.room, type: ShareInvite.serviceType) }
    }

    var port: NWEndpoint.Port? { listener.port }

    func start() {
        listener.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready: self?.onStatus?("Sharing on the local network")
            case .waiting(let error), .failed(let error): self?.onStatus?("Sharing unavailable: \(error.localizedDescription)")
            default: break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
        listener.start(queue: .main)
    }

    func startBrowserListener(onReady: @escaping (Result<UInt16, Error>) -> Void) throws {
        if let port = browserListener?.port {
            onReady(.success(port.rawValue))
            return
        }
        browserListener?.cancel()
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        let listener = try NWListener(using: parameters)
        browserListener = listener
        listener.stateUpdateHandler = { [weak listener] state in
            switch state {
            case .ready:
                if let port = listener?.port { onReady(.success(port.rawValue)) }
            case .failed(let error): onReady(.failure(error))
            default: break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { connection.cancel(); return }
            self.accept(connection, browserKey: self.browserKey)
        }
        listener.start(queue: .main)
    }

    func browserLink(for tunnelURL: URL) -> URL? {
        guard ShareInvite.validTunnel(tunnelURL), let host = tunnelURL.host else { return nil }
        let key = browserKey.withUnsafeBytes { Data($0).base64EncodedString() }
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        return URL(string: "https://jasonkessler.github.io/debate-room/guest.html#\(host).\(key)")
    }

    func publish(_ notebook: SharedNotebook) throws {
        guard !paused, self.notebook != notebook else { return }
        let message = ShareMessage(kind: .snapshot, notebook: notebook)
        guard try JSONEncoder().encode(message).count <= ShareSocket.maxMessage else { throw ShareError.oversized }
        self.notebook = notebook
        for peer in peers.values where peer.resume != nil { peer.socket.send(message) }
    }

    func setPaused(_ value: Bool) {
        paused = value
        for peer in peers.values where peer.resume != nil {
            peer.socket.send(ShareMessage(kind: value ? .paused : .resumed))
        }
    }

    func enableCall() {
        guard !callEnabled else { return }
        callEnabled = true
        for (id, peer) in peers where peer.resume != nil && peer.supportsCall {
            sendCall(CallEvent(kind: .availability, enabled: true), to: id)
        }
    }

    func handleHostCall(_ signal: CallSignal, name: String) {
        handleCall(signal, from: hostCallID, name: name)
    }

    private func sendCall(_ event: CallEvent, to id: UUID) {
        if id == hostCallID { onCallEvent?(event) }
        else if let peer = peers[id], peer.resume != nil, peer.supportsCall {
            peer.socket.send(ShareMessage(kind: .callEvent, callEvent: event))
        }
    }

    private func broadcastRoster() {
        let roster = callMembers.map { CallPeer(id: $0.key, name: $0.value) }
            .sorted { $0.id.uuidString < $1.id.uuidString }
        for id in Array(callMembers.keys) {
            sendCall(CallEvent(kind: .roster, selfID: id, peers: roster), to: id)
        }
    }

    private func removeCallMember(_ id: UUID) {
        if callMembers.removeValue(forKey: id) != nil { broadcastRoster() }
    }

    private func handleCall(_ signal: CallSignal, from id: UUID, name: String) {
        guard callEnabled else {
            sendCall(CallEvent(kind: .error, message: "The host hasn’t enabled the video call."), to: id)
            return
        }
        switch signal.kind {
        case .join:
            guard callMembers[id] != nil || callMembers.count < 4 else {
                sendCall(CallEvent(kind: .error, message: "The video call is full (four people)."), to: id)
                return
            }
            callMembers[id] = name
            broadcastRoster()
        case .leave:
            removeCallMember(id)
        case .offer, .answer, .ice:
            let limit = signal.kind == .ice ? 8192 : 128 * 1024
            guard let to = signal.to, to != id, callMembers[id] != nil, callMembers[to] != nil,
                  let value = signal.value, !value.isEmpty, value.utf8.count <= limit
            else { return }
            sendCall(CallEvent(kind: .signal, from: id, signal: signal), to: to)
        }
    }

    func approve(_ id: UUID) {
        guard let name = peers[id]?.name, peers[id]?.resume == nil,
              approvals.count < 100 else { return }
        let token = UUID().uuidString + UUID().uuidString
        approvals[token] = name
        admit(id, with: token)
    }

    func remove(_ id: UUID) {
        if let peer = peers.removeValue(forKey: id) {
            if let token = peer.resume { approvals.removeValue(forKey: token) }
            removeCallMember(id)
            peer.socket.send(ShareMessage(kind: .rejected), thenClose: true)
            onChange?()
        }
    }

    func stop() {
        listener.cancel()
        browserListener?.cancel()
        browserListener = nil
        let sockets = peers.values.map(\.socket)
        callEnabled = false
        callMembers.removeAll()
        peers.removeAll()
        approvals.removeAll()
        for socket in sockets { socket.send(ShareMessage(kind: .ended), thenClose: true) }
    }

    private func accept(_ connection: NWConnection, browserKey: SymmetricKey? = nil) {
        guard peers.count < 32 else { connection.cancel(); return }
        let id = UUID()
        let socket = ShareSocket(connection, browserKey: browserKey)
        peers[id] = Peer(socket: socket)
        socket.onMessage = { [weak self] message in self?.receive(message, from: id) }
        socket.onClose = { [weak self] _ in
            self?.peers.removeValue(forKey: id)
            self?.removeCallMember(id)
            self?.onChange?()
        }
        socket.start()
        DispatchQueue.main.asyncAfter(deadline: .now() + 12) { [weak self] in
            if let peer = self?.peers[id], peer.name == nil { peer.socket.finish() }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 115) { [weak self] in
            if let peer = self?.peers[id], peer.resume == nil { self?.remove(id) }
        }
    }

    private func receive(_ message: ShareMessage, from id: UUID) {
        guard let peer = peers[id] else { return }
        if message.kind == .callSignal {
            if peer.resume != nil, peer.supportsCall, let name = peer.name, let signal = message.callSignal {
                handleCall(signal, from: id, name: name)
            }
            return
        }
        guard peer.name == nil, message.kind == .join else { peer.socket.finish(); return }
        peers[id]?.supportsCall = message.callVersion == 1
        if let token = message.resume, let name = approvals[token] {
            // Replace an old connection for this device after a network interruption.
            peers.first(where: { $0.value.resume == token })?.value.socket.finish()
            peers[id]?.name = name
            admit(id, with: token)
        } else if peer.socket.isBrowser || message.secret == invite.secret, Date() < invite.expires,
                  let name = message.name?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
            peers[id]?.name = String(name.prefix(80))
            onChange?()
        } else {
            remove(id)
        }
    }

    private func admit(_ id: UUID, with token: String) {
        guard let socket = peers[id]?.socket else { return }
        peers[id]?.resume = token
        socket.send(ShareMessage(kind: .approved, resume: token, callVersion: peers[id]?.supportsCall == true ? 1 : nil))
        if peers[id]?.supportsCall == true {
            sendCall(CallEvent(kind: .availability, enabled: callEnabled), to: id)
        }
        if let notebook { socket.send(ShareMessage(kind: .snapshot, notebook: notebook)) }
        if paused { socket.send(ShareMessage(kind: .paused)) }
        onChange?()
    }
}

final class SharingViewer {
    private let invite: ShareInvite
    private let name: String
    private let directEndpoint: NWEndpoint?
    private var resume: String?
    private var socket: ShareSocket?
    private var internetBridge: InternetViewerBridge?
    private var stopped = false
    private var retries = 0
    var onStatus: ((String) -> Void)?
    var onNotebook: ((SharedNotebook) -> Void)?
    var onCallEvent: ((CallEvent) -> Void)?
    private(set) var callAvailable = false

    func sendCall(_ signal: CallSignal) {
        guard callAvailable else { return }
        socket?.send(ShareMessage(kind: .callSignal, callSignal: signal))
    }

    private func closeCall() {
        callAvailable = false
        onCallEvent?(CallEvent(kind: .availability, enabled: false))
    }

    init(invite: ShareInvite, name: String, directEndpoint: NWEndpoint? = nil) {
        self.invite = invite
        self.name = name
        self.directEndpoint = directEndpoint
    }

    func start() {
        guard !stopped else { return }
        if let url = invite.tunnelURL {
            onStatus?("Connecting to the host over the internet…")
            do {
                let bridge = try InternetViewerBridge(url: url)
                internetBridge = bridge
                bridge.onReady = { [weak self, weak bridge] endpoint in
                    guard let self, let bridge, self.internetBridge === bridge else { return }
                    self.connect(to: endpoint)
                }
                bridge.onFailure = { [weak self, weak bridge] in
                    guard let self, let bridge, self.internetBridge === bridge else { return }
                    self.retry()
                }
                bridge.start()
            } catch {
                retry()
            }
        } else {
            onStatus?(invite.address == nil ? "Finding host on the local network…" : "Connecting to the host’s private address…")
            let endpoint = directEndpoint ?? invite.address?.endpoint
                ?? .service(name: invite.room, type: ShareInvite.serviceType, domain: "local.", interface: nil)
            connect(to: endpoint)
        }
    }

    private func connect(to endpoint: NWEndpoint) {
        let tls = NWProtocolTLS.Options()
        let fingerprint = invite.fingerprint
        sec_protocol_options_set_min_tls_protocol_version(tls.securityProtocolOptions, .TLSv12)
        sec_protocol_options_set_verify_block(tls.securityProtocolOptions, { _, trust, complete in
            let value = sec_trust_copy_ref(trust).takeRetainedValue()
            let chain = SecTrustCopyCertificateChain(value) as? [SecCertificate]
            complete(chain?.first.map { Data(SHA256.hash(data: SecCertificateCopyData($0) as Data)) == fingerprint } ?? false)
        }, .main)
        let connection = NWConnection(to: endpoint, using: NWParameters(tls: tls))
        let socket = ShareSocket(connection)
        self.socket = socket
        socket.onReady = { [weak self, weak socket] in
            guard let self else { return }
            self.onStatus?(self.resume == nil ? "Connected. Waiting for host approval…" : "Resuming session…")
            socket?.send(ShareMessage(kind: .join, name: self.name, secret: self.invite.secret, resume: self.resume, callVersion: 1))
        }
        socket.onMessage = { [weak self] message in self?.receive(message) }
        socket.onClose = { [weak self] _ in self?.retry() }
        socket.start()
        DispatchQueue.main.asyncAfter(deadline: .now() + 12) { [weak socket] in
            guard let socket, socket.connection.state != .ready else { return }
            socket.finish()
        }
    }

    func stop() {
        closeCall()
        stopped = true
        socket?.finish()
        socket = nil
        internetBridge?.stop()
        internetBridge = nil
    }

    private func receive(_ message: ShareMessage) {
        switch message.kind {
        case .approved:
            resume = message.resume
            retries = 0
            onStatus?("Connected · waiting for published notes")
        case .snapshot:
            if let notebook = message.notebook {
                onNotebook?(notebook)
                onStatus?("Connected · \(notebook.currentTurn)")
            }
        case .resumed: onStatus?("Connected · sharing resumed")
        case .paused: onStatus?("The host paused sharing. You can still read published notes.")
        case .rejected:
            stop()
            onStatus?("The host declined or removed this viewer.")
        case .ended:
            stop()
            onStatus?("The host ended sharing. Published notes remain available in this window.")
        case .callEvent:
            guard let event = message.callEvent, resume != nil else { return }
            if event.kind == .availability { callAvailable = event.enabled == true }
            onCallEvent?(event)
        case .join, .callSignal: stop()
        }
    }

    private func retry() {
        guard !stopped else { return }
        closeCall()
        internetBridge?.stop()
        internetBridge = nil
        retries += 1
        guard retries <= 5 else {
            if invite.tunnelURL != nil {
                onStatus?("Host unreachable. Ask for an active internet invite and check your connection.")
                return
            }
            onStatus?(invite.address == nil
                ? "Host unreachable. Check Wi-Fi and local network permission."
                : "Host unreachable. Check that your VPN can reach the host and that their sharing window is open.")
            return
        }
        onStatus?("Disconnected. Reconnecting… Published notes are still available.")
        DispatchQueue.main.asyncAfter(deadline: .now() + Double(min(retries, 4))) { [weak self] in self?.start() }
    }
}
