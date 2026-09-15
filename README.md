# 🌍 世界唱片机 World Vinyl

一个把随机听歌和环游世界结合起来的浏览器唱片机。切换歌曲时，唱片封面、歌曲信息和像素雷达地球会同步更新，帮助你从音乐开始认识不同国家。

## 功能

- 随机播放不同国家的歌曲，展示艺术家、专辑和地区信息。
- 黑胶唱片按 `15 秒一圈` 旋转，中心信息区域保持稳定。
- 像素雷达地球显示海岸线、国界、经纬网、陆地纹理、明暗和扫描效果。
- 小国家使用首都信号点和信息卡展示。
- 唱片封面提前预加载，并优先使用 iTunes 高清封面。
- 支持 iTunes 试听模式和 Jamendo 全曲模式。
- 打开页面即准备第一首歌曲（默认不自动播放），清晰显示播放模式、进度和网络状态。
- 针对 1280×800 桌面屏和移动窄屏做了布局适配，支持减少动态效果偏好与键盘焦点提示。

## 运行

项目提供两种运行模式：

- **Web 版**：启动 Node.js 本地服务，用浏览器访问，适合开发和直接体验。
- **Desktop 版**：使用 Electron 启动内置窗口和本地服务，适合打包为 Windows 应用。

### Web 版（浏览器运行）

要求：Node.js ≥ 18。Web 版服务端只使用 Node.js 内置模块，不需要先执行 `npm install`。

#### 命令行启动

```bash
cd vinyl-globe
node web/server.js
```

服务默认监听 `127.0.0.1:3000`，启动后打开：

http://localhost:3000

如果 3000 端口已被占用，可以修改端口：

```bash
# macOS / Linux
PORT=3001 node web/server.js

# Windows PowerShell
$env:PORT = 3001
node web/server.js
```

也可以使用 `WORLD_VINYL_PORT` 环境变量。服务默认绑定 `127.0.0.1`，可通过 `WORLD_VINYL_HOST` 修改。

#### Windows 一键启动

在项目根目录双击 [`web/start.bat`](web/start.bat)。启动后用浏览器打开 `http://localhost:3000`。

按 `Ctrl+C` 或关闭启动脚本窗口即可停止服务；程序会尝试清理运行缓存。通过 `web/start.bat` 启动时，关闭最后一个浏览器页面也会触发退出清理。

### Desktop 版（Electron）

开发运行前安装 Electron 依赖：

```bash
npm install
npm start
```

也可以双击 [`desktop/start.bat`](desktop/start.bat) 启动开发版。

生成 Windows 安装版和免安装版：

```bash
npm run dist
```

产物位于 `desktop/release/`。打包后的程序会自动运行本地服务并打开内置窗口，不需要另外安装 Node.js 或手动打开浏览器。

## 歌曲来源与配置

默认使用 iTunes 榜单，提供约 30 秒试听，不需要 API key。

要播放 Jamendo 完整歌曲：

1. 在 [Jamendo 开发者后台](https://devportal.jamendo.com) 注册并创建应用，复制 `client_id`。
2. 将 `data/config.example.json` 复制为 `data/config.json`，填写：

   ```json
   {
     "jamendoClientId": "你的 client_id"
   }
   ```

3. 重启服务。也可以使用环境变量：

   ```bash
   JAMENDO_CLIENT_ID=你的_client_id node web/server.js
   ```

   Windows PowerShell：

   ```powershell
   $env:JAMENDO_CLIENT_ID = "你的_client_id"
   node web/server.js
   ```

Desktop 版也可以在窗口顶部的「Jamendo 设置」中填写 `client_id`，保存后重启服务。凭证不会打包进安装程序；不要把 `data/config.json` 或个人凭证提交到 Git。

Jamendo 模式会在音频预缓存的同时查询 MusicBrainz：优先使用艺术家的国家/来源地，必要时沿城市或地区的父级关系查到国家，并缓存结果。当前歌曲会优先解析，界面会区分「正在解析」和「暂无可信资料」；无法确认时显示「未知地区」。未配置 Jamendo key 时会自动回退到 iTunes 试听模式。

## 使用

| 操作 | 效果 |
| --- | --- |
| `R` | 随机切换下一首 |
| `Space` | 播放 / 暂停 |
| 点击唱片 | 播放 / 暂停 |
| `⏭` | 随机切换 |
| `http://localhost:3000/?demo=1` | 页面加载后自动播放（演示用；默认打开只准备歌曲） |

歌曲结束后会自动连播下一首。

播放长时间不推进时会尝试换歌，连续失败 8 次后停止自动重试；点击播放或按 `R` 可主动重试。切歌请求最长等待 45 秒，以覆盖首次编号范围初始化；正常切歌不再等待整首音频下载或地区解析。快速切歌或暂停会取消过期请求和恢复任务。浏览器检测到离线且播放失败时，会等待网络恢复后继续；手动暂停后不会自动恢复。

Jamendo 持续补充少量随机待播候选，联网失败时保留已有候选；每 12 小时也会检查补充。iTunes 每 12 小时按国家更新榜单，失败的国家继续使用旧榜单。

切换到新歌曲后会释放上一首的音频缓存并取消尚未完成的预下载，及时腾出下载名额。暂停或尚未取得替代歌曲时保留当前缓存；在等待随机发现期间取消的切歌请求不会取走待播候选。

像素地球最多每秒绘制 30 帧，旋转和缩放按经过的时间更新，在 60Hz 和高刷新率屏幕上保持相同速度；页面隐藏时跳过绘制，长时间停顿后限制单次运动幅度。

## API

Web 服务提供以下接口：

| 端点 | 说明 |
| --- | --- |
| `GET /api/song` | 随机返回一首歌 |
| `GET /api/song?country=JP` | 按国家返回歌曲，仅 iTunes 模式可用 |
| `GET /api/country?id=...` | 查询歌曲艺术家的国家并缓存结果 |
| `GET /api/info` | 查看当前模式和缓存统计 |
| `GET /api/countries` | 查看已缓存国家列表，仅 iTunes 模式有数据 |

## 开发工具

```bash
npm test                         # 运行回归测试；不需要第三方测试依赖
node web/scripts/build-map.js     # 重新生成地图数据
node web/scripts/render-globe.js  # 渲染地球预览
```

稳定性测试覆盖播放重试与暂停、快速切歌、音频 Range 和流中断、两种曲源的刷新保护，以及使用加速时钟模拟的 8 小时连播。新测试使用临时目录和本地模拟曲源，不读取个人凭证；加速测试不替代真实网络和目标硬件上的长时间播放验证。

## 目录结构

```
vinyl-globe/
├── web/
│   ├── server.js          # Web 版后端、API 和静态服务
│   ├── start.bat          # Web 版 Windows 启动脚本
│   ├── public/            # 前端页面、样式、脚本和地图数据
│   └── scripts/           # 地图生成和预览工具
├── desktop/
│   ├── electron/          # Electron 主进程
│   ├── start.bat          # Desktop 版开发启动脚本
│   └── release/           # 打包产物
├── data/
│   ├── config.example.json
│   ├── songs/             # iTunes 缓存
│   ├── jamendo/           # Jamendo 歌曲池缓存
│   ├── audio/             # 音频缓存
│   └── artist-countries.json
├── package.json
├── runtime-cache.js       # 两种运行模式共用的缓存清理逻辑
└── test/                  # 自动化测试
```

## 缓存与限制

- 运行时歌曲、音频和地区缓存会在程序退出时清理。`data/config.json` 与 `data/catalog-bounds.json` 会保留；后者仅保存最大歌曲编号与查询时间，不保存歌单或音频。
- Jamendo 模式下，歌曲播放结束后会删除对应的本地音频文件，歌曲池和远程 URL 元数据会保留。
- 浏览器崩溃或任务管理器强制结束进程时，无法保证立即清理缓存。
- 不配置 Jamendo key 时只能播放 iTunes 约 30 秒试听。
- 远程歌曲和封面依赖网络；在 HTTPS 部署环境中，个别 `http://` 音频链接可能被浏览器拦截。
- 艺术家国家无法确认或存在歧义时显示「未知地区」；这不是歌曲加载失败，而是资料源没有足够可信的国家信息。
- Jamendo 曲库以独立音乐人为主。

## 地区资料补充

歌曲地区按艺人的来源地或其公开声明的活动地区显示，不根据语言推断国籍。
程序优先使用附证据链接的核实资料，再使用 Jamendo 艺人地区接口，最后由 MusicBrainz 补充。
随程序附带的地区资料保存在 `web/verified-artist-countries.json` 和
`web/jamendo-country-seed.json`，退出清理播放缓存不会删除它们。
新歌曲保留 Jamendo 艺人编号以区分同名艺人；查不到的结果一天后可重试，临时网络失败不记作“无地区”。
`/api/country?id=歌曲编号` 会同时返回地区及来源链接。核实过程见 `COUNTRY_RESEARCH.md`。

## 持续随机发现

Jamendo 模式先从在线接口确认最大歌曲编号，在整个编号范围内均匀抽取编号，并使用[官方歌曲接口](https://developer.jamendo.com/v3.0/tracks)批量精确查询（包含单曲与专辑曲目）。空缺编号会重新抽取，不替换为附近歌曲，也不按接口返回的热度顺序选歌。最多保留 6 首待播候选，预加载其中 4 首；播放后移出候选并继续联网补充。当前会话最近 1000 首避免重复。地区资料是否完整不影响选歌。

歌曲一旦查到就进入候选，后续补充在后台继续；不再执行耗时的深分页。编号范围缓存 6 小时后后台更新，超过 30 天的缓存必须重新初始化；首次安装或删除该文件时仍可能等待较慢的边界查询，更新完成前的新上传歌曲会在下次范围更新后进入抽样范围。

歌手地区按艺人编号合并查询，40 毫秒内到达的候选共用请求；缺失资料直接转交 MusicBrainz，保留其每秒一次的限速，不重复查询已确认的空结果。歌曲信息立即返回，地区独立更新；音频未缓存时流式播放，并取消同一首的重复预下载。随机范围是 Jamendo 当前可提供的歌曲，不代表全球所有平台的全部音乐，也不是各国家等概率。

性能测量方法及本次结果见 [PERFORMANCE.md](PERFORMANCE.md)。
