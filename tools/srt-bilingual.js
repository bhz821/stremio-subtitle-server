#!/usr/bin/env node
/**
 * srt-bilingual.js — 英文字幕 → 中英双语字幕
 *
 * 用法:
 *   node srt-bilingual.js 英文字幕.srt
 *   node srt-bilingual.js 英文字幕.srt -o 输出.srt
 *
 * 输出: 双语 .srt（英文上 中文下），默认文件名加 .zh-en
 */

const fs = require('fs');
const https = require('https');

const input = process.argv.find(a => a.endsWith('.srt') && !a.startsWith('-'));
if (!input) {
  console.log('用法: node srt-bilingual.js <英文字幕.srt>');
  process.exit(1);
}

const outIdx = process.argv.indexOf('-o');
const output = outIdx !== -1 ? process.argv[outIdx + 1] : input.replace(/\.srt$/i, '.zh-en.srt');

const srt = fs.readFileSync(input, 'utf-8');
const blocks = srt.trim().split('\n\n');

// 提取需要翻译的文本行
const textMap = [];
for (let i = 0; i < blocks.length; i++) {
  const lines = blocks[i].split('\n');
  for (let j = 2; j < lines.length; j++) {
    const t = lines[j].trim();
    if (t && !/^\[.*\]$/.test(t)) textMap.push({ blockIdx: i, lineIdx: j, text: t });
  }
}
const uniqueTexts = [...new Set(textMap.map(x => x.text))];

console.log(`📝 ${blocks.length} 条字幕, ${uniqueTexts.length} 行去重后待翻译`);

async function translate(text) {
  return new Promise((ok) => {
    const q = encodeURIComponent(text.slice(0, 4800));
    https.get(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=${q}`,
      { timeout: 15000 }, r => {
      let b = ''; r.on('data', c => b += c); r.on('end', () => {
        try { ok(JSON.parse(b)[0].map(x => x[0]).join('')); }
        catch(e) { ok(''); }
      });
    }).on('error', () => ok(''));
  });
}

(async () => {
  const batchSize = 40;
  const translationMap = {};

  for (let i = 0; i < uniqueTexts.length; i += batchSize) {
    const batch = uniqueTexts.slice(i, i + batchSize);
    const combined = batch.join('\n---|||---\n');
    const result = await translate(combined);
    const translated = result.split('---|||---');
    for (let j = 0; j < batch.length; j++) {
      translationMap[batch[j]] = (translated[j] || '').trim();
    }
    process.stdout.write('.');
  }

  const result = [];
  for (let i = 0; i < blocks.length; i++) {
    const lines = blocks[i].split('\n');
    for (let j = 2; j < lines.length; j++) {
      const t = lines[j].trim();
      if (t && !/^\[.*\]$/.test(t) && translationMap[t]) {
        lines[j] = t + '\n' + translationMap[t];
      }
    }
    result.push(lines.join('\n'));
  }

  fs.writeFileSync(output, result.join('\n\n'));
  console.log(`\n✅ 双语字幕已保存: ${output}`);
})();
