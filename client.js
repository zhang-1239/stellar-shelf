window.__ModuleLoader__.load({
  id: '@zhangxij/stellar-shelf',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    // 服务端口可能不是固定的：探到哪个就用哪个
    const BASE_PORT = 7317;
    const PORTS = Array.from({ length: 13 }, (_, i) => BASE_PORT + i);
    const FALLBACK = `http://127.0.0.1:${BASE_PORT}/`;

    async function findApp() {
      const hits = await Promise.all(PORTS.map(async (p) => {
        try {
          const res = await fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(900) });
          if (!res.ok) return null;
          const data = await res.json();
          return data && data.ok ? `http://127.0.0.1:${p}/` : null;
        } catch {
          return null;
        }
      }));
      return hits.find(Boolean) || null;
    }

    function ShelfIcon({ size = 20, active = false }) {
      const s = Math.max(14, Math.min(28, size));
      return h('svg', {
        viewBox: '0 0 24 24', width: s, height: s, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        style: { display: 'block', opacity: active ? 1 : 0.78 }, 'aria-hidden': true,
      },
        h('path', { d: 'M12 2.6l1.5 4.2 4.2 1.5-4.2 1.5L12 14l-1.5-4.2L6.3 8.3l4.2-1.5z', strokeOpacity: 0.5 }),
        h('path', { d: 'M3.5 14.2c2.2-1.3 5-1.3 7.2 0v6.1c-2.2-1.3-5-1.3-7.2 0z' }),
        h('path', { d: 'M20.5 14.2c-2.2-1.3-5-1.3-7.2 0v6.1c2.2-1.3 5-1.3 7.2 0z' })
      );
    }

    function ShelfPanel() {
      const [url, setUrl] = React.useState(null);
      const [loaded, setLoaded] = React.useState(false);
      const [offline, setOffline] = React.useState(false);
      const mounted = React.useRef(false);

      React.useEffect(() => {
        let alive = true;
        let tries = 0;
        const tick = async () => {
          const found = await findApp();
          if (!alive) return;
          if (found) { setUrl(found); setOffline(false); return; }
          tries += 1;
          // 探不到也先把面板挂上，让用户看见东西，而不是一块"启航"
          if (tries === 2 && !mounted.current) { mounted.current = true; setUrl(FALLBACK); }
          if (tries >= 8) { setOffline(true); return; }
          setTimeout(tick, 900);
        };
        tick();
        return () => { alive = false; };
      }, []);

      const retry = () => {
        setOffline(false);
        setLoaded(false);
        findApp().then((found) => setUrl(found || FALLBACK));
      };

      if (!url) {
        // 只有最开始的几百毫秒会走到这里
        return h('div', {
          style: {
            width: '100%', height: '100%', minHeight: '72vh',
            borderRadius: 12, background: '#05060b',
          },
        });
      }

      return h('div', {
        style: {
          position: 'relative', width: '100%', height: '100%', minHeight: '72vh',
          overflow: 'hidden', borderRadius: 12, background: '#05060b',
        },
      },
        h('iframe', {
          src: url, title: '星槎书斋', allow: 'clipboard-write; fullscreen',
          onLoad: () => setLoaded(true),
          style: {
            position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0, display: 'block',
            background: '#05060b', opacity: loaded ? 1 : 0, transition: 'opacity .35s ease',
          },
        }),
        offline ? h('div', {
          style: {
            position: 'absolute', left: '50%', bottom: 18, transform: 'translateX(-50%)', zIndex: 3,
            display: 'flex', alignItems: 'center', gap: 12,
            padding: '8px 14px', borderRadius: 999,
            background: 'rgba(12,13,20,.86)', border: '1px solid rgba(242,232,213,.2)',
            color: '#e9e2d4', font: '11.5px/1.4 var(--dsh-font-sans, system-ui, sans-serif)',
            letterSpacing: '.06em', backdropFilter: 'blur(10px)',
          },
        },
          h('span', { style: { opacity: .75 } }, '本地服务还没起来'),
          h('button', {
            onClick: retry,
            style: {
              padding: '3px 12px', borderRadius: 999, cursor: 'pointer',
              color: '#12131c', background: '#e8d7b4', border: 'none',
              font: '11px/1.4 var(--dsh-font-sans, system-ui, sans-serif)',
            },
          }, '重试')) : null,
        loaded ? h('a', {
          href: url, target: '_blank', rel: 'noopener noreferrer',
          title: '在浏览器中打开',
          style: {
            position: 'absolute', right: 14, bottom: 14, zIndex: 3,
            padding: '6px 12px', borderRadius: 999,
            font: '11px/1.4 var(--dsh-font-sans, system-ui, sans-serif)', letterSpacing: '0.08em',
            color: '#f2e8d5', background: 'rgba(12,13,20,0.72)',
            border: '1px solid rgba(242,232,213,0.28)', textDecoration: 'none',
            backdropFilter: 'blur(8px)',
          },
        }, '在浏览器中打开 ↗') : null
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: 'stellar-shelf', order: 30, label: '星槎',
        }, ShelfIcon));

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: 'stellar-shelf',
        }, ShelfPanel));
      },
    };
  },
});
