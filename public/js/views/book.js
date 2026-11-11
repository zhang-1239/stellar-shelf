// 书详情
import { api, h, icon, toast, modal, confirmDialog, pct, fmtDate, relTime, clothOf } from '../core.js';
import { render } from '../main.js';
import { openImport } from '../main.js';

const KIND_LABEL = { highlight: '摘录', note: '笔记', thought: '想法', quote: '引文' };

export async function renderBook(route) {
  const id = Number(route.arg);
  let b;
  try { b = await api.get('/books/' + id); }
  catch { return { title: '找不到这本书', sub: '404', body: h('div', { class: 'empty' }, h('div', { class: 'big' }, '书 已 失 踪')) }; }

  const [bg, ink] = clothOf(b.title + (b.author || ''));
  const body = h('div', { style: { paddingTop: '1.2rem' } });

  // ---- 封面 ----
  const cover = h('div', { class: 'detail-cover' },
    b.cover_path
      ? h('img', { src: `/media/${b.cover_path}`, alt: b.title })
      : h('div', { class: 'typo-cover', style: { '--tc-bg': bg, '--tc-ink': ink } },
          h('div', { class: 'tc-t', style: { fontSize: '20px' } }, b.title),
          b.author ? h('div', { class: 'tc-a' }, b.author) : null),
    h('button', {
      title: '更换封面',
      style: {
        position: 'absolute', right: '6px', top: '6px', zIndex: 5, padding: '3px 7px',
        borderRadius: '4px', background: 'rgba(20,16,10,.55)', color: '#f3ead9',
        fontFamily: 'var(--font-sans)', fontSize: '10px', letterSpacing: '.08em',
      },
      onclick: () => pickCover(b, render),
    }, '换封面')
  );

  // ---- 元信息 ----
  const byline = [b.author, b.translator ? `译 / ${b.translator}` : null].filter(Boolean).join('　');
  const metaBits = [
    b.publisher, b.pub_date, b.pages ? `${b.pages} 页` : null,
    b.pub_date && b.pages ? null : null,
    b.word_count ? `${(b.word_count / 1000).toFixed(1)}k 字` : null,
    b.format ? String(b.format).toUpperCase() : null,
    b.isbn ? 'ISBN ' + b.isbn : null,
  ].filter(Boolean);

  const info = h('div', { class: 'detail-info' },
    h('h2', {}, b.title),
    b.subtitle ? h('div', { style: { fontFamily: 'var(--font-kai)', fontSize: '15px', opacity: .7, marginBottom: '.4rem' } }, b.subtitle) : null,
    byline ? h('div', { class: 'byline' }, byline) : null,
    h('div', { class: 'detail-meta' },
      metaBits.map((m) => h('span', {}, m)),
      b.douban_rating ? h('span', { style: { color: 'var(--gold)' } }, `豆瓣 ${b.douban_rating}`) : null
    ),
    b.summary ? summaryBlock(b.summary) : null,
    (b.tags || []).length ? h('div', { class: 'detail-tags' }, b.tags.map((t) => h('span', { class: 'tag-i' }, t))) : null,
    actions(),
    ratingRow(),
    b.status !== 'unread' || b.progress > 0 ? progressBlock() : null
  );

  body.append(h('div', { class: 'detail-hero' }, cover, info));

  // ---- 章节目录 ----
  if (b.chapters?.length) {
    const toc = h('div', { class: 'panel', style: { marginTop: '2.4rem' } },
      h('h3', {}, `目录 · 共 ${b.chapters.length} 章`));
    const list = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: '.1rem' } });
    for (const c of b.chapters) {
      list.append(h('button', {
        class: 'toc-item', style: { padding: '.42rem .6rem' },
        onclick: () => { location.hash = `/read/${b.id}/${c.idx}`; },
      }, h('span', { class: 'ti-n' }, String(c.idx + 1).padStart(2, '0')), c.title));
    }
    toc.append(list);
    body.append(toc);
  }

  // ---- 笔记 ----
  const notes = h('div', { class: 'panel', style: { marginTop: '1.2rem' } },
    h('h3', {}, `我的笔记 · ${b.note_count} 条`));
  if (!b.recent_notes?.length) {
    notes.append(h('div', { style: { fontFamily: 'var(--font-kai)', fontSize: '13px', opacity: .55, lineHeight: 2 } },
      b.content_ready ? '还没有笔记。阅读时选中一段文字，就可以留下摘录与想法。' : '这本书还没有正文，可以先写下你的想法。'));
  } else {
    for (const n of b.recent_notes) {
      notes.append(h('div', { class: 'note-mini' },
        n.excerpt ? h('div', { class: 'nm-ex' }, n.excerpt.slice(0, 120)) : null,
        n.body ? h('div', {}, n.body.slice(0, 200)) : null,
        h('div', { class: 'nm-when' }, `${KIND_LABEL[n.kind] || ''} · ${relTime(n.created_at)}`)
      ));
    }
    notes.append(h('button', {
      class: 'btn', style: { border: '1px solid var(--line-strong)', marginTop: '.6rem' },
      onclick: () => { location.hash = `/notes?book=${b.id}`; },
    }, '查看全部'));
  }
  body.append(notes);

  // ---- 思考（没有正文的书也能写） ----
  body.append(thinkPanel(b));

  return { title: b.title, sub: 'DETAIL', body };

  // ---------- 内部组件 ----------
  function summaryBlock(text) {
    const el = h('div', { class: 'detail-summary', html: escapeHtml(text).replace(/\n+/g, '<br>') });
    el.addEventListener('click', () => el.classList.toggle('open'));
    el.style.cursor = 'pointer';
    return el;
  }

  function progressBlock() {
    return h('div', { style: { marginTop: '1.1rem' } },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--font-sans)', fontSize: '10.5px', letterSpacing: '.1em', opacity: .6 } },
        h('span', {}, b.status === 'finished' ? '已读完' : '阅读进度'),
        h('span', {}, b.status === 'finished' ? (b.finished_at ? fmtDate(b.finished_at) : '') : pct(b.progress) + '%')),
      h('div', { class: 'progress-line' }, h('i', { style: { width: pct(b.status === 'finished' ? 1 : b.progress) + '%' } }))
    );
  }

  function ratingRow() {
    const row = h('div', { style: { display: 'flex', alignItems: 'center', gap: '.35rem', marginTop: '.9rem', fontFamily: 'var(--font-sans)', fontSize: '11px', opacity: .75 } },
      h('span', { style: { letterSpacing: '.16em', opacity: .6, marginRight: '.3rem' } }, '私 评'));
    for (let i = 1; i <= 5; i++) {
      const filled = (b.rating || 0) >= i;
      const s = h('button', {
        style: { fontSize: '16px', lineHeight: 1, color: filled ? 'var(--accent)' : 'var(--ink-3)', opacity: filled ? 1 : .35, transition: 'all .2s' },
        onclick: async () => {
          const val = b.rating === i ? null : i;
          await api.patch('/books/' + b.id, { rating: val });
          b.rating = val;
          render();
        },
      }, '★');
      row.append(s);
    }
    return row;
  }

  function actions() {
    const wrap = h('div', { class: 'detail-actions' });
    if (b.content_ready) {
      wrap.append(h('button', {
        class: 'btn',
        style: { background: 'var(--accent)', color: '#f9f3e7', padding: '.62em 1.3em' },
        onclick: () => { location.hash = `/read/${b.id}/${b.chapter_idx || 0}`; },
      }, icon('book', 15), b.progress > 0 && b.status !== 'finished' ? '继续读' : b.status === 'finished' ? '重读' : '翻开'));
    } else if (b.douban_url) {
      wrap.append(h('a', {
        class: 'btn', href: b.douban_url, target: '_blank', rel: 'noopener',
        style: { border: '1px solid var(--line-strong)' },
      }, '豆瓣页面 ↗'));
    }

    wrap.append(h('button', {
      class: 'btn', style: { border: '1px solid var(--line-strong)' },
      onclick: async () => {
        const next = b.status === 'finished' ? 'reading' : 'finished';
        await api.patch('/books/' + b.id, { status: next });
        toast(next === 'finished' ? '已标记读完' : '已重新放回在读');
        render();
      },
    }, icon('check', 14), b.status === 'finished' ? '取消读完' : '标记读完'));

    wrap.append(h('button', {
      class: 'btn', style: { border: '1px solid var(--line-strong)' },
      onclick: () => editTags(b, render),
    }, '标签'));

    if (b.douban_url) {
      wrap.append(h('a', {
        class: 'btn', href: b.douban_url, target: '_blank', rel: 'noopener',
        style: { border: '1px solid var(--line)', opacity: .7, fontSize: '12px' },
      }, '豆瓣'));
    }

    wrap.append(h('button', {
      class: 'btn', style: { marginLeft: 'auto', opacity: .45, fontSize: '12px' },
      onclick: async () => {
        if (await confirmDialog(`把《${b.title}》从书架上移除？笔记和进度会一起删除。`, '移除')) {
          await api.del('/books/' + b.id);
          toast('已移除');
          location.hash = '/shelf';
        }
      },
    }, icon('trash', 14)));
    return wrap;
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function thinkPanel(b) {
  const ta = h('textarea', {
    class: 'field',
    rows: 4,
    placeholder: '写下你此刻对这本书的想法…',
    style: { border: '1px solid var(--line)', background: 'rgba(255,255,255,.45)', fontFamily: 'var(--font-kai)', fontSize: '14px', lineHeight: 1.9 },
  });
  return h('div', { class: 'panel', style: { marginTop: '1.2rem' } },
    h('h3', {}, '一个想法'),
    ta,
    h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: '.7rem' } },
      h('button', {
        class: 'btn', style: { border: '1px solid var(--line-strong)' },
        onclick: async () => {
          const text = ta.value.trim();
          if (!text) return toast('还没写什么呢');
          await api.post('/notes', { book_id: b.id, kind: 'thought', body: text });
          toast('已记下');
          ta.value = '';
          render();
        },
      }, '记下'))
  );
}

function editTags(b, rerender) {
  const input = h('input', {
    class: 'field', value: (b.tags || []).join(', '),
    placeholder: '如：诗与远方, 宇宙, 重读',
    style: { border: '1px solid var(--line-strong)', background: 'rgba(255,255,255,.5)' },
  });
  const m = modal({
    title: '标 签',
    width: 420,
    content: h('div', {},
      input,
      h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '.5rem', marginTop: '1.2rem' } },
        h('button', { class: 'btn', style: { border: '1px solid var(--line-strong)' }, onclick: () => m.close() }, '取消'),
        h('button', {
          class: 'btn', style: { background: 'var(--accent)', color: '#f8f2e6' },
          onclick: async () => {
            const tags = input.value.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
            await api.patch('/books/' + b.id, { tags });
            m.close();
            rerender();
          },
        }, '保存'))
    ),
  });
  setTimeout(() => input.focus(), 80);
}

function pickCover(b, rerender) {
  const input = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
  input.addEventListener('change', async () => {
    const f = input.files?.[0];
    if (!f) return;
    try {
      await fetch(`/api/books/${b.id}/cover`, { method: 'POST', headers: { 'content-type': f.type }, body: f });
      toast('封面已更新');
      rerender();
    } catch { toast('上传失败'); }
  });
  input.click();
}
