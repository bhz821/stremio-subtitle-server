# Stremio 本地字幕插件

在 iMac 上跑一个 Stremio 插件，从本地 `.srt` 文件加载中文字幕。

## 快速开始

```bash
# 启动
cd ~/stremio-subtitle-server && node server.js

# 安装字幕文件：把 .srt 丢进 ~/.stremio-subs/TV/ 或 Movies/
# 文件名必须含 S01E01 格式（剧集）
```

## 安装插件到 Stremio

方法一（推荐）：手机上开 Stremio → Addons → Install from URL → 输入：

```
http://192.168.2.231:5800/manifest.json
```

方法二：浏览器打开 http://192.168.2.231:5800/ → 点 Install

## 字幕文件命名

```
~/.stremio-subs/
├── TV/
│   ├── I.Will.Find.You.S01E01.chi.srt    ← S01E01 匹配第1季第1集
│   ├── I.Will.Find.You.S01E02.chi.srt    ← S01E02 匹配第1季第2集
│   └── 9-1-1.S09E01.chi.srt              ← S09E01 匹配第9季第1集
└── Movies/
    └── 你的电影名字.chi.srt                ← 放这里，播放时全返回供选择
```

语言自动识别文件名中的 `chi`/`zh`/`eng` 等标签。

## 开机自启

```bash
cp ~/stremio-subtitle-server/com.vickiepo.stremio-subs.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.vickiepo.stremio-subs.plist
```

## API

| 路径 | 说明 |
|------|------|
| `GET /` | 安装页 |
| `GET /manifest.json` | Addon 清单 |
| `GET /subtitles/series/tt1234567/1-1.json` | 字幕查询（S01E01） |
| `GET /subs/TV/xxx.srt` | 字幕文件下载 |

## 端口

- 5800
- 地址: `192.168.2.231:5800`
