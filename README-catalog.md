# 🎬 豆瓣热榜 — Stremio 影视发现插件

从豆瓣抓取热门影视榜单，配合 Torrentio+RD 实现浏览→点击→播放。

端口 **5801**，与本地字幕服务器（5800）同级。

## 榜单

共 **14 个**榜单：

| 图标 | 名称 | 数据源 |
|------|------|--------|
| 🎬 | 热门电影（综合） | 豆瓣 recent_hot |
| 🇨🇳 | 华语热片 | 豆瓣 explore |
| 🇰🇷 | 韩国热片 | 豆瓣 explore |
| 🇯🇵 | 日本热片 | 豆瓣 explore |
| 📽️ | 纪录片（电影） | 豆瓣 explore |
| 📺 | 热门剧集（综合） | 豆瓣 recent_hot |
| 🇨🇳 | 内地热剧 | 豆瓣 recent_hot |
| 🇰🇷 | 韩剧 | 豆瓣 recent_hot |
| 🇯🇵 | 日剧 | 豆瓣 recent_hot |
| 🇪🇺 | 欧美剧 | 豆瓣 recent_hot |
| 📽️ | 纪录片（剧集） | 豆瓣 recent_hot |
| 🎭 | 综艺（综合） | 豆瓣 recent_hot |
| 🇨🇳 | 内地综艺 | 豆瓣 recent_hot |
| 🌍 | 海外综艺 | 豆瓣 recent_hot |

## 安装

```
http://192.168.2.231:5801/manifest.json
```

## 原理

```
豆瓣榜单 → TMDB 搜中文标题(拿海报) → TVmaze 补查 IMDB ID(能播的) → Stremio catalog
```

- **电影**：大部分有 IMDB ID → Torrentio 可播
- **剧集/综艺/纪录片**：部分有 IMDB ID，主要做浏览发现

## 文件

```
~/stremio-subtitle-server/
├── catalog-server.js                  ← 主程序（Node.js）
├── com.vickiepo.stremio-catalog.plist ← launchd 自启
├── .env-catalog                       ← TMDB API Key
├── .catalog-cache.json                ← 缓存（自动管理）
└── catalog.log                        ← 日志
```

## 运维

```bash
# 手动启动
cd ~/stremio-subtitle-server && TMDB_API_KEY=your_key node catalog-server.js

# 查看日志
tail -f ~/stremio-subtitle-server/catalog.log

# 端口确认
lsof -i :5801

# 重启（从 launchd 加载）
launchctl bootout gui/$(id -u)/com.vickiepo.stremio-catalog 2>/dev/null
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.vickiepo.stremio-catalog.plist
```

## 依赖

- TMDB API Key（免费注册：[themoviedb.org/settings/api](https://www.themoviedb.org/settings/api)）
- TVmaze API（免费，无需 Key）
- Node.js（需 nvm 完整路径）
