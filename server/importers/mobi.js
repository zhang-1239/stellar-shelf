// MOBI / AZW3（best-effort）：PalmDB 容器 + PalmDOC 解压 + MOBI/EXTH 元数据。
import fs from 'node:fs';
import { sanitizeFragment, escapeHtml, textOf, splitPlainText, textToParagraphsHtml } from './html.js';
import { mergeTinyChapters, sniffImageExt, splitHtmlByHeadings } from './util.js';

const DRM_OR_KF8 = '这本 MOBI/AZW3 可能是加密的，或为纯 KF8 结构，暂时无法解析正文';
const MAX_TEXT = 200 * 1024 * 1024;

/** PalmDOC LZ77 解压（0x00 字面量 / 0x01-08 复制 / 0x09-7F 字面量 / 80-BF 回溯 / C0-FF 空格+异或）。 */
function palmDocDecompress(src) {
  const out = Buffer.alloc(src.length * 8 + 64);
  let i = 0;
  let o = 0;
  while (i < src.length) {
    const b = src[i++];
    if (b >= 1 && b <= 8) {
      const end = Math.min(i + b, src.length);
      while (i < end) out[o++] = src[i++];
    } else if (b <= 0x7f) {
      out[o++] = b;
    } else if (b >= 0xc0) {
      out[o++] = 0x20;
      out[o++] = b ^ 0x80;
    } else {
      if (i >= src.length) break;
      const pair = (b << 8) | src[i++];
      const dist = (pair >> 3) & 0x7ff;
      const len = (pair & 7) + 3;
      if (!dist || dist > o) break; // 数据损坏，保留已解出的部分
      for (let k = 0; k < len; k++) out[o] = out[o - dist], o++;
    }
  }
  return out.subarray(0, o);
}

function decodeMeta(raw) {
  if (!raw || !raw.length) return '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw).replace(/\u0000/g, '').trim();
  } catch {
    return raw.toString('latin1').replace(/\u0000/g, '').trim();
  }
}

/** 解析 EXTH 记录块。 */
function parseExth(rec0, start) {
  const out = {};
  try {
    const total = rec0.readUInt32BE(start + 4);
    const count = rec0.readUInt32BE(start + 8);
    let p = start + 12;
    const end = Math.min(start + total, rec0.length);
    for (let k = 0; k < count && p + 8 <= end; k++) {
      const type = rec0.readUInt32BE(p);
      const len = rec0.readUInt32BE(p + 4);
      if (len < 8 || p + len > end) break;
      const val = rec0.subarray(p + 8, p + len);
      if (!out[type]) out[type] = val;
      p += len;
    }
  } catch { /* 容错：EXTH 坏了就只用基础元数据 */ }
  return out;
}

function exthText(v) {
  return decodeMeta(v).replace(/\s*[;\u0000]\s*/g, ', ').replace(/,\s*,/g, ',').slice(0, 300);
}

/** kindle:embed:XXXX 的 base32（数字+大写字母）→ 图片序号 */
function decodeBase32(s) {
  const ALPHA = '0123456789ABCDEFGHIJKLMNOPQRSTUV';
  let n = 0;
  for (const ch of String(s || '').toUpperCase()) {
    const v = ALPHA.indexOf(ch);
    if (v < 0) return -1;
    n = n * 32 + v;
    if (n > 0xfffff) return -1;
  }
  return n;
}

function firstHeading(html) {
  const m = html.match(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1\s*>/i);
  return m ? textOf(m[2]).replace(/\s+/g, ' ').trim().slice(0, 80) : '';
}

export async function parse(filePath, opts = {}) {
  const warnings = [];
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch (e) {
    throw new Error(`文件无法读取：${e.message}`);
  }
  if (buf.length < 200) throw new Error('不是有效的 MOBI 文件：长度不足');

  const numRecords = buf.readUInt16BE(76);
  if (!numRecords || numRecords < 2 || 78 + numRecords * 8 > buf.length) {
    throw new Error('不是有效的 MOBI 文件：记录表损坏');
  }
  const offs = new Array(numRecords);
  for (let i = 0; i < numRecords; i++) {
    const o = buf.readUInt32BE(78 + i * 8);
    if (o < 78 || o > buf.length) throw new Error('不是有效的 MOBI 文件：记录偏移越界');
    offs[i] = o;
  }
  const rec = (i) => buf.subarray(offs[i], i + 1 < numRecords ? offs[i + 1] : buf.length);

  const rec0 = rec(0);
  if (rec0.length < 24) throw new Error('不是有效的 MOBI 文件：记录 0 太短');
  const compression = rec0.readUInt16BE(0);
  const textLength = rec0.readUInt32BE(4);
  const textRecordCount = rec0.readUInt16BE(8);
  const encryption = rec0.readUInt16BE(12);
  if (textLength > MAX_TEXT) throw new Error('MOBI 文本过大，已放弃解析');

  // MOBI 头通常紧跟 16 字节的 PalmDOC 头
  let mobiStart = 16;
  if (rec0.subarray(16, 20).toString('latin1') !== 'MOBI') {
    const at = rec0.indexOf('MOBI', 16, 'latin1');
    if (at > 0 && at < 256) mobiStart = at;
  }
  const hasMobi = rec0.subarray(mobiStart, mobiStart + 4).toString('latin1') === 'MOBI';
  const rel32 = (o) => (mobiStart + o + 4 <= rec0.length ? rec0.readUInt32BE(mobiStart + o) : 0);

  const encoding = hasMobi ? (mobiStart + 16 <= rec0.length ? rec0.readUInt16BE(mobiStart + 12) : 0) : 0;
  const decoder = encoding === 65001 ? new TextDecoder('utf-8') : new TextDecoder('windows-1252');

  // 元数据
  let title = '';
  const meta = {
    title: '', author: '', publisher: '', pubDate: '', isbn: '', pages: '',
    price: '', binding: '', translator: '', subtitle: '', summary: '', language: '',
  };
  if (hasMobi) {
    const nameOff = rel32(68);
    const nameLen = rel32(72);
    if (nameOff && nameLen && nameOff + nameLen <= rec0.length) {
      title = decodeMeta(rec0.subarray(nameOff, nameOff + nameLen));
    }
    const exthAt = rec0.indexOf('EXTH', Math.min(mobiStart + 40, rec0.length), 'latin1');
    if (exthAt > 0) {
      const exth = parseExth(rec0, exthAt);
      meta.author = exthText(exth[100]);
      meta.publisher = exthText(exth[101]);
      meta.summary = exthText(exth[103]).slice(0, 600);
      meta.isbn = exthText(exth[104]).replace(/[^\dxX]/g, '').slice(0, 13);
      const subj = exthText(exth[105]);
      if (subj) meta.summary = meta.summary || subj;
      const lang = exthText(exth[524]);
      if (lang) meta.language = lang.slice(0, 20);
    }
  }
  if (!title) title = buf.subarray(0, 32).toString('latin1').replace(/\u0000+/g, '').trim();
  meta.title = title || '';

  if (encryption !== 0) throw new Error(DRM_OR_KF8);
  if (!textLength || !textRecordCount) throw new Error(DRM_OR_KF8);
  if (compression !== 1 && compression !== 2) {
    throw new Error(`MOBI 使用了暂不支持的压缩方式（${compression}）`);
  }

  // 正文
  const parts = [];
  let got = 0;
  for (let r = 1; r <= textRecordCount && r < numRecords && got < textLength; r++) {
    const raw = rec(r);
    const chunk = compression === 2 ? palmDocDecompress(raw) : raw;
    parts.push(chunk);
    got += chunk.length;
  }
  const textBuf = Buffer.concat(parts).subarray(0, textLength || undefined);
  let text = decoder.decode(textBuf).replace(/\u0000/g, '');
  const printable = text.replace(/\s/g, '').length;
  if (!printable || printable < Math.max(16, text.length * 0.02)) throw new Error(DRM_OR_KF8);
  if (printable < 200) warnings.push('MOBI 正文非常短，可能只解析到部分内容');

  // 图片：<img recindex="N"> / kindle:embed:XXXX
  const firstImage = hasMobi ? rel32(92) : 0;
  const assets = [];
  const assetByRec = new Map();
  const asAsset = (recIndex) => {
    if (assetByRec.has(recIndex)) return assetByRec.get(recIndex);
    if (recIndex < 1 || recIndex >= numRecords) return null;
    const data = rec(recIndex);
    let pos = -1;
    for (const magic of ['\xff\xd8\xff', '\x89PNG', 'GIF8']) {
      pos = data.indexOf(Buffer.from(magic, 'latin1'));
      if (pos >= 0 && pos <= 64) break;
      pos = -1;
    }
    if (pos < 0) return null;
    const img = data.subarray(pos);
    const ext = sniffImageExt(img);
    if (!ext) return null;
    const name = `img-${String(assets.length + 1).padStart(3, '0')}.${ext}`;
    assets.push({ path: `assets/${name}`, data: img });
    assetByRec.set(recIndex, `assets/${name}`);
    return `assets/${name}`;
  };

  const rewriteSrc = (src) => {
    const recIdx = /^mobiimg:(\d+)$/.exec(String(src || ''));
    return recIdx ? asAsset(Number(recIdx[1])) : null;
  };

  const html = /<\/?(?:html|body|p|br|div|a)\b/i.test(text);
  let chapters = [];
  if (html) {
    const withMarkers = text
      .replace(/<mbp:pagebreak[^>]*\/?>/gi, '\n<!--PB-->\n')
      .replace(/<img\b[^>]*>/gi, (tag) => {
        const ridx = tag.match(/\brecindex\s*=\s*["']?(\d+)/i);
        const emb = tag.match(/kindle:embed:([0-9A-Za-z]+)/i);
        let n = -1;
        if (ridx) n = firstImage + Number(ridx[1]);
        else if (emb) {
          const v = decodeBase32(emb[1]);
          if (v >= 0) n = firstImage + v;
        }
        return n > 0 ? `<img src="mobiimg:${n}"/>` : tag;
      });

    for (const segment of withMarkers.split('<!--PB-->')) {
      const clean = sanitizeFragment(segment, { rewriteSrc });
      if (!clean.trim()) continue;
      const parts2 = splitHtmlByHeadings(clean, [1, 2, 3]);
      if (parts2.length > 1) chapters.push(...parts2);
      else chapters.push({ title: firstHeading(clean), html: clean });
    }
  } else {
    for (const unit of splitPlainText(text)) {
      const body = textToParagraphsHtml(unit.text);
      if (body) chapters.push({ title: unit.title, html: body });
    }
  }

  chapters = mergeTinyChapters(chapters.filter((c) => textOf(c.html).trim()), 300);
  chapters.forEach((c, i) => { if (!c.title) c.title = `第 ${i + 1} 节`; });
  if (!chapters.length) warnings.push('MOBI 中没有可解析的正文');

  return { meta, cover: null, chapters, assets, warnings: warnings.slice(0, 20) };
}
