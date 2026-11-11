// DOCX：mammoth 转 HTML，按 h1/h2 分章；无标题时按体积切块。
import AdmZip from 'adm-zip';
import mammoth from 'mammoth';
import { XMLParser } from 'fast-xml-parser';
import { sanitizeFragment, textOf } from './html.js';
import {
  asArray, nodeText, cleanMeta, splitHtmlByHeadings, chunkHtml, mergeTinyChapters,
  guessTitle, sniffImageExt,
} from './util.js';

const MAX_THUMB = 8 * 1024 * 1024;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

const STYLE_MAP = [
  "p[style-name='Heading 1'] => h1:fresh",
  "p[style-name='Heading 2'] => h2:fresh",
  "p[style-name='Heading 3'] => h3:fresh",
  "p[style-name='Title'] => h1.title:fresh",
  "p[style-name='标题 1'] => h1:fresh",
  "p[style-name='标题 2'] => h2:fresh",
  "p[style-name='标题 3'] => h3:fresh",
];

function readCoreMeta(zip) {
  const out = {};
  try {
    const entry = zip.getEntry('docProps/core.xml');
    if (!entry) return out;
    const xml = entry.getData().toString('utf8');
    const core = parser.parse(xml).coreProperties || {};
    const t = cleanMeta(nodeText(asArray(core.title)[0]), 200);
    const a = cleanMeta(nodeText(asArray(core.creator)[0]), 100);
    const d = cleanMeta(nodeText(asArray(core.created)[0]), 32);
    if (t) out.title = t;
    if (a) out.author = a;
    const m = d.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m) out.pubDate = `${m[1]}-${m[2]}-${m[3]}`;
  } catch { /* core.xml 可选 */ }
  return out;
}

function readThumbnail(zip) {
  for (const name of ['docProps/thumbnail.jpeg', 'docProps/thumbnail.jpg', 'docProps/thumbnail.png']) {
    try {
      const entry = zip.getEntry(name);
      if (!entry) continue;
      if ((Number(entry.header && entry.header.size) || 0) > MAX_THUMB) continue;
      const data = entry.getData();
      if (!data || !data.length) continue;
      const ext = sniffImageExt(data);
      if (!ext) continue;
      return { ext, data };
    } catch { /* 继续找 */ }
  }
  return null;
}

export async function parse(filePath, opts = {}) {
  const warnings = [];
  const assets = [];
  let imgSeq = 0;

  let zip = null;
  try {
    zip = new AdmZip(filePath);
  } catch (e) {
    throw new Error(`不是有效的 DOCX 文件：${e.message}`);
  }
  const core = readCoreMeta(zip);
  const cover = readThumbnail(zip);

  let result;
  try {
    result = await mammoth.convertToHtml({ path: filePath }, {
      styleMap: STYLE_MAP,
      // 内嵌图片改成 assets/ 引用，字节留在 assets 里
      convertImage: mammoth.images.imgElement(async (image) => {
        try {
          const raw = await image.read();
          const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
          let ext = sniffImageExt(data);
          if (!ext) {
            const ct = String(image.contentType || '').toLowerCase();
            ext = ct.includes('jpeg') ? 'jpg' : ct.includes('png') ? 'png'
              : ct.includes('gif') ? 'gif' : ct.includes('svg') ? 'svg'
                : ct.includes('webp') ? 'webp' : null;
          }
          if (!ext || !data.length) return { src: '' };
          const name = `img-${String(++imgSeq).padStart(3, '0')}.${ext}`;
          assets.push({ path: `assets/${name}`, data });
          return { src: `assets/${name}` };
        } catch {
          return { src: '' };
        }
      }),
    });
  } catch (e) {
    throw new Error(`DOCX 解析失败：${e.message}`);
  }

  // mammoth 的提示（跳过不支持的样式等）去重后最多 5 条
  const seen = new Set();
  for (const msg of result.messages || []) {
    const text = String(msg && msg.message ? msg.message : msg).trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    if (seen.size > 5) break;
    warnings.push(`DOCX: ${text}`);
  }

  const clean = sanitizeFragment(result.value || '', {
    rewriteSrc: (src) => (/^assets\//.test(src) ? src : null),
  });

  const parts = splitHtmlByHeadings(clean, [1, 2]);
  let chapters;
  if (parts.length > 1) {
    chapters = mergeTinyChapters(parts, 300);
  } else {
    const chunks = chunkHtml(clean, 8000);
    if (chunks.length > 1) {
      chapters = chunks.map((html, i) => ({ title: `第 ${i + 1} 部分`, html }));
    } else {
      const title = core.title || guessTitle(textOf(clean), filePath);
      chapters = clean.trim() ? [{ title, html: clean }] : [];
    }
  }

  if (!chapters.length) warnings.push('DOCX 中没有可解析的正文');

  const meta = {
    title: core.title || guessTitle(textOf(clean), filePath),
    author: core.author || '',
    publisher: '', pubDate: core.pubDate || '', isbn: '', pages: '',
    price: '', binding: '', translator: '', subtitle: '', summary: '', language: '',
  };

  return { meta, cover: cover || null, chapters, assets, warnings };
}
