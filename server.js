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

// ====== 访问日志 ======
function log(msg) {
  const t = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${t}] ${msg}`);
}

const SUBS_DIR = path.join(os.homedir(), '.stremio-subs');
const PORT = 5800;
const HOST = '0.0.0.0';
const LAN_IP = '192.168.2.231';

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
        version: '1.0.1',
        name: '📁 本地字幕',
        description: '从 iMac ~/.stremio-subs/ 加载本地 .srt 字幕文件',
        logo: '',
        background: '',
        resources: ['subtitles'],
        types: ['movie', 'series'],
        idPrefixes: ['tt'],
        catalogs: [],
        behaviorHints: {
          configurable: false,
          configurationRequired: false
        }
      };
      return serveJSON(res, manifest);
    }

    // ---- 路由: 安装页 ----
    if (pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>本地字幕插件</title>
  <style>
    body { font-family: -apple-system, sans-serif; max-width: 500px; margin: 40px auto; padding: 0 20px; text-align: center; }
    h1 { font-size: 1.5em; }
    p { color: #555; line-height: 1.6; }
    .btn { display: inline-block; padding: 12px 28px; background: #3b82f6; color: #fff; text-decoration: none; border-radius: 8px; font-size: 1.1em; margin: 10px 0; }
    .code { background: #f4f4f4; padding: 10px; border-radius: 4px; font-family: monospace; font-size: 0.9em; word-break: break-all; }
    .steps { text-align: left; margin: 20px 0; }
    .steps li { margin: 8px 0; }
  </style>
</head>
<body>
  <h1>📁 本地字幕插件</h1>
  <p>从 iMac 本地文件夹加载 .srt 字幕到 Stremio</p>
  <a class="btn" href="stremio://192.168.2.231:5800/manifest.json">Install</a>
  <p><small>或手动添加:</small></p>
  <div class="code">http://192.168.2.231:5800/manifest.json</div>
  <hr style="margin:24px 0">
  <h3 style="text-align:left">📖 使用说明</h3>
  <ol class="steps">
    <li>把 .srt 字幕文件放进 <code>~/.stremio-subs/TV/</code> 或 <code>~/.stremio-subs/Movies/</code></li>
    <li>文件名必须包含 <code>S01E01</code> 格式（剧集）Stremio 才能自动匹配</li>
    <li>安装本插件后，Stremio 播片时在字幕列表中选择</li>
  </ol>
  <p><small>字幕目录: ~/.stremio-subs/</small></p>
</body>
</html>`);
    }

    // ---- 路由: 字幕查询 ----
    // Stremio 实际发过来的格式:
    //   /subtitles/series/tt7587890:8:5/filename=xxx.mkv.json         ← mediaId 里带 :season:episode
    //   /subtitles/series/tt1234567/1-2.json                           ← extra 带 season-episode
    //   /subtitles/movie/tt1234567.json
    const subMatch = pathname.match(/^\/subtitles\/(movie|series)\/([^/]+?)(?:\/([^/]+?))?\.json$/);
    if (subMatch) {
      const mediaType = subMatch[1];
      const mediaId = subMatch[2];
      const extra = subMatch[3] || '';

      // 解码 mediaId (可能含 %3A 即 ":")
      const decodedId = decodeURIComponent(mediaId);

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
        const fileSeMatch = extra.match(/S(\d{2})E(\d{2})/i);
        if (fileSeMatch) {
          season = parseInt(fileSeMatch[1]);
          episode = parseInt(fileSeMatch[2]);
        }
      }

      // 4) 从 query string fallback
      if (season == null && parsed.query.season) season = parseInt(parsed.query.season);
      if (episode == null && parsed.query.episode) episode = parseInt(parsed.query.episode);

      let matchingFiles = [];

      if (season != null && episode != null) {
        matchingFiles = findSubsByEpisode(season, episode);
      } else if (mediaType === 'movie') {
        const moviesDir = path.join(SUBS_DIR, 'Movies');
        matchingFiles = scanSubFiles(moviesDir);
        if (matchingFiles.length === 0) {
          matchingFiles = findSubsByKeyword(decodedId.replace(/:.*$/, ''));
        }
      } else {
        // 没季/集号时: 试 SxxExx 全扫，或用 imdb id 模糊
        matchingFiles = scanSubFiles(SUBS_DIR);
      }

      const subtitles = matchingFiles.map((fp, i) => {
        const fname = path.basename(fp);
        const relPath = path.relative(SUBS_DIR, fp);
        const encodedUrl = `http://${LAN_IP}:${PORT}/subs/${relPath.split(path.sep).map(s => encodeURIComponent(s)).join('/')}`;
        return {
          id: `sub-${i}`,
          url: encodedUrl,
          lang: guessLang(fname),
        };
      });

      return serveJSON(res, { subtitles });
    }

    // ---- 路由: 字幕文件静态服务 ----
    // /subs/TV/filename.srt
    const decodedPath = decodeURIComponent(pathname);
    if (decodedPath.startsWith('/subs/')) {
      const relPath = decodedPath.slice(6); // 去掉 /subs/
      // 安全校验: 不允许跳出 SUBS_DIR
      const safePath = path.resolve(path.join(SUBS_DIR, relPath));
      if (!safePath.startsWith(path.resolve(SUBS_DIR))) {
        res.writeHead(403);
        return res.end('Forbidden');
      }
      if (fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
        const ext = path.extname(safePath).toLowerCase();
        const mimeMap = { '.srt': 'text/plain; charset=utf-8', '.ass': 'text/plain; charset=utf-8', '.ssa': 'text/plain; charset=utf-8' };
        const encodedName = encodeURIComponent(path.basename(safePath));
        res.writeHead(200, {
          'Content-Type': mimeMap[ext] || 'application/octet-stream',
          'Content-Disposition': `inline; filename*=UTF-8''${encodedName}`,
          'Cache-Control': 'no-cache'
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
  console.log(`  字幕目录: ${SUBS_DIR}`);
  console.log(`  字幕文件: ${scanSubFiles(SUBS_DIR).length} 个\n`);
  console.log(`  在 Stremio 中安装:`);
  console.log(`  1. 浏览器打开上面的 addon.json 地址`);
  console.log(`  2. 点击 "Install"`);
  console.log(`  3. 或: Stremio → Addons → 输入 URL 安装\n`);
});

process.on('SIGINT', () => { console.log('\n服务器停止'); process.exit(0); });
process.on('SIGTERM', () => { console.log('\n服务器停止'); process.exit(0); });
