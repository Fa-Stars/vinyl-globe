import SwiftUI

struct RootView: View {
    @EnvironmentObject private var server: ServerModel
    @State private var showSettings = false
    @State private var failure: String?
    @State private var reloadToken = 0

    var body: some View {
        ZStack(alignment: .top) {
            Color.black.ignoresSafeArea()

            if let url = server.url {
                WebView(url: url, reloadToken: reloadToken, failure: $failure)
                    .ignoresSafeArea()
            } else {
                OnboardingView { showSettings = true }
            }

            // 网页自己的「设置」按钮在右上角，所以服务器地址入口放在右下角，避免叠在一起。
            if server.url != nil {
                VStack {
                    Spacer()
                    HStack {
                        Spacer()
                        Button {
                            showSettings = true
                        } label: {
                            Image(systemName: "gearshape.fill")
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(.white.opacity(0.85))
                                .padding(10)
                                .background(.ultraThinMaterial, in: Circle())
                        }
                        .opacity(0.7)
                    }
                }
                .padding(.trailing, 12)
                .padding(.bottom, 10)
            }

            if let failure {
                FailureBanner(message: failure) {
                    reloadToken += 1
                } onSettings: {
                    showSettings = true
                }
                .padding(.horizontal, 14)
                .padding(.top, 52)
                .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.easeInOut(duration: 0.2), value: failure)
        .sheet(isPresented: $showSettings) {
            SettingsView()
                .environmentObject(server)
        }
        .onChange(of: server.address) { _ in
            failure = nil
            reloadToken += 1
        }
    }
}

private struct OnboardingView: View {
    let openSettings: () -> Void

    var body: some View {
        VStack(spacing: 18) {
            Image(systemName: "opticaldisc.fill")
                .font(.system(size: 64, weight: .thin))
                .foregroundStyle(.white.opacity(0.9))

            Text("World Vinyl")
                .font(.system(size: 26, weight: .semibold, design: .rounded))
                .foregroundStyle(.white)

            Text(
                """
                这个版本是播放器的手机遥控外壳：歌曲、封面的解析仍然跑在电脑上。

                1. 在电脑上运行 ios/start-server.bat
                2. 确认手机和电脑连同一个 Wi-Fi
                3. 填它打印出来的地址，例如 192.168.1.23:3000
                """
            )
            .font(.system(size: 14))
            .foregroundStyle(.white.opacity(0.66))
            .multilineTextAlignment(.center)
            .lineSpacing(4)
            .padding(.horizontal, 8)

            Button(action: openSettings) {
                Text("填写服务器地址")
                    .font(.system(size: 16, weight: .semibold))
                    .padding(.horizontal, 26)
                    .padding(.vertical, 12)
                    .background(Color.white.opacity(0.14), in: Capsule())
                    .foregroundStyle(.white)
            }
            .padding(.top, 6)
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct FailureBanner: View {
    let message: String
    let onRetry: () -> Void
    let onSettings: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(message)
                .font(.system(size: 13))
                .foregroundStyle(.white.opacity(0.9))
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 14) {
                Button("重试", action: onRetry)
                Button("服务器地址", action: onSettings)
            }
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(.white)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}
