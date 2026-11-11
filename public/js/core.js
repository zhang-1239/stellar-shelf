// 前端核心：API、DOM helpers、提示、弹层、全局状态
export const api = {
  async req(path, opt = {}) {
    const res = await fetch('/api' + path, {
      headers: opt.body && !(opt.body instanceof FormData) ? { 'content-type': 'application/json' } : {},
      ...opt,
      body: opt.body && !(opt.body instanceof FormData) ? JSON.stringify(opt.body) : opt.body,
    });
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : await res.text();
    if (!res.ok) throw Object.assign(new Error((data && data.error) || `请求失败 ${res.status}`), { data });
    return data;
  },
  get(p) { return this.req(p); },
  post(p, body) { return this.req(p, { method: 'POST', body: body ?? {} }); },
  patch(p, body) { return this.req(p, { method: 'PATCH', body: body ?? {} }); },
  del(p) { return this.req(p, { method: 'DELETE' }); },
  upload(p, form) { return this.req(p, { method: 'POST', body: form }); },
};

// ---------- DOM ----------
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs && typeof attrs === 'object' && !(attrs instanceof Node) && !Array.isArray(attrs)) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class' || k === 'className') el.className = v;
      else if (k === 'style' && typeof v === 'object') {
        for (const [sk, sv] of Object.entries(v)) {
          if (sv == null) continue;
          if (sk.startsWith('--')) el.style.setProperty(sk, String(sv));
          else el.style[sk] = sv;
        }
      }
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k in el && k !== 'list') { try { el[k] = v; } catch { el.setAttribute(k, v); } }
      else el.setAttribute(k, v);
    }
  } else if (attrs != null) kids.unshift(attrs);
  for (const kid of kids.flat(9)) {
    if (kid == null || kid === false || kid === true) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }
export function mount(node, child) { clear(node); node.append(child); return node; }

export function debounce(fn, ms = 180) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ---------- 图标 ----------
const ICONS = {
  shelf: '<path d="M3 4h4v16H3zM9 4h4v16H9zM15 5l4 14-2 .6L13 5.6z"/>',
  star: '<path d="M12 3l2.4 5.6 6.1.5-4.6 4 1.4 6-5.3-3.2-5.3 3.2 1.4-6-4.6-4 6.1-.5z"/>',
  note: '<path d="M5 3h9l5 5v13H5zM14 3v5h5M8 12h7M8 16h5"/>',
  chart: '<path d="M4 20V9M10 20V4M16 20v-7M22 20H2"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  left: '<path d="M15 5l-7 7 7 7"/>',
  right: '<path d="M9 5l7 7-7 7"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M4 12.5l5 5L20 6.5"/>',
  book: '<path d="M4 4.5A2.5 2.5 0 016.5 2H20v18H6.5A2.5 2.5 0 004 22z"/><path d="M4 17.5h16"/>',
  sparkle: '<path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8z"/>',
  orbit: '<circle cx="12" cy="12" r="3"/><ellipse cx="12" cy="12" rx="10" ry="4.5" transform="rotate(-25 12 12)"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h10"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14"/>',
  star4: '<path d="M12 3l2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2z"/>',
};

export function icon(name, size = 18) {
  const span = document.createElement('span');
  span.style.display = 'inline-flex';
  span.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none"
    stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
  return span.firstElementChild;
}

// ---------- 提示 ----------
export function toast(msg, ms = 2400) {
  const layer = document.getElementById('layer-toast');
  const el = h('div', { class: 'toast' }, msg);
  el.style.background = document.body.dataset.mode === 'space' ? 'rgba(240,230,210,.94)' : 'rgba(34,30,23,.92)';
  el.style.color = document.body.dataset.mode === 'space' ? '#12131c' : '#f7f1e4';
  layer.append(el);
  setTimeout(() => {
    el.style.transition = 'opacity .4s, transform .4s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    setTimeout(() => el.remove(), 420);
  }, ms);
}

// ---------- 弹层 ----------
export function modal({ title = '', content, width = 720, onClose, cls = '' } = {}) {
  const layer = document.getElementById('layer-modal');
  const mask = h('div', { class: 'modal-mask' });
  const space = document.body.dataset.mode === 'space';
  mask.style.background = space ? 'rgba(3,4,9,.78)' : 'rgba(60,45,25,.34)';
  mask.style.backdropFilter = 'blur(6px)';

  const box = h('div', { class: 'modal-x ' + cls }, 
    h('div', { class: 'modal-head' },
      h('div', { class: 'modal-title' }, title),
      h('button', { class: 'modal-close', onclick: () => close() }, icon('close', 16))
    ),
    h('div', { class: 'modal-body' }, content)
  );
  box.style.width = `min(${width}px, 100%)`;
  if (space) {
    box.style.background = 'linear-gradient(160deg, rgba(20,20,32,.97), rgba(10,10,18,.99))';
    box.style.border = '1px solid rgba(245,216,160,.16)';
    box.style.color = '#ece5d6';
  } else {
    box.style.background = 'var(--card)';
    box.style.boxShadow = 'var(--shadow-2)';
    box.style.border = '1px solid var(--line)';
  }

  function close() {
    mask.style.transition = 'opacity .25s';
    mask.style.opacity = '0';
    setTimeout(() => { mask.remove(); onClose?.(); }, 240);
  }
  mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(); });
  const onKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
  mask.append(box);
  layer.append(mask);
  return { close, box };
}

export function confirmDialog(text, okLabel = '确定') {
  return new Promise((resolve) => {
    const m = modal({
      title: '请确认',
      width: 380,
      content: h('div', {},
        h('p', { style: { margin: '0 0 1.4rem', lineHeight: '1.9', fontSize: '14px' } }, text),
        h('div', { style: { display: 'flex', gap: '.6rem', justifyContent: 'flex-end' } },
          h('button', { class: 'btn', style: { border: '1px solid var(--line-strong)' }, onclick: () => { m.close(); resolve(false); } }, '取消'),
          h('button', { class: 'btn', style: { background: 'var(--accent)', color: '#f8f2e6' }, onclick: () => { m.close(); resolve(true); } }, okLabel)
        )
      ),
    });
  });
}

// ---------- 全局状态 ----------
export const state = {
  // 第一次打开直接落在星海；之后记住你上次停在哪
  mode: localStorage.getItem('shelf-mode') || 'space',
  view: localStorage.getItem('shelf-view') || 'spine',
  books: [],
  book: null,
  reader: null,
  settings: {},
};

export function saveMode(m) {
  state.mode = m;
  localStorage.setItem('shelf-mode', m);
  document.body.dataset.mode = m;
}

// ---------- 日期/文本 ----------
export function fmtDate(s) {
  if (!s) return '';
  const d = new Date(String(s).replace(' ', 'T') + (String(s).includes('Z') ? '' : 'Z'));
  if (isNaN(d)) return String(s).slice(0, 10);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
}
export function relTime(s) {
  if (!s) return '';
  const d = new Date(String(s).replace(' ', 'T') + 'Z');
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`;
  return fmtDate(s);
}
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export function pct(v) { return Math.round(clamp(Number(v) || 0, 0, 1) * 100); }

// 书脊配色（按书名稳定散列）
const CLOTH = [
  ['#5b3a2e', '#f2e6d2'], ['#2f4238', '#e8e0cd'], ['#3a3f5c', '#e6e2d6'],
  ['#6b4a2f', '#f3e7d1'], ['#4a3348', '#eadfd9'], ['#2e4a4f', '#e2ded1'],
  ['#7a4a35', '#f6ead6'], ['#45443a', '#e9e2cf'], ['#5a2f36', '#f0e2d8'],
  ['#33465e', '#e3e4da'], ['#6a5230', '#f4ead4'], ['#3d4a3a', '#e6e5d2'],
];
export function clothOf(seedStr) {
  let h = 0;
  const s = String(seedStr || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 100000;
  return CLOTH[h % CLOTH.length];
}

/** 小尺寸封面：有图用图，没图用布面排印 */
export function miniCover(book, w = 26, h = 39, opts = {}) {
  const [bg, ink] = clothOf(book.title + (book.author || ''));
  const box = document.createElement('div');
  box.style.cssText = `width:${w}px;height:${h}px;flex:none;border-radius:1px 2px 2px 1px;overflow:hidden;background:${bg};position:relative`;
  if (book.cover_path) {
    const img = document.createElement('img');
    img.src = `/media/${book.cover_path}`;
    img.loading = 'lazy';
    img.style.cssText = 'width:100%;height:100%;object-fit:cover';
    box.append(img);
  } else {
    const t = document.createElement('div');
    t.textContent = (book.title || '').slice(0, 2);
    t.style.cssText = `position:absolute;inset:0;display:grid;place-items:center;color:${ink};opacity:.9;
      font-family:var(--font-serif);font-size:${Math.max(8, Math.round(w * 0.42))}px;line-height:1.2;
      writing-mode:vertical-rl;text-orientation:upright;letter-spacing:.05em`;
    box.append(t);
  }
  return box;
}
