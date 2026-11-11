// 星轨：阅读数据
import { api, h, icon, toast, pct, fmtDate, miniCover, clothOf } from '../core.js';

export async function renderStats(route) {
  const s = await api.get('/stats');
  const body = h('div', {});

  const cards = [
    { v: s.total, l: '藏书' },
    { v: s.byStatus?.finished || 0, l: '已读完' },
    { v: s.byStatus?.reading || 0, l: '在读' },
    { v: s.notes, l: '笔记' },
    { v: s.finishedThisYear, l: '今年读完' },
    { v: s.streak ? `${s.streak}` : '0', l: '连续天数' },
    { v: s.minutes >= 60 ? (s.minutes / 60).toFixed(1) + 'h' : s.minutes + 'm', l: '阅读时长' },
    { v: s.words ? (s.words / 10000).toFixed(1) + 'w' : '0', l: '藏书字数' },
  ];
  const grid = h('div', { class: 'stat-grid' });
  for (const c of cards) grid.append(h('div', { class: 'stat-card' },
    h('div', { class: 'sv' }, String(c.v)), h('div', { class: 'sl' }, c.l)));
  body.append(grid);

  // 月度
  const monthly = h('div', { class: 'panel' }, h('h3', {}, '每 月 入 账'));
  const maxM = Math.max(1, ...s.monthly.map((m) => m.c));
  const bars = h('div', { class: 'bars' });
  for (const m of s.monthly) {
    bars.append(h('div', { class: 'b' },
      h('i', { style: { height: Math.max(2, (m.c / maxM) * 100) + '%' }, title: `${m.c} 本` }),
      h('span', {}, m.m.slice(2))));
  }
  if (!s.monthly.length) bars.append(h('div', { style: { fontFamily: 'var(--font-kai)', opacity: .45, fontSize: '13px' } }, '还没有数据。'));
  monthly.append(bars);
  body.append(monthly);

  // 阅读热度
  const heatPanel = h('div', { class: 'panel' }, h('h3', {}, '阅 读 热 度'));
  const heatMap = new Map(s.heat.map((d) => [d.day, d.s]));
  const maxHeat = Math.max(1, ...[...heatMap.values()]);
  const heat = h('div', { class: 'heat' });
  const days = 118;
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const p = (n) => String(n).padStart(2, '0');
    const key = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    const v = heatMap.get(key) || 0;
    const a = v ? 0.2 + (v / maxHeat) * 0.75 : 0;
    heat.append(h('i', {
      title: `${key} · ${v ? Math.round(v / 60) + ' 分钟' : '未读'}`,
      style: v ? { background: `rgba(150,56,42,${a})` } : {},
    }));
  }
  heatPanel.append(heat);
  body.append(heatPanel);

  // 标签
  if (s.topTags.length) {
    const tp = h('div', { class: 'panel' }, h('h3', {}, '你 的 星 座'));
    const cloud = h('div', { class: 'tagcloud' });
    const maxT = Math.max(...s.topTags.map((t) => t.c));
    for (const t of s.topTags) {
      cloud.append(h('span', {
        style: { fontSize: `${13 + (t.c / maxT) * 12}px`, opacity: 0.55 + (t.c / maxT) * 0.45 },
        onclick: () => { location.hash = `/shelf?tag=${encodeURIComponent(t.name)}`; },
      }, t.name, h('span', { style: { fontSize: '9px', opacity: .5, marginLeft: '.2em', fontFamily: 'var(--font-sans)' } }, t.c)));
    }
    tp.append(cloud);
    body.append(tp);
  }

  // 最近读完
  if (s.recentFinished.length) {
    const rp = h('div', { class: 'panel' }, h('h3', {}, '最 近 读 完'));
    for (const b of s.recentFinished) {
      rp.append(h('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: '1rem', padding: '.55rem 0',
          borderBottom: '1px solid var(--line)', cursor: 'pointer',
        },
        onclick: () => { location.hash = `/book/${b.id}`; },
      },
        miniCover(b, 26, 39),
        h('div', { style: { flex: 1 } },
          h('div', { style: { fontSize: '13.5px' } }, b.title),
          h('div', { style: { fontFamily: 'var(--font-sans)', fontSize: '10.5px', opacity: .5, marginTop: '.15rem' } },
            [b.author, fmtDate(b.finished_at)].filter(Boolean).join(' · '))),
        b.rating ? h('div', { style: { color: 'var(--accent)', fontSize: '12px', letterSpacing: '.1em' } }, '★'.repeat(b.rating)) : null
      ));
    }
    body.append(rp);
  }

  // 导出
  const tools = h('button', {
    class: 'btn', style: { border: '1px solid var(--line-strong)' },
    onclick: () => { window.location.href = '/api/export'; toast('正在导出整座书斋…'); },
  }, '导出为 JSON');

  body.append(h('div', {
    style: { marginTop: '1.4rem', fontFamily: 'var(--font-sans)', fontSize: '10.5px', letterSpacing: '.1em', opacity: .4, lineHeight: 2 },
  }, `星讯互动 ${s.recoActed} 次 · 其中感兴趣 ${s.recoInterested} 本 · 所有数据都在你自己的硬盘上`));

  return { title: '星轨', sub: 'READING TRAJECTORY', tools, body };
}
