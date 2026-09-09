# 世界唱片机 · 开发者指南

本项目是一个「唱片机造型的网页」：随机播放来自世界各地的完整歌曲，旁边有一个
**像素地球**（星露谷梦幻风格），随机到某国时地球转到该国居中、按领土大小缩放、
国家闪烁高亮，并在**首都位置**插一杆弹跳的像素旗。

- 后端：Node.js（**零第三方依赖**，仅用内置 `http/fs/path` 与全局 `fetch`）
- 前端：原生 HTML/CSS/JS，Canvas 渲染像素地球（无框架）
- 要求：Node.js ≥ 18

## 运行

```bash
node web/server.js     # 或 Windows 下双击 web/start.bat
# 打开 http://localhost:3000
```

- 端口：`PORT` 环境变量（默认 3000）
- 播放完整歌曲需要 Jamendo key：在 `data/config.json` 的 `jamendoClientId` 填入
  （当前项目已填好）。未配置则自动回退 iTunes 30 秒试听模式。

## 文件地图（改哪里看这里）

| 想改什么 | 文件 | 关键位置 |
| --- | --- | --- |
| **地球配色**（星露谷风格） | `web/public/app.js` | `PAL` 常量（天空/海/陆地/高亮/旗子颜色） |
| **地球分辨率/画布大小** | `web/public/app.js` | `GW/GH/GCX/GCY/GR` 常量 |
| **缩放逻辑**（国家占画面比例） | `web/public/app.js` | `ZOOM_FILL`、`ZOOM_MAX`、`countryZoom()` |
| **旋转速度/缓动** | `web/public/app.js` | `updateGlobe()`（0.05 / 0.03 系数） |
| **旋转到国家（俯仰/偏航）** | `web/public/app.js` | `setCountry()`、`countryScreenPos()` |
| **首都像素旗标记样式** | `web/public/app.js` | `drawGlobe()` 末尾的旗子绘制段 |
| **背景**（渐变天空/柔光/星星） | `web/public/app.js` | `buildBackdrop()` |
| **高亮闪烁颜色/频率** | `web/public/app.js` | `PAL.hiA/hiB`、`drawGlobe()` 的 `pulse` |
| **球体渲染算法**（投影/明暗） | `web/public/app.js` | `drawGlobe()` 主体循环 |
| **页面布局/唱片机造型** | `web/public/index.html` + `web/public/style.css` | 全部 |
| **地球卡片边框/标题条** | `web/public/style.css` | `.globe-card`、`#globe` |
| **地图数据**（144×72 国家网格） | `web/scripts/build-map.js` | 重跑生成 `web/public/map.json` |
| **首都坐标数据** | `web/public/capitals.json` | 国家码 → [纬度, 经度] |
| **后端 API / 歌曲池 / 音频缓存 / 国家解析** | `web/server.js` | 见下方说明 |

## 像素地球渲染管线（`web/public/app.js`）

1. **数据**：`map.json`（144×72 网格，每格 2 字符国家码，`..` 为海）
   + `capitals.json`（首都坐标）
2. **预计算**（`buildGlobeData()`）：陆地描边数组 + 每国质心（经度用环形平均，防跨 ±180° 出错）
3. **静态背景**（`buildBackdrop()`）：渐变暮色天空 + 球体柔光晕 + 暖白星星（一次性绘制）
4. **每帧渲染**（`drawGlobe()`）：
   - 正交投影：屏幕像素 → 球面方向 → （逆偏航/俯仰旋转）→ 经纬度 → 查网格取色
   - 球体明暗：`sh = 0.6 + 0.4 * dz`（边缘暗、中心亮）
   - 国家高亮：命中 `highlightCode` 的格子用金黄/暖白闪烁
   - 首都旗：`countryScreenPos()` 算首都屏幕位置，画 4×4 旗 + 旗杆 + 底座（弹跳）
5. **运动**（`updateGlobe()`）：偏航 `rot` + 俯仰 `pitch` + 缩放 `zoom` 平滑趋近目标；
   空闲时缓慢自转并还原缩放
6. **状态入口**：`setCountry(code, name)` —— 随机到国家时被调用

## 前端与后端接口

| 端点 | 说明 |
| --- | --- |
| `GET /api/song` | 随机一首歌 `{title, artist, album, streamUrl, artwork, duration, countrycode, country, id}` |
| `GET /api/country?id=…` | 解析该歌艺术家的国籍（MusicBrainz，结果缓存 30 天；无法确认时返回未知） |
| `GET /api/info` | 模式与统计 |
| `GET /audio/{id}` | 本地音频（缓存命中秒开，未命中转发 Jamendo 并后台缓存） |
| `POST /api/audio/played?id=…` | 播放结束后删除该歌曲的本地音频缓存，保留歌曲池和远程 URL 元数据 |
| `POST /api/client-session` | Web 页面会话心跳；最后一个页面关闭后触发后端退出和缓存清理（仅直接 Web 模式） |

## 本地改动的验证方法

- 页面：`node web/server.js` 后浏览器打开 http://localhost:3000
- **像素地球专项**：`node web/scripts/render-globe.js`
  —— 无需浏览器即可把地球渲染成 `data/globe-*.png` 检查效果
  （脚本与 `app.js` 渲染逻辑一致，改完 `app.js` 记得同步改它）
- 注意：前端改动后浏览器要 **Ctrl+F5** 强刷（静态资源已设 `no-cache`，
  且 `index.html` 里带 `?v=` 版本号，改版号可强制更新）

## 目录结构

```
vinyl-globe/
├── web/
│   ├── server.js        # 网页版后端：歌曲池、音频缓存、国家解析、API
│   ├── start.bat        # 网页版一键启动
│   ├── public/          # 前端（纯静态）
│   │   ├── index.html   # 唱片机页面
│   │   ├── style.css    # 样式（唱片机 + 地球卡片）
│   │   ├── app.js       # 前端逻辑（地球渲染在这里！）
│   │   ├── map.json     # 144×72 国家编码网格（像素地球数据）
│   │   └── capitals.json # 世界首都坐标
│   └── scripts/         # 地图生成与地球预览工具
├── desktop/
│   ├── electron/        # Electron 主进程
│   ├── start.bat        # 桌面版启动脚本
│   └── release/         # EXE 与 ZIP 安装包
├── runtime-cache.js     # 两种启动方式共用的退出清理逻辑
└── data/                # 运行缓存（可删，会自动重建）
    ├── config.json      # Jamendo key 配置
    ├── jamendo/pool.json        # 歌曲池缓存
    ├── songs/           # iTunes 兜底模式缓存
    ├── audio/           # 音频预下载缓存（4 首流水线）
    ├── artist-countries.json    # 艺术家国籍解析缓存
    └── ne_110m_admin_0_countries.geojson  # 地图源数据（build-map 用）
```

## 注意事项

- `data/` 下的歌曲、音频、歌曲池和艺术家国家文件都是**运行时缓存**：程序退出时会自动清理，删掉也会重新生成（音频缓存会重新下载，约几分钟）；`data/config.json` 属于配置，会保留；
  改前端/后端时无需动它们。
- `data/config.json` 里的 Jamendo key 是账号凭证：**已被 .gitignore 排除，不会进入仓库**。
  - 克隆仓库后需要先 `copy data\config.example.json data\config.json` 并填入自己的 key
  - 发给协作者没问题（免费），公开仓库请用对方自己的 key
- 改 `web/public/app.js` 的地球部分后，同步更新 `web/scripts/render-globe.js` 保持一致，
  便于离线预览。

## Git 协作

- 仓库已初始化，提交内容：全部代码 + 文档 + `map.json`/`capitals.json`
- 不入库：`data/audio`、`data/songs`、`data/jamendo`、`data/artist-countries.json`、`data/config.json`、地图源 GeoJSON
- 推送到 GitHub：
  ```bash
  git remote add origin https://github.com/<你的用户名>/<仓库名>.git
  git branch -M main
  git push -u origin main
  ```
- 建议在 GitHub 上把仓库设为 **Private**（虽然 key 已排除，但私有更稳妥）
- 协作者改完后 `git pull` 即可；有改动冲突时先 `git pull --rebase`
