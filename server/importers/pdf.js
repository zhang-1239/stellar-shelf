// PDF：pdfjs-dist 的 legacy 构建（Node 专用），逐页抽文本成章。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { escapeHtml, sanitizeFragment } from './html.js';
import { cleanMeta } from './util.js';

const require = createRequire(import.meta.url);

let pdfjsPromise = null;

async function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      // pdfjs 首次导入会打印 canvas/DOMMatrix 缺失的告警；我们只抽文本、不渲染，先静音。
      const savedLog = console.log;
      const savedWarn = console.warn;
      let pdfjs;
      try {
        console.log = () => {};
        console.warn = () => {};
        pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      } finally {
        console.log = savedLog;
        console.warn = savedWarn;
      }
      // Node 里没有真正的 worker：指向 legacy worker 文件，pdfjs 会以 fake worker 方式加载
      try {
        const workerPath = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
        pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;
      } catch { /* 没有 worker 时 pdfjs 会退回 fake worker */ }
      return pdfjs;
    })();
  }
  return pdfjsPromise;
}

function standardFontsUrl() {
  try {
    const pkg = require.resolve('pdfjs-dist/package.json');
    return pathToFileURL(path.join(path.dirname(pkg), 'standard_fonts') + path.sep).href;
  } catch {
    return undefined;
  }
}

/** 合并同一行的文本项：y 变化或 hasEOL 视为换行。 */
function pageLines(items) {
  const lines = [];
  let cur = '';
  let lastY = null;
  for (const it of items) {
    if (typeof it.str !== 'string') continue;
    const y = Array.isArray(it.transform) ? it.transform[5] : null;
    const newLineByY = lastY != null && y != null && Math.abs(y - lastY) > 2.5;
    if (cur && (newLineByY || it.hasEOL)) {
      lines.push(cur);
      cur = '';
    }
    if (it.str) {
      // 相邻文本项之间补空格（西文单词常被拆成多个 item）
      if (cur && !/\s$/.test(cur) && !/^\s/.test(it.str) && /[A-Za-z0-9,.;:]$/.test(cur)) cur += ' ';
      cur += it.str;
    }
    if (y != null) lastY = y;
    if (it.hasEOL && cur) { lines.push(cur); cur = ''; }
  }
  if (cur) lines.push(cur);
  return lines.map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim()).filter(Boolean);
}

export async function parse(filePath, opts = {}) {
  const warnings = [];
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch (e) {
    throw new Error(`PDF 文件无法读取：${e.message}`);
  }
  if (buf.length < 8 || buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new Error('不是有效的 PDF 文件');
  }

  const pdfjs = await getPdfjs();
  const data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const doc = await pdfjs.getDocument({
    data,
    useSystemFonts: false,
    isEvalSupported: false,
    disableFontFace: true,
    standardFontDataUrl: standardFontsUrl(),
    verbosity: 0,
  }).promise;

  const meta = {
    title: '', author: '', publisher: '', pubDate: '', isbn: '', pages: doc.numPages || 0,
    price: '', binding: '', translator: '', subtitle: '', summary: '', language: '',
  };

  try {
    const md = await doc.getMetadata();
    const info = (md && md.info) || {};
    meta.title = cleanMeta(info.Title || info.title, 200);
    meta.author = cleanMeta(info.Author || info.author, 200);
    meta.publisher = ''; // PDF 的 Creator/Producer 是制作软件，不是出版社
    const created = info.CreationDate;
    // 常见的 PDF 日期写法：D:YYYYMMDDHHmmSS
    const m = typeof created === 'string' && created.match(/D:(\d{4})(\d{2})(\d{2})/);
    if (m) meta.pubDate = `${m[1]}-${m[2]}-${m[3]}`;
    else if (created instanceof Date && !Number.isNaN(created.getTime())) {
      meta.pubDate = created.toISOString().slice(0, 10);
    }
    if (md && md.metadata && typeof md.metadata.get === 'function') {
      meta.title = meta.title || cleanMeta(md.metadata.get('dc:title'), 200);
      meta.author = meta.author || cleanMeta(md.metadata.get('dc:creator'), 200);
    }
  } catch (e) {
    warnings.push(`PDF 元数据读取失败：${e.message}`);
  }

  const chapters = [];
  const total = doc.numPages || 0;
  for (let p = 1; p <= total; p++) {
    try {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const lines = pageLines(tc.items || []);
      if (lines.length) {
        const html = lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('\n');
        chapters.push({ title: `第 ${p} 页`, html: sanitizeFragment(html) });
      }
      page.cleanup();
    } catch (e) {
      warnings.push(`第 ${p} 页解析失败：${e.message}`);
    }
  }

  if (!chapters.length) warnings.push('PDF 中没有可提取的文本（可能是扫描版）');

  return {
    meta,
    cover: null,
    chapters,
    assets: [],
    warnings: warnings.slice(0, 20),
    pageCount: total,
  };
}
