#!/usr/bin/env node
/**
 * rd-extract.js — 从 Real-Debrid URL 提取内嵌字幕
 *
 * RD CDN 不支持完整文件下载（切断在 ~7MB），
 * 但支持 range request。本工具并行分块下载全部文件，
 * 再用 mkvextract 提取字幕轨道。
 *
 * 用法:
 *   node rd-extract.js <RD-URL> <track-index> [-o <输出.srt>]
 */

const https = require('https');
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');
const path = require('path');

const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB
const CONCURRENCY = 8; // 8 路并行
const MKVEXTRACT = '/usr/local/bin/mkvextract';

const url = process.argv[2];
const trackIdx = parseInt(process.argv[3] || '2', 10);
const outIdx = process.argv.indexOf('-o');
const outputPath = outIdx !== -1 ? process.argv[outIdx + 1] : '/tmp/rd_extracted.srt';

if (!url) {
  console.log('用法: node rd-extract.js <RD-URL> <track-index> [-o 输出.srt]');
  process.exit(1);
}

/** 获取文件大小 */
function getSize() {
  return new Promise((ok, fail) => {
    https.get(url, { method: 'HEAD', timeout: 10000 }, r => {
      const s = parseInt(r.headers['content-length'] || '0');
      if (!s) fail(new Error('无法获取文件大小'));
      else ok(s);
    }).on('error', fail);
  });
}

/** 下载一个 range 块 */
function downloadRange(start, end) {
  return new Promise((ok, fail) => {
    https.get(url, { headers: { Range: `bytes=${start}-${end}` }, timeout: 15000 }, r => {
      if (r.statusCode !== 206) return fail(new Error(`HTTP ${r.statusCode}`));
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => ok(Buffer.concat(chunks)));
    }).on('error', fail);
  });
}

async function main() {
  console.log(`📦 获取文件信息...`);
  const size = await getSize();
  const totalChunks = Math.ceil(size / CHUNK_SIZE);
  console.log(`   文件: ${(size / 1048576).toFixed(0)}MB (${totalChunks} 块，${CONCURRENCY} 路并发)`);

  // 创建空文件，预分配空间
  const tmpFile = `/tmp/rd_full_${Date.now()}.mkv`;
  const fd = fs.openSync(tmpFile, 'w');
  fs.ftruncateSync(fd, size);
  fs.closeSync(fd);

  // 分块下载
  let downloaded = 0;
  const startTime = Date.now();

  for (let batchStart = 0; batchStart < totalChunks; batchStart += CONCURRENCY) {
    const batchEnd = Math.min(batchStart + CONCURRENCY, totalChunks);
    const promises = [];

    for (let i = batchStart; i < batchEnd; i++) {
      const chunkStart = i * CHUNK_SIZE;
      const chunkEnd = Math.min(chunkStart + CHUNK_SIZE - 1, size - 1);
      promises.push(
        downloadRange(chunkStart, chunkEnd).then(data => {
          const fd2 = fs.openSync(tmpFile, 'r+');
          fs.writeSync(fd2, data, 0, data.length, chunkStart);
          fs.closeSync(fd2);
          downloaded += data.length;
          const pct = (downloaded / size * 100).toFixed(0);
          process.stdout.write(`\r   ${(downloaded/1048576).toFixed(0)}MB / ${(size/1048576).toFixed(0)}MB ${pct}%`);
        })
      );
    }

    await Promise.all(promises);
  }

  const dlTime = ((Date.now() - startTime) / 1000).toFixed(1);
  process.stdout.write(`\n`);
  console.log(`   下载完成: ${dlTime}s`);

  // 提取字幕
  const assFile = tmpFile + '.ass';
  console.log(`🎬 提取字幕轨道 ${trackIdx}...`);
  try {
    execFileSync(MKVEXTRACT, ['tracks', tmpFile, `${trackIdx}:${assFile}`], { timeout: 30000 });
  } catch (e) {
    // 可能已经是 SRT 格式
    try {
      execFileSync(MKVEXTRACT, ['tracks', tmpFile, `${trackIdx}:${outputPath}`], { timeout: 30000 });
    } catch (e2) {
      console.error(`提取失败: ${e2.message}`);
      cleanup();
      process.exit(1);
    }
    cleanup();
    console.log(`✅ 字幕已保存: ${outputPath}`);
    return;
  }

  // 如果是 ASS 格式，转 SRT
  if (fs.existsSync(assFile) && fs.statSync(assFile).size > 0) {
    const assContent = fs.readFileSync(assFile, 'utf-8');
    const srtContent = assToSrt(assContent);
    fs.writeFileSync(outputPath, srtContent, 'utf-8');
    try { fs.unlinkSync(assFile); } catch {}
    console.log(`✅ 字幕已保存 (ASS→SRT): ${outputPath}`);
  }

  cleanup();

  function cleanup() {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

// 复用 assToSrt 逻辑
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

main().catch(e => { console.error(`\n❌ ${e.message}`); process.exit(1); });
