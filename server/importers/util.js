// 解析器共用的工具：字节解码、HTML 分章、小片段合并。
import path from 'node:path';
import { splitPlainText, textOf } from './html.js';

// ---------------------------------------------------------------------------
// 字节解码：BOM → 严格 UTF-8 → GBK / Big5（用常用字命中率挑选）
// ---------------------------------------------------------------------------

const COMMON_HAN = new Set(
  '的一是不了人我在有他这为之大来以个中上们到说国和地也子时道出而要于就下得可你年生自会那后能对着事其里所去行过家十用发天如然作方成者多日都三小军二无同么经法当起与好看学进种将还分此心前面又定见只主没公从'
);

function hanScore(s) {
  let hits = 0;
  let cjk = 0;
  const n = Math.min(s.length, 65536); // 只抽样前 64K 字符，避免大文件变慢
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x3400) continue;
    if (c <= 0x9fff || (c >= 0xf900 && c <= 0xfaff)) {
      cjk++;
      if (COMMON_HAN.has(s[i])) hits++;
    }
  }
  return cjk ? hits / cjk : 0;
}

function replacementRatio(s) {
  const n = Math.min(s.length, 65536);
  let bad = 0;
  for (let i = 0; i < n; i++) if (s.charCodeAt(i) === 0xfffd) bad++;
  return n ? bad / n : 0;
}

/** 把字节解码成文本。MIME 里声明的编码可作首选。 */
export function decodeBytes(buf, preferred) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (!b.length) return '';
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(b.subarray(3));
  }
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));

  // 无 BOM 的 UTF-16：看零字节分布
  if (b.length >= 4 && b.length % 2 === 0) {
    let oddZero = 0;
    let evenZero = 0;
    const n = Math.min(b.length, 4096);
    for (let i = 0; i < n; i += 2) {
      if (b[i] === 0) evenZero++;
      if (b[i + 1] === 0) oddZero++;
    }
    const pairs = n / 2;
    if (oddZero > pairs * 0.6 && evenZero < pairs * 0.1) return new TextDecoder('utf-16le').decode(b);
    if (evenZero > pairs * 0.6 && oddZero < pairs * 0.1) return new TextDecoder('utf-16be').decode(b);
  }

  if (preferred) {
    const enc = normEncoding(preferred);
    if (enc) {
      try {
        const s = new TextDecoder(enc).decode(b);
        if (replacementRatio(s) < 0.002) return s;
        if (enc === 'utf-8') return s;
      } catch { /* 继续探测 */ }
    }
  }

  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { /* 非 UTF-8 */ }

  let best = null;
  let bestScore = -1;
  let bestBad = 1;
  for (const enc of ['gbk', 'big5']) {
    let s;
    try { s = new TextDecoder(enc).decode(b); } catch { continue; }
    const bad = replacementRatio(s);
    if (bad > 0.05) continue;
    const score = hanScore(s);
    if (score > bestScore || (score === bestScore && bad < bestBad)) {
      bestScore = score;
      bestBad = bad;
      best = s;
    }
  }
  return best ?? new TextDecoder('utf-8').decode(b);
}

function normEncoding(label) {
  const l = String(label || '').toLowerCase().trim().replace(/^["']|["']$/g, '');
  if (!l) return null;
  const map = {
    'utf-8': 'utf-8', utf8: 'utf-8',
    gbk: 'gbk', 'gb2312': 'gbk', 'gb-2312': 'gbk', 'x-gbk': 'gbk', 'cp936': 'gbk',
    gb18030: 'gbk', // Node 的 gbk 解码器兼容绝大部分 GB18030
    big5: 'big5', 'big-5': 'big5', 'x-big5': 'big5', cp950: 'big5',
    'utf-16': 'utf-16le', 'utf-16le': 'utf-16le', 'utf-16be': 'utf-16be',
    'iso-8859-1': 'latin1', latin1: 'latin1', 'windows-1252': 'windows-1252',
  };
  return map[l] || null;
}

/** 从 HTML/XHTML 字节里找 charset 声明，交给 decodeBytes。 */
export function decodeHtmlBytes(buf) {
  const head = Buffer.isBuffer(buf) ? buf.subarray(0, 2048).toString('latin1') : '';
  const m = head.match(/<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i)
    || head.match(/encoding\s*=\s*["']([\w-]+)["']/i);
  return decodeBytes(buf, m ? m[1] : null);
}

// ---------------------------------------------------------------------------
// HTML 分章
// ---------------------------------------------------------------------------

function headingText(inner) {
  return textOf(inner).replace(/\s+/g, ' ').trim();
}

/**
 * 在 <h1>/<h2>/<h3> 处切分已清洗的 HTML。标题标签本身被移除（章节标题单独展示）。
 * 返回 [{ title, html }]，首个标题之前的内容 title 为 ''。
 */
export function splitHtmlByHeadings(html, levels = [1, 2, 3]) {
  const src = String(html || '');
  if (!src.trim()) return [];
  const re = new RegExp(`<h([${levels.join('')}])(?:\\s[^>]*)?>([\\s\\S]*?)</h\\1\\s*>`, 'gi');
  const out = [];
  let last = 0;
  let title = '';
  let m;
  while ((m = re.exec(src))) {
    const body = src.slice(last, m.index);
    if (body.trim() || title) out.push({ title, html: body.trim() });
    title = headingText(m[2]).slice(0, 80);
    last = m.index + m[0].length;
  }
  const tail = src.slice(last);
  if (tail.trim() || title) out.push({ title, html: tail.trim() });
  return out.filter((c) => c.html);
}

/** 如果 HTML 以标题开头，取出标题文字并从正文里删掉（章节标题单独展示）。 */
export function takeFirstHeading(html) {
  const src = String(html || '');
  const m = src.match(/^\s*<h([1-6])[^>]*>([\s\S]*?)<\/h\1\s*>/i);
  if (!m) return { title: '', html: src };
  return {
    title: headingText(m[2]).slice(0, 80),
    html: src.slice(m[0].length),
  };
}

/** 没有标题时按纯文本规则分章（第 X 章 / Chapter N）。 */
export function splitByPlainRules(text) {
  return splitPlainText(text).map((u) => ({ title: u.title, html: '' }));
}

/** 按体积在块级标签边界切分，用于没有标题的长文档。 */
export function chunkHtml(html, target = 8000) {
  const src = String(html || '');
  const blocks = src.split(/(?<=<\/(?:p|h[1-6]|li|blockquote|div|pre|table|section)>)/i);
  const out = [];
  let buf = '';
  for (const b of blocks) {
    if (buf && (buf.length + b.length) > target * 1.25 && buf.length >= target * 0.5) {
      out.push(buf);
      buf = '';
    }
    buf += b;
  }
  if (buf.trim()) out.push(buf);
  return out.filter((s) => s.trim());
}

/**
 * 把过短且没有标题的片段并入相邻章节。
 * titled=true 的章节即使很短也保留（例如“版权页”）。
 */
export function mergeTinyChapters(chapters, min = 300) {
  const units = chapters.filter((c) => c && String(c.html || '').trim());
  const out = [];
  let pending = null; // 待并入下一章的小片段
  for (const ch of units) {
    const len = textOf(ch.html).length;
    const tiny = !ch.title && len < min;
    if (tiny) {
      pending = pending ? { title: '', html: pending.html + '\n' + ch.html } : { ...ch };
      continue;
    }
    if (pending) {
      out.push({ title: ch.title || '', html: pending.html + '\n' + ch.html });
      pending = null;
    } else {
      out.push(ch);
    }
  }
  if (pending) {
    // 结尾的小片段：并入上一章，没有上一章就单独成章
    if (out.length) out[out.length - 1].html += '\n' + pending.html;
    else out.push(pending);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 杂项
// ---------------------------------------------------------------------------

export function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/** fast-xml-parser 的节点 → 纯文本 */
export function nodeText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(nodeText).filter(Boolean).join(' ');
  if (typeof v === 'object') return String(v['#text'] ?? '');
  return '';
}

export function attrOf(v, name) {
  if (!v || typeof v !== 'object') return '';
  return String(v[`@_${name}`] ?? '');
}

/** 清理元数据字符串：去标签、压缩空白、截断。 */
export function cleanMeta(s, max = 300) {
  return String(s ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/[\s\u3000]+/g, ' ')
    .trim()
    .slice(0, max);
}

export function guessTitle(text, filePath) {
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines.slice(0, 20)) {
    const t = line
      .replace(/^[\s　]+|[\s　]+$/g, '')
      .replace(/^#{1,6}\s*/, '')          // Markdown 标题记号
      .replace(/^\*\*(.+)\*\*$/, '$1')
      .replace(/^[-*+]\s+/, '');
    if (!t) continue;
    if (t.length <= 40 && !/[。！？；]/.test(t) && !/^[<>{}[\]]/.test(t)) return t;
    break;
  }
  return path.basename(String(filePath || '未命名')).replace(/\.[a-z0-9]+$/i, '') || '未命名';
}

/** 按文件头识别图片格式，返回 jpg/png/gif/webp/bmp/svg 或 null。 */
export function sniffImageExt(buf) {
  if (!buf || buf.length < 4) return null;
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF'
    && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (/^\s*<(\?xml|svg)/i.test(b.subarray(0, 256).toString('latin1'))) return 'svg';
  return null;
}

export function posixDirname(p) {  const s = String(p || '').replace(/\\/g, '/');
  const i = s.lastIndexOf('/');
  return i === -1 ? '' : s.slice(0, i);
}

/** 拼接并规范化 POSIX 路径；越界（../ 逃逸）返回 null。 */
export function joinPosix(base, rel) {
  const r = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const segs = String(base || '').split('/').filter((s) => s && s !== '.');
  for (const seg of r.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (!segs.length) return null; // 越过根目录
      segs.pop();
    } else {
      segs.push(seg);
    }
  }
  return segs.join('/');
}

export function safeDecodeUri(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}
