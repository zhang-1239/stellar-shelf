// SQLite 数据层：node:sqlite（Node 22+ 内置，无需外部依赖）
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { DIR } from './paths.js';

export const db = new DatabaseSync(DIR.db);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS books (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  title           TEXT NOT NULL,
  subtitle        TEXT,
  author          TEXT,
  translator      TEXT,
  publisher       TEXT,
  pub_date        TEXT,
  isbn            TEXT,
  pages           INTEGER,
  price           TEXT,
  binding         TEXT,
  summary         TEXT,
  cover_path      TEXT,                 -- 相对 data/ 的路径，如 covers/b12.jpg
  source          TEXT NOT NULL DEFAULT 'manual',  -- upload | douban | manual
  douban_id       TEXT,
  douban_url      TEXT,
  douban_rating   REAL,
  douban_votes    INTEGER,
  format          TEXT,                 -- epub | pdf | txt | docx | mobi | azw3 | html
  file_path       TEXT,                 -- 相对 data/ 的路径
  file_size       INTEGER,
  content_ready   INTEGER NOT NULL DEFAULT 0,
  chapter_count   INTEGER NOT NULL DEFAULT 0,
  word_count      INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'unread',  -- unread | reading | finished | paused | abandoned
  progress        REAL NOT NULL DEFAULT 0,          -- 0..1
  chapter_idx     INTEGER NOT NULL DEFAULT 0,
  locator         TEXT,                             -- 章节内定位（滚动比例/页码）
  rating          REAL,                             -- 私人评分 0..5
  favorite        INTEGER NOT NULL DEFAULT 0,
  star_seed       REAL,                             -- 星海中的稳定随机种子
  added_at        TEXT NOT NULL DEFAULT (datetime('now')),
  last_read_at    TEXT,
  finished_at     TEXT,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chapters (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id    INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,
  title      TEXT,
  href       TEXT,        -- 相对 data/content/<id>/ 的 html 文件
  word_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_chapters_book ON chapters(book_id, idx);

CREATE TABLE IF NOT EXISTS notes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id      INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL DEFAULT 'note',   -- highlight | note | thought | quote
  chapter_idx  INTEGER,
  chapter_title TEXT,
  locator      TEXT,
  excerpt      TEXT,      -- 原文摘录
  body         TEXT,      -- 我的想法 / 笔记正文
  color        TEXT,
  starred      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notes_book ON notes(book_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tags (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  name   TEXT NOT NULL UNIQUE,
  color  TEXT,
  kind   TEXT NOT NULL DEFAULT 'theme'   -- theme | mood | constellation
);

CREATE TABLE IF NOT EXISTS book_tags (
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (book_id, tag_id)
);

CREATE TABLE IF NOT EXISTS recos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  day           TEXT NOT NULL,               -- YYYY-MM-DD
  douban_id     TEXT,
  title         TEXT NOT NULL,
  author        TEXT,
  publisher     TEXT,
  pub_date      TEXT,
  summary       TEXT,
  cover_url     TEXT,
  cover_path    TEXT,
  douban_rating REAL,
  douban_votes  INTEGER,
  douban_url    TEXT,
  tags          TEXT,
  origin        TEXT,                        -- latest | chart | tag | subject
  rank          INTEGER,
  feedback      TEXT NOT NULL DEFAULT 'none',-- none | interested | not_interested | shelved | read
  thought       TEXT,
  acted_at      TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(day, douban_id)
);
CREATE INDEX IF NOT EXISTS idx_recos_day ON recos(day);

CREATE TABLE IF NOT EXISTS digests (
  day          TEXT PRIMARY KEY,
  line         TEXT,                         -- 今日一句话（星讯开场）
  payload      TEXT,
  generated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id     INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  seconds     INTEGER NOT NULL DEFAULT 0,
  words       INTEGER NOT NULL DEFAULT 0,
  day         TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_day ON sessions(day);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`);

// 轻量迁移：手动调整过的题材归属（覆盖由标签推导出的结果）
try { db.exec('ALTER TABLE books ADD COLUMN genre_override TEXT'); } catch { /* 已存在 */ }

// ---------- 小工具 ----------
export const q = {
  all: (sql, ...p) => db.prepare(sql).all(...p),
  get: (sql, ...p) => db.prepare(sql).get(...p),
  run: (sql, ...p) => db.prepare(sql).run(...p),
};

export function setting(key, fallback = null) {
  const row = q.get('SELECT value FROM settings WHERE key = ?', key);
  return row ? row.value : fallback;
}
export function setSetting(key, value) {
  q.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    key, value == null ? null : String(value));
}

export function touchBook(id, fields = {}) {
  const allowed = ['status', 'progress', 'chapter_idx', 'locator', 'rating', 'favorite', 'summary',
    'last_read_at', 'finished_at', 'cover_path', 'title', 'author', 'publisher', 'star_seed'];
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (allowed.includes(k)) { sets.push(`${k} = ?`); vals.push(v); }
  }
  sets.push("updated_at = datetime('now')");
  q.run(`UPDATE books SET ${sets.join(', ')} WHERE id = ?`, ...vals, id);
}

export function setTagsForBook(bookId, names) {
  q.run('DELETE FROM book_tags WHERE book_id = ?', bookId);
  for (const raw of names || []) {
    const name = String(raw).trim();
    if (!name) continue;
    q.run('INSERT OR IGNORE INTO tags(name) VALUES(?)', name);
    const t = q.get('SELECT id FROM tags WHERE name = ?', name);
    if (t) q.run('INSERT OR IGNORE INTO book_tags(book_id, tag_id) VALUES(?,?)', bookId, t.id);
  }
}

export function bookTags(bookId) {
  return q.all(`SELECT t.name, t.color FROM tags t JOIN book_tags bt ON bt.tag_id = t.id
                WHERE bt.book_id = ? ORDER BY t.name`, bookId).map(r => r.name);
}

export function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function logImport(...a) {
  if (process.env.SHELF_DEBUG) console.log(...a);
}

export { fs };
