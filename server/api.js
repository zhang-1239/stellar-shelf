// HTTP API
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { q, db, setTagsForBook, bookTags, today, setting, setSetting } from './db.js';
import { DIR, bookFilePath, contentDir, coverPath } from './paths.js';
import { ingestUpload, extOf, SUPPORTED, FORMAT_LABEL, getBook } from './importers/index.js';
import * as daily from './daily.js';
import * as douban from './douban.js';
import { textOf } from './importers/html.js';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp3': 'audio/mpeg', '.wasm': 'application/wasm',
};

export function send(res, code, body, headers = {}) {
  res.writeHead(code, {
    'cache-control': 'no-store',
    // 插件面板（不同源）要能探测和调用这些接口
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    ...headers,
  });
  res.end(body);
}

export function json(res, data, code = 200) {
  send(res, code, JSON.stringify(data), { 'content-type': 'application/json; charset=utf-8' });
}

export async function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function publicBook(b) {
  if (!b) return b;
  return { ...b, tags: b.tags ?? bookTags(b.id) };
}

// 把细碎标签归并成「星系」级别的题材：整词匹配，按优先级取第一个命中的
const GENRE_SETS = [
  ['社科', ['社科', '历史', '政治', '社会', '经济', '哲学', '心理', '人类学', '思想', '制度', '治理', '社会学']],
  ['科学', ['科学', '科技', '计算机', '数学', '物理', '生物', '化学', '工程', '算法', '科普']],
  ['艺术', ['艺术', '设计', '美学', '音乐', '摄影', '电影', '绘画', '建筑']],
  ['生活', ['生活', '旅行', '饮食', '健康', '成长', '教育', '育儿']],
  ['小说', ['小说', '长篇', '短篇', '章回', '话本', '传奇', '故事']],
  ['神话', ['神话', '传说', '志怪', '山海', '搜神', '聊斋', '宇宙']],
  ['古典', ['诗', '词', '赋', '曲', '先秦', '魏晋', '唐', '宋', '元', '汉', '明', '清', '经典', '楚辞', '古文', '乐府', '国学']],
  ['文学', ['文学', '散文', '随笔', '诗歌', '外国', '译', '当代', '现代']],
];

function genreOf(primaryTag, tags = []) {
  const all = [primaryTag, ...tags].filter(Boolean).map((t) => String(t).trim());
  for (const [name, list] of GENRE_SETS) {
    if (all.some((t) => list.includes(t))) return name;
  }
  return (primaryTag && String(primaryTag).trim()) || '未分类';
}
// 题材（星系）目录：一份可编辑的名单，存在 settings.genres 里
const DEFAULT_GENRES = ['古典', '小说', '神话', '文学', '社科', '科学', '艺术', '生活', '未分类'];

function usedOverrideGenres() {
  return q.all(`SELECT DISTINCT genre_override AS g FROM books
                WHERE genre_override IS NOT NULL AND genre_override != ''`).map((r) => r.g);
}

/** 当前分类名单（首次访问时用内置 + 已有归属初始化） */
function genreCatalog() {
  let list = null;
  try { list = JSON.parse(setting('genres') || 'null'); } catch { list = null; }
  if (!Array.isArray(list) || !list.length) {
    list = [...new Set([...DEFAULT_GENRES, ...usedOverrideGenres()])];
    setSetting('genres', JSON.stringify(list));
  }
  if (!list.includes('未分类')) list.push('未分类');
  return list;
}
function setCatalog(list) {
  const clean = [...new Set(list.map((g) => String(g || '').trim()).filter(Boolean))];
  if (!clean.includes('未分类')) clean.push('未分类');
  setSetting('genres', JSON.stringify(clean));
  return clean;
}

/** 每本书当前实际所属的题材（手动指定优先，其次由标签推导） */
function effectiveGenres() {
  const rows = q.all(`SELECT b.id, b.genre_override,
      (SELECT t.name FROM book_tags bt JOIN tags t ON t.id = bt.tag_id
       WHERE bt.book_id = b.id ORDER BY bt.tag_id LIMIT 1) AS primary_tag
    FROM books b`);
  return rows.map((b) => ({
    id: b.id,
    genre: (b.genre_override || '').trim() || genreOf(b.primary_tag, bookTags(b.id)),
  }));
}

function listBooks(url) {
  const sp = url.searchParams;
  const where = [];
  const args = [];
  const status = sp.get('status');
  if (status && status !== 'all') {
    if (status === 'shelf') where.push("status != 'finished'");
    else { where.push('status = ?'); args.push(status); }
  }
  const tag = sp.get('tag');
  if (tag) {
    where.push(`id IN (SELECT bt.book_id FROM book_tags bt JOIN tags t ON t.id=bt.tag_id WHERE t.name = ?)`);
    args.push(tag);
  }
  const kw = (sp.get('q') || '').trim();
  if (kw) {
    where.push('(title LIKE ? OR author LIKE ? OR publisher LIKE ?)');
    args.push(`%${kw}%`, `%${kw}%`, `%${kw}%`);
  }
  const sort = sp.get('sort') || 'recent';
  const order = {
    recent: 'COALESCE(last_read_at, added_at) DESC',
    added: 'added_at DESC',
    title: 'title COLLATE NOCASE ASC',
    rating: 'COALESCE(rating,0) DESC, title ASC',
    author: 'author ASC',
    progress: 'progress DESC',
    words: 'word_count DESC',
  }[sort] || 'COALESCE(last_read_at, added_at) DESC';

  const rows = q.all(`SELECT *,
      (SELECT t.name FROM book_tags bt JOIN tags t ON t.id = bt.tag_id
       WHERE bt.book_id = books.id ORDER BY bt.tag_id LIMIT 1) AS primary_tag
      FROM books ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY favorite DESC, ${order}`, ...args);
  for (const b of rows) {
    b.tags = bookTags(b.id);
    const override = (b.genre_override || '').trim();
    b.genre = override || genreOf(b.primary_tag, b.tags);
  }
  return rows;
}

// ---------------- 搜索（含正文） ----------------
function searchAll(kw, limit = 40) {
  const like = `%${kw}%`;
  const books = q.all(`SELECT id, title, author, cover_path, status, progress FROM books
                       WHERE title LIKE ? OR author LIKE ? OR summary LIKE ? LIMIT 20`, like, like, like);
  const notes = q.all(`SELECT n.*, b.title AS book_title FROM notes n JOIN books b ON b.id=n.book_id
                       WHERE n.body LIKE ? OR n.excerpt LIKE ? ORDER BY n.created_at DESC LIMIT 20`,
    like, like);
  // 正文检索：扫章节文件（个人书库规模下足够）
  const hits = [];
  const chapters = q.all(`SELECT c.book_id, c.idx, c.title, c.href, b.title AS book_title
                          FROM chapters c JOIN books b ON b.id=c.book_id
                          WHERE b.content_ready = 1 ORDER BY b.last_read_at DESC NULLS LAST LIMIT 4000`);
  for (const c of chapters) {
    if (hits.length >= limit) break;
    try {
      const file = path.join(contentDir(c.book_id), c.href);
      const html = fs.readFileSync(file, 'utf8');
      const idx = html.indexOf(kw);
      if (idx === -1) continue;
      const text = textOf(html);
      const pos = text.indexOf(kw);
      const snippet = text.slice(Math.max(0, pos - 40), pos + 80).replace(/\s+/g, ' ');
      hits.push({
        book_id: c.book_id, book_title: c.book_title, chapter_idx: c.idx,
        chapter_title: c.title, snippet: `…${snippet}…`,
      });
    } catch { /* ignore */ }
  }
  return { books, notes, passages: hits };
}

// ---------------- 统计 ----------------
function stats() {
  const counts = q.all('SELECT status, COUNT(*) c FROM books GROUP BY status');
  const byStatus = Object.fromEntries(counts.map((r) => [r.status, r.c]));
  const total = q.get('SELECT COUNT(*) c FROM books').c;
  const words = q.get('SELECT COALESCE(SUM(word_count),0) w FROM books').w;
  const notes = q.get('SELECT COUNT(*) c FROM notes').c;
  const finishedThisYear = q.get(`SELECT COUNT(*) c FROM books WHERE finished_at >= date('now','start of year')`).c;

  // 连续 12 个月的柱子（补空月）
  const rawMonthly = Object.fromEntries(
    q.all(`SELECT strftime('%Y-%m', COALESCE(finished_at, added_at)) m, COUNT(*) c
           FROM books GROUP BY m`).map((r) => [r.m, r.c])
  );
  const monthly = [];
  {
    const d = new Date();
    d.setDate(1);
    for (let i = 11; i >= 0; i--) {
      const t = new Date(d.getFullYear(), d.getMonth() - i, 1);
      const key = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`;
      monthly.push({ m: key, c: rawMonthly[key] || 0 });
    }
  }
  const streakDays = q.all(`SELECT DISTINCT day FROM sessions WHERE day IS NOT NULL ORDER BY day DESC LIMIT 400`).map((r) => r.day);
  let streak = 0;
  {
    let cursor = new Date();
    for (;;) {
      const p = (n) => String(n).padStart(2, '0');
      const d = `${cursor.getFullYear()}-${p(cursor.getMonth() + 1)}-${p(cursor.getDate())}`;
      if (streakDays.includes(d)) { streak++; cursor.setDate(cursor.getDate() - 1); }
      else if (streak === 0 && d === today()) { cursor.setDate(cursor.getDate() - 1); }
      else break;
    }
  }
  const minutes = Math.round((q.get('SELECT COALESCE(SUM(seconds),0) s FROM sessions').s || 0) / 60);
  const topTags = q.all(`SELECT t.name, COUNT(*) c FROM tags t JOIN book_tags bt ON bt.tag_id=t.id
                         GROUP BY t.name ORDER BY c DESC LIMIT 10`);
  const ratings = q.all(`SELECT ROUND(rating,1) r, COUNT(*) c FROM books WHERE rating IS NOT NULL GROUP BY r ORDER BY r`);
  const recentFinished = q.all(`SELECT id, title, author, cover_path, finished_at, rating FROM books
                                WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 8`);
  const heat = q.all(`SELECT day, SUM(seconds) s, COUNT(DISTINCT book_id) b FROM sessions
                      WHERE day IS NOT NULL GROUP BY day ORDER BY day DESC LIMIT 120`).reverse();
  return {
    total, byStatus, words, notes, finishedThisYear, minutes, streak,
    monthly, topTags, ratings, recentFinished, heat,
    recoActed: q.get(`SELECT COUNT(*) c FROM recos WHERE feedback != 'none'`).c,
    recoInterested: q.get(`SELECT COUNT(*) c FROM recos WHERE feedback = 'interested'`).c,
  };
}

// ---------------- 上传 ----------------
async function handleUpload(req) {
  const busboy = (await import('busboy')).default;
  return new Promise((resolve, reject) => {
    let bb;
    try { bb = busboy({ headers: req.headers, limits: { fileSize: 300 * 1024 * 1024, files: 10 } }); }
    catch (e) { return reject(new Error('无效的上传请求')); }

    const files = [];
    const fields = {};
    const pending = [];

    bb.on('field', (name, val) => { fields[name] = val; });
    bb.on('file', (name, stream, info) => {
      const ext = extOf(info.filename);
      if (!SUPPORTED.includes(ext)) {
        stream.resume();
        pending.push(Promise.resolve({ error: `不支持的格式：.${ext}` }));
        return;
      }
      const tmp = path.join(DIR.data, 'upload-' + crypto.randomBytes(6).toString('hex') + '.' + ext);
      const out = fs.createWriteStream(tmp);
      pending.push(new Promise((res, rej) => {
        stream.pipe(out);
        stream.on('limit', () => { rej(new Error('文件超过 300MB')); });
        out.on('finish', () => res({ tmp, ext, name: info.filename }));
        out.on('error', rej);
      }));
    });
    bb.on('error', reject);
    bb.on('close', async () => {
      try {
        const results = await Promise.all(pending);
        for (const r of results) {
          if (r.error) { files.push(r); continue; }
          try {
            const book = await ingestUpload({
              tmpPath: r.tmp, ext: r.ext, originalName: r.name,
              meta: pickMeta(fields),
              tags: fields.tags ? String(fields.tags).split(/[,，\s]+/).filter(Boolean) : [],
            });
            files.push({ ok: true, book });
          } catch (err) {
            files.push({ error: `${r.name}: ${err.message}` });
          } finally {
            fs.promises.unlink(r.tmp).catch(() => {});
          }
        }
        resolve({ files, fields });
      } catch (err) { reject(err); }
    });
    req.pipe(bb);
  });
}

function pickMeta(fields) {
  const m = {};
  for (const k of ['title', 'author', 'publisher', 'pubDate', 'isbn', 'summary']) {
    if (fields[k] && String(fields[k]).trim()) m[k] = String(fields[k]).trim();
  }
  return m;
}

// ---------------- 路由 ----------------
export async function handleApi(req, res, url) {
  const p = url.pathname.replace(/^\/api/, '');
  const seg = p.split('/').filter(Boolean);
  const method = req.method;

  try {
    // 健康检查
    if (p === '/health') return json(res, { ok: true, day: today() });

    // ---- 书库 ----
    if (p === '/books' && method === 'GET') return json(res, listBooks(url));

    if (p === '/books/import' && method === 'POST') {
      const out = await handleUpload(req);
      const ok = out.files.filter((f) => f.ok).map((f) => f.book);
      const bad = out.files.filter((f) => f.error).map((f) => f.error);
      return json(res, { imported: ok, errors: bad }, bad.length && !ok.length ? 400 : 200);
    }

    if (seg[0] === 'books' && seg[1]) {
      const id = Number(seg[1]);

      if (!seg[2] && method === 'GET') {
        const b = getBook(id);
        if (!b) return json(res, { error: '没有这本书' }, 404);
        b.recent_notes = q.all('SELECT * FROM notes WHERE book_id = ? ORDER BY created_at DESC LIMIT 6', id);
        return json(res, b);
      }

      if (!seg[2] && method === 'PATCH') {
        const body = await readBody(req);
        const fields = {};
        for (const k of ['status', 'progress', 'chapter_idx', 'locator', 'rating', 'favorite', 'summary',
          'title', 'author', 'publisher', 'cover_path', 'genre_override']) {
          if (k in body) fields[k] = body[k];
        }
        if (body.status === 'finished') {
          fields.finished_at = new Date().toISOString().slice(0, 19).replace('T', ' ');
          fields.progress = 1;
        }
        if (body.status && body.status !== 'finished') fields.finished_at = null;
        if (Object.keys(fields).length) {
          const sets = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
          q.run(`UPDATE books SET ${sets}, updated_at = datetime('now') WHERE id = ?`,
            ...Object.values(fields), id);
        }
        if (Array.isArray(body.tags)) setTagsForBook(id, body.tags);
        return json(res, getBook(id));
      }

      if (!seg[2] && method === 'DELETE') {
        const b = q.get('SELECT * FROM books WHERE id=?', id);
        if (b?.file_path) fs.promises.unlink(path.join(DIR.data, b.file_path)).catch(() => {});
        fs.promises.rm(contentDir(id), { recursive: true, force: true }).catch(() => {});
        q.run('DELETE FROM books WHERE id = ?', id);
        return json(res, { ok: true });
      }

      if (seg[2] === 'cover' && method === 'GET') {
        const b = q.get('SELECT cover_path FROM books WHERE id=?', id);
        if (b?.cover_path) {
          const file = path.join(DIR.data, b.cover_path);
          if (fs.existsSync(file)) {
            res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'image/jpeg', 'cache-control': 'max-age=86400' });
            return fs.createReadStream(file).pipe(res);
          }
        }
        return send(res, 404, 'no cover');
      }

      if (seg[2] === 'cover' && method === 'POST') {
        const ct = req.headers['content-type'] || '';
        if (!/^image\//.test(ct)) return json(res, { error: '需要图片' }, 400);
        const name = `custom-${id}-${crypto.randomBytes(3).toString('hex')}.${(ct.split('/')[1] || 'jpg').replace('jpeg', 'jpg')}`;
        const dest = coverPath(name);
        await new Promise((resolve, reject) => {
          const out = fs.createWriteStream(dest);
          req.pipe(out);
          out.on('finish', resolve);
          out.on('error', reject);
        });
        q.run('UPDATE books SET cover_path=? WHERE id=?', `covers/${name}`, id);
        return json(res, { ok: true, cover_path: `covers/${name}` });
      }

      if (seg[2] === 'file' && method === 'GET') {
        const b = q.get('SELECT file_path, format, title FROM books WHERE id=?', id);
        if (!b?.file_path) return send(res, 404, '没有原文件');
        const file = path.join(DIR.data, b.file_path);
        if (!fs.existsSync(file)) return send(res, 404, '文件已丢失');
        const stat = fs.statSync(file);
        res.writeHead(200, {
          'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'content-length': stat.size,
          'accept-ranges': 'bytes',
        });
        return fs.createReadStream(file).pipe(res);
      }

      if (seg[2] === 'chapter' && method === 'GET') {
        const idx = Number(seg[3]);
        const c = q.get('SELECT * FROM chapters WHERE book_id=? AND idx=?', id, idx);
        if (!c) return json(res, { error: '没有这一章' }, 404);
        const file = path.join(contentDir(id), c.href);
        if (!fs.existsSync(file)) return json(res, { error: '章节文件缺失' }, 404);
        const html = fs.readFileSync(file, 'utf8');
        const prev = q.get('SELECT idx, title FROM chapters WHERE book_id=? AND idx<? ORDER BY idx DESC LIMIT 1', id, idx);
        const next = q.get('SELECT idx, title FROM chapters WHERE book_id=? AND idx>? ORDER BY idx ASC LIMIT 1', id, idx);
        return json(res, { idx: c.idx, title: c.title, html, words: c.word_count, prev, next });
      }

      if (seg[2] === 'asset' && method === 'GET') {
        const rel = seg.slice(3).join('/');
        const base = contentDir(id);
        const file = path.resolve(base, rel);
        if (!file.startsWith(base) || !fs.existsSync(file)) return send(res, 404, 'no asset');
        res.writeHead(200, {
          'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'cache-control': 'max-age=604800',
        });
        return fs.createReadStream(file).pipe(res);
      }

      if (seg[2] === 'session' && method === 'POST') {
        const body = await readBody(req);
        const secs = Math.max(0, Math.min(Number(body.seconds) || 0, 8 * 3600));
        if (secs >= 5) {
          q.run(`INSERT INTO sessions (book_id, seconds, words, day) VALUES (?,?,?,?)`,
            id, Math.round(secs), Number(body.words) || 0, today());
        }
        q.run(`UPDATE books SET last_read_at = datetime('now') WHERE id=?`, id);
        return json(res, { ok: true });
      }
    }

    // ---- 全文搜索 ----
    if (p === '/search' && method === 'GET') {
      const kw = (url.searchParams.get('q') || '').trim();
      if (!kw) return json(res, { books: [], notes: [], passages: [] });
      return json(res, searchAll(kw));
    }

    // ---- 笔记 ----
    if (p === '/notes' && method === 'GET') {
      const bid = url.searchParams.get('book');
      const kind = url.searchParams.get('kind');
      const where = [];
      const args = [];
      if (bid) { where.push('n.book_id = ?'); args.push(Number(bid)); }
      if (kind && kind !== 'all') { where.push('n.kind = ?'); args.push(kind); }
      const rows = q.all(`SELECT n.*, b.title AS book_title, b.author AS book_author, b.cover_path
                          FROM notes n JOIN books b ON b.id = n.book_id
                          ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                          ORDER BY n.created_at DESC, n.id DESC`, ...args);
      return json(res, rows);
    }

    if (p === '/notes' && method === 'POST') {
      const b = await readBody(req);
      if (!b.book_id) return json(res, { error: '缺少 book_id' }, 400);
      const info = q.run(
        `INSERT INTO notes (book_id, kind, chapter_idx, chapter_title, locator, excerpt, body, color)
         VALUES (?,?,?,?,?,?,?,?)`,
        Number(b.book_id), b.kind || 'note', b.chapter_idx ?? null, b.chapter_title ?? null,
        b.locator ?? null, b.excerpt ?? null, b.body ?? null, b.color ?? null
      );
      const note = q.get('SELECT * FROM notes WHERE id = ?', Number(info.lastInsertRowid));
      return json(res, note, 201);
    }

    if (seg[0] === 'notes' && seg[1]) {
      const id = Number(seg[1]);
      if (method === 'PATCH') {
        const b = await readBody(req);
        const sets = [];
        const args = [];
        for (const k of ['body', 'excerpt', 'kind', 'color', 'starred', 'locator']) {
          if (k in b) { sets.push(`${k} = ?`); args.push(b[k]); }
        }
        if (sets.length) {
          q.run(`UPDATE notes SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`, ...args, id);
        }
        return json(res, q.get('SELECT * FROM notes WHERE id=?', id));
      }
      if (method === 'DELETE') {
        q.run('DELETE FROM notes WHERE id = ?', id);
        return json(res, { ok: true });
      }
    }

    // ---- 标签 ----
    // ---- 题材（星系）目录：增 / 改名 / 删 ----
    if (p === '/genres' && method === 'GET') {
      return json(res, { genres: genreCatalog() });
    }
    if (p === '/genres' && method === 'POST') {
      const b = await readBody(req);
      const name = String(b.name || '').trim();
      if (!name) return json(res, { error: '缺少名称' }, 400);
      if (name.length > 12) return json(res, { error: '名称最多 12 个字' }, 400);
      const list = genreCatalog();
      if (list.includes(name)) return json(res, { genres: list, existed: true });
      return json(res, { genres: setCatalog([...list, name]) }, 201);
    }
    if (p === '/genres' && method === 'PATCH') {
      const b = await readBody(req);
      const from = String(b.from || '').trim();
      const to = String(b.to || '').trim();
      if (!from || !to) return json(res, { error: '缺少名称' }, 400);
      if (to.length > 12) return json(res, { error: '名称最多 12 个字' }, 400);
      if (from === '未分类') return json(res, { error: '「未分类」不能改名' }, 400);
      const list = genreCatalog();
      if (to !== from && list.includes(to)) return json(res, { error: '已经有同名分类了' }, 400);
      const next = setCatalog(list.map((g) => (g === from ? to : g)));
      // 原来属于它的书，跟着搬过去
      for (const rec of effectiveGenres()) {
        if (rec.genre === from) q.run('UPDATE books SET genre_override=? WHERE id=?', to, rec.id);
      }
      return json(res, { genres: next });
    }
    if (p === '/genres' && method === 'DELETE') {
      const name = String(url.searchParams.get('name') || '').trim();
      if (!name) return json(res, { error: '缺少名称' }, 400);
      if (name === '未分类') return json(res, { error: '「未分类」不能删除' }, 400);
      const next = setCatalog(genreCatalog().filter((g) => g !== name));
      for (const rec of effectiveGenres()) {
        if (rec.genre === name) q.run('UPDATE books SET genre_override=? WHERE id=?', '未分类', rec.id);
      }
      return json(res, { genres: next });
    }

    if (p === '/tags' && method === 'GET') {
      return json(res, q.all(`SELECT t.id, t.name, t.color, COUNT(bt.book_id) c
                              FROM tags t LEFT JOIN book_tags bt ON bt.tag_id = t.id
                              GROUP BY t.id ORDER BY c DESC, t.name`));
    }
    if (p === '/tags' && method === 'POST') {
      const b = await readBody(req);
      const name = String(b.name || '').trim();
      if (!name) return json(res, { error: '缺少名称' }, 400);
      q.run('INSERT OR IGNORE INTO tags (name, color) VALUES (?,?)', name, b.color || null);
      return json(res, q.get('SELECT * FROM tags WHERE name=?', name), 201);
    }
    if (seg[0] === 'tags' && seg[1] === 'rename' && method === 'POST') {
      const b = await readBody(req);
      if (b.from && b.to) {
        q.run('UPDATE tags SET name=? WHERE name=?', String(b.to).trim(), String(b.from).trim());
      }
      return json(res, { ok: true });
    }

    // ---- 星讯 / 推荐 ----
    if (p === '/recos/today' && method === 'GET') {
      let recos = daily.todaysRecos();
      const digest = daily.todaysDigest();
      return json(res, {
        day: today(),
        line: digest?.line || daily.lineFor(today()),
        recos,
        generated: digest?.generated_at || null,
      });
    }
    if (p === '/recos/refresh' && method === 'POST') {
      const r = await daily.generateDaily({ force: true });
      return json(res, { ...r, recos: daily.todaysRecos(), line: daily.lineFor(today()) });
    }
    if (p === '/recos/history' && method === 'GET') {
      const days = q.all(`SELECT day, COUNT(*) c, SUM(feedback != 'none') acted FROM recos GROUP BY day ORDER BY day DESC LIMIT 60`);
      return json(res, days);
    }
    if (seg[0] === 'recos' && seg[1] && seg[2] === 'feedback' && method === 'POST') {
      const id = Number(seg[1]);
      const b = await readBody(req);
      const fb = ['none', 'interested', 'not_interested', 'shelved', 'read'].includes(b.feedback) ? b.feedback : 'none';
      q.run(`UPDATE recos SET feedback=?, thought=?, acted_at=datetime('now') WHERE id=?`,
        fb, b.thought ?? null, id);
      return json(res, q.get('SELECT * FROM recos WHERE id=?', id));
    }
    if (seg[0] === 'recos' && seg[1] && seg[2] === 'shelve' && method === 'POST') {
      const r = daily.shelveReco(Number(seg[1]));
      return json(res, r || { error: '没有这条推荐' }, r ? 200 : 404);
    }
    if (p === '/recos/day' && method === 'GET') {
      const day = url.searchParams.get('day') || today();
      return json(res, daily.todaysRecos(day));
    }

    // ---- 豆瓣检索（给「手动收录」用） ----
    const doubanOn = () => (setting('douban_enabled', 'off') === 'on');
    if (p === '/douban/search' && method === 'GET') {
      if (!doubanOn()) return json(res, { error: '豆瓣推荐源已关闭，可在设置里打开' }, 403);
      const kw = (url.searchParams.get('q') || '').trim();
      if (!kw) return json(res, []);
      return json(res, await douban.suggest(kw));
    }
    if (p === '/douban/add' && method === 'POST') {
      if (!doubanOn()) return json(res, { error: '豆瓣推荐源已关闭，可在设置里打开' }, 403);
      const b = await readBody(req);
      if (!b.doubanId) return json(res, { error: '缺少 doubanId' }, 400);
      const sub = await douban.subject(b.doubanId);
      if (!sub) return json(res, { error: '抓取失败' }, 502);
      const cover = await douban.cacheCover(sub.coverUrl, b.doubanId);
      const info = q.run(
        `INSERT INTO books (title, author, translator, publisher, pub_date, isbn, pages, price, binding,
           summary, cover_path, source, douban_id, douban_url, status, star_seed)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        sub.title, sub.author, sub.translator, sub.publisher, sub.pubDate, sub.isbn, sub.pages,
        sub.price, sub.binding, sub.summary, cover, 'douban', String(b.doubanId),
        `https://book.douban.com/subject/${b.doubanId}/`, 'unread', Math.random()
      );
      const id = Number(info.lastInsertRowid);
      setTagsForBook(id, (sub.tags || []).slice(0, 4));
      return json(res, getBook(id), 201);
    }

    // ---- 统计 / 导出 / 设置 ----
    if (p === '/stats') return json(res, stats());

    if (p === '/export' && method === 'GET') {
      const dump = {
        exported_at: new Date().toISOString(),
        books: q.all('SELECT * FROM books'),
        chapters: q.all('SELECT book_id, idx, title, word_count FROM chapters ORDER BY book_id, idx'),
        notes: q.all('SELECT * FROM notes'),
        tags: q.all('SELECT * FROM tags'),
        book_tags: q.all('SELECT * FROM book_tags'),
        recos: q.all('SELECT * FROM recos'),
        sessions: q.all('SELECT * FROM sessions'),
      };
      return send(res, 200, JSON.stringify(dump, null, 2), {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="stellar-shelf-${today()}.json"`,
      });
    }

    if (p === '/settings' && method === 'GET') {
      return json(res, Object.fromEntries(q.all('SELECT key, value FROM settings').map((r) => [r.key, r.value])));
    }
    if (p === '/settings' && method === 'POST') {
      const b = await readBody(req);
      for (const [k, v] of Object.entries(b)) setSetting(k, typeof v === 'object' ? JSON.stringify(v) : v);
      return json(res, { ok: true });
    }

    // ---- 星图数据（宏观视图） ----
    if (p === '/constellations' && method === 'GET') {
      const tags = q.all(`SELECT t.name, COUNT(*) c FROM tags t JOIN book_tags bt ON bt.tag_id=t.id
                          GROUP BY t.name HAVING c >= 2 ORDER BY c DESC LIMIT 12`);
      const groups = tags.map((t) => ({
        tag: t.name,
        books: q.all(`SELECT b.id, b.title, b.author FROM books b
                      JOIN book_tags bt ON bt.book_id=b.id JOIN tags t ON t.id=bt.tag_id
                      WHERE t.name=? ORDER BY b.title`, t.name),
      })).filter((g) => g.books.length >= 2);
      return json(res, groups);
    }

    return json(res, { error: 'Not found', path: p }, 404);
  } catch (err) {
    console.error('[api]', p, err);
    return json(res, { error: err.message || '服务器错误' }, 500);
  }
}

export { publicBook, stats, MIME };
