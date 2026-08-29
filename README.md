# 🌍 世界唱片机 World Vinyl

一个把随机听歌和环游世界结合起来的浏览器唱片机。切换歌曲时，唱片封面、歌曲信息和像素雷达地球会同步更新，帮助你从音乐开始认识不同国家。

## 功能

- 随机播放不同国家的歌曲，展示艺术家、专辑和地区信息。
- 黑胶唱片按 `15 秒一圈` 旋转，中心信息区域保持稳定。
- 像素雷达地球显示海岸线、国界、经纬网、陆地纹理、明暗和扫描效果。
- 小国家使用首都信号点和信息卡展示。
- 唱片封面提前预加载，并优先使用 iTunes 高清封面。
- 支持 iTunes 试听模式和 Jamendo 全曲模式。

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

Jamendo 模式使用 MusicBrainz 的结构化数据解析艺术家国家；无法确认时显示「未知地区」。未配置 Jamendo key 时会自动回退到 iTunes 试听模式。

## 使用

| 操作 | 效果 |
| --- | --- |
| `R` | 随机切换下一首 |
| `Space` | 播放 / 暂停 |
| 点击唱片 | 播放 / 暂停 |
| `⏭` | 随机切换 |
| `http://localhost:3000/?demo=1` | 页面加载后自动播放（演示用） |

歌曲结束后会自动连播下一首。

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
node web/scripts/build-map.js     # 重新生成地图数据
node web/scripts/render-globe.js  # 渲染地球预览
```

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

- 运行时缓存会在程序退出时清理，`data/config.json` 会保留。
- Jamendo 模式下，歌曲播放结束后会删除对应的本地音频文件，歌曲池和远程 URL 元数据会保留。
- 浏览器崩溃或任务管理器强制结束进程时，无法保证立即清理缓存。
- 不配置 Jamendo key 时只能播放 iTunes 约 30 秒试听。
- 远程歌曲和封面依赖网络；在 HTTPS 部署环境中，个别 `http://` 音频链接可能被浏览器拦截。
- 艺术家国家无法确认或存在歧义时显示「未知地区」。
- Jamendo 曲库以独立音乐人为主。
