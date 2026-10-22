import AVFoundation
import SwiftUI
import UIKit

@main
struct WorldVinylApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var server = ServerModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(server)
                .preferredColorScheme(.dark)
        }
    }
}

/// 只做一件事：把音频会话设成 playback，这样 WKWebView 里的音乐在锁屏、切后台、
/// 静音开关打开时都能继续播放。
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .default, options: [])
            try session.setActive(true)
        } catch {
            // 失败不致命：只是回到默认的（可能被静音开关打断的）播放行为。
        }
        return true
    }
}
