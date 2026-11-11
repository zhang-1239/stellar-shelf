// 每日星讯：从豆瓣取一批候选书，缓存封面，落成当天的一屏星星。
import * as douban from './douban.js';
import { db, q, today, setting, setSetting } from './db.js';

const LINES = [
  '读书是往身体里装一片星空。',
  '你翻过的每一页，都在宇宙某处多出一点光。',
  '今夜适宜远航，也适宜翻开第一页。',
  '有些书不是被读完的，是被慢慢照亮的。',
  '人在字里行间走久了，会听见自己的回声。',
  '一本书合上时，它的引力还留在你身上。',
  '所有的远方，都先在纸上出现过。',
  '慢一点读，星星是慢的。',
  '你不需要读完所有书，只需要留住那些改变你轨道的。',
  '书架是一张私人星图，只标你真正去过的地方。',
  '阅读是唯一一种可以穿越时间的抵达。',
  '世界很大，字很小，可它们刚好能拼出你。',
  '每本书都是一扇没关严的门。',
  '把日子读薄，把自己读厚。',
  '在别人的句子里，认领自己的秘密。',
  '今夜无风，适合一页一页把时间垫高。',
  '书是安静的飞船，载你去不了的地方。',
  '你不是在读书，你是在给自己造一个可以回去的地方。',
  '光年之外无人应答，但书里总有人先到过。',
  '深夜读书的人，身上有微弱的星光。',
];

function hashDay(day) {
  let h = 0;
  for (const c of day) h = (h * 131 + c.charCodeAt(0)) % 100000;
  return h;
}

export function lineFor(day) {
  return LINES[hashDay(day) % LINES.length];
}

function recentDoubanIds(days = 30) {
  const rows = q.all(`SELECT douban_id FROM recos WHERE day >= date('now', ?)`, `-${days} day`);
  return new Set(rows.map((r) => r.douban_id));
}

/** 根据用户已有标签推测偏好分类 */
function preferredChartType() {
  const rows = q.all(`SELECT t.name, COUNT(*) c FROM tags t JOIN book_tags bt ON bt.tag_id=t.id
                      GROUP BY t.name ORDER BY c DESC LIMIT 6`);
  const names = rows.map((r) => r.name).join(' ');
  const map = [
    [/文学|小说|诗|散文|戏剧/, 'literature'],
    [/社会|历史|政治|人类|哲学|思想/, 'social'],
    [/科技|科学|计算|物理|生物|数学/, 'tech'],
    [/商业|经济|管理|投资/, 'business'],
    [/艺术|设计|美学|摄影|音乐/, 'culture'],
    [/心理|生活|成长|旅行|饮食/, 'life'],
  ];
  for (const [re, type] of map) if (re.test(names)) return type;
  return 'all';
}

export function todaysDigest() {
  return q.get('SELECT * FROM digests WHERE day = ?', today()) || null;
}

export function todaysRecos(day = today()) {
  return q.all('SELECT * FROM recos WHERE day = ? ORDER BY rank ASC, id ASC', day);
}

/**
 * 生成（或补齐）某一天的星讯。
 * @param {{force?:boolean, day?:string, count?:number}} opt
 */
export async function generateDaily(opt = {}) {
  const day = opt.day || today();
  const count = opt.count || 6;
  if (!opt.force) {
    const existing = q.all('SELECT * FROM recos WHERE day = ?', day);
    if (existing.length >= count) return { day, created: 0, total: existing.length, cached: true };
  }

  const seen = recentDoubanIds(30);
  const ctype = preferredChartType();
  const doubanOn = setting('douban_enabled', 'off') === 'on';

  const bag = [];
  const push = (items, origin) => {
    for (const it of items || []) {
      if (!it?.doubanId || seen.has(it.doubanId)) continue;
      if (bag.some((b) => b.doubanId === it.doubanId)) continue;
      bag.push({ ...it, origin });
    }
  };

  // 豆瓣推荐源默认关闭：只有用户自己在设置里打开，才去抓取
  if (doubanOn) {
    try {
      // 一半是「刚出现的」，一半是「被时间留下来的」
      push(await douban.latest('all'), 'latest');
      push(await douban.chart(ctype === 'all' ? '' : ctype), 'chart');
      if (bag.length < count) push(await douban.chart('all'), 'chart');
      if (bag.length < count) push(await douban.latest('literature'), 'latest');
    } catch (err) {
      console.error('[daily] 拉取豆瓣失败:', err.message);
    }
  }

  // 网络不可用时，用书库里尚未读的书作为「今日星讯」
  if (!bag.length) {
    const local = q.all(`SELECT id, title, author, cover_path, summary FROM books
                         WHERE status != 'finished' ORDER BY RANDOM() LIMIT ?`, count);
    let rank = 0;
    for (const b of local) {
      q.run(`INSERT OR IGNORE INTO recos (day, douban_id, title, author, summary, cover_path, origin, rank)
             VALUES (?,?,?,?,?,?,?,?)`, day, `local-${b.id}`, b.title, b.author, b.summary, b.cover_path, 'shelf', rank++);
    }
    q.run(`INSERT OR IGNORE INTO digests (day, line) VALUES (?,?)`, day, lineFor(day));
    return { day, created: local.length, total: local.length, offline: true };
  }

  // 取前 count 本，给其中三本补详情
  const chosen = bag.slice(0, count);
  const detailed = chosen.slice(0, 3);

  for (const it of detailed) {
    try {
      const sub = await douban.subject(it.doubanId);
      if (sub) {
        it.summary = sub.summary || it.summary;
        it.author = it.author || sub.author;
        it.publisher = it.publisher || sub.publisher;
        it.pubDate = it.pubDate || sub.pubDate;
        it.rating = it.rating ?? sub.rating;
        it.coverUrl = it.coverUrl || sub.coverUrl;
        if (sub.tags?.length) it.tags = sub.tags.slice(0, 6);
      }
    } catch (err) {
      console.error('[daily] 详情失败', it.doubanId, err.message);
    }
  }

  let created = 0;
  let rank = 0;
  for (const it of chosen) {
    const coverPathRel = await douban.cacheCover(it.coverUrl, it.doubanId);
    const res = q.run(
      `INSERT OR IGNORE INTO recos
        (day, douban_id, title, author, publisher, pub_date, summary, cover_url, cover_path,
         douban_rating, douban_votes, douban_url, tags, origin, rank)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      day, it.doubanId, it.title, it.author, it.publisher, it.pubDate,
      it.summary || null, it.coverUrl || null, coverPathRel,
      it.rating ?? null, it.votes ?? null, it.url || null,
      (it.tags || []).join(' '), it.origin, rank++
    );
    if (Number(res.changes) > 0) created++;
  }

  q.run(`INSERT INTO digests (day, line, generated_at) VALUES (?,?,datetime('now'))
         ON CONFLICT(day) DO UPDATE SET line=excluded.line, generated_at=excluded.generated_at`,
    day, lineFor(day));
  setSetting('last_daily_scan', new Date().toISOString());

  return { day, created, total: q.all('SELECT * FROM recos WHERE day = ?', day).length };
}

/** 启动时补齐今天的星讯；之后每小时检查一次（跨天自动生成） */
export function startScheduler() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const has = q.get('SELECT COUNT(*) c FROM recos WHERE day = ?', today());
      if (!has || has.c < 3) {
        const hour = new Date().getHours();
        if (hour >= 6 || !has || has.c === 0) {
          const r = await generateDaily({});
          console.log(`[daily] ${r.day} 星讯已备好：${r.total} 颗`);
        }
      }
    } catch (err) {
      console.error('[daily] 调度失败:', err.message);
    } finally {
      running = false;
    }
  };
  setTimeout(tick, 2500);
  const timer = setInterval(tick, 60 * 60 * 1000);
  timer.unref?.();
  return timer;
}

/** 一条推荐 → 书库（「感兴趣」之后可以真的把它放上书架） */
export function shelveReco(recoId) {
  const r = q.get('SELECT * FROM recos WHERE id = ?', recoId);
  if (!r) return null;
  const dup = r.douban_id
    ? q.get('SELECT id FROM books WHERE douban_id = ?', r.douban_id)
    : q.get('SELECT id FROM books WHERE title = ? AND author IS ?', r.title, r.author);
  if (dup) {
    q.run(`UPDATE recos SET feedback='shelved', acted_at=datetime('now') WHERE id=?`, recoId);
    return { bookId: dup.id, existed: true };
  }
  const info = q.run(
    `INSERT INTO books (title, author, publisher, pub_date, summary, cover_path, source,
       douban_id, douban_url, douban_rating, douban_votes, status, star_seed)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    r.title, r.author, r.publisher, r.pub_date, r.summary, r.cover_path, 'douban',
    r.douban_id, r.douban_url, r.douban_rating, r.douban_votes, 'unread', Math.random()
  );
  const bookId = Number(info.lastInsertRowid);
  if (r.tags) {
    const { setTagsForBook } = require_tags();
    setTagsForBook(bookId, String(r.tags).split(/\s+/).filter(Boolean).slice(0, 4));
  }
  q.run(`UPDATE recos SET feedback='shelved', acted_at=datetime('now') WHERE id=?`, recoId);
  return { bookId, existed: false };
}

function require_tags() {
  // 避免循环依赖的小技巧：直接内联
  return {
    setTagsForBook(bookId, names) {
      for (const raw of names || []) {
        const name = String(raw).trim();
        if (!name) continue;
        q.run('INSERT OR IGNORE INTO tags(name) VALUES(?)', name);
        const t = q.get('SELECT id FROM tags WHERE name = ?', name);
        if (t) q.run('INSERT OR IGNORE INTO book_tags(book_id, tag_id) VALUES(?,?)', bookId, t.id);
      }
    },
  };
}
