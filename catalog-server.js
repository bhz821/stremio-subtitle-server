#!/usr/bin/env node
/**
 * Stremio 影视发现插件 (catalog-server.js)
 *
 * 从 TMDB API 拉取东亚影视榜单 → Stremio catalog 格式。
 * 配合 Torrentio+RD：浏览 → 点击 → 自动搜源播放。
 *
 * 地区覆盖：🇨🇳内地 🇭🇰香港 🇹🇼台湾 🇰🇷韩国 🇯🇵日本
 * 分类：电影 / 剧集 / 综艺
 *
 * 端口 5801，与字幕服务器 (5800) 同级。
 *
 * 首次使用: get TMDB API Key → ~/.env-catalog
 *   https://www.themoviedb.org/settings/api
 *
 * 启动:
 *   export TMDB_API_KEY=your_key
 *   node catalog-server.js
 *
 * 安装:
 *   http://192.168.2.231:5801/addon.json
 */

const http = require('http');
const https = require('https');
const url = require('url');
const path = require('path');
const fs = require('fs');

// ===========================================================================
//  配置
// ===========================================================================
const PORT = 5801;
const HOST = '0.0.0.0';
const LAN_IP = '192.168.2.231';
const CACHE_FILE = path.join(__dirname, '.catalog-cache.json');
const ENV_FILE = path.join(__dirname, '.env-catalog');

const TTL = {
  catalog: 30 * 60 * 1000,
  meta:    24 * 60 * 60 * 1000,
  imdb:    7 * 24 * 60 * 60 * 1000,
};

// ---- 读取 TMDB API Key ----
let TMDB_API_KEY = process.env.TMDB_API_KEY || '';
if (!TMDB_API_KEY && fs.existsSync(ENV_FILE)) {
  const m = fs.readFileSync(ENV_FILE, 'utf-8').match(/^TMDB_API_KEY=(.+)$/m);
  if (m) TMDB_API_KEY = m[1].trim();
}

// ===========================================================================
//  日志
// ===========================================================================
function log(msg) {
  const t = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[catalog][${t}] ${msg}`);
}

// ===========================================================================
//  缓存
// ===========================================================================
const store = { meta: {}, catalogs: {}, imdb: {} };

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
      Object.assign(store, raw);
      log(`缓存已加载: ${Object.keys(store.catalogs).length} 榜单, ${Object.keys(store.meta).length} 详情, ${Object.keys(store.imdb).length} IMDB`);
    }
  } catch (e) { log(`缓存加载跳过: ${e.message}`); }
}

function persistCache() {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(store), 'utf-8'); } catch (e) { log(`缓存写入失败: ${e.message}`); }
}

function cacheGet(bucket, key, ttl) {
  const entry = store[bucket]?.[key];
  if (entry && Date.now() - entry.t < ttl) return entry.d;
  return null;
}

function cacheSet(bucket, key, data) {
  if (!store[bucket]) store[bucket] = {};
  store[bucket][key] = { t: Date.now(), d: data };
}

// ===========================================================================
//  TMDB API
// ===========================================================================
const TMDB_HOST = 'api.themoviedb.org';

function tmdbFetch(endpoint) {
  return new Promise((resolve, reject) => {
    const sep = endpoint.includes('?') ? '&' : '?';
    const req = https.get({
      hostname: TMDB_HOST,
      path: `/3${endpoint}${sep}api_key=${TMDB_API_KEY}`,
      headers: { 'Accept': 'application/json' },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`TMDB ${res.statusCode}: ${body.slice(0, 150)}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`JSON: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('TMDB timeout')); });
  });
}

async function resolveImdbId(tmdbId, tmdbType) {
  const ck = `${tmdbId}`;
  const hit = cacheGet('imdb', ck, TTL.imdb);
  if (hit !== null) return hit;
  try {
    const d = await tmdbFetch(`/${tmdbType}/${tmdbId}?language=zh-CN`);
    const id = d.imdb_id || null;
    cacheSet('imdb', ck, id);
    return id;
  } catch (e) {
    log(`IMDB 解析失败 [tmdb#${tmdbId}]: ${e.message}`);
    return null;
  }
}

// ===========================================================================
//  豆瓣 API — explore（电影用）
// ===========================================================================
async function doubanFetchExplore(type, tag, limit = 20) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: 'movie.douban.com',
      path: `/j/search_subjects?type=${type}&tag=${encodeURIComponent(tag)}&page_limit=${limit}&page_start=0`,
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body).subjects || []); }
        catch (e) { reject(new Error(`豆瓣JSON: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(6000, () => { req.destroy(); reject(new Error('豆瓣超时')); });
  });
}

// ===========================================================================
//  豆瓣 API — Rexxar 合集（剧集/综艺/纪录片用，豆瓣官方榜单）
// ===========================================================================
async function doubanFetchRexxar(collectionId, limit = 20) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: 'm.douban.com',
      path: `/rexxar/api/v2/subject_collection/${collectionId}/items?start=0&count=${limit}`,
      headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36', 'Accept': 'application/json', 'Referer': 'https://m.douban.com/' },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const d = JSON.parse(body);
          resolve(d.subject_collection_items || []);
        } catch (e) { reject(new Error(`豆瓣合集JSON: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(6000, () => { req.destroy(); reject(new Error('豆瓣合集超时')); });
  });
}

// ===========================================================================
//  豆瓣 API — Recent Hot（电影/综艺用，豆瓣首页同款）
// ===========================================================================
async function doubanFetchRecentHot(mediaType, category, subType, limit = 20) {
  let path = `/rexxar/api/v2/subject/recent_hot/${mediaType}?start=0&limit=${limit}`;
  if (category) path += `&category=${category}`;
  if (subType)  path += `&type=${subType}`;
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: 'm.douban.com',
      path,
      headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36', 'Accept': 'application/json', 'Referer': 'https://m.douban.com/' },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`豆瓣hotJSON: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(6000, () => { req.destroy(); reject(new Error('豆瓣hot超时')); });
  });
}

// ===========================================================================
//  TVmaze API（TMDB 没 IMDB 时用英文名补查）
// ===========================================================================
async function tvmazeSearch(query) {
  const ck = `tvz_${query}`;
  const hit = cacheGet('imdb', ck, TTL.imdb);
  if (hit !== null) return hit;
  try {
    const d = await new Promise((ok, no) => {
      const req = https.get('https://api.tvmaze.com/search/shows?q=' + encodeURIComponent(query), { timeout: 5000 }, r => {
        let b = ''; r.on('data', c => b += c); r.on('end', () => ok(JSON.parse(b)));
      });
      req.on('error', no);
    });
    const imdb = d?.[0]?.show?.externals?.imdb || null;
    cacheSet('imdb', ck, imdb);
    return imdb;
  } catch (e) { return null; }
}

// ===========================================================================
//  IMDB 搜索（中文标题 → TMDB 找英文名 → TVmaze 补 IMDB ID）
// ===========================================================================
async function searchImdbByTitle(title, year, tmdbType) {
  const ck = `srch_${tmdbType}_${title}_${year || ''}`;
  const hit = cacheGet('imdb', ck, TTL.imdb);
  if (hit !== null) return hit;

  try {
    // 清理标题：去掉"第X季/第X集"等后缀（TMDB 搜不到带季号的）
    const cleanTitle = title.replace(/[（(]?\s*第[一二三四五六七八九十\d]+季\s*[）)]?\s*$/g, '').trim();
    // TMDB 搜索（带年份搜不到就重试不限年份）
    let results = [];
    const params = new URLSearchParams({ query: cleanTitle, language: 'zh-CN', page: '1' });
    if (year) params.set('year', year);
    let data = await tmdbFetch(`/search/${tmdbType}?${params.toString()}`);
    results = data.results || [];
    if (!results.length && year) {
      // 年份搜不到 → 不限年份再试（剧集季节年份≠首播年份）
      const params2 = new URLSearchParams({ query: cleanTitle, language: 'zh-CN', page: '1' });
      data = await tmdbFetch(`/search/${tmdbType}?${params2.toString()}`);
      results = data.results || [];
    }
    if (!results.length) { cacheSet('imdb', ck, null); return null; }

    const best = results[0];
    let imdbId = await resolveImdbId(best.id, tmdbType);

    // TMDB 没挂 IMDB ID → 用英文名走 TVmaze 补查
    if (!imdbId) {
      const enName = best.original_name || best.name;
      imdbId = await tvmazeSearch(enName);
    }

    cacheSet('imdb', ck, imdbId);
    return {
      imdbId,
      poster: best.poster_path ? `https://image.tmdb.org/t/p/w342${best.poster_path}` : null,
      bg: best.backdrop_path ? `https://image.tmdb.org/t/p/w1280${best.backdrop_path}` : null,
      tmdbId: best.id,
      desc: best.overview?.slice(0, 400),
    };
  } catch (e) { return null; }
}

// ===========================================================================
//  Catalog 构建函数
// ===========================================================================
/** 从豆瓣 explore 标签构建（电影用） */
async function buildExploreCatalog(type, tag, tmdbSearchType, limit) {
  const ck = `exp_${type}_${tag}`;
  const cached = cacheGet('catalogs', ck, TTL.catalog);
  if (cached) return cached;

  const subjects = await doubanFetchExplore(type, tag, 20);
  if (!subjects.length) return { metas: [] };

  const metas = [];
  for (let i = 0; i < Math.min(subjects.length, limit); i += 3) {
    const batch = subjects.slice(i, i + 3);
    const results = await Promise.allSettled(batch.map(s => searchImdbByTitle(s.title, s.year, tmdbSearchType)));
    for (let j = 0; j < batch.length; j++) {
      const s = batch[j];
      const r = results[j].status === 'fulfilled' ? results[j].value : null;
      const imdbId = r?.imdbId || null;
      const entry = {
        id: imdbId || `db:${s.id}`,
        type,
        name: s.title,
        poster: r?.poster || s.cover || undefined,
        background: r?.bg || undefined,
        imdb_id: imdbId || undefined,
        year: s.year || '',
        description: r?.desc || undefined,
        _douban_rate: s.rate,
      };
      cacheSet('meta', `${type}:${entry.id}`, entry);
      metas.push(entry);
    }
  }
  const result = { metas };
  cacheSet('catalogs', ck, result);
  return result;
}

/** 从豆瓣 Rexxar 合集构建（剧集/综艺/纪录片用） */
async function buildRexxarCatalog(collectionId, type, tmdbSearchType, limit, regionFilter) {
  const ck = `rxr_${collectionId}${regionFilter ? '_' + regionFilter : ''}`;
  const cached = cacheGet('catalogs', ck, TTL.catalog);
  if (cached) return cached;

  let items = await doubanFetchRexxar(collectionId, 60); // 多取点供过滤
  if (!items.length) return { metas: [] };

  // 可选地区过滤
  if (regionFilter) {
    items = items.filter(item => {
      const region = (item.card_subtitle || '').split(' / ')[1] || '';
      return region === regionFilter;
    });
  }

  const metas = [];
  const slice = items.slice(0, limit);
  for (let i = 0; i < slice.length; i += 3) {
    const batch = slice.slice(i, i + 3);
    const results = await Promise.allSettled(
      batch.map(item => searchImdbByTitle(item.title, (item.card_subtitle || '').split(' / ')[0], tmdbSearchType))
    );
    for (let j = 0; j < batch.length; j++) {
      const item = batch[j];
      const r = results[j].status === 'fulfilled' ? results[j].value : null;
      const imdbId = r?.imdbId || null;
      const subtitle = item.card_subtitle || '';
      const year = subtitle.split(' / ')[0] || '';
      const region = subtitle.split(' / ')[1] || '';
      const genres = subtitle.split(' / ').slice(2, 3).join('') || undefined;
      const entry = {
        id: imdbId || `db:${item.id}`,
        type,
        name: item.title,
        poster: r?.poster || item.cover?.url || undefined,
        background: r?.bg || undefined,
        imdb_id: imdbId || undefined,
        year,
        description: r?.desc || (genres ? '类型: ' + genres + (region ? ' · ' + region : '') : undefined),
        _douban_rate: item.rating?.value ? String(item.rating.value) : undefined,
      };
      cacheSet('meta', `${type}:${entry.id}`, entry);
      metas.push(entry);
    }
  }
  const result = { metas };
  cacheSet('catalogs', ck, result);
  return result;
}

/** 从豆瓣 Recent Hot 接口构建（电影综合、综艺用） */
async function buildRecentHotCatalog(mediaType, category, subType, stremioType, limit) {
  const ck = `hot_${mediaType}_${category || ''}_${subType || ''}`;
  const cached = cacheGet('catalogs', ck, TTL.catalog);
  if (cached) return cached;

  const d = await doubanFetchRecentHot(mediaType, category, subType, limit);
  const items = d.items || [];
  if (!items.length) return { metas: [] };

  const metas = [];
  for (let i = 0; i < items.length; i += 3) {
    const batch = items.slice(i, i + 3);
    const results = await Promise.allSettled(
      batch.map(item => searchImdbByTitle(item.title, (item.card_subtitle || '').split(' / ')[0], stremioType === 'movie' ? 'movie' : 'tv'))
    );
    for (let j = 0; j < batch.length; j++) {
      const item = batch[j];
      const r = results[j].status === 'fulfilled' ? results[j].value : null;
      const imdbId = r?.imdbId || null;
      const subtitle = item.card_subtitle || '';
      const year = subtitle.split(' / ')[0] || '';
      const genre = subtitle.split(' / ').slice(2, 3).join('') || undefined;
      const entry = {
        id: imdbId || `db:${item.id}`,
        type: stremioType,
        name: item.title,
        poster: r?.poster || item.pic?.normal || item.pic?.large || item.pic || undefined,
        background: r?.bg || undefined,
        imdb_id: imdbId || undefined,
        year,
        description: r?.desc || (genre ? '类型: ' + genre : undefined),
        _douban_rate: item.rating?.value ? String(item.rating.value) : undefined,
      };
      cacheSet('meta', `${stremioType}:${entry.id}`, entry);
      metas.push(entry);
    }
  }
  const result = { metas };
  cacheSet('catalogs', ck, result);
  return result;
}

// ===========================================================================
//  榜单定义（13 个）
// ===========================================================================
const CATALOG_DEFS = [
  // ── 电影（综合用 Recent Hot，地区用 explore 标签）──
  { type: 'movie',  id: 'movie_hot',    name: '🎬 热门电影（综合）', build: () => buildRecentHotCatalog('movie', null, null, 'movie', 20) },
  { type: 'movie',  id: 'cn_movies',    name: '🇨🇳 华语热片',       build: () => buildExploreCatalog('movie',  '华语',     'movie', 15) },
  { type: 'movie',  id: 'kr_movies',    name: '🇰🇷 韩国热片',       build: () => buildExploreCatalog('movie',  '韩国电影', 'movie', 15) },
  { type: 'movie',  id: 'jp_movies',    name: '🇯🇵 日本热片',       build: () => buildExploreCatalog('movie',  '日本电影', 'movie', 15) },
  { type: 'movie',  id: 'doc_movies',   name: '📽️ 纪录片（电影）',  build: () => buildExploreCatalog('movie', '纪录片',   'movie', 15) },

  // ── 剧集（豆瓣 Recent Hot 官方分类）──
  { type: 'series', id: 'tv_hot',       name: '📺 热门剧集（综合）', build: () => buildRecentHotCatalog('tv', 'tv',    null,             'series', 20) },
  { type: 'series', id: 'cn_series',    name: '🇨🇳 内地热剧',      build: () => buildRecentHotCatalog('tv', 'tv',    'tv_domestic',    'series', 15) },
  { type: 'series', id: 'kr_series',    name: '🇰🇷 韩剧',          build: () => buildRecentHotCatalog('tv', 'tv',    'tv_korean',      'series', 15) },
  { type: 'series', id: 'jp_series',    name: '🇯🇵 日剧',          build: () => buildRecentHotCatalog('tv', 'tv',    'tv_japanese',    'series', 15) },
  { type: 'series', id: 'us_series',    name: '🇪🇺 欧美剧',        build: () => buildRecentHotCatalog('tv', 'tv',    'tv_american',    'series', 15) },
  { type: 'series', id: 'doc_series',   name: '📽️ 纪录片（剧集）', build: () => buildRecentHotCatalog('tv', 'tv',    'tv_documentary',  'series', 15) },

  // ── 综艺（豆瓣 Recent Hot 官方分类）──
  { type: 'series', id: 'variety_all',  name: '🎭 综艺（综合）',   build: () => buildRecentHotCatalog('tv', 'show', null,              'series', 20) },
  { type: 'series', id: 'variety_cn',   name: '🇨🇳 内地综艺',     build: () => buildRecentHotCatalog('tv', 'show', 'show_domestic',   'series', 20) },
  { type: 'series', id: 'variety_global',name: '🌍 海外综艺',     build: () => buildRecentHotCatalog('tv', 'show', 'show_foreign',    'series', 20) },
];

async function buildMeta(stremioType, id) {
  const ck = `${stremioType}:${id}`;
  const hit = cacheGet('meta', ck, TTL.meta);
  if (hit) return hit;

  let tmdbId;
  // 豆瓣 ID（db:XXXXX）→ 从缓存拿
  if (id.startsWith('db:')) {
    const cached = cacheGet('meta', `${stremioType}:${id}`, TTL.meta);
    return cached || null;
  }

  const tmdbType = stremioType === 'series' ? 'tv' : 'movie';

  if (id.startsWith('tt')) {
    try {
      const d = await tmdbFetch(`/find/${id}?external_source=imdb_id&language=zh-CN`);
      const results = d[`${tmdbType}_results`] || [];
      if (!results.length) return null;
      tmdbId = results[0].id;
    } catch (e) { log(`IMDB->TMDB 查找失败 [${id}]: ${e.message}`); return null; }
  } else if (id.startsWith('tmdb:')) {
    tmdbId = parseInt(id.slice(5), 10);
  } else {
    tmdbId = parseInt(id, 10);
  }
  if (!tmdbId || isNaN(tmdbId)) return null;

  try {
    const d = await tmdbFetch(`/${tmdbType}/${tmdbId}?language=zh-CN`);
    const meta = {
      id: d.imdb_id || `tmdb:${tmdbId}`,
      type: stremioType,
      name: d.title || d.name || '未知',
      poster: d.poster_path ? `https://image.tmdb.org/t/p/w500${d.poster_path}` : undefined,
      background: d.backdrop_path ? `https://image.tmdb.org/t/p/w1280${d.backdrop_path}` : undefined,
      imdb_id: d.imdb_id || undefined,
      year: (d.release_date || d.first_air_date || '').slice(0, 4),
      description: d.overview?.slice(0, 500),
      genres: d.genres?.map(g => g.name).slice(0, 5),
      releaseInfo: (d.release_date || d.first_air_date || '').slice(0, 4),
      runtime: d.runtime || undefined,
    };
    cacheSet('meta', ck, meta);
    persistCache();
    return meta;
  } catch (e) {
    log(`Meta 获取失败 [${id}]: ${e.message}`);
    return null;
  }
}

// ===========================================================================
//  Manifest
// ===========================================================================
function buildManifest() {
  return {
    id: 'com.vickiepo.east-asia-catalog',
    version: '1.0.0',
    name: '🎬 豆瓣热榜',
    description: '豆瓣热门影视榜单（华语电影 · 国产剧 · 韩剧 · 日剧 · 综艺），点击→Torrentio 播',
    logo: '',
    background: '',
    resources: ['catalog', 'meta'],
    types: ['movie', 'series'],
    idPrefixes: ['tt', 'tmdb', 'db'],
    catalogs: CATALOG_DEFS.map(c => ({
      type: c.type,
      id: c.id,
      name: c.name,
      extra: [{ name: 'skip', isRequired: false }],
      extraSupported: ['search', 'skip'],
      extraRequired: [],
    })),
    behaviorHints: { configurable: false, configurationRequired: false },
  };
}

// ===========================================================================
//  HTTP 服务器
// ===========================================================================
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const start = Date.now();

  res.on('finish', () => log(`${Date.now() - start}ms ${req.method} ${pathname}`));
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  try {
    // ── 安装页 ──
    if (pathname === '/')    return res.end(renderHomePage());

    // ── Manifest ──
    if (pathname === '/manifest.json' || pathname === '/addon.json') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(buildManifest(), null, 2) + '\n');
    }

    // ── Catalog: /catalog/movie/cn_movies.json ──
    const cm = pathname.match(/^\/catalog\/(movie|series)\/([^.]+)\.json$/);
    if (cm) {
      const [, type, catalogId] = cm;
      const def = CATALOG_DEFS.find(d => d.type === type && d.id === catalogId);
      if (!def) return json404(res, `Unknown catalog: ${catalogId}`);
      if (!TMDB_API_KEY) return jsonOk(res, { metas: [], error: '需要 TMDB API Key' });
      const data = await def.build();
      return jsonOk(res, data);
    }

    // ── Meta: /meta/movie/tt1234567.json ──
    const mm = pathname.match(/^\/meta\/(movie|series)\/(.+)\.json$/);
    if (mm) {
      if (!TMDB_API_KEY) return jsonOk(res, { meta: null, error: '需要 TMDB API Key' });
      const meta = await buildMeta(mm[1], mm[2]);
      if (!meta) return json404(res, `Meta not found: ${mm[2]}`);
      return jsonOk(res, { meta });
    }

    // ── 404 ──
    json404(res, 'Not found');

  } catch (err) {
    log(`请求异常: ${err.message}`);
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

function jsonOk(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data, null, 2) + '\n');
}
function json404(res, msg) {
  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: msg }));
}

// ===========================================================================
//  安装页
// ===========================================================================
function renderHomePage() {
  const hasKey = !!TMDB_API_KEY;
  const rows = [
    ['🎬 电影', CATALOG_DEFS.filter(d => d.type === 'movie')],
    ['📺 剧集', CATALOG_DEFS.filter(d => d.type === 'series')],
  ];
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>东亚影视发现插件</title>
<style>
body{font-family:-apple-system,sans-serif;max-width:560px;margin:40px auto;padding:0 20px;text-align:center}
h1{font-size:1.5em}
p{color:#555;line-height:1.6}
.btn{display:inline-block;padding:14px 32px;background:#3b82f6;color:#fff;text-decoration:none;border-radius:8px;font-size:1.1em;margin:10px 0}
.btn:hover{background:#2563eb}
.btn:disabled{opacity:0.5;pointer-events:none}
.code{background:#f4f4f4;padding:10px;border-radius:4px;font-family:monospace;font-size:0.9em;word-break:break-all}
.cat-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;text-align:left;margin:16px 0}
.cat-grid div{background:#f9fafb;padding:10px 14px;border-radius:6px;font-size:0.9em}
.status{display:inline-block;padding:4px 12px;border-radius:20px;font-size:0.9em;${hasKey?'background:#dcfce7;color:#166534':'background:#fee2e2;color:#991b1b'}}
</style></head>
<body>
<h1>🎬 豆瓣热榜</h1>
<p>豆瓣热门影视榜单 → 点击 → Torrentio+RD 自动播</p>
<p><span class="status">${hasKey?'✓ TMDB API 已配置':'✗ TMDB API 未配置'}</span></p>
${hasKey?`<a class="btn" href="stremio://${LAN_IP}:${PORT}/manifest.json">安装到 Stremio</a>`:`<a class="btn" disabled>先配置 TMDB Key 再安装</a>`}
<p><small>或手动添加:</small></p>
<div class="code">http://${LAN_IP}:${PORT}/manifest.json</div>
<hr style="margin:20px 0">
${!hasKey?`
<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:16px;text-align:left;margin:16px 0">
<strong>⚠️ 需要免费 TMDB API Key</strong>
<ol style="margin:8px 0;padding-left:20px">
<li>打开 <a href="https://www.themoviedb.org/settings/api" target="_blank">TMDB API 页面</a></li>
<li>注册 → 申请 API Key（免费，即时生效）</li>
<li>把 Key 写入 <code>~/.env-catalog</code>：<div class="code" style="margin-top:6px">TMDB_API_KEY=你的key</div></li>
<li>重启本服务器</li>
</ol>
</div>`:''}
<h3 style="text-align:left">📖 榜单列表</h3>
${rows.map(([title, cats]) => `
<h4 style="text-align:left;margin:12px 0 4px">${title}</h4>
<div class="cat-grid">${cats.map(c => `<div>${c.name}</div>`).join('')}</div>
`).join('')}
<p style="font-size:0.85em;color:#888;margin-top:20px">点击影片 → Torrentio 自动搜 RD 源 → 直接播放<br>
数据来源: TMDB | ${CATALOG_DEFS.length} 个榜单</p>
</body></html>`;
}

// ===========================================================================
//  启动
// ===========================================================================
loadCache();
setInterval(persistCache, 5 * 60 * 1000).unref();

server.listen(PORT, HOST, () => {
  console.log(`\n  🎬 Stremio 豆瓣热榜插件`);
  console.log(`  ──────────────────────────────`);
  console.log(`  Addon:  http://${LAN_IP}:${PORT}/addon.json`);
  console.log(`  TMDB:   ${TMDB_API_KEY ? '✓ 已配置' : '✗ 未配置（见安装页面指引）'}`);
  console.log(`  榜单:   ${CATALOG_DEFS.length} 个 (${CATALOG_DEFS.filter(d => d.type === 'movie').length} 电影 + ${CATALOG_DEFS.filter(d => d.type === 'series').length} 剧集)`);
  console.log(`  端口:   ${PORT}\n`);
  console.log(`  在 Stremio 中安装:`);
  console.log(`  1. 浏览器打开 http://${LAN_IP}:${PORT}`);
  console.log(`  2. 点击 "安装到 Stremio"`);
  console.log(`  3. 或: Stremio → Addons → 输入 URL\n`);
});

process.on('SIGINT',  () => { persistCache(); process.exit(0); });
process.on('SIGTERM', () => { persistCache(); process.exit(0); });
