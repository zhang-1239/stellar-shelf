// 书架：书脊 / 封面 / 名录 三种陈列
import { api, h, icon, state, clothOf, pct, fmtDate, miniCover } from '../core.js';
import { openImport, render } from '../main.js';

const VIEWS = [
  { id: 'spine', label: '书脊' },
  { id: 'cover', label: '封面' },
  { id: 'list', label: '名录' },
];

const STATUS_GROUPS = [
  { key: 'reading', label: '正在读', order: 0 },
  { key: 'unread', label: '待读', order: 1 },
  { key: 'finished', label: '已读', order: 2 },
];

function spineOf(b) {
  const [bg, ink] = clothOf(b.title + b.author);
  const words = Number(b.word_count) || 0;
  const w = words ? Math.max(26, Math.min(54, 22 + Math.round(words / 14000))) : 30;
  let seed = 0;
  for (const c of String(b.id) + b.title) seed = (seed * 31 + c.charCodeAt(0)) % 997;
  const hgt = 172 + (seed % 62);
  // 书名越长，字号越小，保证竖排能塞进书脊
  const len = String(b.title).length;
  const fs = Math.max(9.5, Math.min(12.5, 118 / Math.max(4, len)));
  const el = h('div', {
    class: 'spine', title: b.title,
    style: { '--h': hgt + 'px', '--w': w + 'px', '--spine-bg': bg, '--spine-ink': ink },
    onclick: () => { location.hash = `/book/${b.id}`; },
  },
    h('div', { class: 'spine-t', style: { fontSize: fs + 'px' } }, b.title),
    h('div', { class: 'spine-band' }),
    b.status === 'finished' ? h('div', { class: 'spine-fin' }, '读毕') : null,
    b.progress > 0 && b.status !== 'finished' ? h('div', { class: 'spine-progress', style: { width: pct(b.progress) + '%' } }) : null
  );
  return el;
}

export function CoverThumb(b, { width } = {}) {
  const [bg, ink] = clothOf(b.title + (b.author || ''));
  const inner = b.cover_path
    ? h('img', { src: `/media/${b.cover_path}`, alt: b.title, loading: 'lazy' })
    : h('div', { class: 'typo-cover', style: { '--tc-bg': bg, '--tc-ink': ink } },
        h('div', { class: 'tc-t' }, b.title),
        b.author ? h('div', { class: 'tc-a' }, b.author) : null);
  return h('div', {
    class: 'cover-frame',
    style: width ? { width: width + 'px' } : {},
  }, inner,
    b.status === 'finished' ? h('div', { class: 'cover-badge done' }, '读毕') : null,
    b.status === 'reading' ? h('div', { class: 'cover-badge' }, pct(b.progress) + '%') : null
  );
}

function coverCard(b) {
  return h('div', {
    class: 'cover-card',
    onclick: () => { location.hash = `/book/${b.id}`; },
  },
    CoverThumb(b),
    h('div', { class: 'c-title' }, b.title),
    h('div', { class: 'c-sub' }, [b.author, b.status === 'finished' ? '已读' : b.word_count ? `${Math.round(b.word_count / 1000)}k 字` : null].filter(Boolean).join(' · '))
  );
}

function listRows(books) {
  const table = h('table', { class: 'book-list' });
  for (const b of books) {
    table.append(h('tr', {
      onclick: () => { location.hash = `/book/${b.id}`; },
    },
      h('td', { style: { width: '34px', paddingRight: 0 } }, miniCover(b, 22, 33)),
      h('td', {},
        h('div', { class: 'bl-title' }, b.title),
        h('div', { class: 'bl-meta' }, [b.author, b.publisher].filter(Boolean).join(' · '))
      ),
      h('td', { class: 'bl-prog' }, b.status === 'finished' ? '已读' : b.status === 'reading' ? `${pct(b.progress)}%` : (b.added_at ? fmtDate(b.added_at) : '')),
      h('td', { class: 'bl-meta', style: { textAlign: 'right', width: '80px' } }, (b.tags || []).slice(0, 2).join(' · '))
    ));
  }
  return table;
}

export async function renderShelf(route) {
  const filter = route.params.get('s') || 'all';
  const books = await api.get('/books');
  state.books = books;

  const tools = h('div', { style: { display: 'flex', gap: '.45rem', alignItems: 'center' } });

  const viewToggle = h('div', { class: 'view-toggle' });
  for (const v of VIEWS) {
    viewToggle.append(h('button', {
      class: state.view === v.id ? 'on' : '',
      onclick: () => { state.view = v.id; localStorage.setItem('shelf-view', v.id); render(); },
    }, v.label));
  }
  tools.append(viewToggle);

  tools.append(h('button', {
    class: 'btn', style: { border: '1px solid var(--line-strong)' },
    onclick: () => openImport(),
  }, icon('plus', 14), '入库'));

  const body = h('div', { class: 'view-shelf' });

  if (!books.length) {
    body.append(h('div', { class: 'empty' },
      h('div', { class: 'big' }, '书 架 尚 空'),
      h('div', {}, '把第一本书放进来吧。它可以是一个文件，也可以只是一个名字。'),
      h('button', { class: 'btn', style: { border: '1px solid var(--line-strong)', marginTop: '.5rem' }, onclick: () => openImport() },
        icon('plus', 14), '入库')
    ));
    return { title: '书架', sub: '0 BOOKS', tools, body };
  }

  // 筛选
  const chips = h('div', { style: { display: 'flex', gap: '.5rem', flexWrap: 'wrap', marginBottom: '.4rem', marginTop: '.2rem' } });
  const counts = {
    all: books.length,
    reading: books.filter((b) => b.status === 'reading').length,
    unread: books.filter((b) => b.status === 'unread').length,
    finished: books.filter((b) => b.status === 'finished').length,
  };
  for (const [key, label] of [['all', '全部'], ['reading', '在读'], ['unread', '待读'], ['finished', '已读']]) {
    chips.append(h('button', {
      class: 'chip' + (filter === key ? ' on' : ''),
      style: filter === key ? { color: 'var(--accent)', borderColor: 'var(--accent)' } : {},
      onclick: () => { location.hash = key === 'all' ? '/shelf' : `/shelf?s=${key}`; },
    }, `${label} ${counts[key]}`));
  }
  body.append(chips);

  const shown = filter === 'all' ? books : books.filter((b) => b.status === filter);

  if (state.view === 'list') {
    body.append(listRows(shown));
  } else if (state.view === 'cover') {
    const grid = h('div', { class: 'covers' });
    for (const b of shown) grid.append(coverCard(b));
    body.append(grid);
  } else {
    // 书脊：按状态分区，每 18 本一块木板
    const groups = filter === 'all' ? STATUS_GROUPS : STATUS_GROUPS.filter((g) => g.key === filter);
    for (const g of groups) {
      const items = shown.filter((b) => b.status === g.key);
      if (!items.length) continue;
      const section = h('div', { class: 'shelf-section' },
        h('div', { class: 'shelf-label' }, g.label, h('span', { class: 'count' }, `${items.length} 册`)));
      for (let i = 0; i < items.length; i += 18) {
        const plank = h('div', { class: 'plank' });
        for (const b of items.slice(i, i + 18)) plank.append(spineOf(b));
        section.append(plank);
      }
      body.append(section);
    }
    if (!shown.length) {
      body.append(h('div', { class: 'empty' }, h('div', { class: 'big' }, '此 处 无 书')));
    }
  }

  const reading = books.filter((b) => b.status === 'reading' && b.progress > 0);
  return {
    title: '我的书架',
    sub: `${books.length} BOOKS · ${books.filter((b) => b.status === 'finished').length} FINISHED${reading.length ? ' · ' + reading.length + ' IN PROGRESS' : ''}`,
    tools,
    body,
  };
}
