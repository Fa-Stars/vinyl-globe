# 🌍 世界唱片机 World Vinyl

一个唱片机造型的网站：**随机播放来自全世界任意一个国家的完整歌曲**。
中间是旋转的黑胶唱片（标签显示歌曲封面），按下 **R** 键随机切换下一首；
旁边是**像素化地球仪**，实时高亮正在播放歌曲所属的国家。

## 运行

要求：Node.js ≥ 18（无任何第三方依赖）。

```bash
cd vinyl-globe
node server.js
```

打开 http://localhost:3000

> 首次访问时，后台会自动抓取各国家的歌曲（约 1~2 分钟跑完全部国家，
> 期间页面立即可用：先随机到已就绪的国家）。歌曲按国家缓存到 `data/songs/`（或 `data/jamendo/`），
> 每 12 小时自动刷新一次。重启秒级恢复（直接从磁盘缓存加载）。

### 播放完整歌曲（推荐，Jamendo）

默认数据源是 iTunes 榜单（**30 秒试听**）。要播放**完整歌曲**，配置免费的 Jamendo API key：

1. 打开 https://devportal.jamendo.com 免费注册，登录后创建应用，复制 `client_id`
2. 把 key 填入 `data/config.json` 的 `jamendoClientId` 字段（或设置环境变量 `JAMENDO_CLIENT_ID`）
3. 重启 `node server.js`，即自动切换为 **Jamendo 全曲模式**

Jamendo 是正版免费（Creative Commons）音乐平台，返回**完整 mp3**，
并按**艺术家国籍**过滤——正好驱动像素地球的国家高亮。未配置 key 时自动回退到 iTunes 试听模式。

## 使用

| 操作 | 效果 |
| --- | --- |
| `R` | 随机切换到下一首（来自随机国家） |
| `Space` | 播放 / 暂停 |
| 点击唱片 | 播放 / 暂停 |
| `⏭` 按钮 | 随机切换 |
| 打开 `http://localhost:3000/?demo=1` | 页面加载后自动开始播放（演示用） |

歌曲结束自动连播下一首（试听模式下 30 秒结束即切换），也可以随时按 `R`。

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

- **数据源双模式**（`server.js` 按 `JAMENDO_CLIENT_ID` 是否配置自动切换）：
  - **Jamendo（全曲）**：`https://api.jamendo.com/v3.0/tracks/?client_id=…&order=popularity_total&audioformat=mp32`
    按热度分页拉取**全局歌曲池**（约 840 首完整 mp3，CORS 开放可直接网页播放），随机选曲。
  - **iTunes（试听兜底）**：`https://itunes.apple.com/{国家码}/rss/topsongs/limit=100/json`，
    按国家组织、30 秒试听，像素地球可高亮国家（代价是无全曲）。
- **艺术家国籍解析**（Jamendo 模式让地球亮起来）：Jamendo API 本身不提供国家字段，
  服务器通过**联网搜索**解析艺术家国籍——
  ① **MusicBrainz**（结构化元数据库，取 `area`/`country` ISO 码，限速 1 请求/秒）；
  ② 未命中时用 **Bing 搜索**（cn.bing.com，3 个查询模板多数投票，≥2 一致才采信，
  并剔除艺术家名字本身避免「Jasmine Jordan→约旦」类误判）。
  结果缓存到 `data/artist-countries.json`（30 天有效），实测命中率约 **70%**；
  后台自动回填全部艺术家，播放中歌曲通过 `GET /api/country?id=` 即时解析并点亮地球。
- **容错**：区分「永久无效」（HTTP 400 / Jamendo API 报错）与「瞬时失败」（网络/超时，自动重试一次、
  不误标记）；榜单只有一首歌时 Apple 返回单个对象而非数组，已做归一化处理。
- **提速**：歌曲池常驻内存/磁盘，热请求毫秒级返回；服务器维护一个 **10 首预下载流水线**
  （`data/audio/` 本地缓存，3 路并发下载、自动淘汰旧文件），且 `/api/song` **优先返回已缓存的歌**：
  无论何时按 R 切换，基本都是直接读本地（TTFB ~40ms），不再等待远程 CDN。
- **像素地球**（`public/map.json` + `public/capitals.json`）：由 Natural Earth 110m 国界数据栅格化成 144×72 的
  国家编码网格（每格 2.5°×2.5°），浏览器端用 Canvas 以**任天堂卡通像素风**绘制成纯球体
  （星空背景、球体明暗、陆地描边）。播放到某国时，地球会**任意方向旋转**（偏航+俯仰）把该国转到
  画面正中，并按**领土大小自适应缩放**（国家约占画面 30%，周边邻国/大陆轮廓仍可见），
  国家黄白闪烁高亮，并在**首都位置**竖起一杆**弹跳闪烁的像素旗标记**；空闲时缓慢自转。
  重新生成地图：`node scripts/build-map.js`；渲染预览：`node scripts/render-globe.js`。

## API

| 端点 | 说明 |
| --- | --- |
| `GET /api/song` | 随机返回一首歌 `{title, artist, album, streamUrl, artwork, duration, countrycode, country}` |
| `GET /api/song?country=JP` | 指定国家返回一首歌（仅 iTunes 模式可用） |
| `GET /api/country?id=…` | 解析/返回某首歌艺术家的国籍（MusicBrainz + Bing，结果缓存 30 天） |
| `GET /api/info` | 模式与缓存统计（`mode: jamendo/itunes`、歌曲数） |
| `GET /api/countries` | 已缓存国家列表（仅 iTunes 模式有数据） |

## 目录结构

```
vinyl-globe/
├── server.js            # 后端：歌曲爬取（Jamendo/iTunes）+ 随机选歌 API + 静态服务
├── public/
│   ├── index.html       # 唱片机页面
│   ├── style.css        # 唱片机 / 像素地球样式
│   ├── app.js           # 前端逻辑（R 键切换、音频、地球渲染）
│   └── map.json         # 144×72 国家编码栅格（像素地球数据）
├── scripts/
│   └── build-map.js     # 由 Natural Earth GeoJSON 生成 map.json
└── data/
    ├── config.json      # 配置：填 jamendoClientId 开启全曲模式
    ├── songs/           # iTunes 试听缓存
    ├── jamendo/         # Jamendo 全曲缓存
    └── ne_110m_admin_0_countries.geojson  # 地图源数据
```

## 已知限制

- **试听 vs 全曲**：不配置 Jamendo key 时只能播 iTunes 的 30 秒试听；配置 key 后即全曲播放。
- **国家解析**：艺术家国籍通过 MusicBrainz / Bing 联网解析（命中率约 70%），
  查不到的艺术家显示「未知地区」且地球不高亮；结果缓存 30 天。
- 若部署到 HTTPS 环境，个别 `http://` 音频链接会被浏览器拦截；本地 `http://localhost` 无此问题。
- Jamendo 曲库以独立音乐人为主（非主流榜单金曲），胜在正版全曲播放。
