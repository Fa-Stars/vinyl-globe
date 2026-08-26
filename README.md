# 🌍 世界唱片机 World Vinyl

一个把“随机听歌”和“环游世界”结合起来的浏览器唱片机。每次切换歌曲时，唱片封面、歌曲信息和像素雷达地球会同步更新，帮助你从音乐开始认识不同国家。

> 实体化目标与原型规格见 [PRODUCT_BRIEF.md](PRODUCT_BRIEF.md)。

## 功能亮点

- 随机播放来自不同国家的歌曲，并显示艺术家、专辑和地区信息。
- 黑胶唱片使用整张歌曲海报作为外围图像，唱片按 **15 秒一圈**旋转，中心信息区域保持稳定。
- 唱片封面会提前预加载；iTunes 封面优先使用高清版本，失败时自动回退到原图。
- 像素雷达地球包含海岸线、国界、经纬网、陆地纹理、球体明暗和雷达扫描效果。
- 小国家不会被放大成零散像素点，而是通过首都信号点和信息卡清晰展示。
- 切换国家使用平滑过渡，不再出现突然闪光。
- 项目显示规则会将 `TW` 与 `CN` 统一归入“中国”区域显示；底层地图网格编码仍保留原始数据。

## 运行

要求：Node.js ≥ 18（无任何第三方依赖）。

```bash
cd vinyl-globe
node web/server.js
```

打开 http://localhost:3000

也可以在 Windows 下双击 `web/start.bat` 启动。

### Electron 桌面程序

项目现在也支持打包为 Windows 桌面程序。开发运行前先安装 Electron 依赖：

```bash
npm install
npm start
```

生成安装版和免安装版 `.exe`：

```bash
npm run dist
```

产物会出现在 `desktop/release/`。桌面程序启动时会自动运行本地服务并打开内置窗口，
不需要用户另外安装 Node.js 或手动打开浏览器。也可以双击 `desktop/start.bat` 运行开发版。

#### 在程序内填写 Jamendo client_id

打开窗口顶部的「Jamendo 设置」，输入从 Jamendo 开发者后台获取的 `client_id`，
点击「保存并重启服务」即可切换到完整歌曲模式；清空后保存则恢复 iTunes 30 秒试听模式。

凭证和运行缓存保存在 Windows 用户数据目录下，不会打包进 exe，也不会写入安装目录。
公开发布安装包时仍建议不要把个人凭证预先放进用户数据目录或环境变量中。

> 未配置 Jamendo key 时，后台会自动抓取各国家的 iTunes 歌曲（约 1~2 分钟跑完全部国家，
> 期间页面立即可用：先随机到已就绪的国家）。Jamendo 模式则从全局歌曲池加载并随机选曲。
> 运行缓存每 12 小时自动刷新，重启时会从磁盘快速恢复。

### 播放完整歌曲（推荐，Jamendo）

默认数据源是 iTunes 榜单（**30 秒试听**）。要播放**完整歌曲**，配置免费的 Jamendo API key：

1. 打开 https://devportal.jamendo.com 免费注册，登录后创建应用，复制 `client_id`
2. 将 `data/config.example.json` 复制为 `data/config.json`，再把 key 填入 `jamendoClientId` 字段（或设置环境变量 `JAMENDO_CLIENT_ID`）
3. 重启 `node web/server.js`，即自动切换为 **Jamendo 全曲模式**

Jamendo 是正版免费（Creative Commons）音乐平台，返回**完整 mp3**，
歌曲从全局热门池随机选择；服务器会尽力解析艺术家所属国家来驱动像素地球高亮，无法确认时保持未知。
未配置 key 时自动回退到 iTunes 试听模式。

## 使用

| 操作 | 效果 |
| --- | --- |
| `R` | 随机切换到下一首（来自随机国家） |
| `Space` | 播放 / 暂停 |
| 点击唱片 | 播放 / 暂停 |
| `⏭` 按钮 | 随机切换 |
| 打开 `http://localhost:3000/?demo=1` | 页面加载后自动开始播放（演示用） |

歌曲结束后会自动连播下一首；也可以随时按 `R` 手动切换。

## 工作原理

```
┌──────────────────────┐   全局歌曲池 + 磁盘缓存 + 后台预取   ┌───────────────────────┐
│ Jamendo API（全曲）  │ ─────────────────────────────────▶ │ data/jamendo/pool.json│
│ 或 iTunes RSS（试听）│      每 12 小时刷新                  │  ~840 首完整歌曲 / 池  │
└──────────────────────┘                                     └───────────┬───────────┘
                                                                        ▼
                                                       ┌────────────────────────────┐
                                                       │ GET /api/song               │
                                                       │ 从歌曲池随机选一首（秒回）   │
                                                       └────────────────────────────┘
```

- **数据源双模式**（`web/server.js` 按 `JAMENDO_CLIENT_ID` 是否配置自动切换）：
  - **Jamendo（全曲）**：`https://api.jamendo.com/v3.0/tracks/?client_id=…&order=popularity_total&audioformat=mp32`
    按热度分页拉取**全局歌曲池**（约 840 首完整 mp3，CORS 开放可直接网页播放），随机选曲。
  - **iTunes（试听兜底）**：`https://itunes.apple.com/{国家码}/rss/topsongs/limit=100/json`，
    按国家组织、30 秒试听，像素地球可高亮国家（代价是无全曲）。
- **艺术家国籍解析**（Jamendo 模式让地球亮起来）：Jamendo API 本身不提供国家字段，
  服务器只采信 **MusicBrainz** 的结构化元数据（取 `area`/`country` ISO 码，限速 1 请求/秒），
  并要求艺术家名称唯一精确匹配；无法确认时返回「未知地区」，不使用搜索摘要猜测国家。
  结果缓存到 `data/artist-countries.json`（30 天有效）；
  后台自动回填全部艺术家，播放中歌曲通过 `GET /api/country?id=` 即时解析并点亮地球。
- **容错**：区分「永久无效」（HTTP 400 / Jamendo API 报错）与「瞬时失败」（网络/超时，自动重试一次、
  不误标记）；榜单只有一首歌时 Apple 返回单个对象而非数组，已做归一化处理。
- **提速**：歌曲池常驻内存/磁盘，热请求毫秒级返回；服务器维护一个小型预取流水线，
  并优先返回已经缓存的歌曲，减少切换时的等待。
- **像素雷达地球**（`web/public/map.json` + `web/public/capitals.json`）：由 Natural Earth 110m 国界数据栅格化成
  144×72 的国家编码网格（每格约 2.5°×2.5°），浏览器端用 Canvas 绘制深色球体、海岸线、低对比度国界、
  经纬网、陆地纹理、扫描线和雷达扫掠。播放到某国时，地球会平滑定位，高亮该国并显示信号卡片；
  小国家使用首都信号点，不再依赖放大成一大片像素。空闲时地球缓慢自转。
- **唱片视觉**：歌曲海报铺满唱片外围区域，并叠加细微沟槽纹理和高光；外围图像每 15 秒旋转一圈，
  中心圆形信息区域保持稳定。下一首歌曲的封面会提前预加载，并优先尝试 iTunes 高清封面。
- 重新生成地图：`node web/scripts/build-map.js`；渲染预览：`node web/scripts/render-globe.js`。

## API

| 端点 | 说明 |
| --- | --- |
| `GET /api/song` | 随机返回一首歌 `{title, artist, album, streamUrl, artwork, duration, countrycode, country}` |
| `GET /api/song?country=JP` | 指定国家返回一首歌（仅 iTunes 模式可用） |
| `GET /api/country?id=…` | 解析/返回某首歌艺术家的国籍（MusicBrainz，结果缓存 30 天） |
| `GET /api/info` | 模式与缓存统计（`mode: jamendo/itunes`、歌曲数） |
| `GET /api/countries` | 已缓存国家列表（仅 iTunes 模式有数据） |

## 缓存生命周期

程序退出时会清理歌曲、音频、Jamendo/iTunes 歌曲池、艺术家国家信息和地球图片等运行时缓存；Electron 在关闭窗口和最终退出阶段都会执行一次幂等清理；`data/config.json` 会保留，因此已输入的 Jamendo `client_id` 不会丢失。直接运行 `web/start.bat` 后按 Ctrl+C、Ctrl+Break 或直接关闭控制台窗口，也支持该清理逻辑。

Jamendo 模式下，歌曲播放结束后也会立即删除该歌曲的本地音频文件和下载临时文件；歌曲池及远程 URL 元数据会保留，以便后续需要时重新下载。

> 通过 `web/start.bat` 启动时，关闭最后一个浏览器页面会通知 Node 服务退出并清理缓存；关闭启动脚本的控制台窗口、按 Ctrl+C 或 Ctrl+Break 也会触发清理。浏览器崩溃或任务管理器强制结束属于不可捕获的终止方式，无法保证立即执行清理（心跳失联时最多等待约 45 秒）。

## 目录结构

```
vinyl-globe/
├── web/
│   ├── server.js        # 网页版后端：歌曲爬取 + API + 静态服务
│   ├── start.bat        # 网页版启动脚本
│   ├── public/          # 网页版前端
│   │   ├── index.html   # 唱片机页面
│   │   ├── style.css    # 唱片机 / 像素地球样式
│   │   ├── app.js       # 前端逻辑（R 键切换、音频、地球渲染）
│   │   ├── map.json     # 144×72 国家编码栅格（像素地球数据）
│   │   └── capitals.json # 国家首都坐标
│   └── scripts/         # 网页版地图生成和预览工具
├── desktop/
│   ├── electron/        # Electron 主进程和退出清理逻辑
│   ├── start.bat        # 桌面版开发启动脚本
│   └── release/         # EXE 与 ZIP 安装包
├── package.json         # Electron 开发/打包配置
├── package-lock.json
├── runtime-cache.js     # 两种启动方式共用的退出清理逻辑
└── data/
    ├── config.example.json # Jamendo 配置模板
    ├── songs/              # iTunes 试听缓存
    ├── jamendo/            # Jamendo 全曲缓存
    ├── audio/              # 可选的本地音频缓存
    └── artist-countries.json # 艺术家国籍缓存
```

## 上传到 GitHub

如果远程仓库还没有绑定，可以执行：

```bash
git init
git add .
git commit -m "chore: initial commit"
git branch -M main
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

如果项目已经有远程仓库，日常更新通常只需要：

```bash
git add .
git commit -m "docs: update README"
git push origin main
```

推送前可以检查：

```bash
git status
git remote -v
```

如果 GitHub 仓库比本地多了提交，先同步再推送：

```bash
git pull --rebase origin main
git push origin main
```

## 已知限制

- **试听 vs 全曲**：不配置 Jamendo key 时只能播 iTunes 的约 30 秒试听；配置 key 后才可使用 Jamendo 全曲模式。
- **国家解析**：艺术家国籍通过 MusicBrainz 结构化数据解析，查不到或名称有歧义的艺术家显示「未知地区」且地球不高亮；
  结果会缓存到本地。
- **封面加载**：远程封面依赖网络；高清封面不可用时会自动使用原始 URL 或默认样式回退。
- 若部署到 HTTPS 环境，个别 `http://` 音频链接会被浏览器拦截；本地 `http://localhost` 无此问题。
- Jamendo 曲库以独立音乐人为主（非主流榜单金曲），胜在正版全曲播放。
