import Combine
import Foundation

/// 保存用户填写的 World Vinyl 服务器地址（同一 Wi-Fi 下运行 `node web/server.js` 的电脑）。
final class ServerModel: ObservableObject {
    private static let storeKey = "worldvinyl.server.address"

    @Published var address: String

    init() {
        address = UserDefaults.standard.string(forKey: Self.storeKey) ?? ""
    }

    /// 把用户输入（`192.168.1.23`、`192.168.1.23:3000`、`http://host:3000`）解析成可加载的 URL。
    var url: URL? {
        let raw = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return nil }

        let withScheme = raw.contains("://") ? raw : "http://\(raw)"
        guard var components = URLComponents(string: withScheme),
              let host = components.host,
              !host.isEmpty else {
            return nil
        }
        if components.scheme == nil { components.scheme = "http" }
        if components.port == nil { components.port = 3000 }
        return components.url
    }

    func save(_ value: String) {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        address = trimmed
        UserDefaults.standard.set(trimmed, forKey: Self.storeKey)
    }

    func clear() {
        address = ""
        UserDefaults.standard.removeObject(forKey: Self.storeKey)
    }
}
