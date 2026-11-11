// 星讯：每天从豆瓣来的候选星
import { api, h, icon, toast, state, clothOf } from '../core.js';
import { render } from '../main.js';

export async function renderRecos(route) {
  let data;
  try { data = await api.get('/recos/today'); }
  catch (e) { data = { day: '', line: '', recos: [] }; }

  const body = h('div', { class: 'view-recos' });
  body.append(h('div', { class: 'digest-line' }, data.line || '今天没有星讯。'));

  const tools = h('div', { style: { display: 'flex', gap: '.45rem', alignItems: 'center' } });
  const refreshBtn = h('button', {
    class: 'btn', style: { border: '1px solid var(--line-strong)' },
    onclick: async (e) => {
      e.target.disabled = true;
      refreshBtn.textContent = '正在重访豆瓣…';
      try {
        const r = await api.post('/recos/refresh');
        toast(`换了一批：${r.total} 颗`);
        render();
      } catch (err) { toast('刷新失败：' + err.message); refreshBtn.disabled = false; }
    },
  }, '换一批');
  tools.append(refreshBtn);

  if (!data.recos?.length) {
    body.append(h('div', { class: 'empty' },
      h('div', { class: 'big' }, '今 夜 无 星'),
      h('div', {}, '要么豆瓣暂时联系不上，要么今天的推荐还没生成。'),
      h('button', { class: 'btn', style: { border: '1px solid var(--line-strong)' }, onclick: () => refreshBtn.click() }, '再试一次')));
    return { title: '今日星讯', sub: 'DAILY STARS', tools, body };
  }

  const grid = h('div', { class: 'reco-grid' });
  for (const r of data.recos) grid.append(card(r));
  body.append(grid);

  body.append(h('div', {
    style: {
      marginTop: '2.4rem', paddingTop: '1.2rem', borderTop: '1px solid var(--line)',
      fontFamily: 'var(--font-sans)', fontSize: '10.5px', letterSpacing: '.12em', opacity: .45, lineHeight: 2,
    },
  }, `数据来源：豆瓣读书 · 生成于 ${(data.generated || '').slice(0, 16)} · 标记「感兴趣」的书会留在星图上等你`));

  return { title: '今日星讯', sub: `DAILY STARS · ${data.day}`, tools, body };
}

function card(r) {
  const [bg, ink] = clothOf(r.title + (r.author || ''));
  const picked = r.feedback === 'interested' || r.feedback === 'shelved';
  const el = h('div', { class: 'reco-card' + (picked ? ' picked' : '') + (r.feedback === 'not_interested' ? ' dim' : '') });

  const thought = h('textarea', {
    class: 'reco-thought field',
    rows: 2,
    placeholder: '为什么它吸引你／为什么不了…',
    value: r.thought || '',
    style: {
      border: '1px solid var(--line)', background: 'rgba(255,255,255,.5)',
      fontFamily: 'var(--font-kai)', display: r.thought ? 'block' : '',
    },
  });
  thought.addEventListener('blur', async () => {
    if ((thought.value || '') !== (r.thought || '')) {
      await api.post(`/recos/${r.id}/feedback`, { feedback: r.feedback, thought: thought.value.trim() || null });
      r.thought = thought.value.trim();
      toast('想法已存');
    }
  });

  const acts = h('div', { class: 'reco-acts' });

  const yes = h('button', { class: 'ra yes' + (picked ? ' on' : ''), onclick: () => feedback('interested') }, '感兴趣');
  const no = h('button', { class: 'ra no' + (r.feedback === 'not_interested' ? ' on' : ''), onclick: () => feedback('not_interested') }, '略过');
  const thinkBtn = h('button', { class: 'ra', onclick: () => { el.classList.toggle('thinking'); thought.focus(); } }, '想法');
  const shelf = h('button', { class: 'ra shelf', onclick: shelve }, r.feedback === 'shelved' ? '已在书架' : '放入书架');

  acts.append(yes, no, thinkBtn, shelf);

  el.append(
    h('div', { class: 'reco-top' },
      h('div', { class: 'reco-cover' },
        r.cover_path
          ? h('img', { src: `/media/${r.cover_path}`, alt: r.title, loading: 'lazy' })
          : h('div', { class: 'typo-cover', style: { '--tc-bg': bg, '--tc-ink': ink } },
              h('div', { class: 'tc-t', style: { fontSize: '11px' } }, r.title))),
      h('div', { class: 'reco-h' },
        h('div', { class: 'rh-t' }, r.title),
        h('div', { class: 'rh-a' }, [r.author, r.publisher].filter(Boolean).join(' · ')),
        r.douban_rating
          ? h('div', { class: 'rh-r' }, `★ ${r.douban_rating}${r.douban_votes ? ` · ${r.douban_votes} 人评价` : ''}`)
          : null,
        (r.tags ? String(r.tags).split(/\s+/).filter(Boolean).slice(0, 3) : []).length
          ? h('div', { class: 'rh-tags' }, String(r.tags).split(/\s+/).filter(Boolean).slice(0, 3).map((t) => h('span', {}, t)))
          : null)
    ),
    r.summary
      ? h('div', { class: 'reco-sum' }, r.summary.replace(/\s+/g, ' ').slice(0, 220))
      : h('div', { class: 'reco-sum', style: { opacity: .5, fontFamily: 'var(--font-kai)' } },
          [r.pub_date ? r.pub_date + ' 出版' : null, r.author ? `${r.author} 著` : null, '豆瓣上还没有更长的介绍。']
            .filter(Boolean).join(' · ')),
    thought,
    acts
  );
  return el;

  async function feedback(fb) {
    const next = r.feedback === fb ? 'none' : fb;
    await api.post(`/recos/${r.id}/feedback`, { feedback: next, thought: thought.value.trim() || null });
    r.feedback = next;
    yes.classList.toggle('on', next === 'interested' || r.feedback === 'shelved');
    no.classList.toggle('on', next === 'not_interested');
    el.classList.toggle('picked', next === 'interested' || r.feedback === 'shelved');
    el.classList.toggle('dim', next === 'not_interested');
    if (next !== 'none') toast(next === 'interested' ? '记下了：感兴趣' : '记下了：略过');
  }

  async function shelve() {
    if (r.feedback === 'shelved') { toast('已经在书架上了'); return; }
    try {
      const out = await api.post(`/recos/${r.id}/shelve`);
      r.feedback = 'shelved';
      shelf.textContent = '已在书架';
      el.classList.add('picked');
      toast(out?.existed ? '书架上已有这本' : '已放入书架');
    } catch (e) { toast('失败了：' + e.message); }
  }
}
