// 纯文本 / Markdown / HTML：编码探测 + 分章 + 段落化。
import fs from 'node:fs';
import path from 'node:path';
import { sanitizeFragment, escapeHtml, splitPlainText, textOf, textToParagraphsHtml } from './html.js';
import {
  decodeBytes, decodeHtmlBytes, splitHtmlByHeadings, mergeTinyChapters,
  guessTitle, sniffImageExt, safeDecodeUri, chunkHtml,
} from './util.js';

const MAX_IMG = 20 * 1024 * 1024;
const IMG_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg']);
const STOP_IMG = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i; // http: data: file: //host

function extOf(p) {
  const m = String(p || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

/** 从正文开头几行里找 “作者：XXX / 书名：XXX”。 */
function sniffMeta(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/).slice(0, 20)) {
    const t = line.trim();
    const a = t.match(/^(?:作\s*者|著\s*者|Author)\s*[:：]\s*(.{1,40})$/i);
    if (a && !out.author) out.author = a[1].trim();
    const b = t.match(/^(?:书\s*名|标\s*题|Title)\s*[:：]\s*(.{1,60})$/i);
    if (b && !out.title) out.title = b[1].trim();
  }
  return out;
}

/** 单行过长又靠全角缩进分段时，先在缩进处切开。 */
function splitLongIndented(text) {
  if (!text.includes('　　')) return text;
  return text.split('\n').map((line) => {
    if (line.length < 400 || !line.includes('　　')) return line;
    return line.split(/(?=　　)/).join('\n');
  }).join('\n');
}

/** 段落化：保留中文两字缩进 → text-indent:2em。 */
function paragraphsHtml(text) {
  const src = splitLongIndented(String(text || '').replace(/\r\n?/g, '\n'));
  // 交给统一的段落排版：短句成诗、长行按缩进合并回自然段
  return sanitizeFragment(textToParagraphsHtml(src));
}

// --- 本地图片 ---------------------------------------------------------------

function makeImageCopier(filePath, assets, warnings) {
  const dir = path.dirname(path.resolve(filePath));
  const byName = new Map();
  let seq = 0;
  return function copy(rawSrc) {
    const src = String(rawSrc || '').trim();
    if (!src || STOP_IMG.test(src)) return null; // 远程/内联图片一律丢弃
    const rel = safeDecodeUri(src.split('#')[0].split('?')[0]);
    const abs = path.resolve(dir, rel);
    if (abs !== dir && !abs.startsWith(dir + path.sep)) return null; // 只读源文件目录内
    if (byName.has(abs)) return byName.get(abs);
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) return null;
      if (st.size > MAX_IMG) {
        warnings.push(`图片过大已跳过：${rel}`);
        return null;
      }
      const data = fs.readFileSync(abs);
      const ext = sniffImageExt(data) || extOf(abs);
      if (!IMG_EXT.has(ext)) return null;
      const e = ext === 'jpeg' ? 'jpg' : ext;
      const name = `img-${String(++seq).padStart(3, '0')}.${e}`;
      assets.push({ path: `assets/${name}`, data });
      byName.set(abs, `assets/${name}`);
      return `assets/${name}`;
    } catch {
      return null;
    }
  };
}

// --- Markdown ---------------------------------------------------------------

const HR_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const HEAD_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const UL_RE = /^\s{0,3}[-*+]\s+(.*)$/;
const OL_RE = /^\s{0,3}\d+[.)]\s+(.*)$/;
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;

function mdInline(s, img) {
  let t = escapeHtml(s);
  t = t.replace(/!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g,
    (m, alt, url) => {
      const local = img ? img(url) : null;
      return local ? `<img src="${local}" alt="${alt}">` : '';
    });
  t = t.replace(/\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g,
    (m, label, url) => (/^(?:https?:|mailto:|#)/i.test(url) ? `<a href="${url}">${label}</a>` : label));
  t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
  t = t.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  t = t.replace(/ {2,}$/gm, '<br>');
  return t;
}

function mdToHtml(src, img) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const fence = line.match(/^\s*(```+|~~~+)\s*[\w+#-]*\s*$/);
    if (fence) {
      const mark = fence[1][0].repeat(3);
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(mark)) { buf.push(lines[i]); i++; }
      i++; // 跳过收尾围栏
      out.push(`<pre><code>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }

    if (HR_RE.test(line)) { out.push('<hr>'); i++; continue; }

    const h = line.match(HEAD_RE);
    if (h) {
      const level = Math.min(h[1].length + 1, 6); // # → h2（h1 留给书名）
      out.push(`<h${level}>${mdInline(h[2], img)}</h${level}>`);
      i++;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const buf = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        buf.push(lines[i].match(QUOTE_RE)[1]);
        i++;
      }
      out.push(`<blockquote>${buf.map((l) => `<p>${mdInline(l, img)}</p>`).join('')}</blockquote>`);
      continue;
    }

    if (UL_RE.test(line) || OL_RE.test(line)) {
      const ordered = OL_RE.test(line);
      const re = ordered ? OL_RE : UL_RE;
      const items = [];
      while (i < lines.length && re.test(lines[i])) {
        items.push(`<li>${mdInline(lines[i].match(re)[1], img)}</li>`);
        i++;
        // 列表项之间的空行
        while (i < lines.length && !lines[i].trim() && i + 1 < lines.length && re.test(lines[i + 1])) i++;
      }
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }

    // 普通段落：连续的非空行合并
    const buf = [];
    while (i < lines.length && lines[i].trim() && !HEAD_RE.test(lines[i]) && !HR_RE.test(lines[i])
      && !UL_RE.test(lines[i]) && !OL_RE.test(lines[i]) && !QUOTE_RE.test(lines[i])
      && !/^\s*(```+|~~~+)/.test(lines[i])) {
      buf.push(lines[i].trim());
      i++;
    }
    if (buf.length) out.push(`<p>${buf.map((l) => mdInline(l, img)).join('\n')}</p>`);
    else i++;
  }
  return out.join('\n');
}

// --- 各分支 -----------------------------------------------------------------

function baseMeta(title) {
  return {
    title: title || '', author: '', publisher: '', pubDate: '', isbn: '', pages: '',
    price: '', binding: '', translator: '', subtitle: '', summary: '', language: '',
  };
}

function parsePlain(buf, filePath, warnings) {
  const text = decodeBytes(buf).replace(/\u0000/g, '');
  const sniffed = sniffMeta(text);
  const meta = baseMeta(sniffed.title || guessTitle(text, filePath));
  if (sniffed.author) meta.author = sniffed.author;

  const units = splitPlainText(text);
  const chapters = units
    .map((u) => ({ title: u.title, html: paragraphsHtml(u.text) }))
    .filter((c) => c.html);
  if (!chapters.length) warnings.push('文本中没有可解析的段落');
  return { meta, cover: null, chapters, assets: [], warnings };
}

function parseHtmlDoc(buf, filePath, warnings) {
  const text = decodeHtmlBytes(buf);
  const assets = [];
  const copyImage = makeImageCopier(filePath, assets, warnings);
  const bodyMatch = text.match(/<body\b[^>]*>([\s\S]*)<\/body\s*>/i);
  const body = bodyMatch ? bodyMatch[1] : text;

  const clean = sanitizeFragment(body, {
    // 图片已在 copyImage 里改名，这里只放行我们自己生成的 assets/ 路径
    rewriteSrc: (src) => (/^assets\//.test(src) ? src : copyImage(src)),
  });
  if (!clean.trim()) {
    warnings.push('HTML 中没有可解析的正文');
    return { meta: baseMeta(guessTitle('', filePath)), cover: null, chapters: [], assets, warnings };
  }

  const parts = splitHtmlByHeadings(clean, [1, 2, 3]);
  let chapters;
  if (parts.length > 1) {
    chapters = mergeTinyChapters(parts, 300);
  } else {
    // 没有小标题：长文档按体积切，短文档整篇一章
    const title = guessTitle(textOf(clean), filePath);
    const chunks = textOf(clean).length > 30000 ? chunkHtml(clean, 12000) : [clean];
    chapters = chunks.map((html, idx) => ({
      title: chunks.length > 1 ? `${title}（${idx + 1}）` : title,
      html,
    }));
  }
  return { meta: baseMeta(guessTitle(textOf(clean), filePath)), cover: null, chapters, assets, warnings };
}

function parseMarkdown(buf, filePath, warnings) {
  const src = decodeBytes(buf).replace(/\u0000/g, '').replace(/\r\n?/g, '\n');
  const assets = [];
  const copyImage = makeImageCopier(filePath, assets, warnings);
  const meta = baseMeta(guessTitle(src, filePath));

  const hasHeadings = /^\s{0,3}#{1,3}\s+\S/m.test(src);
  let chapters;
  if (hasHeadings) {
    const html = sanitizeFragment(mdToHtml(src, copyImage), {
      rewriteSrc: (s) => (/^assets\//.test(s) ? s : null),
    });
    chapters = mergeTinyChapters(splitHtmlByHeadings(html, [2, 3]), 300);
  } else {
    // 没有 Markdown 标题：复用纯文本分章，再逐章转 HTML
    chapters = splitPlainText(src)
      .map((u) => ({ title: u.title, html: mdToHtml(u.text, copyImage) }))
      .filter((c) => textOf(c.html).trim());
  }
  if (!chapters.length) warnings.push('Markdown 中没有可解析的正文');
  return { meta, cover: null, chapters, assets, warnings };
}

export async function parse(filePath, opts = {}) {
  const warnings = [];
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch (e) {
    throw new Error(`文件无法读取：${e.message}`);
  }
  if (!buf.length) throw new Error('文件是空的');

  const ext = extOf(filePath) || extOf(opts.originalName) || 'txt';
  if (ext === 'html' || ext === 'htm') return parseHtmlDoc(buf, filePath, warnings);
  if (ext === 'md' || ext === 'markdown') return parseMarkdown(buf, filePath, warnings);
  return parsePlain(buf, filePath, warnings);
}
