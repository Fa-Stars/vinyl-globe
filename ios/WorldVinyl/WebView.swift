import SwiftUI
import WebKit

/// 全屏 WKWebView，加载局域网上的 Web 版播放器。
struct WebView: UIViewRepresentable {
    let url: URL
    let reloadToken: Int
    @Binding var failure: String?

    func makeCoordinator() -> Coordinator {
        Coordinator(failure: $failure)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.allowsAirPlayForMediaPlayback = true

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.isOpaque = false
        webView.backgroundColor = .black
        webView.scrollView.backgroundColor = .black
        webView.scrollView.bounces = false
        webView.allowsBackForwardNavigationGestures = false
        webView.load(URLRequest(url: url))
        context.coordinator.lastLoaded = url
        context.coordinator.lastToken = reloadToken
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        if context.coordinator.lastToken != reloadToken {
            context.coordinator.lastToken = reloadToken
            context.coordinator.lastLoaded = url
            webView.load(URLRequest(url: url))
            return
        }
        if context.coordinator.lastLoaded != url {
            context.coordinator.lastLoaded = url
            webView.load(URLRequest(url: url))
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        private let failure: Binding<String?>
        var lastLoaded: URL?
        var lastToken = 0

        init(failure: Binding<String?>) {
            self.failure = failure
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            failure.wrappedValue = nil
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            failure.wrappedValue = nil
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            report(error)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            report(error)
        }

        private func report(_ error: Error) {
            let code = (error as NSError).code
            // 用户主动打断（例如切到设置）不算失败。
            if code == NSURLErrorCancelled { return }
            if code == NSURLErrorAppTransportSecurityRequiresSecureConnection {
                failure.wrappedValue = "系统拦截了明文 HTTP 请求，请重新安装这个版本。"
                return
            }
            failure.wrappedValue = "连不上电脑上的 World Vinyl 服务（\(code)）。请确认电脑开着、同一 Wi-Fi、地址端口正确。"
        }
    }
}
