// 应用入口：只有星海。翻开书时，阅读器覆盖在星空之上。
import { h } from './core.js';
import { openSpace, closeSpace } from './space/space.js';
import { openReader, closeReader } from './views/reader.js';

let ctl = null;
let reader = null;

function boot() {
  const app = document.getElementById('app');
  app.innerHTML = '';
  document.body.dataset.mode = 'space';
  startSpace();
}

async function startSpace() {
  try {
    ctl = await openSpace({});
  } catch (err) {
    console.error(err);
    showFailure(err);
  }
}

function showFailure(err) {
  const app = document.getElementById('app');
  app.innerHTML = '';
  app.append(h('div', {
    style: {
      position: 'fixed', inset: 0, zIndex: 45, display: 'grid', placeItems: 'center',
      background: 'radial-gradient(circle at 50% 40%, #14172a 0%, #05060b 62%)',
      color: '#ede4d2', textAlign: 'center', padding: '2rem',
    },
  },
    h('div', { style: { maxWidth: '540px' } },
      h('div', { style: { fontSize: '26px', letterSpacing: '.4em', marginBottom: '1.4rem', fontFamily: 'var(--font-li)' } }, '星 海 未 启'),
      h('div', { style: { fontFamily: 'var(--font-kai)', fontSize: '15px', lineHeight: 2.1, opacity: .82 } },
        '这台机器的浏览器没有给 WebGL，或者显卡驱动拒绝了它。星海需要它的 3D 能力。'),
      h('div', {
        style: {
          marginTop: '1.2rem', padding: '.9rem 1rem', borderRadius: '8px',
          background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.12)',
          fontFamily: 'ui-monospace, monospace', fontSize: '11.5px', lineHeight: 1.9,
          color: 'rgba(237,228,210,.7)', wordBreak: 'break-all',
        },
      }, String(err?.message || err)),
      h('button', {
        class: 'b-solid', style: { marginTop: '1.6rem' },
        onclick: () => location.reload(),
      }, '再试一次'))));
}

// 星海 → 翻开一本书
window.addEventListener('space:open-book', async (e) => {
  const { bookId, chapterIdx } = e.detail || {};
  if (!bookId) return;
  if (reader) { reader.close(); reader = null; }
  try {
    reader = await openReader(bookId, chapterIdx || 0, {
      onClose: () => {
        reader = null;
        ctl?.refresh?.();
      },
    });
  } catch (err) {
    console.error(err);
    ctl?.refresh?.();
  }
});

window.addEventListener('space:exit', () => {
  // 星海就是整个应用，没有地方可退。保留这个事件以便将来扩展。
});

window.addEventListener('beforeunload', () => {
  try { closeReader(); closeSpace(); } catch { /* ignore */ }
});

boot();
