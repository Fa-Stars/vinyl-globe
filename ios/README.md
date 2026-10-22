# World Vinyl · iOS（自用侧载版）

这是一个 **SwiftUI + WKWebView 外壳**：它不重新实现播放器，而是把你的 iPhone 连到
电脑上正在运行的 `web/server.js`，全屏显示同一个播放器界面，并把音频会话设为
`playback`，所以锁屏、切后台、静音开关打开时都能继续放。

```
iPhone (WorldVinyl.app)  ──Wi-Fi──▶  电脑  node web/server.js (0.0.0.0:3000)
```

因此：**电脑必须开着、和手机同一个 Wi-Fi**。真正的离线播放需要把 `web/server.js`
的选曲/地区解析逻辑搬到 App 内（见文末「后续」）。

---

## 1. 先在电脑上起一个手机能访问的服务

默认的 `node web/server.js` 只监听 `127.0.0.1`，手机连不上。用附带脚本启动，它会
自动切到 `0.0.0.0`、关掉「最后一个页面关闭就退出」的逻辑，并把可填进 App 的地址
打印出来：

```bat
ios\start-server.bat
```

输出类似：

```
    172.20.10.2:3000
    100.74.168.45:3000
```

- 第一次运行如果 Windows 防火墙弹窗，请勾选 **专用网络** 并允许。
- 手机和电脑连同一个路由器（不要用「访客网络」，它常隔离设备）。
- 打开手机浏览器访问上面打印的地址（例如 `http://172.20.10.2:3000`）能出现播放器，就说明网络通了。

## 2. 编出一个 `.ipa`

苹果的工具链（Xcode、`codesign`）只能在 macOS 上跑，所以这条路必须借 macOS。
两条都行，选一条：

### 路线 A：GitHub Actions（不用买 Mac）

1. 把 `ios/` 和 `.github/workflows/ios-ipa.yml` 推到仓库（默认在 `main`）。
2. 打开仓库 → **Actions** → **iOS unsigned IPA** → **Run workflow**。
3. 大约 3–6 分钟后，在该次运行的 **Artifacts** 里下载 `WorldVinyl-unsigned-ipa.zip`，
   解压得到 `WorldVinyl-unsigned.ipa`（还有 `SHA256SUMS.txt`）。

产物是 **未签名** 的 —— 这正是侧载需要的形态，签名由第 3 步在你电脑上完成。
私有仓库的 macOS 分钟数是计费的（约 10 倍系数），公开仓库免费。

### 路线 B：有 Mac / 借一台 Mac

```bash
brew install xcodegen
xcodegen generate --spec ios/project.yml --project ios
open ios/WorldVinyl.xcodeproj
```

在 Xcode 里选中 target → **Signing & Capabilities** → 勾 **Automatically manage
signing** → Team 选你的 **个人 Apple ID（Personal Team）**，连上 iPhone 直接 Run
即可。想导出 ipa：**Product → Archive → Distribute App → Development**。

> 没有付费账号时，Xcode 里首次使用个人团队需要在
> **Xcode → Settings → Accounts** 登录 Apple ID（免费即可）。

## 3. 在 Windows 上用 Sideloadly 装

1. 装 [Sideloadly](https://sideloadly.io/)；它依赖 Apple 的驱动，Windows 上先装
   Microsoft Store 的 **Apple Devices**，或 iTunes（非 Store 版）。
2. iPhone 用数据线连电脑，手机上点「信任此电脑」。
3. Sideloadly 顶部选设备，把 `WorldVinyl-unsigned.ipa` 拖进 **IPA** 框。
4. **Apple ID** 填你的 Apple ID（免费账号即可）。密码建议用
   [App 专用密码](https://appleid.apple.com)（Sideloadly 会提示）。
5. 点 **Start**。期间可能要求输入密码，耐心等它重签并安装。
6. 手机桌面出现图标后 **还打不开**，先去 **设置 → 通用 → VPN 与设备管理**，
   点你的 Apple ID → **信任**。
7. iOS 16 及以上还需要 **设置 → 隐私与安全性 → 开发者模式** → 打开 → 重启手机。

## 4. 首次打开 App

- 弹出 **本地网络** 权限时选择 **允许**（拒绝过的话去
  设置 → World Vinyl → 本地网络 里改）。
- 在 App 里填 `192.168.1.23:3000`（端口可省略，默认 3000），点「保存并连接」。
- 右下角齿轮随时可以改服务器地址（右上角那个是网页自己的 Jamendo 设置）；连不上时顶部会弹出提示和「重试」。

## 5. 免费 Apple ID 侧载的限制

| 限制 | 说明 |
| --- | --- |
| 有效期 **7 天** | 到期图标变灰打不开，用 Sideloadly 重新 Start 一次即可（数据保留）。 |
| 同时最多 3 个自签 App | 覆盖安装不算新的，但别装太多。 |
| 每 7 天最多 10 个 App ID | 频繁改 `PRODUCT_BUNDLE_IDENTIFIER` 会消耗额度。 |
| 不能上架 / 不能 TestFlight | 那是 99 美元账号的事。 |

想免掉 7 天过期：用同一套代码在 Xcode 里选个人团队 Archive 安装也一样是 7 天；
真正长期免重签要么 99 美元账号，要么走 AltStore 的自动续签（需要电脑定期在线）。

## 6. 常见问题

**「无法验证 App」/ 图标变灰**
证书 7 天到期了，或没做第 3 步的「信任」。重跑 Sideloadly。

**「连接失败 (Error -1004 / -1009)」**
手机和电脑没在同一网段；或服务仍只监听 127.0.0.1（确认用了 `start-server.bat`，
或设置了 `WORLD_VINYL_HOST=0.0.0.0`）；或防火墙拦了 node.exe。

**「系统拦截了明文 HTTP 请求」**
说明 Info.plist 里的 ATS 例外没生效 —— 重装这次构建的包，别用旧包。

**能开界面但没声音**
iOS 静音开关不影响本 App（已设 `playback` 分类），检查电脑那端是否正在播放：
这个壳只负责显示，解码仍发生在电脑的 `web/server.js` 会话里。

## 7. 后续（可选）

要做到「不连电脑、离线可用」，需要把 `web/server.js` 的选曲与地区解析搬进 App：
`web/jamendo-country.js`、`web/random-discovery.js`、`web/jamendo-metadata.js`、
`web/country-resolver.js` 都是无依赖的纯逻辑，可以在 WKWebView 里直接复用
（`new Function('module', 'exports', src)` 包裹），再用 `index.html` 里的一个
standalone 适配层顶掉 `/api/*` 请求。这一步比外壳大得多，属于单独的工程。

## 8. 工程结构

| 路径 | 作用 |
| --- | --- |
| `ios/project.yml` | XcodeGen 描述文件，信源；`.xcodeproj` 由它生成，不入库 |
| `ios/WorldVinyl/WorldVinylApp.swift` | App 入口 + 音频会话（后台播放） |
| `ios/WorldVinyl/RootView.swift` | 外壳界面、首启引导、连接失败提示 |
| `ios/WorldVinyl/WebView.swift` | WKWebView 封装与加载失败回调 |
| `ios/WorldVinyl/ServerModel.swift` | 服务器地址的解析与持久化（UserDefaults） |
| `ios/WorldVinyl/SettingsView.swift` | 地址填写界面 |
| `ios/WorldVinyl/Assets.xcassets` | App 图标（1024 单尺寸，Xcode 14+） |
| `ios/tools/make-icon.py` | 按 `build/icon.svg` 的几何重绘图标，Pillow 生成 |
| `ios/start-server.bat` | 监听 `0.0.0.0` 并打印局域网地址的启动脚本 |
| `.github/workflows/ios-ipa.yml` | macOS 上编未签名 ipa 并上传 artifact |

改图标：`python ios/tools/make-icon.py`（需要 Pillow）。
