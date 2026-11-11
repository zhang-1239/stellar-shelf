// 豆瓣数据源：书籍详情、新书速递、最受关注、搜索联想、封面缓存。
// 只抓公开页面，低频、串行、带缓存 —— 这是一份私人书架，不做爬虫农场。
import fs from 'node:fs';
import path from 'node:path';
import { DIR, coverPath } from './paths.js';
import { decodeEntities } from './importers/html.js';

const UA = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0 Safari/537.36',
  'accept-language': 'zh-CN,zh;q=0.9',
  accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
  referer: 'https://book.douban.com/',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastAt = 0;

/** 串行限速 GET */
async function get(url, { asJson = false, tries = 3, timeout = 20000 } = {}) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    const wait = Math.max(0, 900 - (Date.now() - lastAt));
    if (wait) await sleep(wait);
    lastAt = Date.now();
    try {
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeout), redirect: 'follow' });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return asJson ? await res.json() : await res.text();
    } catch (err) {
      if (attempt === tries) throw new Error(`豆瓣请求失败 (${url}): ${err.message}`);
      await sleep(1200 * attempt);
    }
  }
  return null;
}

const strip = (s) => decodeEntities(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const pick = (html, re) => { const m = html.match(re); return m ? strip(m[1]) : null; };

/** 解析 book.douban.com/latest 或 /chart 的列表条目 */
export function parseList(html, origin = 'latest') {
  const items = [];
  const blocks = html.split(/<li class="media clearfix">/).slice(1);
  for (const block of blocks) {
    const url = (block.match(/href="(https:\/\/book\.douban\.com\/subject\/(\d+)\/?)"/) || [])[1];
    if (!url) continue;
    const id = url.match(/subject\/(\d+)/)[1];
    const cover = (block.match(/<img[^>]+class="subject-cover"[^>]+src="([^"]+)"/) || [])[1]
      || (block.match(/<img[^>]+src="([^"]+)"[^>]*class="subject-cover"/) || [])[1];
    const title = pick(block, /<h2[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/);
    const abstract = pick(block, /class="subject-abstract[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    const rating = pick(block, /class="font-small fleft">\s*([\d.]+)\s*<\/span>/);
    const votes = (block.match(/class="fleft ml8 color-gray">\((\d+)人评价\)/) || [])[1];
    const tagText = pick(block, /class="subject-tags"[^>]*>([\s\S]*?)<\/div>/);

    const parts = (abstract || '').split(' / ').map((s) => s.trim()).filter(Boolean);
    // 形如 「作者 / 2026-10 / 出版社 / 59.00 / 平装」
    let author = null, pubDate = null, publisher = null, price = null, binding = null;
    const rest = [...parts];
    author = rest.shift() || null;
    if (rest[0] && /^\d{4}(-\d{1,2})?$/.test(rest[0])) pubDate = rest.shift();
    if (rest.length >= 1) publisher = rest.shift();
    if (rest[0] && /[元¥$]|^\d+(\.\d+)?$/.test(rest[0])) price = rest.shift();
    if (rest.length) binding = rest.join(' / ');

    items.push({
      doubanId: id, url: url.replace(/\/$/, '') + '/', title, coverUrl: cover || null,
      author, pubDate, publisher, price, binding,
      rating: rating ? Number(rating) : null,
      votes: votes ? Number(votes) : null,
      tags: tagText ? tagText.split(/\s+/).filter(Boolean).slice(0, 6) : [],
      summary: null,
      origin,
    });
  }
  return items;
}

/** 解析书籍详情页 */
export function parseSubject(html) {
  const title = pick(html, /<span property="v:itemreviewed">([\s\S]*?)<\/span>/);
  if (!title) return null;

  const infoBlock = (html.match(/<div id="info"[^>]*>([\s\S]*?)<\/div>\s*<div id="intro"/) || [])[1]
    || (html.match(/<div id="info"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '';

  const field = (label) => {
    const re = new RegExp(`<span class="pl">\\s*${label}\\s*:?\\s*</span>([\\s\\S]*?)(?:<br\\s*\\/?>|</div>)`);
    const m = infoBlock.match(re);
    if (!m) return null;
    const txt = strip(m[1]);
    return txt || null;
  };

  const cover = (html.match(/<a class="nbg"[\s\S]{0,200}?<img src="([^"]+)"/) || [])[1] || null;
  const rating = pick(html, /<strong class="ll rating_num"[^>]*>([\s\S]*?)<\/strong>/);
  const votes = pick(html, /<span property="v:votes">(\d+)<\/span>/);

  // 简介：优先「内容简介」整段，其次折叠摘要
  let summary = null;
  const intros = [...html.matchAll(/<div class="intro">([\s\S]*?)<\/div>/g)].map((m) => m[1]);
  if (intros.length) {
    const rich = intros.find((s) => s.length > 120) || intros[0];
    summary = decodeEntities(rich.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))
      .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    if (summary.length > 1200) summary = summary.slice(0, 1200).trim() + '……';
  }

  const tagList = [...html.matchAll(/<a href="\/tag\/[^"]*"[^>]*>([^<]+)<\/a>/g)]
    .map((m) => strip(m[1])).filter(Boolean).slice(0, 8);

  const authorIntro = (() => {
    const m = html.match(/<div class="related_info">[\s\S]*?<div class="indent"[^>]*>([\s\S]*?)<\/div>/);
    if (!m) return null;
    const t = decodeEntities(m[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))
      .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    return t.length > 600 ? t.slice(0, 600) + '……' : t;
  })();

  return {
    title,
    author: field('作者') || null,
    translator: field('译者') || null,
    publisher: field('出版社') || null,
    pubDate: field('出版年') || null,
    pages: Number((field('页数') || '').match(/\d+/)?.[0]) || null,
    price: field('定价') || null,
    binding: field('装帧') || null,
    isbn: field('ISBN') || null,
    rating: rating ? Number(rating) : null,
    votes: votes ? Number(votes) : null,
    coverUrl: cover,
    summary,
    authorIntro,
    tags: tagList,
  };
}

/** 搜索联想（书名 → 候选） */
export async function suggest(query) {
  const url = `https://book.douban.com/j/subject_suggest?q=${encodeURIComponent(query)}`;
  const data = await get(url, { asJson: true });
  if (!Array.isArray(data)) return [];
  return data.filter((d) => d.type === 'b').map((d) => ({
    doubanId: String(d.id),
    title: decodeEntities(d.title || ''),
    author: decodeEntities(d.author_name || ''),
    pubDate: d.year || null,
    coverUrl: d.pic || null,
    url: `https://book.douban.com/subject/${d.id}/`,
  }));
}

export async function subject(doubanId) {
  const html = await get(`https://book.douban.com/subject/${doubanId}/`);
  return html ? parseSubject(html) : null;
}

export const LATEST_CATEGORIES = {
  all: '全部', literature: '文学', culture: '文化', art: '艺术设计', social: '社科',
  business: '商业经管', tech: '科技', life: '生活', comic: '绘本漫画',
};

/** 新书速递 */
export async function latest(category = 'all') {
  const sub = LATEST_CATEGORIES[category] || LATEST_CATEGORIES.all;
  const html = await get(`https://book.douban.com/latest?subcat=${encodeURIComponent(sub)}`);
  return html ? parseList(html, 'latest') : [];
}

/** 最受关注（分类榜） */
const CHART_TYPES = {
  all: '', literature: '文学', popular: '流行', culture: '文化', social: '社科', tech: '科技',
  business: '经管', life: '生活',
};
export async function chart(type = 'all') {
  const t = CHART_TYPES[type] ?? '';
  const html = await get(`https://book.douban.com/chart${t ? '?type=' + encodeURIComponent(t) : ''}`);
  return html ? parseList(html, 'chart') : [];
}

/**
 * 下载封面并缓存到本地。豆瓣图床需要 referer。
 * @returns {Promise<string|null>} 相对 data/ 的路径
 */
export async function cacheCover(coverUrl, key) {
  if (!coverUrl) return null;
  const safeKey = `douban-${String(key).replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const ext = (coverUrl.match(/\.(jpe?g|png|webp)/i) || [, 'jpg'])[1].toLowerCase().replace('jpeg', 'jpg');
  const name = `${safeKey}.${ext}`;
  const dest = coverPath(name);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 512) return `covers/${name}`;

  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(coverUrl, { headers: UA, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 512) throw new Error('封面过小');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      return `covers/${name}`;
    } catch {
      await sleep(600 * (i + 1));
    }
  }
  return null;
}

export { DIR, path };
