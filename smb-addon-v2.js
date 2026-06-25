#!/usr/bin/env node
/**
 * smb-addon-v2.js — SMB 本地媒体（SDK 式架构，同 Intelligent Debrid Search）
 *
 * 直接用 URL 路由匹配，handler 格式与 stremio-addon-sdk 一致。
 * 零依赖。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const os = require('os');
const https = require('https');

// ======================== 配置 ========================
const PORT = parseInt(process.env.PORT || '5802', 10);
const MEDIA_DIR = process.env.MEDIA_DIR;
if (!MEDIA_DIR || !fs.existsSync(MEDIA_DIR)) {
  console.error('❌ 请设置有效的 MEDIA_DIR');
  process.exit(1);
}

const SUBS_DIR = path.join(os.homedir(), '.stremio-subs');
const TMDB_CACHE_FILE = path.join(os.homedir(), '.smb-tmdb-cache.json');
const TMDB_KEY = (() => {
  let k = process.env.TMDB_API_KEY || '';
  if (!k) try {
    const c = fs.readFileSync(path.join(__dirname, '.env-catalog'), 'utf-8');
    const m = c.match(/^TMDB_API_KEY=(.+)$/m);
    if (m) k = m[1].trim();
  } catch {}
  return k;
})();

const LAN_IP = (() => {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets).sort()) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal && net.address.startsWith('192.168.')) return net.address;
    }
  }
  return '127.0.0.1';
})();
const BASE_URL = `http://${LAN_IP}:${PORT}`;
const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.m4v', '.webm', '.flv', '.ts', '.m2ts', '.iso']);

// ======================== 工具 ========================
function encodeId(s) { return Buffer.from(s, 'utf-8').toString('base64url'); }
function decodeId(s) { return Buffer.from(s, 'base64url').toString('utf-8'); }
function extractSE(name) { const m = name.match(/S(\d{2})E(\d{2})/i); return m ? { s: parseInt(m[1]), e: parseInt(m[2]) } : null; }
function fmtSize(b) { if (!b) return '?'; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0, s = b; while (s >= 1024 && i < 4) { s /= 1024; i++; } return s.toFixed(i > 0 ? 1 : 0) + ' ' + u[i]; }

// ======================== TMDB 缓存 ========================
let tmdbCache = {};
try { tmdbCache = JSON.parse(fs.readFileSync(TMDB_CACHE_FILE, 'utf-8')); } catch { tmdbCache = {}; }

// ======================== 文件扫描 ========================
const SKIP_DIRS = new Set(['lost+found', 'opt', 'xiaomi_camera_videos', '__MACOSX', 'System Volume Information', '$Recycle.Bin', '.Trashes', '.Spotlight-V100', '.fseventsd']);
let fileCache = [];
let lastScan = 0;

function scanMediaDir() {
  const files = [];
  const start = Date.now();
  function walk(dir, rel, depth) {
    if (depth > 3) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const fp = path.join(dir, e.name);
      const rp = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) walk(fp, rp, depth + 1);
      else if (e.isFile() && VIDEO_EXTS.has(path.extname(e.name).toLowerCase())) {
        let st;
        try { st = fs.statSync(fp); } catch { continue; }
        files.push({ relPath: rp, fullPath: fp, name: path.basename(e.name, path.extname(e.name)), size: st.size, mtime: st.mtimeMs, se: extractSE(e.name) });
      }
    }
  }
  walk(MEDIA_DIR, '', 0);
  files.sort((a, b) => b.mtime - a.mtime);
  fileCache = files;
  lastScan = Date.now();
  console.log(`📂 ${files.length} 个文件 (${Date.now() - start}ms)`);
}
scanMediaDir();

function getFiles() { if (Date.now() - lastScan > 60000) scanMediaDir(); return fileCache; }

// ======================== 按 ID 找文件 ========================
function findFile(id) {
  const files = getFiles();
  const idStr = String(id);

  // ttXXXXXX:S:E → 查 TMDB 缓存 + 匹配季集
  if (/^tt\d+/i.test(idStr)) {
    const parts = idStr.split(':');
    const imdbId = parts[0].toLowerCase();
    const reqS = parts[1] ? parseInt(parts[1]) : null;
    const reqE = parts[2] ? parseInt(parts[2]) : null;
    for (const f of files) {
      const meta = tmdbCache[f.relPath];
      if (!meta || !meta.imdbId || meta.imdbId.toLowerCase() !== imdbId) continue;
      if (reqS != null && reqE != null) {
        if (meta.season === reqS && meta.episode === reqE) return f;
      } else {
        return f; // 无季集要求返回第一个匹配
      }
    }
    return null;
  }

  // smb_<base64>
  const cleaned = idStr.startsWith('smb_') ? idStr.slice(4) : idStr;
  try { const rp = decodeId(cleaned); return files.find(f => f.relPath === rp) || null; } catch { return null; }
}

// ======================== Manifest ========================
const MANIFEST = {
  id: 'com.vickiepo.smb-local-v3',
  version: '3.7.0',
  name: 'SMB 本地媒体',
  description: '播放 SMB 共享目录中的视频文件',
  resources: ['catalog', 'stream', 'meta', 'subtitles'],
  types: ['movie', 'series'],
  idPrefixes: ['smb_', 'tt'],
  catalogs: [
    { type: 'movie', id: 'smb-local', name: '📁 SMB 本地 · 电影', extra: [{ name: 'search', isRequired: false }] },
    { type: 'series', id: 'smb-local', name: '📁 SMB 本地 · 剧集', extra: [{ name: 'search', isRequired: false }] },
  ],
  behaviorHints: { configurable: false, configurationRequired: false },
};

// ======================== 处理器 ========================
const handlers = {};

function define(name, fn) { handlers[name] = fn; }

define('catalog', async (args) => {
  let files = getFiles();
  // 按请求的类型过滤（movie 或 series）
  if (args.type === 'series') {
    files = files.filter(f => f.se);
  } else {
    files = files.filter(f => !f.se);
  }
  if (args.extra.search) {
    const q = args.extra.search.toLowerCase();
    files = files.filter(f => f.name.toLowerCase().includes(q));
  }
  const metas = files.map(f => {
    const meta = tmdbCache[f.relPath];
    const id = meta && meta.imdbId
      ? (meta.season != null ? `${meta.imdbId}:${meta.season}:${meta.episode}` : meta.imdbId)
      : `smb_${encodeId(f.relPath)}`;
    const item = {
      id, type: f.se ? 'series' : 'movie',
      name: (meta && meta.title) || f.name,
      posterShape: 'poster',
      description: (meta && meta.overview) || `${f.relPath}\n${fmtSize(f.size)}`,
    };
    if (f.se) { item.name += ` S${String(f.se.s).padStart(2, '0')}E${String(f.se.e).padStart(2, '0')}`; item.releaseInfo = `S${String(f.se.s).padStart(2, '0')}E${String(f.se.e).padStart(2, '0')}`; }
    if (meta) { item.year = meta.year ? parseInt(meta.year) : undefined; if (meta.poster) item.poster = meta.poster; if (meta.background) item.background = meta.background; }
    else item.year = undefined;
    return item;
  });
  return { metas: metas.slice(0, 100), cacheMaxAge: 300 };
});

define('meta', async (args) => {
  const id = String(args.id);
  const file = findFile(id);
  if (!file) return { meta: null };
  const meta = tmdbCache[file.relPath];
  const metaId = meta && meta.imdbId ? (meta.season != null ? `${meta.imdbId}:${meta.season}:${meta.episode}` : meta.imdbId) : `smb_${encodeId(file.relPath)}`;
  const metaObj = {
    id: metaId,
    type: (meta && meta.season != null) ? 'series' : 'movie',
    name: (meta && meta.title) || file.name,
    poster: meta ? meta.poster : undefined, posterShape: 'poster',
    description: (meta && meta.overview) || `📂 ${file.relPath}\n💾 ${fmtSize(file.size)}`,
  };
  if (meta && meta.season != null && meta.episode != null) {
    metaObj.videos = [{ id: metaId, season: meta.season, episode: meta.episode, title: meta.title || file.name }];
  }
  return { meta: metaObj, cacheMaxAge: 300 };
});

define('stream', async (args) => {
  const file = findFile(args.id);
  if (!file) return { streams: [] };
  return {
    streams: [{
      url: `${BASE_URL}/file/${encodeId(file.relPath)}`,
      title: `📁 SMB 本地 · ${fmtSize(file.size)}`,
      behaviorHints: { notWebReady: false, bingeGroup: 'SMB-LOCAL', filename: path.basename(file.relPath) },
    }],
    cacheMaxAge: 30,
  };
});

define('subtitles', async (args) => {
  const file = findFile(args.id);
  if (!file) return { subtitles: [] };
  const se = file.se || extractSE(file.name);
  const subs = [];
  if (se) {
    const s = String(se.s).padStart(2, '0');
    const e = String(se.e).padStart(2, '0');
    const pat = new RegExp(`S${s}E${e}`, 'i');
    if (fs.existsSync(SUBS_DIR)) {
      const scan = (dir) => { const r = []; try { for (const en of fs.readdirSync(dir, { withFileTypes: true })) { if (en.name.startsWith('.')) continue; const fp = path.join(dir, en.name); if (en.isDirectory()) r.push(...scan(fp)); else if (/\.(srt|ass|ssa)$/i.test(en.name)) r.push(fp); } } catch {} return r; };
      for (const fp of scan(SUBS_DIR)) {
        if (pat.test(path.basename(fp))) {
          const lang = (() => { const l = path.basename(fp).toLowerCase(); if (/chi|zho|zh|chs|cht|chinese|简体|繁体|中文/i.test(l)) return 'Chinese'; if (/eng|en|english/i.test(l)) return 'English'; return 'Chinese'; })();
          subs.push({ id: `sub-${subs.length}`, url: `${BASE_URL}/subs/${encodeURIComponent(path.relative(SUBS_DIR, fp))}`, lang });
        }
      }
    }
  }
  return { subtitles: subs };
});

// ======================== SDK 式路由 ========================
function server(req, res) {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const method = req.method;

  const ts = new Date().toISOString().slice(11, 19);
  const from = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?';

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {
    // Manifest
    if (pathname === '/manifest.json') {
      return json(res, MANIFEST);
    }

    // 主页
    if (pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>SMB 本地媒体</title><style>body{font-family:-apple-system,sans-serif;max-width:600px;margin:40px auto;padding:0 20px;line-height:1.6}.btn{display:inline-block;padding:12px 28px;background:#8246e5;color:#fff;text-decoration:none;border-radius:8px;font-size:16px;margin:10px 0}.btn:hover{background:#6b3bc4}pre{background:#f4f4f4;padding:12px;border-radius:6px;font-size:13px}</style></head><body><h1>📺 SMB 本地媒体</h1><p>${getFiles().length} 个视频文件</p><a class="btn" href="stremio://${LAN_IP}:${PORT}/manifest.json">📦 安装到 Stremio</a><p>或手动输入：</p><pre>http://${LAN_IP}:${PORT}/manifest.json</pre></body></html>`);
      return;
    }

    // 字幕文件服务
    if (pathname.startsWith('/subs/')) {
      const decoded = decodeURIComponent(pathname.slice(6));
      const safe = path.resolve(path.join(SUBS_DIR, decoded));
      if (!safe.startsWith(path.resolve(SUBS_DIR))) { res.writeHead(403); res.end('Forbidden'); return; }
      if (!fs.existsSync(safe) || !fs.statSync(safe).isFile()) { res.writeHead(404); res.end('Not Found'); return; }
      const ext = path.extname(safe).toLowerCase();
      res.writeHead(200, { 'Content-Type': ext === '.srt' ? 'text/plain; charset=utf-8' : 'text/plain; charset=utf-8' });
      fs.createReadStream(safe).pipe(res);
      return;
    }

    // 视频文件服务
    if (pathname.startsWith('/file/')) {
      let relPath;
      try { relPath = decodeId(pathname.slice(6)); } catch { res.writeHead(400); res.end('Bad id'); return; }
      const safe = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, '');
      const fp = path.join(MEDIA_DIR, safe);
      if (!fp.startsWith(path.resolve(MEDIA_DIR))) { res.writeHead(403); res.end('Forbidden'); return; }
      let st;
      try { st = fs.statSync(fp); } catch { res.writeHead(404); res.end('Not Found'); return; }
      const ext = path.extname(fp).toLowerCase();
      const range = req.headers.range;
      if (range) {
        const p = range.replace(/bytes=/, '').split('-');
        const start = parseInt(p[0]);
        const end = p[1] ? parseInt(p[1]) : st.size - 1;
        res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': 'video/mp4' });
        fs.createReadStream(fp, { start, end }).pipe(res);
      } else {
        res.writeHead(200, { 'Content-Length': st.size, 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' });
        fs.createReadStream(fp).pipe(res);
      }
      return;
    }

    // SDK 式路由: /:resource/:type/:id.json  或 /:resource/:type/:id/:extra?.json
    // 同 stremio-addon-sdk 的 getRouter
    const routeMatch = pathname.match(/^\/(catalog|stream|meta|subtitles)\/([^/]+?)\/([^/]+?)(?:\/([^/]+?))?\.json$/);
    if (routeMatch) {
      const resource = routeMatch[1];
      const type = routeMatch[2];
      const id = decodeURIComponent(routeMatch[3]);
      const extraRaw = routeMatch[4] || '';
      const extra = {};

      // 解析 extra (同 SDK: qs.parse)
      if (extraRaw) {
        // series: 1-2 → { season: 1, episode: 2 }
        const seMatch = extraRaw.match(/^(\d+)-(\d+)$/);
        if (seMatch) { extra.season = parseInt(seMatch[1]); extra.episode = parseInt(seMatch[2]); }
        // search query
        if (parsed.query.search) extra.search = parsed.query.search;
        if (parsed.query.skip) extra.skip = parseInt(parsed.query.skip);
      }
      if (parsed.query.season) extra.season = parseInt(parsed.query.season);
      if (parsed.query.episode) extra.episode = parseInt(parsed.query.episode);

      process.stdout.write(`[${ts}] ${resource}/${type}/${id} from ${from}\n`);

      const handler = handlers[resource];
      if (!handler) { res.writeHead(404); res.end('{}'); return; }

      handler({ type, id, extra, config: {} })
        .then(result => json(res, result))
        .catch(err => { console.error(err); res.writeHead(500); res.end('{}'); });
      return;
    }

    res.writeHead(404); res.end('Not Found');
  } catch (e) {
    console.error('❌', e.message);
    res.writeHead(500); res.end('Internal Error');
  }
}

function json(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

http.createServer(server).listen(PORT, '0.0.0.0', () => {
  console.log(`\n📺 SMB 本地媒体 — 端口 ${PORT}`);
  console.log(`   文件: ${getFiles().length} | TMDB: ${Object.values(tmdbCache).filter(v => v).length} 已刮削`);
  console.log(`   安装: http://${LAN_IP}:${PORT}\n`);
});
