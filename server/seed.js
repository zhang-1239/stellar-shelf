// 首航：把几本真实公版书装进书斋，并从豆瓣取一批书目信息。
// 用法：node server/seed.js [--force]
import fs from 'node:fs';
import path from 'node:path';
import { DIR, bookFilePath } from './paths.js';
import { db, q, setTagsForBook, today } from './db.js';
import { ingestUpload, getBook } from './importers/index.js';
import * as douban from './douban.js';
import { generateDaily } from './daily.js';

const CACHE = path.join(DIR.data, 'seed-cache');
fs.mkdirSync(CACHE, { recursive: true });

const SOURCES = [
  { id: 23873, title: '詩經', author: '佚名（先秦）', tags: ['诗', '先秦', '经典'], status: 'reading', progress: 0.18, rating: 5,
    summary: '中國最早的詩歌總集，三百零五篇，從西周初年到春秋中葉。風、雅、頌三部分，寫勞作、愛情、征戰與祭祀——先民的心事，隔了三千年還在響。' },
  { id: 24041, title: '洛神賦', author: '曹植', tags: ['赋', '魏晋'], status: 'finished', rating: 5,
    summary: '曹植渡洛水，遇見一位神女。寫她的容貌、她的遲疑、她終究要離開。全篇是一場看得見卻夠不著的相逢。' },
  { id: 25352, title: '長恨歌', author: '白居易', tags: ['诗', '唐'], status: 'finished', rating: 4,
    summary: '白居易寫唐玄宗與楊貴妃，從「漢皇重色思傾國」到「天長地久有時盡」。六十句，一段盛世與一場長恨。' },
  { id: 25288, title: '山海經', author: '佚名（先秦）', tags: ['神话', '先秦', '宇宙'], status: 'reading', progress: 0.06,
    summary: '先秦的地理與神話之書，記錄山川、異獸、遠國。與其說它寫的是地理，不如說它寫的是古人想像世界的邊界。' },
  { id: 24264, title: '紅樓夢', author: '曹雪芹', tags: ['小说', '清'], status: 'unread',
    summary: '曹雪芹寫賈府由盛而衰，寫一群人如何在大觀園裡做夢、醒來、散去。中國小說的高峰。' },
  { id: 23962, title: '西遊記', author: '吳承恩', tags: ['小说', '明', '神话'], status: 'unread',
    summary: '玄奘取經的故事長成了神魔小說。孫悟空一路降妖，其實是在降自己。' },
];

const UA = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36' };

async function fetchText(id) {
  const cacheFile = path.join(CACHE, `${id}.txt`);
  if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).size > 2000) {
    return fs.readFileSync(cacheFile, 'utf8');
  }
  const url = `https://www.gutenberg.org/cache/epub/${id}/pg${id}.txt`;
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  let text = new TextDecoder('utf-8').decode(buf);
  // 去掉 Gutenberg 头尾
  const startMarkers = [
    /\*\*\*\s*START OF (THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\*\*\*/i,
    /\*\*\*\s*START OF THE PROJECT GUTENBERG EBOOK[^\n]*\*\*\*/i,
  ];
  for (const m of startMarkers) {
    const idx = text.search(m);
    if (idx !== -1) { text = text.slice(idx).replace(m, ''); break; }
  }
  const endIdx = text.search(/\*\*\*\s*END OF (THE|THIS) PROJECT GUTENBERG EBOOK/i);
  if (endIdx !== -1) text = text.slice(0, endIdx);
  text = text.replace(/\r\n?/g, '\n').trim();
  fs.writeFileSync(cacheFile, text, 'utf8');
  return text;
}

async function seedBooks(force) {
  const existing = q.get('SELECT COUNT(*) c FROM books').c;
  if (existing > 0 && !force) {
    console.log(`书库已有 ${existing} 本，跳过。用 --force 重新导入。`);
    return;
  }

  for (const src of SOURCES) {
    const dup = q.get('SELECT id FROM books WHERE title = ?', src.title);
    if (dup) { console.log(`· 已有《${src.title}》，跳过`); continue; }
    try {
      process.stdout.write(`· 取书《${src.title}》… `);
      const text = await fetchText(src.id);
      const tmp = path.join(CACHE, `${src.id}.upload.txt`);
      fs.writeFileSync(tmp, text, 'utf8');
      const book = await ingestUpload({
        tmpPath: tmp, ext: 'txt', originalName: `${src.title}.txt`,
        meta: { title: src.title, author: src.author, summary: src.summary || undefined },
        tags: src.tags,
      });
      const fields = {};
      if (src.status) fields.status = src.status;
      if (src.progress) fields.progress = src.progress;
      if (src.rating) fields.rating = src.rating;
      if (src.status === 'finished') {
        fields.finished_at = new Date(Date.now() - Math.random() * 60 * 86400000)
          .toISOString().slice(0, 19).replace('T', ' ');
        fields.progress = 1;
      }
      if (src.status === 'reading') fields.last_read_at = new Date().toISOString().slice(0, 19).replace('T', ' ');
      const sets = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
      if (sets) q.run(`UPDATE books SET ${sets} WHERE id = ?`, ...Object.values(fields), book.id);
      console.log(`✓ ${book.chapter_count} 章 · ${(book.word_count / 1000).toFixed(1)}k 字`);
    } catch (err) {
      console.log(`✕ ${err.message}`);
    }
  }
}

async function seedFromDouban(limit = 10) {
  if (q.get(`SELECT COUNT(*) c FROM books WHERE source = 'douban'`).c > 0) {
    console.log('· 已有豆瓣书目，跳过');
    return;
  }
  let bag = [];
  try {
    bag = [...(await douban.chart('all')).slice(0, 8), ...(await douban.latest('all')).slice(0, 8)];
  } catch (err) {
    console.log('· 豆瓣不可达：' + err.message);
    return;
  }
  const seen = new Set();
  let n = 0;
  for (const it of bag) {
    if (n >= limit) break;
    if (seen.has(it.doubanId)) continue;
    seen.add(it.doubanId);
    try {
      const sub = await douban.subject(it.doubanId);
      if (!sub) continue;
      const cover = await douban.cacheCover(sub.coverUrl || it.coverUrl, it.doubanId);
      const info = q.run(
        `INSERT INTO books (title, author, translator, publisher, pub_date, isbn, pages, price, binding,
           summary, cover_path, source, douban_id, douban_url, douban_rating, douban_votes, status, star_seed)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        sub.title, sub.author, sub.translator, sub.publisher, sub.pubDate, sub.isbn, sub.pages,
        sub.price, sub.binding, sub.summary, cover, 'douban', it.doubanId,
        it.url, sub.rating ?? it.rating, sub.votes ?? it.votes,
        Math.random() < 0.25 ? 'finished' : 'unread', Math.random()
      );
      setTagsForBook(Number(info.lastInsertRowid), (sub.tags || []).slice(0, 3));
      n++;
      process.stdout.write(`· ${sub.title} `);
    } catch (err) {
      // 单本失败无所谓
    }
  }
  console.log(`\n· 豆瓣书目 ${n} 本`);
}

function seedNotes() {
  if (q.get('SELECT COUNT(*) c FROM notes').c > 0) return;
  const find = (title) => q.get('SELECT id FROM books WHERE title = ?', title);
  // 按章名定位真正的章节，保证摘录能被正文高亮
  const chapterOf = (bookRow, needle) => {
    if (!bookRow) return { idx: 0, title: '' };
    const row = q.get(`SELECT idx, title FROM chapters WHERE book_id = ? AND title LIKE ?
                       ORDER BY idx LIMIT 1`, bookRow.id, `%${needle}%`);
    if (row) return { idx: row.idx, title: row.title };
    const first = q.get('SELECT idx, title FROM chapters WHERE book_id = ? ORDER BY idx LIMIT 1', bookRow.id);
    return { idx: first?.idx ?? 0, title: first?.title ?? '' };
  };

  const poetry = find('詩經');
  const luoshen = find('洛神賦');
  const changhen = find('長恨歌');
  const items = [];
  if (poetry) {
    const c = chapterOf(poetry, '關睢') || chapterOf(poetry, '關雎');
    items.push({ book_id: poetry.id, kind: 'highlight', chapter_idx: c.idx, chapter_title: c.title,
      excerpt: '關關雎鳩', body: '两千多年前的人，也是先听见水声，才想起一个人的。' });
    const c2 = chapterOf(poetry, '桃夭');
    items.push({ book_id: poetry.id, kind: 'thought', chapter_idx: c2.idx, chapter_title: c2.title,
      excerpt: null, body: '读《诗》最好的时刻是夜里。字少，留白多，正好放进自己的心事。' });
  }
  if (luoshen) {
    const c = chapterOf(luoshen, '洛神');
    items.push({ book_id: luoshen.id, kind: 'highlight', chapter_idx: c.idx, chapter_title: c.title,
      excerpt: '翩若惊鴻，婉若游龍', body: '曹植写的是神，其实写的是够不着的人。' });
  }
  if (changhen) {
    const c = chapterOf(changhen, '長恨');
    items.push({ book_id: changhen.id, kind: 'quote', chapter_idx: c.idx, chapter_title: c.title,
      excerpt: '天長地久有時盡', body: null });
  }
  for (const it of items) {
    q.run(`INSERT INTO notes (book_id, kind, chapter_idx, chapter_title, excerpt, body, created_at)
           VALUES (?,?,?,?,?,?, datetime('now', ?))`,
      it.book_id, it.kind, it.chapter_idx ?? null, it.chapter_title ?? null,
      it.excerpt, it.body, `-${Math.floor(Math.random() * 20) + 1} day`);
  }
  console.log(`· 示例笔记 ${items.length} 条`);
}

function seedSessions() {
  if (q.get('SELECT COUNT(*) c FROM sessions').c > 0) return;
  const books = q.all('SELECT id FROM books WHERE content_ready = 1');
  if (!books.length) return;
  for (let i = 0; i < 70; i++) {
    const daysAgo = Math.floor(Math.random() * 110);
    const b = books[Math.floor(Math.random() * books.length)];
    const d = new Date(); d.setDate(d.getDate() - daysAgo);
    const p = (n) => String(n).padStart(2, '0');
    const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    if (Math.random() < 0.35) continue;
    q.run(`INSERT INTO sessions (book_id, seconds, words, day, started_at)
           VALUES (?,?,?,?,?)`, b.id, 600 + Math.floor(Math.random() * 3000), 0, day, day + ' 21:00:00');
  }
  console.log('· 阅读记录已铺');
}

const force = process.argv.includes('--force');
const reset = process.argv.includes('--reset');

if (reset) {
  console.log('· 清空书库（保留豆瓣缓存）');
  q.run('DELETE FROM books');
  q.run('DELETE FROM recos');
  q.run('DELETE FROM sessions');
  q.run('DELETE FROM notes');
  q.run('DELETE FROM book_tags');
  q.run('DELETE FROM tags');
  q.run("DELETE FROM sqlite_sequence WHERE name IN ('books','notes','chapters','sessions','recos')");
  for (const d of fs.readdirSync(DIR.content)) {
    fs.rmSync(path.join(DIR.content, d), { recursive: true, force: true });
  }
  for (const f of fs.readdirSync(DIR.books)) {
    fs.rmSync(path.join(DIR.books, f), { force: true });
  }
}

console.log('—— 首航 ——');
await seedBooks(force);
await seedFromDouban(10);
seedNotes();
seedSessions();
try {
  const r = await generateDaily({});
  console.log(`· 今日星讯 ${r.total} 颗`);
} catch (err) {
  console.log('· 星讯生成失败：' + err.message);
}
const total = q.get('SELECT COUNT(*) c FROM books').c;
const withContent = q.get('SELECT COUNT(*) c FROM books WHERE content_ready = 1').c;
console.log(`\n完成：${total} 本书（${withContent} 本有正文）`);
