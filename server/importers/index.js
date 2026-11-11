// 导入管线：分发到各格式解析器，并把结果落盘到 data/content/<id>/
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DIR, bookFilePath, contentDir, coverPath } from '../paths.js';
import { db, q } from '../db.js';
import { countWords, escapeHtml, textOf } from './html.js';
import { toSimplified, simplifyHtml } from '../simplify.js';

export const SUPPORTED = ['epub', 'pdf', 'txt', 'docx', 'mobi', 'azw3', 'md', 'markdown', 'html', 'htm'];

export function extOf(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

export const FORMAT_LABEL = {
  epub: 'EPUB', pdf: 'PDF', txt: 'TXT', docx: 'DOCX', mobi: 'MOBI', azw3: 'AZW3',
  md: 'Markdown', markdown: 'Markdown', html: 'HTML', htm: 'HTML',
};

const PARSERS = {
  epub: () => import('./epub.js'),
  txt: () => import('./txt.js'),
  md: () => import('./txt.js'),
  markdown: () => import('./txt.js'),
  html: () => import('./txt.js'),
  htm: () => import('./txt.js'),
  docx: () => import('./docx.js'),
  mobi: () => import('./mobi.js'),
  azw3: () => import('./mobi.js'),
  pdf: () => import('./pdf.js'),
};

/**
 * 解析一本书。返回统一结构：
 * { meta, cover:{ext,data}|null, chapters:[{title,html}], assets:[{path,ext,data}], warnings }
 */
export async function parseBook(filePath, ext, opts = {}) {
  const loader = PARSERS[ext];
  if (!loader) throw new Error(`暂不支持 .${ext} 格式`);
  const mod = await loader();
  const result = await mod.parse(filePath, opts);
  return normalize(result, ext);
}

function normalize(r, ext) {
  const out = {
    meta: r.meta || {},
    cover: r.cover && r.cover.data ? r.cover : null,
    chapters: [],
    assets: r.assets || [],
    warnings: r.warnings || [],
    pageCount: r.pageCount || 0,
  };
  for (const ch of r.chapters || []) {
    const html = ch.html != null ? ch.html : (ch.text != null ? `<p>${escapeHtml(ch.text)}</p>` : '');
    if (!String(html).trim()) continue;
    out.chapters.push({ title: (ch.title || '').trim() || `第 ${out.chapters.length + 1} 节`, html });
  }
  if (!out.chapters.length) {
    out.chapters.push({ title: '正文', html: '<p>（这本书没有可解析的正文内容。）</p>' });
    out.warnings.push('未解析到正文');
  }
  return out;
}

function slugName(name, ext) {
  const base = String(name || 'cover').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 20);
  return `${base || 'cover'}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
}

/**
 * 把上传的临时文件导入书库。
 */
export async function ingestUpload({ tmpPath, ext, originalName, meta = {}, tags = [] }) {
  const parsed = await parseBook(tmpPath, ext, { originalName });

  const m = { ...parsed.meta, ...meta };
  const title = toSimplified((m.title || '').trim()) || guessTitleFromName(originalName);
  const author = toSimplified((m.author || '').trim()) || null;
  const summary = toSimplified((m.summary || '').trim()) || null;

  const contents = parsed.chapters.map((c) => {
    const html = simplifyHtml(c.html);
    const text = textOf(html);
    return { title: toSimplified(c.title), html, words: countWords(text) };
  });
  const totalWords = contents.reduce((s, c) => s + c.words, 0);
  const totalText = contents.map((c) => textOf(c.html)).join('\n');
  const autoSummary = summary || autoSummaryFrom(totalText);

  const info = q.run(
    `INSERT INTO books (title, subtitle, author, translator, publisher, pub_date, isbn, pages, price,
       binding, summary, source, format, file_size, content_ready, chapter_count, word_count, star_seed, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    title, m.subtitle || null, author, m.translator || null, m.publisher || null, m.pubDate || null,
    m.isbn || null, m.pages || null, m.price || null, m.binding || null, autoSummary,
    'upload', ext, fs.statSync(tmpPath).size, 1, contents.length, totalWords,
    Math.random(), 'unread'
  );
  const id = Number(info.lastInsertRowid);

  // 原始文件归档
  const dest = bookFilePath(id, ext);
  fs.copyFileSync(tmpPath, dest);
  q.run('UPDATE books SET file_path = ? WHERE id = ?', path.relative(DIR.data, dest), id);

  // 正文
  const dir = contentDir(id);
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  for (const a of parsed.assets) {
    const target = path.join(dir, a.path);
    if (!target.startsWith(dir)) continue;       // 防目录穿越
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, a.data);
  }
  contents.forEach((c, i) => {
    const rel = `c${String(i + 1).padStart(4, '0')}.html`;
    const html = c.html.replace(/src="assets\//g, `src="/api/books/${id}/asset/assets/`);
    fs.writeFileSync(path.join(dir, rel), html, 'utf8');
    q.run('INSERT INTO chapters (book_id, idx, title, href, word_count) VALUES (?,?,?,?,?)',
      id, i, c.title, rel, c.words);
  });

  // 封面
  if (parsed.cover) {
    const name = slugName('cover', parsed.cover.ext || 'jpg');
    fs.writeFileSync(coverPath(name), parsed.cover.data);
    q.run('UPDATE books SET cover_path = ? WHERE id = ?', `covers/${name}`, id);
  }

  // 标签
  const tagNames = (Array.isArray(tags) ? tags : String(tags || '').split(/[,，\s]+/))
    .map((t) => String(t).trim()).filter(Boolean);
  for (const name of tagNames) {
    q.run('INSERT OR IGNORE INTO tags(name) VALUES(?)', name);
    const t = q.get('SELECT id FROM tags WHERE name = ?', name);
    if (t) q.run('INSERT OR IGNORE INTO book_tags(book_id, tag_id) VALUES(?,?)', id, t.id);
  }

  return getBook(id);
}

export function guessTitleFromName(name) {
  return String(name || '未命名')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[（(【\[].*?[)）】\]]/g, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || '未命名';
}

function autoSummaryFrom(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  const cut = clean.slice(0, 180);
  return cut.length < clean.length ? cut + '……' : cut;
}

export function getBook(id) {
  const b = q.get('SELECT * FROM books WHERE id = ?', Number(id));
  if (!b) return null;
  b.tags = q.all(`SELECT t.name FROM tags t JOIN book_tags bt ON bt.tag_id=t.id WHERE bt.book_id=? ORDER BY t.name`, b.id).map(r => r.name);
  b.chapters = q.all('SELECT idx, title, word_count FROM chapters WHERE book_id = ? ORDER BY idx', b.id);
  b.note_count = q.get('SELECT COUNT(*) c FROM notes WHERE book_id = ?', b.id).c;
  return b;
}

export { escapeHtml };
