# 🌍 世界唱片机 World Vinyl

一个用于个人非商业原型的随机音乐播放器。歌曲来自 Jamendo，切歌时同步更新唱片封面、歌曲信息和像素地球上的艺人地区。支持浏览器运行，也可打包成 Windows 桌面程序。

- 播放完整歌曲，显示作者、歌曲原页和 Creative Commons 许可证。
- 启动后准备第一首歌，点击播放才出声；歌曲结束后自动连播。
- 后台保留少量随机候选，目标提前缓冲 2 首，方便连续切歌。
- 歌曲信息、音频和地区查询独立进行；未知地区不会阻止播放。

## 快速开始

### Web 版

需要 Node.js ≥ 18。服务端仅使用 Node.js 内置模块，运行 Web 版无需安装 npm 依赖。

1. 在 [Jamendo 开发者后台](https://devportal.jamendo.com) 创建应用，取得自己的 `client_id`。
2. 将 [data/config.example.json](data/config.example.json) 复制为 `data/config.json`，填写凭证：

   ```json
   { "jamendoClientId": "你的 client_id" }
   ```

3. 在项目根目录启动服务：

   ```bash
   node web/server.js
   ```

4. 打开 [本地播放器](http://localhost:3000)。Windows 也可以双击 [web/start.bat](web/start.bat)。

默认监听 `127.0.0.1:3000`。缺少凭证时显示配置提示，不会改用其他曲源。

| 环境变量 | 用途 |
| --- | --- |
| `JAMENDO_CLIENT_ID` | 替代配置文件中的凭证，优先于文件配置 |
| `PORT` / `WORLD_VINYL_PORT` | 修改端口；`PORT` 优先 |
| `WORLD_VINYL_HOST` | 修改监听地址，默认仅允许本机访问 |
| `WORLD_VINYL_DATA_DIR` | 指定可写数据目录，默认使用项目的 `data/` |

例如修改端口：

```bash
# macOS / Linux
PORT=3001 node web/server.js
```

```powershell
# Windows PowerShell
$env:PORT = 3001
node web/server.js
```

按 `Ctrl+C` 停止服务。默认的 Web 页面会话管理也会在最后一个已连接页面关闭后退出并清理缓存；首次打开页面之前服务会持续等待。

### Desktop 版

开发运行前安装锁定的依赖：

```bash
npm ci
npm start
```

Windows 也可以双击 [desktop/start.bat](desktop/start.bat)。程序自动选择空闲端口，启动内置后端并打开 Electron 窗口。

首次运行请在窗口顶部的「Jamendo 设置」填写凭证，保存后程序会重启内置服务。桌面版把配置和缓存放在 Electron 用户数据目录下的 `data/`，**不读取 Web 版的配置文件，也不继承外部 `JAMENDO_CLIENT_ID`**。

构建 Windows 应用：

```bash
npm run pack   # 生成目录版，Windows 下通常为 desktop/release/win-unpacked/
npm run dist   # 生成 Windows x64 的 NSIS 安装版和 Portable 免安装版
```

产物位于 `desktop/release/`，打包后的程序自带运行环境，无需用户另装 Node.js。目录版必须保留整个输出目录，不能只复制其中的 exe。

安装版和免安装版可在 [GitHub Releases](https://github.com/Fa-Stars/vinyl-globe/releases) 下载；每次发布会注明版本和构建来源。`main` 可能包含发布后的更新，需要尚未发布的功能时可从当前源码构建。

## 操作

| 操作 | 效果 |
| --- | --- |
| 点击播放按钮或唱片 | 播放 / 暂停 |
| 点击 `⏭` | 随机下一首 |
| `Space` | 播放 / 暂停 |
| `R` | 随机下一首 |
| 访问 `/?demo=1` | 尝试自动播放；仍受浏览器自动播放策略限制 |

快捷键会避开输入框、按钮和设置对话框。若 `R` 没有响应，先点击页面空白处。长时间播放不推进时会尝试换歌，连续失败 8 次后停止自动重试；可点击播放主动重试。手动暂停后不会自行恢复。

## 随机选歌、地区与缓存

- 在 Jamendo 在线曲库的歌曲编号范围内随机抽取，跳过空缺编号、无音频和许可信息不完整的曲目。最多保留 6 首候选，最近 1000 首避免重复；不按热度或地区选歌，也不保证各国家等概率。
- 音频预取目标为 **2 首**，同时只下载 **1 首**。完整缓存最多 3 首，单首上限 16 MiB，总预算 48 MiB（含临时文件），有效期 15 分钟。超出单首上限仍可在线流式播放。
- 切走或播放结束后释放该首音频；歌曲池与远程 URL 仅在当前进程内存中。启动时清理遗留音频和旧歌单，正常退出还会清理地区等运行缓存；强制结束进程可能留有临时文件，下次启动会清理。
- 个人配置与 `catalog-bounds.json` 会保留。后者只含数字编号边界和查询时间，不含歌单或音频。编号边界缓存 6 小时后后台更新，超过 30 天需重新初始化；首次运行可能因边界查询而等待更久。
- 地区表示艺人的来源地或公开声明的活动地区，不等同于国籍，也不按语言或姓名推断。查询顺序为核实资料、Jamendo 艺人资料、MusicBrainz；无法确认时显示「未知地区」。
- 地区证据及身份范围保存在 [verified-artist-countries.json](web/verified-artist-countries.json) 和 [jamendo-country-seed.json](web/jamendo-country-seed.json)，运行清理不会删除它们。维护资料时应保留来源链接、核实时间、艺人编号和歌曲编号，避免混淆同名艺人。

歌曲、封面和地区查询依赖网络，缓存不提供离线曲库功能。歌曲元数据返回不代表已经出声，启动速度还受音源与网络影响。

## 音乐使用范围

本项目仅作为个人非商业联网听歌和原型测试使用，不提供商业曲库授权，也不证明每首歌的全部权利已经核实。使用须遵守 [Jamendo API 条款](https://devportal.jamendo.com/api_terms_of_use) 和每首歌自己的 [Creative Commons 许可证](https://creativecommons.org/faq/)。

- 播放器保留作者、歌曲原页和具体许可链接；目前只接受可识别的 CC BY 系列标准非地区版许可。识别许可格式不等于确认权利归属。
- 保留歌曲要求的署名。NC、ND 等条件需按具体用途判断，不能把原样播放的使用范围直接延伸到改编、分发或商业宣传。
- 临时缓冲仅为播放服务，不提供下载或离线访问。缓存数量和时长是本项目的工程限制，不是平台授予的许可配额。
- 分享仓库、安装包或设备镜像时，不附带抓取的歌曲、封面或个人凭证；协作者使用自己的 `client_id`。
- 公开演示视频、直播、展览或销售实体设备前，另行确认平台及作品、录音、封面的适用授权。演示音轨可使用自制或明确覆盖该用途的素材。

## 开发与验证

后端为原生 Node.js，前端为 HTML/CSS/JavaScript 与 Canvas，桌面外壳使用 Electron。

| 修改内容 | 主要文件 |
| --- | --- |
| 页面与唱片外观 | `web/public/index.html`、`web/public/style.css` |
| 播放交互、地球渲染 | `web/public/app.js` |
| API、音频转发与缓存 | `web/server.js`、`runtime-cache.js` |
| 随机发现与许可信息解析 | `web/random-discovery.js`、`web/jamendo-metadata.js` |
| 艺人地区解析 | `web/jamendo-country.js`、`web/country-resolver.js` |
| 桌面启动与设置 | `desktop/electron/main.js`、`desktop/electron/preload.js` |
| 地图与首都坐标 | `web/public/map.json`、`web/public/capitals.json` |

```bash
npm test                                      # 回归测试，使用临时目录与模拟曲源
node web/scripts/build-map.js                  # 重新生成地图数据
node web/scripts/render-globe.js               # 渲染地球预览至 data/globe-*.png
node web/scripts/measure-startup.cjs            # 用真实凭证和隔离缓存测量冷启动
node web/scripts/measure-startup.cjs --reuse-bounds  # 仅复用已有数字编号边界
```

修改地球渲染逻辑时，同步检查预览脚本。测试覆盖播放恢复、快速切歌、音频 Range、缓存限制、授权信息和桌面启动；模拟长时间播放不替代真实网络、系统音频输出和实体硬件验收。

`web/scripts/research-countries.cjs` 用于维护地区资料，会访问在线接口并写入地区种子文件。`data/research-catalog.json` 是该脚本使用的元数据样本，不是运行时播放曲库。

### Web API

| 端点 | 说明 |
| --- | --- |
| `GET /api/song` | 随机歌曲；缺凭证返回 503 / `JAMENDO_SETUP_REQUIRED`；不支持 `country` 筛选 |
| `GET /api/country?id=...` | 查询艺人地区与来源信息 |
| `GET /api/info` | 当前模式和缓存统计 |
| `GET /api/countries` | 兼容旧客户端，返回空列表 |
| `GET /audio/{id}` | 本地缓存或在线音频流，支持 Range |
| `POST /api/audio/played?id=...` | 播放结束或切走后释放音频缓存 |
| `POST /api/client-session` | Web 页面会话心跳，用于退出与清理 |

仓库不包含个人凭证、抓取音频、运行缓存、`node_modules/` 或打包产物。提交前检查 `.gitignore`；打包文件清单由 `package.json` 管理，排除个人配置和音频文件。
