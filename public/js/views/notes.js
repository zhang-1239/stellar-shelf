// 笔记总览
import { api, h, icon, toast, relTime, fmtDate, modal } from '../core.js';
import { render } from '../main.js';

const KINDS = [
  { id: 'all', label: '全部' },
  { id: 'highlight', label: '摘录' },
  { id: 'note', label: '笔记' },
  { id: 'thought', label: '想法' },
];

const KIND_LABEL = { highlight: '摘录', note: '笔记', thought: '想法', quote: '引文' };

export async function renderNotes(route) {
  const kind = route.params.get('k') || 'all';
  const bookId = route.params.get('book');
  const notes = await api.get(`/notes?kind=${kind}${bookId ? `&book=${bookId}` : ''}`);

  const body = h('div', {});

  const filters = h('div', { class: 'note-filters' });
  for (const k of KINDS) {
    filters.append(h('button', {
      class: 'chip' + (kind === k.id ? ' on' : ''),
      style: kind === k.id ? { color: 'var(--accent)', borderColor: 'var(--accent)' } : {},
      onclick: () => { location.hash = k.id === 'all' ? '/notes' : `/notes?k=${k.id}`; },
    }, k.label));
  }
  filters.append(h('div', { style: { flex: 1 } }));

  if (bookId) {
    const book = notes[0];
    filters.append(h('button', {
      class: 'chip on', style: { color: 'var(--accent)', borderColor: 'var(--accent)' },
      onclick: () => { location.hash = '/notes'; },
    }, `《${book?.book_title || '这本书'}》 ✕`));
  }
  body.append(filters);

  if (!notes.length) {
    body.append(h('div', { class: 'empty' },
      h('div', { class: 'big' }, '尚 无 笔 墨'),
      h('div', {}, '读书时选中一段话，就能把摘录和想法留在这里。')));
    return { title: '笔记', sub: 'NOTES', body };
  }

  const list = h('div', {});
  let lastDay = '';
  for (const n of notes) {
    const day = String(n.created_at).slice(0, 10);
    if (day !== lastDay) {
      list.append(h('div', {
        style: {
          fontFamily: 'var(--font-sans)', fontSize: '10px', letterSpacing: '.2em',
          opacity: .4, margin: '1.6rem 0 .7rem',
        },
      }, fmtDate(n.created_at)));
      lastDay = day;
    }

    const item = h('div', { class: `note-item k-${n.kind}` },
      n.excerpt ? h('div', { class: 'note-excerpt' }, n.excerpt) : null,
      n.body ? h('div', { class: 'note-body' }, n.body) : null,
      h('div', { class: 'note-foot' },
        h('span', { class: 'nf-book', onclick: () => { location.hash = `/book/${n.book_id}`; } }, `《${n.book_title}》`),
        n.chapter_title ? h('span', {}, n.chapter_title.slice(0, 20)) : null,
        h('span', {}, KIND_LABEL[n.kind] || n.kind),
        h('span', { class: 'nf-tools' },
          n.chapter_idx != null ? h('button', {
            title: '回到原文',
            onclick: () => { location.hash = `/read/${n.book_id}/${n.chapter_idx}`; },
          }, '↩ 原文') : null,
          h('button', { title: '编辑', onclick: () => editNote(n) }, '编辑'),
          h('button', {
            title: '删除',
            onclick: async () => {
              await api.del('/notes/' + n.id);
              toast('已删除');
              render();
            },
          }, '删除')
        )
      )
    );
    list.append(item);
  }
  body.append(list);

  function editNote(n) {
    const ta = h('textarea', {
      class: 'field', rows: 5, value: n.body || '',
      style: { border: '1px solid var(--line-strong)', background: 'rgba(255,255,255,.5)', fontFamily: 'var(--font-kai)', lineHeight: 1.9, fontSize: '14px' },
    });
    const m = modal({
      title: '编 辑',
      width: 520,
      content: h('div', {},
        n.excerpt ? h('div', {
          style: { fontFamily: 'var(--font-kai)', fontSize: '13.5px', lineHeight: 1.9, opacity: .8, padding: '.8rem 1rem', background: 'rgba(180,140,60,.1)', borderRadius: '6px', marginBottom: '.9rem' },
        }, `「${n.excerpt}」`) : null,
        ta,
        h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '.5rem', marginTop: '1rem' } },
          h('button', { class: 'btn', style: { border: '1px solid var(--line-strong)' }, onclick: () => m.close() }, '取消'),
          h('button', {
            class: 'btn', style: { background: 'var(--accent)', color: '#f8f2e6' },
            onclick: async () => {
              await api.patch('/notes/' + n.id, { body: ta.value.trim() });
              m.close(); toast('已保存'); render();
            },
          }, '保存'))
      ),
    });
    setTimeout(() => ta.focus(), 100);
  }

  const bookCount = new Set(notes.map((n) => n.book_id)).size;
  return {
    title: '笔记',
    sub: `${notes.length} NOTES · ${bookCount} BOOKS`,
    body,
  };
}
