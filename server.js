#!/usr/bin/env node
/**
 * Stremio 本地字幕服务器
 *
 * 实现 Stremio addon 的 subtitles 资源接口。
 * 从 ~/.stremio-subs/ 目录加载 .srt 文件，按 SxxExx 模式匹配剧集。
 *
 * 启动: node server.js
 * 安装: 浏览器打开 http://192.168.2.231:5800/addon.json
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const os = require('os');
const { spawn, execFile } = require('child_process');
const https = require('https');

// ====== 访问日志 ======
function log(msg) {
  const t = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${t}] ${msg}`);
}

const SUBS_DIR = path.join(os.homedir(), '.stremio-subs');
const PORT = 5800;
const HOST = '0.0.0.0';
const LAN_IP = '192.168.2.231';

// 数字 ID → 文件路径 映射表
let subIdCounter = 1;
const subIdMap = {};

/** 简易 ASS → SRT 转换 */
function assToSrt(content) {
  const lines = content.split('\n');
  const events = [];
  let formatFields = [], inEvents = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('Format:')) formatFields = line.slice(7).split(',').map(f => f.trim());
    if (line.startsWith('[Events]')) { inEvents = true; continue; }
    if (inEvents && line.startsWith('Dialogue:')) {
      const parts = line.slice(9).split(',');
      if (formatFields.length && parts.length >= formatFields.length) {
        const startStr = parts[formatFields.indexOf('Start')] || '';
        const endStr = parts[formatFields.indexOf('End')] || '';
        let text = parts.slice(formatFields.indexOf('Text')).join(',').replace(/\{[^}]*\}/g, '').replace(/\\N/gi, '\n').trim();
        if (!text) continue;
        const s = parseAssTime(startStr), e = parseAssTime(endStr);
        events.push({ s, e, text });
      }
    }
  }
  events.sort((a, b) => a.s - b.s);
  return events.map((ev, i) => `${i+1}\n${fmtSrtTime(ev.s)} --> ${fmtSrtTime(ev.e)}\n${ev.text}\n`).join('\n');
}
function parseAssTime(t) {
  const m = t.match(/(\d+):(\d+):(\d+)\.(\d+)/);
  return m ? (+m[1]*3600)+(+m[2]*60)+(+m[3])+(+m[4]/100) : 0;
}
function fmtSrtTime(sec) {
  const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60), s = Math.floor(sec%60), ms = Math.round((sec%1)*1000);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(ms).padStart(3,'0')}`;
}

// ======================== 文件扫描 ========================

/** 递归扫描目录下所有字幕文件 */
function scanSubFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue; // 跳过隐藏文件
    const fullPath = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        results.push(...scanSubFiles(fullPath));
      } else if (entry.isFile() && /\.(srt|ass|ssa)$/i.test(entry.name)) {
        results.push(fullPath);
      }
    } catch { /* 权限问题跳过 */ }
  }
  return results;
}

/** 按季/集编号找匹配字幕 */
function findSubsByEpisode(season, episode) {
  const s = String(season).padStart(2, '0');
  const e = String(episode).padStart(2, '0');
  const pattern = new RegExp(`S${s}E${e}`, 'i');
  return scanSubFiles(SUBS_DIR).filter(f => pattern.test(path.basename(f)));
}

/** 按文件名关键词匹配（用于电影或模糊搜索） */
function findSubsByKeyword(keyword) {
  if (!keyword) return [];
  const kw = keyword.toLowerCase().replace(/^tt/, '');
  return scanSubFiles(SUBS_DIR).filter(f =>
    path.basename(f).toLowerCase().includes(kw)
  );
}

/** 猜测字幕语言 */
function guessLang(filename) {
  const lower = filename.toLowerCase();
  if (/chi|zho|zh|chs|cht|chinese|简体|繁体|中文/i.test(lower)) return 'Chinese';
  if (/eng|en|english/i.test(lower)) return 'English';
  if (/jpn|ja|japanese|日本語/i.test(lower)) return 'Japanese';
  if (/kor|ko|korean|한국어/i.test(lower)) return 'Korean';
  // 文件名不含语言标记时，从目录推断
  return 'Chinese'; // 默认中文不瞎猜
}

// ======================== 手机端字幕浏览页 ========================

function renderBrowserPage(items, query, typeFilter, totalCount) {
  const searchVal = query.replace(/"/g, '&quot;');
  const rows = items.map(f => {
    const seInfo = f.se ? `S${f.se[1]}E${f.se[2]}` : '';
    const typeIcon = f.type === 'series' ? '📺' : '🎬';
    const langLower = f.lang.toLowerCase();
    const langBadge = `<span class="lang ${langLower}">${f.lang}</span>`;
    const extUpper = f.ext.slice(1).toUpperCase();
    const extBadge = f.ext === '.ass' ? `<span class="ext ass">ASS</span>` : `<span class="ext srt">SRT</span>`;
    const dlUrl = `/subs/${f.encodedRel}`;
    return `<tr>
      <td class="name"><a href="${dlUrl}">${typeIcon} ${f.fname}</a></td>
      <td class="meta">${seInfo ? `<span class="se">${seInfo}</span> ` : ''}${langBadge} ${extBadge}</td>
      <td class="dl"><a href="${dlUrl}" download="${f.fname}" class="dl-btn" title="下载">⬇</a></td>
    </tr>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
  <title>本地字幕 · 浏览器</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #111; color: #eee; min-height: 100vh; }
    .container { max-width: 700px; margin: 0 auto; padding: 12px; }
    h1 { font-size: 1.25em; margin-bottom: 2px; }
    .sub { color: #888; font-size: 0.8em; margin-bottom: 12px; }
    .sub a { color: #3b82f6; text-decoration: none; }
    .bar { display: flex; gap: 8px; margin-bottom: 10px; }
    .bar input { flex: 1; padding: 10px 12px; border-radius: 8px; border: 1px solid #333; background: #222; color: #eee; font-size: 16px; outline: none; -webkit-appearance: none; }
    .bar input:focus { border-color: #3b82f6; }
    .bar button { padding: 10px 16px; border-radius: 8px; border: none; background: #3b82f6; color: #fff; font-size: 15px; cursor: pointer; -webkit-appearance: none; }
    .tags { display: flex; gap: 6px; margin-bottom: 10px; flex-wrap: wrap; }
    .tag { padding: 5px 12px; border-radius: 16px; border: 1px solid #444; background: transparent; color: #aaa; font-size: 13px; cursor: pointer; text-decoration: none; }
    .tag.act { background: #3b82f6; color: #fff; border-color: #3b82f6; }
    .tag.clr { border-color: #d55; color: #d55; }
    .cnt { font-size: 0.8em; color: #666; margin-bottom: 8px; }
    table { width: 100%; border-collapse: collapse; }
    tr { border-bottom: 1px solid #1a1a1a; }
    td { padding: 8px 4px; vertical-align: middle; }
    td.name { font-size: 13px; }
    td.name a { color: #ddd; text-decoration: none; display: block; }
    td.name a:active { color: #3b82f6; }
    td.meta { white-space: nowrap; text-align: right; padding-right: 6px; }
    td.dl { width: 32px; text-align: center; }
    .lang { display: inline-block; padding: 1px 7px; border-radius: 10px; font-size: 10px; font-weight: 600; }
    .lang.chinese { background: #1a3a2a; color: #4ade80; }
    .lang.english { background: #1a2a3a; color: #60a5fa; }
    .lang.japanese { background: #3a1a2a; color: #f472b6; }
    .lang.korean { background: #2a1a3a; color: #a78bfa; }
    .ext { font-size: 9px; margin-left: 3px; }
    .ext.srt { color: #888; }
    .ext.ass { color: #f59e0b; }
    .se { color: #fbbf24; font-size: 11px; margin-right: 3px; }
    .dl-btn { text-decoration: none; font-size: 18px; color: #555; padding: 2px 4px; }
    .dl-btn:active { color: #3b82f6; }
    .emp { text-align: center; padding: 40px 0; color: #555; font-size: 14px; }
    .tip { background: #1a1a2e; border-radius: 8px; padding: 10px 12px; margin-top: 16px; font-size: 12px; color: #777; line-height: 1.6; }
    .tip code { background: #222; padding: 1px 5px; border-radius: 4px; font-size: 11px; }
    .tagline { margin-top: 16px; text-align: center; font-size: 11px; color: #444; }
    @media (prefers-color-scheme: light) {
      body { background: #f5f5f5; color: #222; }
      .bar input { background: #fff; border-color: #ddd; color: #222; }
      tr { border-bottom-color: #e8e8e8; }
      td.name a { color: #333; }
      .tip { background: #e8e8f0; color: #555; }
      .tip code { background: #ddd; }
      .cnt { color: #999; }
    }
  </style>
</head>
<body>
<div class="container">
  <h1>📁 字幕浏览器</h1>
  <div class="sub"><a href="/addon.json">📦 安装到 Stremio</a> · ${items.length}/${totalCount} 个字幕</div>

  <form class="bar" method="get" action="/">
    <input type="text" name="q" placeholder="搜索剧名或 S01E02" value="${searchVal}" autofocus>
    <button type="submit">搜</button>
  </form>

  <div class="tags">
    <a class="tag${typeFilter === 'all' ? ' act' : ''}" href="/?${query ? 'q='+encodeURIComponent(query)+'&' : ''}type=all">全部</a>
    <a class="tag${typeFilter === 'series' ? ' act' : ''}" href="/?${query ? 'q='+encodeURIComponent(query)+'&' : ''}type=series">📺 剧集</a>
    <a class="tag${typeFilter === 'movie' ? ' act' : ''}" href="/?${query ? 'q='+encodeURIComponent(query)+'&' : ''}type=movie">🎬 电影</a>
    ${query ? `<a class="tag clr" href="/">✕ 清除</a>` : ''}
  </div>

  ${items.length === 0 ? '<div class="emp">没有匹配的字幕文件</div>' : ''}

  ${items.length > 0 ? `<table>${rows}</table>` : ''}

  <div class="tip">
    <strong>📱 iPhone 用法</strong><br>
    在 Stremio 网页版点"Play in VLC"后，切回 Safari 打开本页 → 搜剧名 → 点 ⬇ 下载字幕 → 在 VLC 中"添加字幕文件"
  </div>
  <div class="tagline">iMac · ~/.stremio-subs/ · ${totalCount} 个文件</div>
</div>
</body>
</html>`;
}

// ======================== 手机端字幕提取页 ========================

function renderExtractPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
  <title>字幕提取 · 工具</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #111; color: #eee; min-height: 100vh; padding: 12px; }
    .container { max-width: 700px; margin: 0 auto; }
    h1 { font-size: 1.2em; margin-bottom: 4px; }
    .sub { color: #888; font-size: 0.8em; margin-bottom: 12px; }
    .sub a { color: #3b82f6; text-decoration: none; }
    .card { background: #1a1a1a; border-radius: 10px; padding: 14px; margin-bottom: 12px; }
    .card h2 { font-size: 1em; margin-bottom: 8px; }
    .bar { display: flex; gap: 8px; margin-bottom: 8px; }
    .bar input { flex: 1; padding: 10px 12px; border-radius: 8px; border: 1px solid #333; background: #222; color: #eee; font-size: 14px; outline: none; -webkit-appearance: none; }
    .bar input:focus { border-color: #3b82f6; }
    .bar button, .btn { padding: 10px 16px; border-radius: 8px; border: none; background: #3b82f6; color: #fff; font-size: 14px; cursor: pointer; -webkit-appearance: none; white-space: nowrap; }
    .btn:disabled { opacity: 0.5; }
    .btn.green { background: #22c55e; }
    .btn.orange { background: #f59e0b; }
    .btn.sm { padding: 6px 12px; font-size: 12px; }
    .tag { display: inline-block; padding: 3px 8px; border-radius: 10px; font-size: 11px; margin: 2px; cursor: pointer; border: 1px solid #444; background: transparent; color: #aaa; }
    .tag.act { background: #3b82f6; color: #fff; border-color: #3b82f6; }
    .tag.green { background: #22c55e; color: #000; border-color: #22c55e; }
    #results { margin-top: 8px; }
    .vitem { padding: 8px 0; border-bottom: 1px solid #1a1a1a; font-size: 13px; display: flex; align-items: center; gap: 8px; }
    .vitem .vname { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .vitem .vsize { color: #666; font-size: 11px; white-space: nowrap; }
    .tracks { margin: 8px 0; }
    .track-item { display: inline-block; padding: 6px 12px; margin: 3px; border-radius: 8px; background: #222; font-size: 12px; cursor: pointer; border: 1px solid transparent; }
    .track-item.act { border-color: #3b82f6; background: #1a2a4a; }
    .url-input { width: 100%; padding: 10px; border-radius: 8px; border: 1px solid #333; background: #222; color: #eee; font-size: 13px; outline: none; margin-bottom: 8px; }
    .url-input:focus { border-color: #3b82f6; }
    .status { padding: 10px; border-radius: 8px; margin: 8px 0; font-size: 13px; display: none; }
    .status.loading { display: block; background: #1a1a3a; color: #888; }
    .status.done { display: block; background: #1a3a1a; color: #4ade80; }
    .status.error { display: block; background: #3a1a1a; color: #f87171; }
    .dl-link { display: block; padding: 12px; background: #1a3a1a; border-radius: 8px; color: #4ade80; text-decoration: none; font-size: 15px; margin-top: 8px; text-align: center; }
    .tip { background: #1a1a2e; border-radius: 8px; padding: 10px; margin-top: 12px; font-size: 12px; color: #777; line-height: 1.6; }
    .tip code { background: #222; padding: 1px 5px; border-radius: 4px; font-size: 11px; }
    .nav { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
    .nav a { color: #888; text-decoration: none; font-size: 13px; padding: 4px 10px; border-radius: 16px; border: 1px solid #333; }
    .nav a.act { color: #3b82f6; border-color: #3b82f6; }
    #autoDetect { font-size: 12px; color: #888; padding: 8px; margin-bottom: 8px; }
    #autoDetect .found { color: #4ade80; }
    #autoDetect .none { color: #888; }
    @media (prefers-color-scheme: light) {
      body { background: #f5f5f5; color: #222; }
      .card { background: #fff; }
      .bar input, .url-input { background: #fff; border-color: #ddd; color: #222; }
      .track-item { background: #eee; }
      .track-item.act { background: #dbeafe; border-color: #3b82f6; }
      .nav a { border-color: #ddd; color: #666; }
      .nav a.act { color: #3b82f6; border-color: #3b82f6; }
      .tip { background: #e8e8f0; color: #555; }
      .tip code { background: #ddd; }
      .status.loading { background: #e8e8f0; }
      .status.done { background: #dcfce7; }
      .status.error { background: #fee2e2; }
    }
  </style>
</head>
<body>
<div class="container">
  <h1>🔧 字幕提取</h1>
  <div class="sub">
    <a href="/">← 返回字幕浏览器</a>
  </div>

  <div class="nav">
    <a href="#rd" class="act" id="tabRD" onclick="switchTab('rd');loadRD()">⚡ Debrid</a>
    <a href="#smb" id="tabSMB" onclick="switchTab('smb')">📁 本地</a>
    <a href="#url" id="tabURL" onclick="switchTab('url')">🔗 URL</a>
  </div>

  <!-- RD 模式 -->
  <div class="card" id="panelRD">
    <h2>⚡ Real-Debrid 最近下载</h2>
    <p style="font-size:12px;color:#888;margin-bottom:8px">点你刚才播过的视频，提取内嵌英文字幕并翻译</p>
    <div id="rdList" style="margin-bottom:8px">加载中...</div>
    <div id="rdTracks" class="tracks" style="display:none"></div>
    <div id="rdStatus" class="status" style="display:none"></div>
    <button class="btn green" id="rdExtractBtn" style="display:none" onclick="startExtract('rd')">🚀 提取并翻译</button>
    <hr style="border-color:#333;margin:12px 0">
    <div style="font-size:13px;color:#888;margin-bottom:6px">或者从 OpenSubtitles 搜索：</div>
    <div class="bar">
      <input type="text" id="rdImdbId" placeholder="片名或 IMDB ID (tt32493765)" style="flex:1;padding:8px 10px;border-radius:6px;border:1px solid #333;background:#222;color:#eee;font-size:13px;outline:none;-webkit-appearance:none">
      <button class="btn orange" onclick="searchOS()" style="padding:8px 12px;font-size:12px">🔍 搜索</button>
    </div>
    <div id="rdOsResults" style="margin-top:6px"></div>
    <div id="rdOsStatus" class="status"></div>
    <div id="rdOsActions" style="display:none;margin-top:8px;gap:8px">
      <button class="btn green" onclick="downloadOS()" style="flex:1">⬇ 下载</button>
      <button class="btn orange" onclick="translateOS()" style="flex:1" id="rdOsTranslateBtn">🌐 翻译</button>
    </div>
  </div>

  <!-- 翻译已有字幕 -->
  <div class="card" style="margin-top:8px">
    <h2>🌐 翻译已有英文字幕</h2>
    <p style="font-size:12px;color:#888;margin-bottom:6px">搜索字幕库里已有的 .srt 文件，选一个翻译为双语</p>
    <div class="bar">
      <input type="text" id="existingSubSearch" placeholder="搜索剧名..." style="flex:1;padding:8px 10px;border-radius:6px;border:1px solid #333;background:#222;color:#eee;font-size:13px;outline:none;-webkit-appearance:none">
      <button class="btn orange" id="existingSubSearchBtn" style="padding:8px 12px;font-size:12px">🔍 搜索</button>
    </div>
    <div id="existingSubResults" style="margin-top:6px"></div>
    <div id="existingSubStatus" class="status"></div>
  </div>

  

  <!-- SMB 模式 -->
  <div class="card" id="panelSMB">
    <h2>📁 从 SMB 本地视频提取</h2>
    <div class="bar">
      <input type="text" id="smbSearch" placeholder="搜索剧名…" oninput="searchSMB()">
    </div>
    <div id="smbResults"></div>
    <div id="smbTracks" class="tracks"></div>
    <div id="smbStatus" class="status"></div>
    <button class="btn green" id="smbExtractBtn" style="display:none" onclick="startExtract('smb')">🚀 提取并翻译</button>
  </div>

  <!-- URL 模式 -->
  <div class="card" id="panelURL" style="display:none">
    <h2>🔗 从视频 URL 提取</h2>
    <p style="font-size:12px;color:#666;margin-bottom:8px">粘贴视频文件的直链 URL（支持 Real-Debrid 等 HTTP 链接）</p>
    <input class="url-input" type="text" id="videoUrl" placeholder="https://real-debrid.com/... 或 /Volumes/Media/TV/xxx.mkv" value="">
    <div id="urlTracks" class="tracks"></div>
    <div id="urlStatus" class="status"></div>
    <button class="btn orange" id="urlProbeBtn" onclick="probeUrl()">🔍 探测字幕轨道</button>
    <button class="btn green" id="urlExtractBtn" style="display:none" onclick="startExtract('url')">🚀 提取并翻译</button>
  </div>

  <div id="autoDetect">
    <span id="detectMsg">正在检测当前 Stremio 流…</span>
  </div>

  <div class="tip">
    <strong>💡 说明</strong><br>
    <b>本地视频：</b>从 /Volumes/Media/ 选择文件。提取较慢（SMB 读取 30-60 秒）。<br>
    <b>URL 模式：</b>粘贴 Debrid 直链即可快速提取（HTTP range request）。<br>
    提取后自动翻译为中英双语字幕，存入 ~/.stremio-subs/。<br>
    完成后前往 <a href="/" style="color:#3b82f6">字幕浏览器</a> 下载。
  </div>
</div>

<script>
let selectedVideo = null;
let selectedURL = null;
let selectedTrack = 0;

function switchTab(tab) {
  var tabs = {rd:'RD',smb:'SMB',url:'URL'};
  Object.keys(tabs).forEach(function(t) {
    document.getElementById('tab' + tabs[t]).className = '';
    document.getElementById('panel' + tabs[t]).style.display = 'none';
  });
  document.getElementById('tab' + tabs[tab]).className = 'act';
  document.getElementById('panel' + tabs[tab]).style.display = 'block';
}

// 自动检测当前 Stremio 流
async function checkStremioStream() {
  try {
    const r = await fetch('/api/search-videos');
    const d = await r.json();
    if (d.currentStream && Object.keys(d.currentStream).length > 0) {
      document.getElementById('detectMsg').innerHTML = '<span class="found">✅ 检测到活跃流，尝试提取…</span>';
      // 尝试获取流详情
    } else {
      document.getElementById('detectMsg').innerHTML = '<span class="none">ℹ️ 未检测到活跃 Stremio 流（播放时才显示）</span>';
    }
  } catch(e) {
    document.getElementById('detectMsg').innerHTML = '<span class="none">ℹ️ 无法检测 Stremio 状态</span>';
  }
}

// ===== RD 加载 =====
async function loadRD() {
  var el = document.getElementById('rdList');
  el.innerHTML = '加载中...';
  try {
    var r = await fetch('/api/rd-downloads');
    var d = await r.json();
    if (!d.downloads || !d.downloads.length) {
      el.innerHTML = '<div style="color:#888;font-size:13px;padding:8px 0">没有 RD 下载记录。先播一个视频再回来。</div>';
      return;
    }
    el.innerHTML = '';
    d.downloads.forEach(function(v) {
      var sz = v.filesize > 1073741824 ? (v.filesize/1073741824).toFixed(1) + 'GB' : v.filesize > 1048576 ? (v.filesize/1048576).toFixed(0) + 'MB' : (v.filesize/1024).toFixed(0) + 'KB';
      var div = document.createElement('div');
      div.className = 'rd-item';
      div.innerHTML = '<span class="rbadge">RD</span><span class="rname">' + (v.filename || '?') + '</span><span class="rsize">' + sz + '</span>';
      div.addEventListener('click', function() {
        var fn = v.filename || '';
        var m = fn.match(/S(\\d{2})E(\\d{2})/i);
        var q;
        if (m) {
          var show = fn.replace(/[.\\s-]*S\\d{2}E\\d{2}.*$/i, '').replace(/[.\\s]/g, ' ');
          q = show + ' S' + m[1] + 'E' + m[2];
        } else {
          q = fn.replace(/\.[^/.]+$/, '').replace(/[.\\s_]/g, ' ');
        }
        document.getElementById('rdImdbId').value = q;
        searchOS();
      });
      el.appendChild(div);
    });
  } catch(e) {
    el.innerHTML = '<div style="color:#f87171;font-size:13px">加载失败: ' + e.message + '</div>';
  }
}
function selectRD(url, name) {
  selectedURL = url;
  selectedTrack = 0;
  document.getElementById('rdTracks').innerHTML = '探测中...';
  document.getElementById('rdExtractBtn').style.display = 'none';
  var st = document.getElementById('rdStatus');
  st.className = 'status loading';
  st.textContent = '探测 ' + name + ' 的字幕轨道...';
  st.style.display = 'block';
  fetch('/api/probe?url=' + encodeURIComponent(url)).then(function(r) { return r.json(); }).then(function(d) {
    if (d.error) { st.className = 'status error'; st.textContent = '探测失败: ' + d.error; return; }
    var tracks = d.tracks || [];
    if (!tracks.length) { document.getElementById('rdTracks').innerHTML = '<span style="color:#f59e0b;font-size:13px">\u26a0 没有字幕轨道</span>'; st.style.display = 'none'; return; }
    document.getElementById('rdTracks').innerHTML = tracks.map(function(t,i) {
      var lang = (t.tags && t.tags.language) || '?';
      return '<span class="track-item" id="rdTrack' + i + '" >\uD83C\uDFAC 轨道' + i + ' (' + lang + ')</span>';
    }).join('');
    selectTrack(0, 'rd');
    document.getElementById('rdExtractBtn').style.display = 'inline-block';
    st.style.display = 'none';
  }).catch(function(e) { st.className = 'status error'; st.textContent = '请求失败: ' + e.message; });
}

// ===== OS 搜索 =====
var selectedOSFileId = null; var selectedOSFilename = null; var osResultsFileIds = [];
function searchOS() {
  var q = document.getElementById('rdImdbId').value.trim();
  if (!q) { alert('输入片名或 IMDB ID'); return; }
  var st = document.getElementById('rdOsStatus');
  var r = document.getElementById('rdOsResults');
  st.className = 'status loading';
  st.textContent = '搜索...';
  st.style.display = 'block';
  r.innerHTML = '';
    document.getElementById('rdOsActions').style.display = 'none';
  var url = q.match(/^tt\\d+/) ? '/api/search-subtitles?imdb_id=' + encodeURIComponent(q) : '/api/search-subtitles?query=' + encodeURIComponent(q);
  fetch(url).then(function(r2) { return r2.json(); }).then(function(d) {
    var subs = d.subtitles || [];
    if (!subs.length) { st.className = 'status error'; st.textContent = '没找到字幕'; return; }
    st.style.display = 'none';
    r.innerHTML = subs.map(function(s, i) {
      return '<div class="rd-item" ><span class="rbadge">OS</span><span class="rname">' + (s.filename || '字幕 ' + (i+1)) + '</span></div>';
    }).join('');
    osResultsFileIds = subs.map(function(s) { return s.file_id; }); window.osResultsSubs = subs; selectOS(0, subs[0].file_id);
  }).catch(function(e) { st.className = 'status error'; st.textContent = '搜索失败: ' + e.message; });
}
function selectOS(idx, fileId) {
  selectedOSFileId = fileId;
  if (typeof osResultsSubs !== 'undefined' && osResultsSubs[idx]) selectedOSFilename = osResultsSubs[idx].filename || '';
  var items = document.querySelectorAll('#rdOsResults .rd-item');
  for (var i = 0; i < items.length; i++) items[i].style.background = i === idx ? '#1a3a1a' : '';
  document.getElementById('rdOsActions').style.display = 'flex';
}
function downloadOS() {
  if (!selectedOSFileId) { alert('先选一个字幕'); return; }
  var st = document.getElementById('rdOsStatus');
  st.className = 'status loading';
  st.textContent = '下载...';
  st.style.display = 'block';
  var qName = (document.getElementById('rdImdbId').value.trim() || 'subtitle').replace(/[^a-zA-Z0-9一-鿿]/g, '.').replace(/\\.+/g, '.').replace(/^\\.|\\.$/g, '') + '.srt';
  fetch('/api/download-subtitle?file_id=' + selectedOSFileId + '&filename=' + encodeURIComponent(qName)).then(function(r) { return r.json(); }).then(function(d) {

    if (d.error) { st.className = 'status error'; st.textContent = '\u274C ' + d.error; return; }
    st.className = 'status done';
    st.innerHTML = '<div style="text-align:center;padding:8px;font-size:14px;color:#4ade80">\u2705 \u5df2\u4fdd\u5b58\u5230\u5b57\u5e55\u5e93: ' + (d.filename || '\u4e0b\u8f7d\u6210\u529f') + '</div>';
    document.getElementById('rdOsTranslateBtn').disabled = false;
  }).catch(function(e) { st.className = 'status error'; st.textContent = '\u274C ' + e.message; });

function searchExistingSubs() {
  var q = document.getElementById('existingSubSearch').value.trim().toLowerCase();
  if (!q) { alert('输入搜索词'); return; }
  var st = document.getElementById('existingSubStatus');
  var r = document.getElementById('existingSubResults');
  st.className = 'status loading';
  st.textContent = '搜索...';
  st.style.display = 'block';
  r.innerHTML = '';
  fetch('/api/search-subs?q=' + encodeURIComponent(q)).then(function(r2) { return r2.json(); }).then(function(d) {
    var files = d.files || [];
    if (!files.length) { st.className = 'status error'; st.textContent = '没找到匹配的英文字幕'; return; }
    st.style.display = 'none';
    r.innerHTML = '<div style="font-size:11px;color:#888;margin-bottom:4px">找到 ' + files.length + ' 个英文字幕：</div>';
    files.forEach(function(f) {
      var div = document.createElement('div');
      div.className = 'vitem';
      div.setAttribute('data-file', f);
      div.innerHTML = '<span class="vname">' + f + '</span>';
      div.addEventListener('click', function() {
        var st2 = document.getElementById('existingSubStatus');
        st2.className = 'status loading';
        st2.textContent = '\u23F3 \u7FFB\u8BD1\u4E2D\uFF0815-30\u79D2\uFF09...';
        st2.style.display = 'block';
        fetch('/api/translate-subtitle?file=' + encodeURIComponent(f)).then(function(r3) { return r3.json(); }).then(function(d2) {
          if (d2.error) { st2.className = 'status error'; st2.textContent = '\u274C ' + d2.error; return; }
          st2.className = 'status done';
          st2.innerHTML = '\u2705 \u53CC\u8BED\u5B57\u5E55\u5C31\u7EEA\uFF01<a href="' + d2.subtitleUrl + '" class="dl-link" download>\u2B07 ' + (d2.filename || '\u4E0B\u8F7D') + '</a>';
        });
      });
      r.appendChild(div);
    });
  }).catch(function(e) { st.className = 'status error'; st.textContent = '搜索失败: ' + e.message; });
}

function manualTranslate() {
  var fn = document.getElementById('manualTranslateFile').value.trim();
  if (!fn) { alert('输入文件名'); return; }
  var st = document.getElementById('manualTranslateStatus');
  st.className = 'status loading';
  st.textContent = '\u23F3 \u7FFB\u8BD1\u4E2D\uFF0815-30\u79D2\uFF09...';
  st.style.display = 'block';
  fetch('/api/translate-subtitle?file=' + encodeURIComponent(fn)).then(function(r) { return r.json(); }).then(function(d) {
    if (d.error) { st.className = 'status error'; st.textContent = '\u274C ' + d.error; return; }
    st.className = 'status done';
    st.innerHTML = '\u2705 \u53CC\u8BED\u5B57\u5E55\u5C31\u7EEA\uFF01<a href="' + d.subtitleUrl + '" class="dl-link" download>\u2B07 ' + (d.filename || '\u4E0B\u8F7D') + '</a>';
  }).catch(function(e) { st.className = 'status error'; st.textContent = '\u274C ' + e.message; });
}

function translateOS() {
  var fileName = (document.getElementById('rdImdbId').value.trim() || 'subtitle').replace(/[^a-zA-Z0-9]/g, '.').replace(/\\.+/g, '.').replace(/^\\.|\\.$/g, '') + '.srt';
  if (!fileName || fileName === '.srt') { alert('no file'); return; }
  var st = document.getElementById('rdOsStatus');
  st.className = 'status loading';
  st.textContent = '\u23F3 \u7FFB\u8BD1\u4E2D\uFF0815-30\u79D2\uFF09...';
  st.style.display = 'block';
  fetch('/api/translate-subtitle?file=' + encodeURIComponent(fileName)).then(function(r) { return r.json(); }).then(function(d) {
    if (d.error) { st.className = 'status error'; st.textContent = '\u274C ' + d.error + ' \u91CD\u8BD5\u8BF7\u518D\u70B9\u7FFB\u8BD1'; return; }
    st.className = 'status done';
    st.innerHTML = '\u2705 \u53CC\u8BED\u5B57\u5E55\u5C31\u7EEA\uFF01<a href="' + d.subtitleUrl + '" class="dl-link" download>\u2B07 ' + (d.filename || '\u4E0B\u8F7D') + '</a>';
  }).catch(function(e) { st.className = 'status error'; st.textContent = '\u274C ' + e.message; });
}

// 搜索 SMB 视频
let smbSearchTimer;
function searchSMB() {
  clearTimeout(smbSearchTimer);
  const q = document.getElementById('smbSearch').value;
  smbSearchTimer = setTimeout(async () => {
    const r = await fetch('/api/search-videos' + (q ? '?q=' + encodeURIComponent(q) : ''));
    const d = await r.json();
    const el = document.getElementById('smbResults');
    if (!d.videos || !d.videos.length) {
      el.innerHTML = '<div style="color:#666;font-size:13px;padding:8px 0">没有找到匹配的视频文件</div>';
      return;
    }
    el.innerHTML = el.innerHTML = '';
    d.videos.forEach(function(v) {
      var sz = v.size > 1073741824 ? (v.size/1073741824).toFixed(1)+'GB' : v.size > 1048576 ? (v.size/1048576).toFixed(0)+'MB' : (v.size/1024).toFixed(0)+'KB';
      var div = document.createElement('div');
      div.className = 'vitem';
      div.setAttribute('data-path', encodeURIComponent(v.path));
      div.innerHTML = '<span class="vname">📺 ' + v.name + '</span><span class="vsize">' + sz + '</span>';
      el.appendChild(div);
    });
  }, 300);
}

function selectSMB(path, name) {
  selectedVideo = path;
  selectedTrack = 0;
  document.getElementById('smbTracks').innerHTML = '正在探测字幕轨道…';
  document.getElementById('smbExtractBtn').style.display = 'none';
  document.getElementById('smbStatus').className = 'status loading';
  document.getElementById('smbStatus').textContent = '正在探测 ' + name + ' 的字幕轨道…';
  document.getElementById('smbStatus').style.display = 'block';

  fetch('/api/probe?url=' + encodeURIComponent(path)).then(r => r.json()).then(d => {
    if (d.error) {
      document.getElementById('smbStatus').className = 'status error';
      document.getElementById('smbStatus').textContent = '探测失败: ' + d.error;
      return;
    }
    const tracks = d.tracks || [];
    if (!tracks.length) {
      document.getElementById('smbTracks').innerHTML = '<span style="color:#f59e0b;font-size:13px">⚠️ 未检测到字幕轨道</span>';
      document.getElementById('smbStatus').style.display = 'none';
      return;
    }
    const html = tracks.map((t, i) => {
      const lang = t.tags && t.tags.language ? t.tags.language : 'unknown';
      return '<span class="track-item" id="smbTrack' + i + '" >🎬 轨道 ' + i + ' (' + lang + ')</span>';
    }).join('');
    document.getElementById('smbTracks').innerHTML = html;
    // 默认选中第一个
    selectTrack(0, 'smb');
    document.getElementById('smbExtractBtn').style.display = 'inline-block';
    document.getElementById('smbStatus').style.display = 'none';
  }).catch(e => {
    document.getElementById('smbStatus').className = 'status error';
    document.getElementById('smbStatus').textContent = '请求失败: ' + e.message;
  });
}

function selectTrack(idx, mode) {
  selectedTrack = idx;
  const prefix = mode === 'smb' ? 'smbTrack' : 'urlTrack';
  document.querySelectorAll('[id^="' + prefix + '"]').forEach(el => el.className = 'track-item');
  const el = document.getElementById(prefix + idx);
  if (el) el.className = 'track-item act';
}

// URL 模式探测
function probeUrl() {
  const url = document.getElementById('videoUrl').value.trim();
  if (!url) { alert('请输入视频 URL'); return; }
  selectedURL = url;
  selectedTrack = 0;
  document.getElementById('urlTracks').innerHTML = '正在探测…';
  document.getElementById('urlExtractBtn').style.display = 'none';
  document.getElementById('urlStatus').className = 'status loading';
  document.getElementById('urlStatus').textContent = '正在探测字幕轨道…';
  document.getElementById('urlStatus').style.display = 'block';

  fetch('/api/probe?url=' + encodeURIComponent(url)).then(r => r.json()).then(d => {
    if (d.error) {
      document.getElementById('urlStatus').className = 'status error';
      document.getElementById('urlStatus').textContent = '探测失败: ' + d.error;
      return;
    }
    const tracks = d.tracks || [];
    if (!tracks.length) {
      document.getElementById('urlTracks').innerHTML = '<span style="color:#f59e0b;font-size:13px">⚠️ 未检测到字幕轨道</span>';
      document.getElementById('urlStatus').style.display = 'none';
      return;
    }
    const html = tracks.map((t, i) => {
      const lang = t.tags && t.tags.language ? t.tags.language : 'unknown';
      return '<span class="track-item" id="urlTrack' + i + '" >🎬 轨道 ' + i + ' (' + lang + ')</span>';
    }).join('');
    document.getElementById('urlTracks').innerHTML = html;
    selectTrack(0, 'url');
    document.getElementById('urlExtractBtn').style.display = 'inline-block';
    document.getElementById('urlStatus').style.display = 'none';
  }).catch(e => {
    document.getElementById('urlStatus').className = 'status error';
    document.getElementById('urlStatus').textContent = '请求失败: ' + e.message;
  });
}

// 开始提取
function startExtract(mode) {
  const url = mode === 'smb' ? selectedVideo : selectedURL;
  if (!url) { alert('请先选择视频'); return; }
  const statusEl = document.getElementById(mode + 'Status');
  const btnEl = document.getElementById(mode + 'ExtractBtn');

  statusEl.className = 'status loading';
  statusEl.textContent = '正在提取字幕（可能需要 30-60 秒）…';
  statusEl.style.display = 'block';
  btnEl.disabled = true;

  const params = new URLSearchParams({ url, track: selectedTrack });
  fetch('/api/extract?' + params).then(r => r.json()).then(d => {
    btnEl.disabled = false;
    if (d.error) {
      statusEl.className = 'status error';
      statusEl.textContent = '❌ ' + d.error;
      return;
    }
    statusEl.className = 'status done';
    statusEl.innerHTML = '✅ 字幕就绪！<a href="' + d.subtitleUrl + '" class="dl-link" download>' +
      (d.filename || '下载双语字幕') + '</a>';
  }).catch(e => {
    btnEl.disabled = false;
    statusEl.className = 'status error';
    statusEl.textContent = '❌ 请求失败: ' + e.message;
  });
}

}

// 启动自动检测
document.addEventListener('click', function(e) {
  var t = e.target;
  if (t.classList.contains('vitem') || t.closest('.vitem')) {
    var item = t.classList.contains('vitem') ? t : t.closest('.vitem');
    var path = item.getAttribute('data-path');
    if (path) selectSMB(decodeURIComponent(path), (item.querySelector('.vname')||{}).textContent || '');
    return;
  }
  if (t.classList.contains('track-item')) {
    var idx = Array.prototype.indexOf.call(t.parentNode.children, t);
    selectTrack(idx, t.parentNode.id.replace('Tracks','').toLowerCase());
    return;
  }
  if (t.closest('#rdOsResults .rd-item')) {
    var items = Array.prototype.slice.call(t.closest('#rdOsResults').children);
    var ii = items.indexOf(t.closest('.rd-item'));
    if (typeof osResultsFileIds !== 'undefined' && osResultsFileIds[ii]) selectOS(ii, osResultsFileIds[ii]);
    return;
  }
});
checkStremioStream(); switchTab('rd'); loadRD();
</script>
</body>
</html>`;
}

// ======================== 视频字幕提取工具 ========================

const FFMPEG = '/usr/local/bin/ffmpeg';
const FFPROBE = '/usr/local/bin/ffprobe';
const NODE_BIN = '/Users/vickiepo/.nvm/versions/node/v22.22.2/bin/node';
const BILINGUAL_TOOL = path.join(__dirname, 'tools', 'srt-bilingual.js');

/** 用 ffprobe 探测视频的字幕轨道 */
function probeSubtitleTracks(videoPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFPROBE, [
      '-v', 'error',
      '-select_streams', 's',
      '-show_entries', 'stream=index:stream_tags=language,title:stream_tags=language',
      '-of', 'json',
      videoPath
    ]);
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', code => {
      if (code === 0) {
        try { resolve(JSON.parse(stdout).streams || []); }
        catch(e) { reject(new Error('解析 ffprobe 输出失败: ' + e.message)); }
      } else {
        reject(new Error('ffprobe 退出码 ' + code + ': ' + stderr.slice(-300)));
      }
    });
    proc.on('error', e => reject(new Error('ffprobe 无法启动: ' + e.message)));
  });
}

/** 从视频提取指定轨道的字幕为 SRT */
function extractSubtitleTrack(videoPath, trackIndex) {
  return new Promise(async (resolve, reject) => {
    const outFile = `/tmp/sub_extract_${Date.now()}.srt`;
    // 对 SMB 文件路径，先 dd 到本地再提取（SMB 顺序读取太慢）
    // 对 HTTP URL，直接 ffmpeg（HTTP range request 快）
    const isLocalFile = videoPath.startsWith('/') || videoPath.startsWith('file://');
    const srcPath = videoPath;

    if (isLocalFile) {
      log(`  → 本地文件，先复制到 /tmp...`);
      try {
        await new Promise((ok, fail) => {
          const dd = spawn('dd', ['if=' + videoPath.replace(/^file:\/\//, ''), 'of=' + outFile + '.input', 'bs=1M']);
          let err = '';
          dd.stderr.on('data', d => err += d);
          dd.on('close', c => c === 0 ? ok() : fail(new Error('dd 退出码 ' + c)));
          dd.on('error', e => fail(e));
        });
        log(`  → 复制完成，开始提取字幕...`);
        const st = fs.statSync(outFile + '.input');
        log(`  → 文件大小: ${(st.size / 1048576).toFixed(1)}MB`);
        await runFFmpeg(outFile + '.input', trackIndex, outFile);
        try { fs.unlinkSync(outFile + '.input'); } catch {}
        if (fs.existsSync(outFile) && fs.statSync(outFile).size > 0) return resolve(outFile);
        return reject(new Error('提取后文件为空'));
      } catch (e) {
        // dd 失败时尝试直接 ffmpeg
        log(`  → dd 失败(${e.message})，尝试直接 ffmpeg...`);
        try { fs.unlinkSync(outFile + '.input'); } catch {}
      }
    }

    // 直接 ffmpeg
    try {
      await runFFmpeg(srcPath, trackIndex, outFile);
      if (fs.existsSync(outFile) && fs.statSync(outFile).size > 0) return resolve(outFile);
      reject(new Error('提取后文件为空'));
    } catch (e) {
      reject(e);
    }

    function runFFmpeg(input, track, output) {
      return new Promise((ok, fail) => {
        const args = ['-y', '-i', input, '-map', `0:${track}`, output];
        const proc = spawn(FFMPEG, args);
        let stderr = '';
        proc.stderr.on('data', d => stderr += d);
        proc.on('close', code => {
          if (code === 0) return ok();
          fail(new Error('ffmpeg 退出码 ' + code + ': ' + stderr.slice(-300)));
        });
        proc.on('error', e => fail(new Error('ffmpeg 启动失败: ' + e.message)));
      });
    }
  });
}

/** 翻译英文字幕为双语 */
function translateToBilingual(srtFile, outputPath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(BILINGUAL_TOOL)) {
      return reject(new Error('翻译工具不存在: ' + BILINGUAL_TOOL));
    }
    execFile(NODE_BIN, [BILINGUAL_TOOL, srtFile, '-o', outputPath], {
      timeout: 300000,
      maxBuffer: 10 * 1024 * 1024
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error('翻译失败: ' + (stderr || err.message).slice(-200)));
      if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
        resolve(outputPath);
      } else {
        reject(new Error('翻译后文件为空'));
      }
    });
  });
}

/** 生成字幕文件名（从视频文件名推 SxxExx） */
function genSubtitleFilename(videoName, trackLang, trackIndex) {
  const base = path.basename(videoName, path.extname(videoName));
  const se = base.match(/S(\\d{2})E(\\d{2})/i);
  const lang = (trackLang || 'en').toLowerCase();
  const langTag = lang === 'en' ? 'zh-en' : lang + '-zh';
  if (se) {
    return `TV/${base.replace(/\.[^/.]+$/, '')}.${langTag}.srt`;
  }
  return `Movies/${base}.${langTag}.srt`;
}

/** 扫描 SMB 视频目录，返回文件列表 */
function scanSMBVideos(searchTerm) {
  const dirs = ['/Volumes/Media/TV', '/Volumes/Media/Movies'];
  const results = [];
  const q = (searchTerm || '').toLowerCase();
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        if (e.isFile() && /\.(mkv|mp4|avi|mov|ts|m2ts)$/i.test(e.name)) {
          if (q && !e.name.toLowerCase().includes(q)) continue;
          const fp = path.join(dir, e.name);
          const st = fs.statSync(fp);
          results.push({ name: e.name, path: fp, dir: path.basename(dir), size: st.size });
        }
      }
    } catch {}
  }
  results.sort((a, b) => a.name.localeCompare(b.name));
  return results;
}

// ====== Real-Debrid API ======
const RD_API_KEY = (() => {
  try {
    const c = fs.readFileSync(path.join(__dirname, '.env-rd'), 'utf-8');
    const m = c.match(/^RD_API_KEY=(.+)$/m);
    return m ? m[1].trim() : '';
  } catch { return ''; }
})();

function fetchRDDownloads(limit) {
  limit = limit || 10;
  return new Promise((resolve) => {
    if (!RD_API_KEY) return resolve([]);
    const u = new URL('https://api.real-debrid.com/rest/1.0/downloads');
    u.searchParams.set('limit', String(limit));
    https.get(u, { headers: { 'Authorization': 'Bearer ' + RD_API_KEY }, timeout: 10000 }, (r) => {
      let d = '';
      r.on('data', chunk => d += chunk);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve([]); } });
    }).on('error', () => resolve([]));
  });
}

// ====== OpenSubtitles API ======
const OS_API_KEY = (() => {
  try {
    const c2 = fs.readFileSync(path.join(__dirname, '.env-os'), 'utf-8');
    const m = c2.match(/^OS_API_KEY=(.+)$/m);
    return m ? m[1].trim() : '';
  } catch { return ''; }
})();
const OS_TOKEN = (() => {
  try {
    const c2 = fs.readFileSync(path.join(__dirname, '.env-os'), 'utf-8');
    const m = c2.match(/^OS_TOKEN=(.+)$/m);
    return m ? m[1].trim() : '';
  } catch { return ''; }
})();

function searchOpenSubtitles(imdbId, season, episode, query) {
  return new Promise((resolve) => {
    if (!OS_API_KEY) return resolve([]);
    let path2;
    if (query) {
      path2 = '/api/v1/subtitles?query=' + encodeURIComponent(query.toLowerCase()) + '&languages=en';
      if (season != null) path2 += '&season_number=' + season + '&episode_number=' + (episode || 1);
    } else {
      path2 = '/api/v1/subtitles?imdb_id=' + imdbId.replace(/^tt/, '') + '&languages=en';
    }
    osApiFetch(path2, resolve);
  });
}
function osApiFetch(path2, resolve, retries) {
  retries = retries || 0;
  if (retries > 3) { resolve([]); return; }
  const req = https.request({
    hostname: 'api.opensubtitles.com', path: path2, timeout: 15000,
    headers: { 'Api-Key': OS_API_KEY, 'User-Agent': 'stremio-local-subs/1.0' }
  }, (r) => {
    let d = '';
    r.on('data', chunk => d += chunk);
    r.on('end', () => {
      if (r.statusCode >= 301 && r.statusCode <= 303 && r.headers.location) {
        osApiFetch(r.headers.location, resolve, retries + 1);
        return;
      }
      try {
        const data = JSON.parse(d);
        const subs = (data.data || []).filter(s => { const a = s.attributes || {}; return a.language === 'en' && a.files && a.files.length > 0; });
        subs.sort((a, b) => (b.attributes.download_count || 0) - (a.attributes.download_count || 0));
        resolve(subs.slice(0, 5).map(s => ({ id: 'os-' + s.id, file_id: s.attributes.files[0].file_id, lang: 'English', filename: s.attributes.files[0].file_name || '' })));
      } catch { resolve([]); }
    });
  });
  req.on('error', () => resolve([]));
  req.end();
}
function osDownload(fileId) {
  return new Promise((resolve, reject) => {
    if (!OS_API_KEY || !OS_TOKEN) return reject(new Error('no OS creds'));
    const body = JSON.stringify({ file_id: fileId });
    const curl = spawn('/usr/bin/curl', [
      '-s', '-X', 'POST',
      '-H', 'Api-Key: ' + OS_API_KEY,
      '-H', 'Authorization: Bearer ' + OS_TOKEN,
      '-H', 'Content-Type: application/json',
      '-H', 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      '-d', body,
      'https://api.opensubtitles.com/api/v1/download'
    ], { timeout: 20000 });
    let stdout = '', stderr = '';
    curl.stdout.on('data', d => stdout += d);
    curl.stderr.on('data', d => stderr += d);
    curl.on('close', code => {
      if (code !== 0) return reject(new Error('curl exit ' + code));
      try { const data = JSON.parse(stdout); if (data.link) resolve(data.link); else reject(new Error('no link')); }
      catch (e) { reject(new Error(stderr.slice(0, 100) || 'parse fail')); }
    });
    curl.on('error', reject);
  });
}

// ======================== HTTP 服务器 ========================

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const from = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?';
  log(`${req.method} ${pathname} from ${from}`);
  const start = Date.now();
  const done = () => log(`${Date.now() - start}ms ${pathname}`);
  res.on('finish', done);

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    // ---- 路由: Addon 清单 (manifest.json 是标准名, addon.json 兼容) ----
    if (pathname === '/manifest.json' || pathname === '/addon.json') {
      const manifest = {
        id: 'com.vickiepo.local-subs',
        version: '1.4.0',
        name: '📁 本地字幕',
        description: '从 iMac ~/.stremio-subs/ 加载本地 .srt 字幕文件',
        logo: '',
        background: '',
        resources: ['subtitles'],
        types: ['movie', 'series'],
        idPrefixes: ['tt', 'smb_'],
        catalogs: [],
        behaviorHints: {
          configurable: false,
          configurationRequired: false
        }
      };
      return serveJSON(res, manifest);
    }

    // ---- 路由: 主页 - 手机端字幕浏览器 ----
    if (pathname === '/') {
      const query = (parsed.query.q || '').trim();
      const typeFilter = parsed.query.type || 'all';
      const searchLower = query.toLowerCase();

      let files = scanSubFiles(SUBS_DIR);
      const totalCount = files.length;

      if (searchLower) {
        files = files.filter(fp => path.basename(fp).toLowerCase().includes(searchLower));
      }

      const items = files.map(fp => {
        const fname = path.basename(fp);
        const relPath = path.relative(SUBS_DIR, fp);
        const encodedRel = relPath.split(path.sep).map(s => encodeURIComponent(s)).join('/');
        const se = fname.match(/S(\\d{2})E(\\d{2})/i);
        const lang = guessLang(fname);
        const ext = path.extname(fname).toLowerCase();
        const type = se ? 'series' : 'movie';
        return { fname, relPath, encodedRel, se, lang, ext, type };
      });

      let filtered = items;
      if (typeFilter === 'series') filtered = items.filter(f => f.type === 'series');
      else if (typeFilter === 'movie') filtered = items.filter(f => f.type === 'movie');

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(renderBrowserPage(filtered, query, typeFilter, totalCount));
    }

    // ---- 路由: 字幕提取工具页面 ----
    if (pathname === '/extract') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(renderExtractPage());
    }

    // ---- API: 搜索 SMB 视频 ----
    if (pathname === '/api/search-videos') {
      const q = (parsed.query.q || '').trim();
      const results = scanSMBVideos(q);
      // 也尝试探测当前 Stremio 流
      let currentStream = null;
      try {
        const s = http.get('http://localhost:11470/stats.json', { timeout: 3000 }, r => {
          let d = '';
          r.on('data', c => d += c);
          r.on('end', () => {
            try { const j = JSON.parse(d); if (Object.keys(j).length) currentStream = j; } catch {}
          });
        });
        s.on('error', () => {});
        s.end();
      } catch {}
      return serveJSON(res, { videos: results.slice(0, 200), currentStream });
    }

    // ---- API: RD 最近下载 ----
    if (pathname === '/api/rd-downloads') {
      fetchRDDownloads(10).then(function(list) {
        var videos = (list || []).filter(function(f) { return /\.(mkv|mp4|avi|mov|ts)$/i.test(f.filename || '') });
        serveJSON(res, { downloads: videos });
      }).catch(function() { serveJSON(res, { downloads: [] }); });
      return;
    }

    // ---- API: OS 搜索 ----
    if (pathname === '/api/search-subtitles') {
      var imdbId = (parsed.query.imdb_id || '').replace(/^tt/, '');
      var query = parsed.query.query || '';
      if (!imdbId && !query) { res.writeHead(400); return res.end(JSON.stringify({ error: 'need imdb_id or query' })); }
      searchOpenSubtitles('tt' + imdbId, null, null, query).then(function(subs) {
        serveJSON(res, { subtitles: subs });
      }).catch(function() { serveJSON(res, { subtitles: [] }); });
      return;
    }

    // ---- API: OS 下载 ----
    if (pathname === '/api/download-subtitle') {
      var fileId = parseInt(parsed.query.file_id || '0', 10);
      var fileName = parsed.query.filename || '';
      if (!fileId) { res.writeHead(400); return res.end(JSON.stringify({ error: 'need file_id' })); }
      // 清理文件名，保留 SxxExx 和剧名
      var cleanName = fileName.replace(/[^a-zA-Z0-9.\- \[\]]/g, '').replace(/\s+/g, ' ').trim();
      if (!cleanName || cleanName.length < 5) cleanName = 'os_' + fileId + '.srt';
      if (!cleanName.endsWith('.srt')) cleanName = cleanName.replace(/\.[^/.]+$/, '') + '.srt';
      (async function() {
        try {
          var dlUrl = await osDownload(fileId);
          var u = new URL(dlUrl);
          https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 30000 }, function(r) {
            var chunks = [];
            r.on('data', function(c) { chunks.push(c); });
            r.on('end', function() {
              var outDir = path.join(SUBS_DIR, 'TV');
              if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
              var outFile = path.join(outDir, cleanName);
              fs.writeFileSync(outFile, Buffer.concat(chunks));
              log('OS 下载完成: ' + outFile);
              var encodedName = encodeURIComponent(cleanName);
              serveJSON(res, { success: true, subtitleUrl: '/subs/TV/' + encodedName, filename: cleanName, fileId: fileId });
            });
          });
        } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      })();
      return;
    }

    // ---- API: 搜索已有字幕 ----
    if (pathname === '/api/search-subs') {
      var q = (parsed.query.q || '').toLowerCase();
      var files = [];
      try {
        var dir = path.join(SUBS_DIR, 'TV');
        if (fs.existsSync(dir)) {
          fs.readdirSync(dir).forEach(function(f) {
            if (f.endsWith('.srt') && !f.endsWith('.zh-en.srt') && f.toLowerCase().includes(q)) {
              files.push(f);
            }
          });
        }
        fs.readdirSync(SUBS_DIR).forEach(function(f) {
          if (f.endsWith('.srt') && !f.endsWith('.zh-en.srt') && f.toLowerCase().includes(q)) {
            files.push(f);
          }
        });
      } catch {}
      files.sort();
      serveJSON(res, { files: files.slice(0, 50) });
      return;
    }

    if (pathname === '/api/translate-subtitle') {
      var fileParam = parsed.query.file || '';
      if (!fileParam) { res.writeHead(400); return res.end(JSON.stringify({ error: 'need file' })); }
      (async function() {
        try {
          var inFile = path.join(SUBS_DIR, 'TV', fileParam);
          if (!fs.existsSync(inFile)) { res.writeHead(404); return res.end(JSON.stringify({ error: 'file not found: ' + fileParam })); }
          var ext = path.extname(fileParam);
          var base = path.basename(fileParam, ext);
          var outFile = path.join(SUBS_DIR, 'TV', base + '.zh-en.srt');
          await translateToBilingual(inFile, outFile);
          log('翻译完成: ' + outFile);
          serveJSON(res, { success: true, subtitleUrl: '/subs/TV/' + encodeURIComponent(base + '.zh-en.srt'), filename: base + '.zh-en.srt' });
        } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      })();
      return;
    }

    // ---- API: OS 字幕翻译 ----
    if (pathname === '/api/translate-subtitle') {
      var fileId = parseInt(parsed.query.file_id || '0', 10);
      if (!fileId) { res.writeHead(400); return res.end(JSON.stringify({ error: 'need file_id' })); }
      (async function() {
        try {
          var inFile = path.join(SUBS_DIR, 'TV', 'os_' + fileId + '.srt');
          var outFile = path.join(SUBS_DIR, 'TV', 'os_' + fileId + '.zh-en.srt');
          if (!fs.existsSync(inFile)) { res.writeHead(404); return res.end(JSON.stringify({ error: 'file not found' })); }
          await translateToBilingual(inFile, outFile);
          log('OS 翻译完成: ' + outFile);
          serveJSON(res, { success: true, subtitleUrl: '/subs/TV/os_' + fileId + '.zh-en.srt', filename: 'os_' + fileId + '.zh-en.srt' });
        } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      })();
      return;
    }

    // ---- API: 探测视频字幕轨道 ----
    if (pathname === '/api/probe') {
      const videoUrl = parsed.query.url || '';
      if (!videoUrl) { res.writeHead(400); return res.end(JSON.stringify({ error: '缺少 url 参数' })); }

      probeSubtitleTracks(videoUrl).then(tracks => {
        serveJSON(res, { tracks });
      }).catch(err => {
        serveJSON(res, { error: err.message, tracks: [] });
      });
      return;
    }

    // ---- API: 提取 + 翻译字幕 ----
    if (pathname === '/api/extract') {
      const videoUrl = parsed.query.url || '';
      const trackIdx = parseInt(parsed.query.track || '0', 10);
      const trackLang = parsed.query.lang || '';
      if (!videoUrl) { res.writeHead(400); return res.end(JSON.stringify({ error: '缺少 url 参数' })); }

      // 异步处理，用 IIFE 包装
      (async () => {
        const timeout = setTimeout(() => {
          try { res.writeHead(504); res.end(JSON.stringify({ error: '处理超时' })); } catch {}
        }, 300000);
        try {
          log(`提取字幕: track=${trackIdx} url=${videoUrl.slice(0, 80)}...`);
          const srtFile = await extractSubtitleTrack(videoUrl, trackIdx);
          log(`提取完成: ${srtFile} (${fs.statSync(srtFile).size} bytes)`);

          const videoName = decodeURIComponent(videoUrl.split('/').pop() || 'video').replace(/\.[^/.]+$/, '');
          const subFilename = genSubtitleFilename(videoName, trackLang, trackIdx);
          const outputPath = path.join(SUBS_DIR, subFilename);
          const outputDir = path.dirname(outputPath);
          if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

          log(`开始翻译...`);
          try {
            await translateToBilingual(srtFile, outputPath);
            log(`翻译完成: ${outputPath}`);
          } catch (e) {
            log(`翻译失败(${e.message})，保留原文`);
            fs.copyFileSync(srtFile, outputPath);
          }
          try { fs.unlinkSync(srtFile); } catch {}

          const encodedPath = subFilename.split(path.sep).map(s => encodeURIComponent(s)).join('/');
          const dlUrl = `/subs/${encodedPath}`;
          clearTimeout(timeout);
          return serveJSON(res, { success: true, subtitleUrl: dlUrl, filename: path.basename(outputPath) });
        } catch (e) {
          clearTimeout(timeout);
          log(`提取失败: ${e.message}`);
          res.writeHead(500);
          return res.end(JSON.stringify({ error: e.message }));
        }
      })();
      return;
    }
    //   /subtitles/series/tt7587890:8:5/filename=xxx.mkv.json         ← mediaId 里带 :season:episode
    //   /subtitles/series/tt1234567/1-2.json                           ← extra 带 season-episode
    //   /subtitles/movie/tt1234567.json
    const subMatch = pathname.match(/^\/subtitles\/(movie|series)\/([^/]+?)(?:\/([^/]+?))?\.json$/);
    if (subMatch) {
      const mediaType = subMatch[1];
      const mediaId = subMatch[2];
      const extra = subMatch[3] || '';

      // 解码 mediaId (可能含 %3A 即 ":")
      let decodedId = decodeURIComponent(mediaId);

      // smb_<base64> → 从 TMDB 缓存查 IMDB ID
      if (decodedId.startsWith('smb_')) {
        try {
          const cachePath = path.join(os.homedir(), '.smb-tmdb-cache.json');
          if (fs.existsSync(cachePath)) {
            const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
            const b64 = decodedId.slice(4);
            for (const [relPath, meta] of Object.entries(cache)) {
              if (meta && meta.imdbId) {
                const encoded = Buffer.from(relPath, 'utf-8').toString('base64url');
                if (encoded === b64) {
                  decodedId = meta.imdbId;
                  log(`  ↪ smb → tt: ${meta.imdbId} (${meta.title})`);
                  // 顺便取出季集号，后面字幕匹配用
                  if (meta.season != null && meta.episode != null) {
                    decodedId += `:${meta.season}:${meta.episode}`;
                    log(`  ↪ 附加季集: S${meta.season}E${meta.episode}`);
                  }
                  break;
                }
              }
            }
          }
        } catch (e) {
          log(`  ⚠ smb 转 tt 失败: ${e.message}`);
        }
      }

      let season = null;
      let episode = null;

      // 1) 从 decodedId 解析 :season:episode (如 tt7587890:8:5)
      const idSeMatch = decodedId.match(/:(\d+):(\d+)$/);
      if (idSeMatch) {
        season = parseInt(idSeMatch[1]);
        episode = parseInt(idSeMatch[2]);
      }

      // 2) 从 extra 解析 "season-episode" (如 "1-2")
      if (season == null) {
        const seMatch = extra.match(/^(\d+)-(\d+)$/);
        if (seMatch) {
          season = parseInt(seMatch[1]);
          episode = parseInt(seMatch[2]);
        }
      }

      // 3) 从 extra 的 filename 中搜 SxxExx
      if (season == null) {
        const fileSeMatch = extra.match(/S(\\d{2})E(\\d{2})/i);
        if (fileSeMatch) {
          season = parseInt(fileSeMatch[1]);
          episode = parseInt(fileSeMatch[2]);
        }
      }

      // 4) 从 query string fallback
      if (season == null && parsed.query.season) season = parseInt(parsed.query.season);
      if (episode == null && parsed.query.episode) episode = parseInt(parsed.query.episode);

      // 5) movie 类型的 tt ID → 查 TMDB 缓存是否有季集号
      if (season == null && mediaType === 'movie' && /^tt\d+$/i.test(decodedId)) {
        try {
          const cachePath = path.join(os.homedir(), '.smb-tmdb-cache.json');
          if (fs.existsSync(cachePath)) {
            const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
            for (const [, meta] of Object.entries(cache)) {
              if (meta && meta.imdbId && meta.imdbId.toLowerCase() === decodedId.toLowerCase()) {
                if (meta.season != null && meta.episode != null) {
                  season = meta.season;
                  episode = meta.episode;
                  log(`  ↪ 从 TMDB 缓存找到季集: S${season}E${episode}`);
                  break;
                }
              }
            }
          }
        } catch (e) {
          log(`  ⚠ TMDB 缓存查询失败: ${e.message}`);
        }
      }

      // 从 extra 中提取视频文件名 → 剧名（用于字幕过滤）
      let showFilter = '';
      const decodedExtra = decodeURIComponent(extra);
      const fnMatch = decodedExtra.match(/filename=(.+?)(?:\.(?:mkv|mp4|avi|mov|ts|m2ts))(?:\&|$)/i);
      if (fnMatch) {
        const basename = path.basename(fnMatch[1], path.extname(fnMatch[1]));
        // 匹配 S##E## 或 - S##E## -，取前面的部分作为剧名
        const showPart = basename.split(/[.\s-]+S\d{2}E\d{2}[.\s-]+/i)[0];
        if (showPart) showFilter = showPart.replace(/[.\s-]+/g, ' ').toLowerCase().trim();
      }

      let matchingFiles = [];

      if (season != null && episode != null) {
        matchingFiles = findSubsByEpisode(season, episode);
        // 用剧名过滤：只保留文件名/路径含剧名的字幕
        if (showFilter) {
          const keywords = showFilter.split(' ').filter(k => k.length > 3); // 只保留有意义的词
          matchingFiles = matchingFiles.filter(fp => {
            const lower = fp.toLowerCase();
            return keywords.every(kw => lower.includes(kw));
          });
        }
      } else {
        matchingFiles = scanSubFiles(SUBS_DIR);
        const seInName = decodedId.match(/S(\\d{2})E(\\d{2})/i);
        if (seInName) {
          const seStr = 'S' + seInName[1] + 'E' + seInName[2];
          matchingFiles = matchingFiles.filter(f =>
            path.basename(f).toUpperCase().includes(seStr)
          );
        }
      }

      const subtitles = matchingFiles.map((fp, i) => {
        const fname = path.basename(fp);
        const id = subIdCounter++;
        subIdMap[id] = fp;
        return {
          id: `sub-${id}`,
          url: `http://${LAN_IP}:${PORT}/subs/TV/${id}.srt`,
          lang: guessLang(fname),
        };
      });

      return serveJSON(res, { subtitles });
    }

    // /subs/TV/filename.srt  — 旧方式（兼容）
    // 先检查 ID 映射
    const tvIdMatch = pathname.match(/^\/subs\/TV\/(\d+)\.srt$/);
    if (tvIdMatch) {
      const id = parseInt(tvIdMatch[1], 10);
      const mappedPath = subIdMap[id];
      if (mappedPath && fs.existsSync(mappedPath) && fs.statSync(mappedPath).isFile()) {
        const ext = path.extname(mappedPath).toLowerCase();
        let content = fs.readFileSync(mappedPath, 'utf-8');
        // ASS → SRT 转换（Stremio 代理不支持 ASS）
        if (ext === '.ass' || ext === '.ssa') content = assToSrt(content);
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Length': Buffer.byteLength(content, 'utf-8')
        });
        return res.end(content);
      }
    }
    const decodedPath = decodeURIComponent(pathname);
    if (decodedPath.startsWith('/subs/')) {
      const relPath = decodedPath.slice(6);
      const safePath = path.resolve(path.join(SUBS_DIR, relPath));
      if (!safePath.startsWith(path.resolve(SUBS_DIR))) {
        res.writeHead(403);
        return res.end('Forbidden');
      }
      if (fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
        const ext = path.extname(safePath).toLowerCase();
        const mimeMap = { '.srt': 'text/plain', '.ass': 'text/plain', '.ssa': 'text/plain' };
        res.writeHead(200, {
          'Content-Type': mimeMap[ext] || 'application/octet-stream'
        });
        return fs.createReadStream(safePath).pipe(res);
      }
    }

    // ---- 404 ----
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));

  } catch (err) {
    console.error('请求处理出错:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

function serveJSON(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data, null, 2) + '\n');
}

// ======================== 启动 ========================

server.listen(PORT, HOST, () => {
  console.log(`\n  🎬 Stremio 本地字幕服务器`);
  console.log(`  ─────────────────────────────`);
  console.log(`  Addon:  http://${LAN_IP}:${PORT}/addon.json`);
  console.log(`  字幕浏览器: http://${LAN_IP}:${PORT}`);
  console.log(`  字幕目录: ${SUBS_DIR}`);
  console.log(`  字幕文件: ${scanSubFiles(SUBS_DIR).length} 个\n`);
  console.log(`  在 Stremio 中安装:`);
  console.log(`  1. 浏览器打开上面的 addon.json 地址`);
  console.log(`  2. 点击 "Install"`);
  console.log(`  3. 或: Stremio → Addons → 输入 URL 安装\n`);
});

process.on('SIGINT', () => { console.log('\n服务器停止'); process.exit(0); });
process.on('SIGTERM', () => { console.log('\n服务器停止'); process.exit(0); });
