import CryptoKit
import Foundation

/// After exchanging fresh public salts, each direction uses a separate AES-GCM
/// key. Ordered, implicit nonces make dropped, replayed, and reordered frames fail.
struct BrowserShareCipher {
    static let saltSize = 32
    private let sendKey: SymmetricKey
    private let receiveKey: SymmetricKey
    private var sendCounter: UInt64 = 0
    private var receiveCounter: UInt64 = 0

    init(key: SymmetricKey, serverSalt: Data, clientSalt: Data) {
        let salt = serverSalt + clientSalt
        let label = "debate-room-browser-v1/"
        sendKey = HKDF<SHA256>.deriveKey(inputKeyMaterial: key, salt: salt,
            info: Data((label + "host").utf8), outputByteCount: 32)
        receiveKey = HKDF<SHA256>.deriveKey(inputKeyMaterial: key, salt: salt,
            info: Data((label + "guest").utf8), outputByteCount: 32)
    }

    private func nonce(_ counter: UInt64) throws -> AES.GCM.Nonce {
        var counter = counter.bigEndian
        let bytes = withUnsafeBytes(of: &counter) { Data($0) }
        return try AES.GCM.Nonce(data: Data(repeating: 0, count: 4) + bytes)
    }

    mutating func seal(_ data: Data) throws -> Data {
        let box = try AES.GCM.seal(data, using: sendKey, nonce: nonce(sendCounter))
        sendCounter += 1
        return box.ciphertext + box.tag
    }

    mutating func open(_ data: Data) throws -> Data {
        let box = try AES.GCM.SealedBox(nonce: nonce(receiveCounter),
                                        ciphertext: data.dropLast(16), tag: data.suffix(16))
        let plaintext = try AES.GCM.open(box, using: receiveKey)
        receiveCounter += 1
        return plaintext
    }

    static func randomSalt() -> Data {
        SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
    }
}
