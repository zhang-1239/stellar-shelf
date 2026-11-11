// 阅读器：从星海翻开一本书之后的全屏界面。日常 / 护眼 / 米黄 / 夜间 四种显示模式。
import { api, h, toast, modal, fmtDate, pct, clamp, debounce } from '../core.js';

let current = null;

// 显示模式。护眼是默认——从星空翻开书，不该突然刺眼。
const THEMES = [
  { id: 'eye', label: '护眼', bg: '#cfe3cd', ink: '#23301f', sub: '#5d7355', line: 'rgba(35,48,31,.16)', card: '#d9e9d6' },
  { id: 'day', label: '日常', bg: '#fbf9f4', ink: '#24211c', sub: '#8a8272', line: 'rgba(60,50,35,.14)', card: '#ffffff' },
  { id: 'paper', label: '米黄', bg: '#efe6d2', ink: '#33291c', sub: '#8a7c63', line: 'rgba(72,54,30,.16)', card: '#f6efdd' },
  { id: 'night', label: '夜间', bg: '#17181c', ink: '#c9c4b8', sub: '#7b7668', line: 'rgba(200,195,180,.14)', card: '#1f2026' },
  { id: 'starry', label: '星空', bg: '#070a12', ink: '#dcd6c6', sub: '#7d7a6e', line: 'rgba(210,205,190,.14)', card: '#0d1018', starry: true },
  { id: 'custom', label: '自定义', bg: '#f3efe6', ink: '#24211c', sub: '#8a8272', line: 'rgba(60,50,35,.14)', card: '#ffffff' },
];

const FONT_SIZES = [16, 17, 18, 19, 20, 22, 24];

// 可选字体。前七种是系统自带（Windows 上都有），最后一种霞鹜文楷是开源字体，若已安装则出现。
const FONTS = [
  { id: 'song', label: '宋体', css: '"STSong","华文宋体","Songti SC","SimSun",serif' },
  { id: 'lxgw', label: '文楷', css: '"LXGW WenKai","STSong","华文宋体",serif' },
  { id: 'kai', label: '楷体', css: '"KaiTi","楷体","STKaiti","华文楷体",serif' },
  { id: 'fang', label: '仿宋', css: '"FangSong","仿宋","STFangsong","华文仿宋",serif' },
  { id: 'hei', label: '黑体', css: '"SimHei","黑体","STHeiti",sans-serif' },
  { id: 'deng', label: '等线', css: '"DengXian","等线","Microsoft YaHei",sans-serif' },
  { id: 'yahei', label: '雅黑', css: '"Microsoft YaHei","微软雅黑",sans-serif' },
  { id: 'li', label: '隶书', css: '"LiSu","隶书","STLiti","华文隶书",serif' },
];

function fontCssOf(id) {
  const f = FONTS.find((x) => x.id === id) || FONTS[0];
  return f.css;
}

/** 浅色底配深字，深色底配浅字 */
function inkFor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return { ink: '#24211c', sub: '#8a8272', line: 'rgba(60,50,35,.14)', card: '#ffffff' };
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.55
    ? { ink: '#24211c', sub: 'rgba(36,33,28,.55)', line: 'rgba(60,50,35,.16)', card: 'rgba(255,255,255,.55)' }
    : { ink: '#e6e2d6', sub: 'rgba(230,226,214,.5)', line: 'rgba(220,214,198,.16)', card: 'rgba(255,255,255,.06)' };
}

function customBg() {
  return localStorage.getItem('reader-custom-bg') || '#f3efe6';
}

/** 打开阅读器（覆盖在星海之上） */
export async function openReader(bookId, chapterIdx, { onClose } = {}) {
  closeReader();

  const book = await api.get('/books/' + bookId);
  const isPdf = String(book.format || '').toLowerCase() === 'pdf';
  const el = h('div', { class: 'reader' });

  const savedThemeId = localStorage.getItem('reader-theme');
  let themeIdx = Math.max(0, THEMES.findIndex((t) => t.id === savedThemeId));
  const themeButtonLabel = () => THEMES[themeIdx % THEMES.length].label;

  const close = () => {
    try { ctx.flush(); } catch { /* ignore */ }
    clearInterval(ctx.timer);
    window.removeEventListener('keydown', onKey);
    ctx.selbar?.remove();
    el.remove();
    current = null;
    onClose?.();
  };

  // ---------- 顶栏 ----------
  const chapterLabel = h('span', { class: 'rt-chapter' }, '');
  const progressLabel = h('span', { class: 'rt-progress' }, '');

  const mkBtn = (label, fn, title) => h('button', { class: 'reader-btn', title, onclick: fn }, label);

  const top = h('div', { class: 'reader-top' },
    mkBtn('← 星空', close, '回到星海'),
    h('div', { class: 'rt-title' }, book.title),
    h('span', { class: 'rt-dot' }),
    chapterLabel,
    h('div', { class: 'rt-spacer' }),
    progressLabel,
    mkBtn('目录', () => toggleSide('left'), '目录'),
    mkBtn('笔记', () => toggleSide('right'), '笔记'),
    mkBtn('显示', () => toggleDisplay(), '字号与背景'),
    mkBtn('✕', close, '合上')
  );

  // ---------- 侧栏 ----------
  const left = h('aside', { class: 'reader-side scroll' }, h('h5', {}, '目 录'));
  const right = h('aside', { class: 'reader-side right scroll' }, h('h5', {}, '笔 记'));

  const tocBtns = [];
  for (const c of book.chapters || []) {
    const b = h('button', {
      class: 'toc-item' + (c.idx === chapterIdx ? ' on' : ''),
      onclick: () => loadChapter(c.idx),
    }, h('span', { class: 'ti-n' }, String(c.idx + 1).padStart(2, '0')), c.title);
    tocBtns.push(b);
    left.append(b);
  }
  if (!(book.chapters || []).length) {
    left.append(h('div', { class: 'ti-empty' }, '这本书没有可解析的目录'));
  }

  const main = h('div', { class: 'reader-main scroll' });
  el.append(top, h('div', { class: 'reader-body' }, left, main, right));
  document.body.append(el);

  // ---------- 状态 ----------
  const ctx = {
    el, book, chapter: null, notes: [],
    fontStep: Number(localStorage.getItem('reader-fs') || 0),
    themeIdx,
    startedAt: Date.now(),
  };
  current = ctx;

  applyFont();
  applyTheme();

  // ---------- 章节 ----------
  async function loadChapter(idx, { keepScroll = false } = {}) {
    idx = clamp(idx, 0, Math.max(0, (book.chapters?.length || 1) - 1));
    await saveProgress();
    main.innerHTML = '<div class="rt-loading">翻页中…</div>';

    if (isPdf) return loadPdfPage(idx);

    let data;
    try { data = await api.get(`/books/${book.id}/chapter/${idx}`); }
    catch (err) { main.innerHTML = `<div class="empty">${err.message}</div>`; return; }

    ctx.chapter = { idx: data.idx, title: data.title };
    chapterLabel.textContent = data.title || `第 ${idx + 1} 章`;
    tocBtns.forEach((b, i) => b.classList.toggle('on', i === idx));

    const inner = h('div', { class: 'reader-inner' });
    inner.innerHTML = data.html;

    const pager = h('div', { class: 'pager' },
      data.prev ? h('button', { onclick: () => loadChapter(data.prev.idx) }, `← ${short(data.prev.title)}`) : h('button', { disabled: true }, ''),
      h('span', { class: 'pg-n' }, `${idx + 1} / ${book.chapters.length}`),
      data.next ? h('button', { onclick: () => loadChapter(data.next.idx) }, `${short(data.next.title)} →`) : h('button', { disabled: true }, ''));

    main.innerHTML = '';
    main.append(inner, pager);
    main.scrollTop = 0;

    await loadNotes();
    highlightExcerpts(inner, ctx.notes.filter((n) => n.chapter_idx === idx && n.excerpt));
    updateProgressLabel();
  }

  // ---------- PDF ----------
  let pdfDoc = null;
  async function loadPdfPage(idx) {
    if (!pdfDoc) {
      const pdfjs = await import('/vendor/pdf.min.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';
      pdfDoc = await pdfjs.getDocument(`/api/books/${book.id}/file`).promise;
    }
    ctx.chapter = { idx, title: `第 ${idx + 1} 页` };
    chapterLabel.textContent = `第 ${idx + 1} / ${pdfDoc.numPages} 页`;
    tocBtns.forEach((b, i) => b.classList.toggle('on', i === idx));

    const stage = h('div', { class: 'pdf-stage' });
    main.innerHTML = '';
    main.append(stage);
    const page = await pdfDoc.getPage(idx + 1);
    const scale = Math.min(2, Math.max(1.1, (main.clientWidth - 80) / page.getViewport({ scale: 1 }).width));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    stage.append(h('div', { class: 'pdf-page' }, canvas));
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

    stage.append(h('div', { class: 'pager' },
      idx > 0 ? h('button', { onclick: () => loadChapter(idx - 1) }, '← 上一页') : h('button', { disabled: true }, ''),
      h('span', { class: 'pg-n' }, `${idx + 1} / ${pdfDoc.numPages}`),
      idx + 1 < pdfDoc.numPages ? h('button', { onclick: () => loadChapter(idx + 1) }, '下一页 →') : h('button', { disabled: true }, '')));

    await loadNotes();
    updateProgressLabel();
  }

  // ---------- 笔记 ----------
  async function loadNotes() {
    try {
      ctx.notes = await api.get('/notes?book=' + book.id);
      renderNotesSide();
    } catch { ctx.notes = []; }
  }

  function renderNotesSide() {
    right.innerHTML = '';
    right.append(h('h5', {}, `笔 记 · ${ctx.notes.length}`));
    if (!ctx.notes.length) {
      right.append(h('div', { class: 'ti-empty' }, '选中正文里的一段话，即可留下摘录与想法。'));
      return;
    }
    for (const n of ctx.notes) {
      right.append(h('div', {
        class: 'side-note',
        onclick: () => { if (n.chapter_idx != null && n.chapter_idx !== ctx.chapter?.idx) loadChapter(n.chapter_idx); },
      },
        n.excerpt ? h('div', { class: 'sn-x' }, `「${n.excerpt.slice(0, 100)}」`) : null,
        n.body ? h('div', { class: 'sn-y' }, n.body.slice(0, 220)) : null,
        h('div', { class: 'sn-w' }, [n.chapter_title?.slice(0, 14), fmtDate(n.created_at)].filter(Boolean).join(' · ')),
        h('button', {
          class: 'sn-del', title: '删除',
          onclick: async (e) => { e.stopPropagation(); await api.del('/notes/' + n.id); loadNotes(); },
        }, '删除')));
    }
  }

  // ---------- 划词 ----------
  const selbar = h('div', { class: 'selbar', style: { display: 'none' } });
  document.body.append(selbar);
  ctx.selbar = selbar;
  const hideSelbar = () => { selbar.style.display = 'none'; };

  main.addEventListener('mouseup', (e) => setTimeout(() => showSelbar(e), 10));
  main.addEventListener('scroll', hideSelbar, { passive: true });

  function showSelbar(e) {
    const sel = window.getSelection();
    const text = sel?.toString().trim();
    if (!text || text.length < 2 || !main.contains(sel.anchorNode)) return hideSelbar();
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!rect.width) return hideSelbar();

    selbar.innerHTML = '';
    const mk = (label, fn) => h('button', { onclick: (ev) => { ev.preventDefault(); fn(text); } }, label);
    selbar.append(
      mk('摘录', (t) => addNote('highlight', t)),
      h('div', { class: 'sep' }),
      mk('写想法', (t) => addNote('note', t)),
      h('div', { class: 'sep' }),
      mk('复制', (t) => { navigator.clipboard?.writeText(t); toast('已复制'); hideSelbar(); })
    );
    selbar.style.display = 'flex';
    selbar.style.left = clamp(rect.left + rect.width / 2 - 90, 10, window.innerWidth - 200) + 'px';
    selbar.style.top = (rect.top > 70 ? rect.top - 48 : rect.bottom + 12) + 'px';
  }

  function addNote(kind, excerpt) {
    hideSelbar();
    const chIdx = ctx.chapter?.idx ?? 0;
    const chTitle = ctx.chapter?.title || '';
    const ta = h('textarea', {
      class: 'field', rows: 4,
      placeholder: kind === 'highlight' ? '为什么这一段值得留下？（可留空）' : '写下你的想法…',
    });

    const cancelBtn = h('button', { class: 'b-ghost' }, '取消');
    const saveBtn = h('button', { class: 'b-solid' }, '保存');

    const body = h('div', {},
      h('div', { class: 'quote-box' }, `「${excerpt.slice(0, 500)}」`),
      h('div', { style: { marginTop: '.9rem' } }, ta),
      h('div', { class: 'modal-foot' },
        h('span', { class: 'mf-hint' }, chTitle),
        h('div', { style: { display: 'flex', gap: '.5rem' } }, cancelBtn, saveBtn)));

    const m = modal({
      title: kind === 'highlight' ? '留 下 这 段' : '写 下 想 法',
      width: 520,
      content: body,
    });

    cancelBtn.addEventListener('click', () => m.close());
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      try {
        await api.post('/notes', {
          book_id: book.id, kind, chapter_idx: chIdx, chapter_title: chTitle,
          excerpt, body: ta.value.trim() || null,
        });
        m.close();
        toast('已存下');
        await loadNotes();
        const inner = main.querySelector('.reader-inner');
        if (inner) highlightExcerpts(inner, ctx.notes.filter((n) => n.chapter_idx === chIdx && n.excerpt));
      } catch (err) {
        saveBtn.disabled = false;
        toast('保存失败：' + err.message);
      }
    });

    setTimeout(() => ta.focus(), 120);
  }

  // ---------- 进度 ----------
  async function saveProgress() {
    if (!ctx.chapter) return;
    const total = book.chapters?.length || 1;
    const ratio = main.scrollHeight > main.clientHeight
      ? clamp(main.scrollTop / (main.scrollHeight - main.clientHeight), 0, 1) : 1;
    const overall = clamp((ctx.chapter.idx + ratio) / total, 0, 1);
    try {
      await api.patch('/books/' + book.id, {
        progress: overall,
        chapter_idx: ctx.chapter.idx,
        locator: ratio.toFixed(3),
        status: book.status === 'finished' ? 'finished' : (overall > 0.985 ? 'finished' : 'reading'),
      });
    } catch { /* ignore */ }
  }

  function updateProgressLabel() {
    const total = book.chapters?.length || 1;
    progressLabel.textContent = `${(ctx.chapter?.idx ?? 0) + 1} / ${total}`;
  }

  main.addEventListener('scroll', debounce(() => { saveProgress(); }, 900), { passive: true });

  // ---------- 外观 ----------
  function applyFont() {
    const size = FONT_SIZES[clamp(4 + ctx.fontStep, 0, FONT_SIZES.length - 1)];
    const family = fontCssOf(localStorage.getItem('reader-font') || 'song');
    el.style.setProperty('--reader-fs', size + 'px');
    el.style.setProperty('--reader-lh', size >= 20 ? '2.15' : '2.05');
    el.style.setProperty('--reader-w', size >= 22 ? '32em' : '36em');
    el.style.setProperty('--reader-font', family);
    localStorage.setItem('reader-fs', String(ctx.fontStep));
  }

  function selectTheme(id) {
    const i = THEMES.findIndex((t) => t.id === id);
    if (i === -1) return;
    ctx.themeIdx = i;
    applyTheme();
    buildDisplayPanel();
  }

  function applyTheme() {
    const t = THEMES[ctx.themeIdx % THEMES.length];
    let { bg, ink, sub, line, card } = t;
    if (t.id === 'custom') {
      bg = customBg();
      const c = inkFor(bg);
      ink = c.ink; sub = c.sub; line = c.line; card = c.card;
    }
    el.style.setProperty('--reader-bg', bg);
    el.style.setProperty('--ink', ink);
    el.style.setProperty('--ink-2', ink);
    el.style.setProperty('--ink-3', sub);
    el.style.setProperty('--line', line);
    el.style.setProperty('--line-strong', sub);
    el.style.setProperty('--card', card);
    el.style.color = ink;
    el.style.background = bg;
    el.dataset.theme = t.id;
    el.classList.toggle('starry', Boolean(t.starry));
    if (t.starry) applyStarDensity(Number(localStorage.getItem('reader-star-density') || 3));
    const inner = main.querySelector('.reader-inner');
    if (inner) inner.style.color = ink;
    localStorage.setItem('reader-theme', t.id);
  }

  // ---------- 显示面板：字号与背景一次看全 ----------
  const displayPanel = h('div', { class: 'display-panel' });
  let displayOpen = false;

  function toggleDisplay() {
    displayOpen = !displayOpen;
    displayPanel.classList.toggle('show', displayOpen);
    if (displayOpen) buildDisplayPanel();
  }

  // 点面板外面就收起
  el.addEventListener('pointerdown', (e) => {
    if (!displayOpen) return;
    if (displayPanel.contains(e.target)) return;
    if (e.target.closest?.('.reader-btn')) return;
    displayOpen = false;
    displayPanel.classList.remove('show');
  });

  function buildDisplayPanel() {
    displayPanel.innerHTML = '';

    const curSize = FONT_SIZES[clamp(4 + ctx.fontStep, 0, FONT_SIZES.length - 1)];
    const fontRow = h('div', { class: 'dp-row' });
    for (const sz of FONT_SIZES) {
      fontRow.append(h('button', {
        class: 'dp-btn' + (sz === curSize ? ' on' : ''),
        onclick: () => { ctx.fontStep = sz - 18; applyFont(); buildDisplayPanel(); },
      }, String(sz)));
    }

    // 字体
    const curFont = localStorage.getItem('reader-font') || 'song';
    const lxgwOn = Array.from(document.styleSheets).some((s) => (s.href || '').includes('/vendor/lxgw/lxgw.css'));
    const typeRow = h('div', { class: 'dp-row dp-fonts' });
    for (const f of FONTS) {
      const missing = f.id === 'lxgw' && !lxgwOn;
      const b = h('button', {
        class: 'dp-font' + (f.id === curFont ? ' on' : '') + (missing ? ' missing' : ''),
        title: missing ? '文楷字体未随包分发' : (f.css.split(',')[1] || f.label),
        onclick: () => {
          if (missing) {
            toast('「文楷」未随包分发：把字体放进 public/vendor/lxgw/ 后重启即可');
            return;
          }
          localStorage.setItem('reader-font', f.id);
          applyFont();
          buildDisplayPanel();
        },
      }, f.label);
      b.style.fontFamily = f.css;
      typeRow.append(b);
    }

    const bgRow = h('div', { class: 'dp-bgs' });
    for (const t of THEMES) {
      const active = THEMES[ctx.themeIdx % THEMES.length].id === t.id;
      const sw = h('button', {
        class: 'dp-sw' + (active ? ' on' : '') + (t.starry ? ' starry' : ''),
        title: t.label,
        style: { background: t.id === 'custom' ? customBg() : t.bg },
        onclick: () => selectTheme(t.id),
      }, h('span', { class: 'dp-sw-l' }, t.label));
      bgRow.append(sw);
    }

    const color = h('input', { type: 'color', class: 'dp-color', value: customBg(), title: '自定义底色' });
    color.addEventListener('input', () => {
      localStorage.setItem('reader-custom-bg', color.value);
      selectTheme('custom');
      color.value = customBg();
    });

    displayPanel.append(
      h('div', { class: 'dp-title' }, '字号'),
      fontRow,
      h('div', { class: 'dp-title' }, '字体'),
      typeRow,
      h('div', { class: 'dp-title' }, '背景'),
      bgRow,
      h('div', { class: 'dp-custom' },
        h('span', { class: 'dp-custom-l' }, '自定义底色'),
        color));

    // 只有选星空时，才出现「星点密度」
    if (THEMES[ctx.themeIdx % THEMES.length].starry) {
      const dens = Number(localStorage.getItem('reader-star-density') || 3);
      const input = h('input', {
        type: 'range', class: 'dp-range', min: '1', max: '5', step: '1', value: String(dens),
      });
      const label = h('span', { class: 'dp-custom-l' },
        `星点密度 · ${{ 1: '很稀', 2: '稀', 3: '适中', 4: '密', 5: '很密' }[dens]}`);
      input.addEventListener('input', () => {
        const v = Number(input.value);
        localStorage.setItem('reader-star-density', String(v));
        applyStarDensity(v);
        label.textContent = `星点密度 · ${{ 1: '很稀', 2: '稀', 3: '适中', 4: '密', 5: '很密' }[v]}`;
      });
      displayPanel.append(
        h('div', { class: 'dp-title', style: { marginTop: '15px' } }, '星空'),
        h('div', { class: 'dp-custom' }, label, input));
    }
  }

  function applyStarDensity(v) {
    // 数字越大，平铺尺寸越小 → 星点越密
    const sd = 2.0 - (Number(v) - 1) * 0.35;
    el.style.setProperty('--sd', String(sd.toFixed(2)));
  }

  el.append(displayPanel);

  function toggleSide(which) {
    const side = which === 'left' ? left : right;
    const on = side.style.display !== 'none';
    side.style.display = on ? 'none' : '';
  }

  // ---------- 键盘 ----------
  const onKey = (e) => {
    if (/input|textarea/i.test(document.activeElement?.tagName || '')) return;
    if (e.key === 'ArrowRight') {
      const total = isPdf ? (pdfDoc?.numPages || 1) : (book.chapters?.length || 1);
      if (ctx.chapter && ctx.chapter.idx + 1 < total) loadChapter(ctx.chapter.idx + 1);
    }
    if (e.key === 'ArrowLeft' && ctx.chapter?.idx > 0) loadChapter(ctx.chapter.idx - 1);
    if (e.key === 'Escape') close();
  };
  window.addEventListener('keydown', onKey);

  ctx.timer = setInterval(() => {
    const secs = Math.round((Date.now() - ctx.startedAt) / 1000);
    if (secs > 30) {
      api.post(`/books/${book.id}/session`, { seconds: 30 }).catch(() => {});
      ctx.startedAt = Date.now();
    }
  }, 30000);

  ctx.flush = () => {
    saveProgress();
    const secs = Math.round((Date.now() - ctx.startedAt) / 1000);
    if (secs >= 5) api.post(`/books/${book.id}/session`, { seconds: secs }).catch(() => {});
  };

  await loadChapter(chapterIdx || book.chapter_idx || 0);
  return { el, close };
}

export function closeReader() {
  if (!current) return;
  try { current.flush(); } catch { /* ignore */ }
  clearInterval(current.timer);
  window.removeEventListener('keydown', current.onKey);
  current.selbar?.remove();
  current.el.remove();
  current = null;
}

function short(t, n = 9) {
  const s = String(t || '').replace(/\s+/g, ' ');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/** 把已存摘录在正文里点亮 */
export function highlightExcerpts(root, notes) {
  if (!notes?.length) return;
  for (const n of notes) {
    const needle = String(n.excerpt || '').trim();
    if (needle.length < 2) continue;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) nodes.push(node);
    for (const textNode of nodes) {
      const idx = textNode.nodeValue.indexOf(needle);
      if (idx === -1) continue;
      if (textNode.parentElement?.closest('mark.hl')) continue;
      try {
        const range = document.createRange();
        range.setStart(textNode, idx);
        range.setEnd(textNode, idx + needle.length);
        const mark = document.createElement('mark');
        mark.className = 'hl';
        mark.dataset.noteId = n.id;
        range.surroundContents(mark);
      } catch { /* 跨节点，跳过 */ }
      break;
    }
  }
}
