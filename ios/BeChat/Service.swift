import Foundation
import Security
import CryptoKit

struct ServerAddress {
    static let initial = URL(string: "https://bechat.onbequick.ru")!
    static func parse(_ raw: String) -> URL? {
        let input = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var c = URLComponents(string: input), c.scheme?.lowercased() == "https",
              let host = c.host, !host.isEmpty, c.user == nil, c.password == nil,
              c.query == nil, c.fragment == nil, ["", "/"].contains(c.path) else { return nil }
        c.scheme = "https"; c.host = host.lowercased(); c.path = ""
        if c.port == 443 { c.port = nil }
        return c.url
    }
    static func sameOrigin(_ a: URL, _ b: URL) -> Bool {
        a.scheme?.lowercased() == "https" && b.scheme?.lowercased() == "https" &&
        a.host?.lowercased() == b.host?.lowercased() && (a.port ?? 443) == (b.port ?? 443)
    }
}

struct ServiceError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
    init(_ message: String) { self.message = message }
}

struct Proof {
    let verifier: String
    let challenge: String
    let nonce: String
    private static func base64(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    private static func random() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = bytes.withUnsafeMutableBytes { buf in SecRandomCopyBytes(kSecRandomDefault, buf.count, buf.baseAddress!) }
        guard status == errSecSuccess else { throw ServiceError("Не удалось начать защищённый вход.") }
        return base64(Data(bytes))
    }
    init() throws {
        let value = try Self.random()
        verifier = value
        challenge = Self.base64(Data(SHA256.hash(data: Data(value.utf8))))
        nonce = try Self.random()
    }
}

enum SessionVault {
    private static func query(_ origin: URL) -> [String: Any] {
        [kSecClass as String:kSecClassGenericPassword,
         kSecAttrService as String:"ru.onbequick.bechat.session",
         kSecAttrAccount as String:origin.absoluteString]
    }
    static func get(_ origin: URL) -> String? {
        var q = query(origin); q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess, let bytes = item as? Data else { return nil }
        return String(data: bytes, encoding: .utf8)
    }
    static func clear(_ origin: URL) { SecItemDelete(query(origin) as CFDictionary) }
    static func save(_ token: String, for origin: URL) {
        let bytes = Data(token.utf8)
        let q = query(origin)
        if SecItemUpdate(q as CFDictionary, [kSecValueData as String:bytes] as CFDictionary) == errSecItemNotFound {
            var entry = q; entry[kSecValueData as String] = bytes
            entry[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            SecItemAdd(entry as CFDictionary, nil)
        }
    }
}

final class DirectConnection: NSObject, URLSessionTaskDelegate {
    static let session = URLSession(configuration: .ephemeral, delegate: DirectConnection(), delegateQueue: nil)
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

