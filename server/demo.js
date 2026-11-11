// 零门槛演示：空书库时自动装进三本公版书 + 两条示例笔记。
// 目的只有一个——装完打开就能看见星系、颜色和能点开读的书。
import fs from 'node:fs';
import path from 'node:path';
import { DIR } from './paths.js';
import { q, setSetting, setting } from './db.js';
import { ingestUpload } from './importers/index.js';

const DEMO_BOOKS = [
  {
    file: 'luoshen.txt', title: '洛神赋', author: '曹植', tag: '古典',
    status: 'finished', progress: 1, rating: 5,
    summary: '曹植渡洛水，遇见一位神女。写她的容貌、她的迟疑、她终究要离开。全篇是一场看得见却够不着的相逢。',
    note: { kind: 'highlight', excerpt: '翩若惊鸿，婉若游龙', body: '曹植写的是神，其实写的是够不着的人。' },
  },
  {
    file: 'shijing.txt', title: '诗经', author: '佚名（先秦）', tag: '古典',
    status: 'reading', progress: 0.18,
    summary: '中国最早的诗歌总集，三百零五篇。风、雅、颂三部分，写劳作、爱情、征战与祭祀——先民的心事，隔了三千年还在响。',
    note: { kind: 'thought', excerpt: null, body: '读《诗》最好的时刻是夜里。字少，留白多，正好放进自己的心事。' },
  },
  {
    file: 'shanhaijing.txt', title: '山海经', author: '佚名（先秦）', tag: '神话',
    status: 'unread',
    summary: '先秦的地理与神话之书，记录山川、异兽、远国。与其说它写的是地理，不如说它写的是古人想象世界的边界。',
  },
];

function alreadySeeded() {
  if (q.get('SELECT COUNT(*) c FROM books').c > 0) return true;
  return setting('demo_seeded') === '1';
}

/** 空书库时安装演示书；已有书则什么都不做 */
export async function ensureDemo({ force = false } = {}) {
  if (!force && alreadySeeded()) return { seeded: 0 };

  let seeded = 0;
  for (const d of DEMO_BOOKS) {
    const src = path.join(DIR.demo, d.file);
    if (!fs.existsSync(src)) continue;
    if (q.get('SELECT id FROM books WHERE title = ?', d.title)) { seeded++; continue; }

    const tmp = path.join(DIR.data, `demo-${d.file}`);
    fs.copyFileSync(src, tmp);
    try {
      const book = await ingestUpload({
        tmpPath: tmp, ext: 'txt', originalName: `${d.title}.txt`,
        meta: { title: d.title, author: d.author, summary: d.summary },
        tags: [d.tag],
      });
      const fields = { status: d.status, progress: d.progress ?? 0 };
      if (d.rating) fields.rating = d.rating;
      if (d.status === 'finished') fields.finished_at = new Date().toISOString().slice(0, 19).replace('T', ' ');
      if (d.status === 'reading') fields.last_read_at = new Date().toISOString().slice(0, 19).replace('T', ' ');
      const sets = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
      q.run(`UPDATE books SET ${sets} WHERE id = ?`, ...Object.values(fields), book.id);

      if (d.note) {
        q.run(`INSERT INTO notes (book_id, kind, chapter_idx, chapter_title, excerpt, body)
               VALUES (?,?,?,?,?,?)`,
          book.id, d.note.kind, 0, null, d.note.excerpt, d.note.body);
      }
      seeded++;
    } finally {
      fs.promises.unlink(tmp).catch(() => {});
    }
  }

  setSetting('demo_seeded', '1');
  console.log(`  演示书库：已装入 ${seeded} 本（《洛神赋》《诗经》《山海经》）`);
  return { seeded };
}
