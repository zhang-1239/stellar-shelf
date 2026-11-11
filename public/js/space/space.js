// 星海：这既是一个书架，也是整个应用。
// 星系 = 分类，星的颜色 = 阅读状态，靠近一颗星才看清它是一本书。
import * as THREE from '/vendor/three.module.min.js';
import { api, h, toast, pct, fmtDate, modal } from '../core.js';

let root = null;
let raf = 0;
let disposed = false;

const CFG = {
  reach: 18,          // 进入「接近」状态的距离
  startDist: 9.5,     // 停在书前的距离
  galaxyDist: 2.7,    // 停在星系前的距离系数
  accel: 60,
  damp: 0.9,
  maxSpeed: 52,
  lookSpeed: 0.0024,
  flyDur: 1.5,
};

// 状态 → 颜色。这四种颜色就是这本书的图例。
const C = {
  unread: 0x6f9dff,     // 蓝：未读
  reading: 0xf3d274,    // 黄：在读
  finished: 0xffffff,   // 白：读完
  reco: 0x4fe3d0,       // 青：今日推荐（还没上书架）
};
const STATUS_LABEL = { unread: '未读', reading: '在读', finished: '已读完' };

// 手感参数（滚轮推力 / 滑行惯性 / 转向灵敏度），存在本地，滑杆可调
const FEEL_KEY = 'space-feel';
const FEEL_DEFAULT = { speed: 1, glide: 0.96, look: 1, gap: 1 };
function loadFeel() {
  try {
    const s = JSON.parse(localStorage.getItem(FEEL_KEY) || '{}');
    const num = (v, d, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
    return {
      speed: num(s.speed, FEEL_DEFAULT.speed, 0.25, 3),
      glide: num(s.glide, FEEL_DEFAULT.glide, 0.88, 0.99),
      look: num(s.look, FEEL_DEFAULT.look, 0.4, 3),
      gap: num(s.gap, FEEL_DEFAULT.gap, 0.4, 2.2),
    };
  } catch { return { ...FEEL_DEFAULT }; }
}

/** 星海筛选：按阅读状态显隐 */
const FILTER_KEY = 'space-filter';
function loadFilter() {
  try {
    const s = JSON.parse(localStorage.getItem(FILTER_KEY) || '{}');
    return {
      unread: s.unread !== false,
      reading: s.reading !== false,
      finished: s.finished !== false,
      reco: s.reco !== false,
    };
  } catch { return { unread: true, reading: true, finished: true, reco: true }; }
}

export async function openSpace({ onOpenBook } = {}) {
  disposed = false;
  const feel = loadFeel();
  const filter = loadFilter();

  const [books, digest, stats, notes, genreDir, appSettings] = await Promise.all([
    api.get('/books'),
    api.get('/recos/today').catch(() => ({ recos: [], line: '' })),
    api.get('/stats').catch(() => null),
    api.get('/notes').catch(() => []),
    api.get('/genres').catch(() => ({ genres: [] })),
    api.get('/settings').catch(() => ({})),
  ]);
  const recos = (digest?.recos || []).filter((r) => r.feedback !== 'not_interested' && r.feedback !== 'shelved');

  root = h('div', { id: 'space-root' });
  document.body.append(root);

  // ================= HUD =================
  const brand = h('div', { class: 'space-brand' },
    h('div', { class: 'sb-t' }, '星 槎'),
    h('div', { class: 'sb-s' }, `${books.length} 颗星 · ${countGalaxies(books)} 个星系`));

  // 顶部那句话
  const quoteText = digest?.line || '读书是往身体里装一片星空。';
  const quoteBar = h('div', { class: 'quote-bar' },
    h('span', { class: 'q-mark' }, '「'),
    h('span', { class: 'q-text' }, quoteText),
    h('span', { class: 'q-mark' }, '」'));
  if (localStorage.getItem('space-quote') === 'off') quoteBar.classList.add('gone');

  const btn = (label, fn, cls = '') => h('button', { class: 'sp-btn ' + cls, onclick: fn }, label);

  const topRight = h('div', { class: 'space-tools' },
    btn('星系', () => togglePanel('galaxies')),
    btn('星图', () => togglePanel('map')),
    btn('筛选', () => togglePanel('filters')),
    btn('设置', () => togglePanel('settings')),
    btn('句子', () => toggleQuote(), 'quote-toggle'),
  );

  // 星系索引
  const galaxyPanel = h('aside', { class: 'side-panel galaxy-panel' });
  // 星图
  const mapWrap = h('div', { class: 'starmap' });
  const mapCanvas = h('canvas', { width: 420, height: 420 });
  mapWrap.append(mapCanvas);
  // 右下：星轨
  const statPanel = h('aside', { class: 'side-panel stat-panel' });
  buildStats(statPanel, stats, notes, books);
  // 设置（入库 + 归类）
  const settingsPanel = h('aside', { class: 'side-panel settings-panel' });
  // 筛选（按阅读状态显隐）
  const filterPanel = h('aside', { class: 'side-panel filter-panel' });

  // 左下提示
  const hint = h('div', { class: 'space-hint' });
  hint.innerHTML = '<div>拖动 <kbd>鼠标</kbd> 环顾 · <kbd>滚轮往上</kbd> 往前飞 · <kbd>W</kbd><kbd>S</kbd> 也行</div>'
    + '<div>点一颗星飞过去 · <kbd>M</kbd> 星图 · <kbd>G</kbd> 星系 · <kbd>Esc</kbd> 收起界面</div>';

  // 图例
  const legend = h('div', { class: 'legend' },
    dot(C.unread, '未读'), dot(C.reading, '在读'), dot(C.finished, '已读完'), dot(C.reco, '今日推荐'));

  // 手感滑杆：速度 / 惯性 / 转向
  const feelBar = h('div', { class: 'feel-bar' });
  {
    const specs = [
      { key: 'speed', label: '速度', min: 0.25, max: 3, step: 0.05, fmt: (v) => v.toFixed(2) + '×' },
      { key: 'glide', label: '惯性', min: 0.88, max: 0.99, step: 0.005, fmt: (v) => Math.round(((v - 0.88) / (0.99 - 0.88)) * 100) + '%' },
      { key: 'look', label: '转向', min: 0.4, max: 3, step: 0.05, fmt: (v) => v.toFixed(2) + '×' },
      { key: 'gap', label: '间距', min: 0.4, max: 2.2, step: 0.05, fmt: (v) => v.toFixed(2) + '×', apply: (v) => applySpacing(v) },
    ];
    const refs = [];
    for (const s of specs) {
      const val = h('span', { class: 'feel-val' }, s.fmt(feel[s.key]));
      const inp = h('input', {
        type: 'range', class: 'feel-range',
        min: String(s.min), max: String(s.max), step: String(s.step), value: String(feel[s.key]),
      });
      inp.addEventListener('input', () => {
        feel[s.key] = Number(inp.value);
        val.textContent = s.fmt(feel[s.key]);
        localStorage.setItem(FEEL_KEY, JSON.stringify(feel));
        s.apply?.(feel[s.key]);
      });
      refs.push({ s, inp, val });
      feelBar.append(h('label', { class: 'feel' }, h('span', { class: 'feel-lab' }, s.label), inp, val));
    }
    feelBar.append(h('button', {
      class: 'feel-reset', title: '恢复默认手感',
      onclick: () => {
        for (const { s, inp, val } of refs) {
          feel[s.key] = FEEL_DEFAULT[s.key];
          inp.value = String(feel[s.key]);
          val.textContent = s.fmt(feel[s.key]);
        }
        localStorage.setItem(FEEL_KEY, JSON.stringify(feel));
        toast('手感已恢复默认');
      },
    }, '↺'));
  }

  const nearCard = h('div', { class: 'near-card' });
  const gaze = h('div', { class: 'gaze' }, h('i'));
  const loading = h('div', { class: 'space-loading' }, h('div', { class: 'sl-t' }, '启 航'));
  const labels = h('div', { class: 'galaxy-labels' });

  root.append(gaze,
    h('div', { class: 'space-top' }, brand, quoteBar, topRight),
    galaxyPanel, mapWrap, statPanel, settingsPanel, filterPanel, legend, feelBar, hint, labels, nearCard, loading);

  function dot(color, label) {
    return h('span', { class: 'lg' },
      h('i', { style: { background: '#' + color.toString(16).padStart(6, '0') } }), label);
  }

  // ================= 渲染器 =================
  if (!hasWebGL()) throw new Error('这个浏览器没有可用的 WebGL 上下文');
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x020206, 1);
  root.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x020206);
  scene.fog = new THREE.FogExp2(0x020206, 0.00055);
  const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 6000);

  const glowTex = makeGlowTexture();
  const nebTex = makeNebulaTexture();
  const nebula = buildNebula(nebTex);
  scene.add(nebula);
  const milkyWay = buildMilkyWay(nebTex);
  scene.add(milkyWay);
  const starfield = buildStarfield(glowTex);
  scene.add(starfield);

  // ================= 星系 =================
  const galaxies = buildGalaxies(books);
  const galaxyLayer = new THREE.Group();
  scene.add(galaxyLayer);

  const labelsList = [];
  for (const g of galaxies) {
    const col = new THREE.Color().setHSL((hash01(g.tag) * 0.12 + 0.58) % 1, 0.55, 0.55);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color: col, transparent: true, opacity: 0.22,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, fog: false,
    }));
    halo.scale.setScalar(g.radius * 5.2);
    halo.position.copy(g.center);
    halo.renderOrder = -6;
    galaxyLayer.add(halo);

    g.halo = halo;
    g.currentCenter = g.center.clone();

    const label = h('div', {
      class: 'galaxy-label',
      title: `飞到「${g.tag}」`,
      onclick: () => flyToGalaxy(g),
    },
      h('div', { class: 'gl-t' }, g.tag),
      h('div', { class: 'gl-c' }, `${g.books.length} 本`));
    labels.append(label);
    labelsList.push({ g, el: label, halo });
  }

  // 书 → 星
  const entries = [];
  for (const g of galaxies) {
    g.books.forEach((b, j) => {
      entries.push(makeStar(b, g, j, glowTex));
    });
  }
  for (const e of entries) scene.add(e.group);

  // 今日推荐 → 青色脉冲星
  const recoCenter = new THREE.Vector3(0, 150, 0);
  const recoGroup = { center: recoCenter.clone(), currentCenter: recoCenter.clone(), radius: 34, tag: '今日星群' };
  const recoEntries = recos.map((r, i) => makeRecoStar(r, recoGroup, i, recos.length, glowTex));
  for (const e of recoEntries) scene.add(e.group);
  if (recoEntries.length) {
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color: C.reco, transparent: true, opacity: 0.12,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, fog: false,
    }));
    halo.scale.setScalar(120);
    halo.position.copy(recoCenter);
    scene.add(halo);
    recoGroup.halo = halo;
    const label = h('div', {
      class: 'galaxy-label reco-label',
      title: '飞到「今日星群」',
      onclick: () => flyToGalaxy(recoGroup),
    },
      h('div', { class: 'gl-t' }, '今日星群'),
      h('div', { class: 'gl-c' }, `${recoEntries.length} 颗候选`));
    labels.append(label);
    labelsList.push({ g: recoGroup, el: label });
  }

  // ================= 相机初始 =================
  /** 星系间距：滑杆一动就重排整片星海 */
  function applySpacing(k) {
    for (const g of galaxies) {
      g.currentCenter.copy(g.center).multiplyScalar(k);
      if (g.halo) g.halo.position.copy(g.currentCenter);
    }
    if (recoGroup) {
      recoGroup.currentCenter.copy(recoGroup.center).multiplyScalar(k);
      if (recoGroup.halo) recoGroup.halo.position.copy(recoGroup.currentCenter);
    }
    for (const e of [...entries, ...recoEntries]) {
      e.pos.copy(e.galaxy.currentCenter).add(e.local);
      e.group.position.copy(e.pos);
    }
  }
  applySpacing(feel.gap);

  const bounds = new THREE.Box3();
  for (const e of entries) bounds.expandByPoint(e.pos);
  for (const e of recoEntries) bounds.expandByPoint(e.pos);
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const span = Math.max(size.x, size.z, 200);

  camera.position.set(center.x, center.y + span * 0.3, center.z + span * 0.95);
  let yaw = 0, pitch = 0, speed = 0;
  const vel = new THREE.Vector3();
  const keys = new Set();
  {
    const d = center.clone().sub(camera.position).normalize();
    yaw = Math.atan2(-d.x, -d.z);
    pitch = THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(d.y, -1, 1)), -1.2, 1.2);
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
  }

  // ================= 交互 =================
  let dragging = false, lastX = 0, lastY = 0, moved = 0;
  let flying = null, near = null, hovered = null;
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2(9, 9);
  const canvas = renderer.domElement;
  canvas.style.cursor = 'grab';

  canvas.addEventListener('pointerdown', (e) => {
    dragging = true; moved = 0; lastX = e.clientX; lastY = e.clientY;
    canvas.setPointerCapture?.(e.pointerId);
    canvas.style.cursor = 'grabbing';
    canvas.classList.add('dragging');
  });
  canvas.addEventListener('pointermove', (e) => {
    pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    moved += Math.abs(dx) + Math.abs(dy);
    if (!flying) {
      yaw -= dx * CFG.lookSpeed * feel.look;
      pitch = THREE.MathUtils.clamp(pitch - dy * CFG.lookSpeed * feel.look, -1.45, 1.45);
    }
  });
  const endDrag = (e) => {
    dragging = false;
    canvas.style.cursor = 'grab';
    canvas.classList.remove('dragging');
    if (moved < 6 && e.type === 'pointerup') clickAt();
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', () => { dragging = false; canvas.style.cursor = 'grab'; });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    // 往上滚 = 往前飞（越来越近）。滚一格就走一大步，跟手。
    speed = THREE.MathUtils.clamp(speed - e.deltaY * 1.15 * feel.speed, -180, 320);
  }, { passive: false });

  const onKeyDown = (e) => {
    const k = e.key.toLowerCase();
    if (k === 'escape') { if (anyPanelOpen()) closePanels(); else onExit?.(); return; }
    if (k === 'm') return togglePanel('map');
    if (k === 'g') return togglePanel('galaxies');
    if (k === 'enter' && near) return openNear();
    keys.add(k);
    if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' ', 'shift'].includes(k)) e.preventDefault();
  };
  const onKeyUp = (e) => keys.delete(e.key.toLowerCase());
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('resize', onResize);

  function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }

  let onExit = null;
  function setExit(fn) { onExit = fn; }

  // ================= 选中与飞行 =================
  const allHits = [...entries, ...recoEntries];
  applyFilter();

  function clickAt() {
    raycaster.setFromCamera(pointer, camera);
    const targets = allHits.filter((x) => x.group.visible).map((x) => x.hit);
    const hit = raycaster.intersectObjects(targets, false)[0];
    if (!hit) return;
    const entry = allHits.find((x) => x.hit === hit.object);
    if (entry) flyToStar(entry);
  }

  function flyToStar(entry) {
    const dir = camera.position.clone().sub(entry.pos).normalize();
    if (dir.lengthSq() < 0.001) dir.set(0, 0, 1);
    const dest = entry.pos.clone().add(dir.multiplyScalar(CFG.startDist));
    flying = {
      from: camera.position.clone(),
      to: dest,
      look: entry.pos.clone().add(new THREE.Vector3(0, 1.35, 0)),
      t: 0, dur: CFG.flyDur, entry,
    };
    vel.set(0, 0, 0);
    speed = 0;
  }

  function flyToGalaxy(g) {
    const c = g.currentCenter || g.center;
    const dir = camera.position.clone().sub(c).normalize();
    const dist = Math.max(70, g.radius * CFG.galaxyDist + 40);
    const dest = c.clone().add(dir.multiplyScalar(dist));
    flying = {
      from: camera.position.clone(),
      to: dest,
      look: c.clone(),
      t: 0, dur: 1.9, galaxy: g,
    };
    vel.set(0, 0, 0);
    speed = 0;
    closePanels();
  }

  // ================= 书卡 =================
  let cardFor = null;
  function showCard(entry) {
    const isReco = Boolean(entry.reco);
    const data = entry.data;
    cardFor = entry.id;
    const colorHex = isReco ? C.reco : (C[data.status] || C.unread);
    nearCard.innerHTML = '';

    const cover = h('div', { class: 'near-cover' },
      data.cover_path
        ? h('img', { src: `/media/${data.cover_path}`, alt: data.title })
        : h('div', { class: 'typo-cover', style: { '--tc-bg': '#1d1f2e', '--tc-ink': '#e8dcc4' } },
            h('div', { class: 'tc-t', style: { fontSize: '11px' } }, data.title)));

    const acts = h('div', { class: 'near-acts' });

    if (isReco) {
      acts.append(
        h('button', { class: 'sp-btn primary', onclick: () => shelveReco(entry) }, '放入书架'),
        h('button', { class: 'sp-btn', onclick: () => markReco(entry, 'interested') }, '感兴趣'),
        h('button', { class: 'sp-btn', onclick: () => markReco(entry, 'not_interested') }, '不感兴趣'),
        h('button', { class: 'sp-btn', onclick: () => openLink(data.douban_url) }, '豆瓣 ↗'),
      );
    } else {
      acts.append(
        h('button', {
          class: 'sp-btn primary',
          onclick: () => data.content_ready ? openBook(data) : openNotes(data),
        }, data.content_ready ? (data.progress > 0 ? '继续读' : '翻开') : '这本书没有正文'),
        h('button', {
          class: 'sp-btn',
          onclick: async () => {
            const next = data.status === 'finished' ? 'reading' : 'finished';
            await api.patch('/books/' + data.id, { status: next });
            data.status = next;
            if (next === 'finished') data.progress = 1;
            paintStar(entry, isReco);
            toast(next === 'finished' ? '已标记读完，这颗星亮起来' : '已放回在读');
            showCard(entry);
            refreshStats();
          },
        }, data.status === 'finished' ? '取消读完' : '标记读完'),
        h('button', { class: 'sp-btn', onclick: () => openNotes(data) }, `笔记 ${data.note_count || 0}`),
      );
      if (data.douban_url) acts.append(h('button', { class: 'sp-btn', onclick: () => openLink(data.douban_url) }, '豆瓣 ↗'));
    }

    nearCard.append(
      cover,
      h('div', { class: 'near-body' },
        h('div', { class: 'near-t' }, data.title),
        h('div', { class: 'near-a' }, data.author || '佚名'),
        h('div', { class: 'near-meta' },
          h('i', { class: 'near-dot', style: { background: '#' + colorHex.toString(16).padStart(6, '0') } }),
          [
            isReco ? '今日推荐' : STATUS_LABEL[data.status] || '未读',
            !isReco && data.status === 'reading' ? `读到 ${pct(data.progress)}` : null,
            data.genre,
            isReco ? (data.douban_rating ? `豆瓣 ${data.douban_rating}` : null) : (data.word_count ? `${(data.word_count / 1000).toFixed(0)}k 字` : null),
          ].filter(Boolean).join(' · ')),
        data.summary ? h('div', { class: 'near-sum' }, String(data.summary).replace(/\s+/g, ' ').slice(0, 130) + '…') : null,
        acts)
    );
    nearCard.classList.add('show');
    root.classList.add('locked');
  }

  function hideCard() {
    cardFor = null;
    nearCard.classList.remove('show');
    root.classList.remove('locked');
  }

  function openNear() {
    const entry = allHits.find((x) => x.id === cardFor);
    if (!entry) return;
    if (entry.reco) shelveReco(entry);
    else if (entry.data.content_ready) openBook(entry.data);
    else openNotes(entry.data);
  }

  function openBook(data) {
    const to = data.chapter_idx || 0;
    dispatchEvent(new CustomEvent('space:open-book', { detail: { bookId: data.id, chapterIdx: to } }));
  }

  function openNotes(data) {
    api.get('/notes?book=' + data.id).then((list) => {
      const body = h('div', { class: 'notes-modal' });
      if (!list.length) {
        body.append(h('div', { class: 'nm-empty' }, '还没有笔记。翻开这本书，选中一段话就能留下摘录。'));
      }
      for (const n of list) {
        body.append(h('div', { class: 'nm-item' },
          n.excerpt ? h('div', { class: 'nm-ex' }, `「${n.excerpt.slice(0, 120)}」`) : null,
          n.body ? h('div', { class: 'nm-body' }, n.body.slice(0, 240)) : null,
          h('div', { class: 'nm-when' }, [n.chapter_title, fmtDate(n.created_at)].filter(Boolean).join(' · '))));
      }
      modal({ title: `《${data.title}》的笔记 · ${list.length} 条`, width: 560, content: body });
    });
  }

  async function markReco(entry, fb) {
    await api.post(`/recos/${entry.data.id}/feedback`, { feedback: fb });
    toast(fb === 'interested' ? '记下了：感兴趣' : '记下了：不感兴趣');
    removeEntry(entry);
  }

  async function shelveReco(entry) {
    try {
      const out = await api.post(`/recos/${entry.data.id}/shelve`);
      toast(out?.existed ? '书架上已有这本' : '已放入书架');
      removeEntry(entry);
      // 收起这张卡，等下次刷新时它会作为一颗新星出现
      hideCard();
      toast('重新进入星海就能看见它');
    } catch (e) {
      toast('操作失败：' + e.message);
    }
  }

  function removeEntry(entry) {
    entry.group.visible = false;
    entry.hit.visible = false;
    const idx = allHits.indexOf(entry);
    if (idx !== -1) allHits.splice(idx, 1);
    if (near === entry) { near = null; hideCard(); }
  }

  function openLink(url) {
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  }

  // ================= 面板 =================
  let panelOpen = null;
  function anyPanelOpen() { return panelOpen !== null; }
  function closePanels() {
    panelOpen = null;
    galaxyPanel.classList.remove('show');
    mapWrap.classList.remove('show');
    statPanel.classList.remove('open');
    settingsPanel.classList.remove('show');
    filterPanel.classList.remove('show');
  }
  function togglePanel(which) {
    const already = panelOpen === which;
    closePanels();
    if (already) return;
    panelOpen = which;
    if (which === 'galaxies') { galaxyPanel.classList.add('show'); }
    if (which === 'map') { mapWrap.classList.add('show'); drawMap(); }
    if (which === 'stats') { statPanel.classList.add('open'); }
    if (which === 'settings') { settingsPanel.classList.add('show'); }
    if (which === 'filters') { filterPanel.classList.add('show'); buildFilterPanel(); }
  }

  // ================= 筛选：按阅读状态显隐星星 =================
  const FILTER_DEFS = [
    { key: 'unread', label: '未读', color: C.unread },
    { key: 'reading', label: '在读', color: C.reading },
    { key: 'finished', label: '已读完', color: C.finished },
    { key: 'reco', label: '今日推荐', color: C.reco },
  ];
  const filterChips = h('div', { class: 'fchips' });
  filterPanel.append(
    h('div', { class: 'panel-head' }, '筛 选',
      h('button', { class: 'panel-x', onclick: closePanels }, '✕')),
    filterChips,
    h('div', { class: 'fnote' }, '点一下隐藏这种颜色的星星，可以多选'));
  buildFilterPanel();

  function buildFilterPanel() {
    filterChips.innerHTML = '';
    for (const f of FILTER_DEFS) {
      const on = filter[f.key] !== false;
      filterChips.append(h('button', {
        class: 'fchip' + (on ? ' on' : ''),
        title: on ? '点击隐藏' : '点击显示',
        onclick: () => {
          filter[f.key] = !on;
          localStorage.setItem(FILTER_KEY, JSON.stringify(filter));
          applyFilter();
          buildFilterPanel();
        },
      },
        h('i', { style: { background: '#' + f.color.toString(16).padStart(6, '0') } }),
        h('span', {}, f.label),
        h('em', {}, on ? '显示' : '隐藏')));
    }
  }

  function applyFilter() {
    if (!allHits) return;
    for (const e of allHits) {
      const key = e.reco ? 'reco' : (e.data.status || 'unread');
      e.group.visible = filter[key] !== false;
    }
    if (near && !near.group.visible) { near = null; hideCard(); }
  }

  // ================= 设置：入库 + 归类 =================
  const DEFAULT_GENRES = ['古典', '小说', '神话', '文学', '社科', '科学', '艺术', '生活', '未分类'];
  function buildSettings(panel) {
    panel.innerHTML = '';
    panel.append(h('div', { class: 'panel-head' }, '设 置',
      h('button', { class: 'panel-x', onclick: closePanels }, '✕')));

    const status = h('div', { class: 'set-status' });

    // —— 入库 ——
    const fileInput = h('input', {
      type: 'file', multiple: true, style: { display: 'none' },
      accept: '.epub,.pdf,.txt,.mobi,.azw3,.docx,.md,.markdown,.html,.htm',
    });
    fileInput.addEventListener('change', async () => {
      const files = [...fileInput.files];
      if (!files.length) return;
      status.textContent = `正在解析 ${files.length} 个文件…`;
      const form = new FormData();
      for (const f of files) form.append('file', f, f.name);
      try {
        const res = await fetch('/api/books/import', { method: 'POST', body: form });
        const out = await res.json();
        const ok = out.imported?.length || 0;
        const bad = out.errors?.length || 0;
        status.textContent = `入库 ${ok} 本${bad ? `，失败 ${bad} 个` : ''}${ok ? '，正在刷新星海…' : ''}`;
        if (ok) setTimeout(() => location.reload(), 1100);
      } catch (err) {
        status.textContent = '导入失败：' + err.message;
      }
    });

    panel.append(
      h('button', { class: 'set-upload', onclick: () => fileInput.click() }, '＋ 入库（上传书籍）'),
      fileInput,
      h('div', { class: 'set-hint' }, 'EPUB · PDF · TXT · MOBI · AZW3 · DOCX · Markdown'));

    // —— 豆瓣推荐源（默认关闭）——
    const doubanOn = String((appSettings && appSettings.douban_enabled) || 'off') === 'on';
    const doubanToggle = h('button', {
      class: 'set-toggle' + (doubanOn ? ' on' : ''),
      title: '开启后会从豆瓣读书抓取每日推荐',
    }, doubanOn ? '已开启' : '已关闭');
    doubanToggle.addEventListener('click', async () => {
      const next = doubanToggle.classList.contains('on') ? 'off' : 'on';
      try {
        await api.post('/settings', { douban_enabled: next });
        doubanToggle.classList.toggle('on', next === 'on');
        doubanToggle.textContent = next === 'on' ? '已开启' : '已关闭';
        status.textContent = next === 'on'
          ? '豆瓣推荐源已开启：下次生成星讯时会去抓取'
          : '豆瓣推荐源已关闭：今日星群只从你自己的书里挑';
      } catch (e) {
        status.textContent = '改不了：' + e.message;
      }
    });
    panel.append(
      h('div', { class: 'set-label' }, '推荐来源'),
      h('div', { class: 'set-row' },
        h('span', { class: 'set-title' }, '豆瓣读书'),
        doubanToggle),
      h('div', { class: 'set-hint set-hint-left' }, '关闭时，今日星群只从你还没读完的书里挑。'));

    // —— 归类 ——
    const genreOptions = [...new Set([
      ...DEFAULT_GENRES,
      ...((genreDir && genreDir.genres) || []),
      ...books.map((b) => b.genre).filter(Boolean),
    ])];
    const selects = [];
    const addOption = (name) => {
      const n = String(name || '').trim();
      if (!n || genreOptions.includes(n)) return false;
      genreOptions.push(n);
      for (const s of selects) s.append(h('option', { value: n }, n));
      return true;
    };

    const list = h('div', { class: 'set-list' });
    for (const b of books) {
      const sel = h('select', { class: 'set-select' });
      for (const g of genreOptions) {
        sel.append(h('option', { value: g, selected: g === b.genre }, g));
      }
      selects.push(sel);
      sel.addEventListener('change', async () => {
        const to = sel.value;
        try {
          await api.patch('/books/' + b.id, { genre_override: to });
          b.genre = to;
          status.textContent = `《${b.title}》→「${to}」，刷新后生效…`;
          setTimeout(() => location.reload(), 900);
        } catch (err) {
          status.textContent = '改不了：' + err.message;
          sel.value = b.genre;
        }
      });
      list.append(h('div', { class: 'set-row' },
        h('span', { class: 'set-title', title: b.title }, b.title),
        sel));
    }

    // —— 分类管理：新建 / 改名 / 删除 ——
    const newInput = h('input', {
      class: 'set-new-input', placeholder: '新分类名，如「诗集」「传记」', maxlength: '12',
    });
    const newBtn = h('button', { class: 'set-new-btn' }, '新建');
    const chips = h('div', { class: 'set-chips' });
    let catalog = [...genreOptions];

    const dropOption = (name) => {
      const i = genreOptions.indexOf(name);
      if (i !== -1) genreOptions.splice(i, 1);
      for (const s of selects) {
        const opt = [...s.options].find((o) => o.value === name);
        if (opt) opt.remove();
      }
    };

    const removeGenre = async (name) => {
      try {
        const r = await api.del('/genres?name=' + encodeURIComponent(name));
        dropOption(name);
        renderChips(r.genres || catalog.filter((g) => g !== name));
        status.textContent = `已删除「${name}」，原来属于它的书移到了「未分类」`;
        setTimeout(() => location.reload(), 1000);
      } catch (e) {
        status.textContent = '删不掉：' + e.message;
      }
    };

    const startRename = (chip, from) => {
      const input = h('input', { class: 'set-chip-input', value: from, maxlength: '12' });
      chip.replaceChildren(input);
      input.focus();
      input.select();
      let settled = false;
      const commit = async () => {
        if (settled) return;
        settled = true;
        const to = input.value.trim();
        if (!to || to === from) { renderChips(catalog); return; }
        try {
          const r = await api.patch('/genres', { from, to });
          dropOption(from);
          addOption(to);
          renderChips(r.genres || []);
          status.textContent = `「${from}」已改名为「${to}」`;
          setTimeout(() => location.reload(), 1000);
        } catch (e) {
          status.textContent = '改名失败：' + e.message;
          renderChips(catalog);
        }
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') { settled = true; renderChips(catalog); }
      });
      input.addEventListener('blur', commit);
    };

    function renderChips(list) {
      catalog = [...new Set(list || catalog)].filter(Boolean);
      chips.innerHTML = '';
      for (const name of catalog) {
        if (name === '未分类') continue;
        const label = h('span', { class: 'set-chip-name', title: '点击改名' }, name);
        const chip = h('span', { class: 'set-chip' },
          label,
          h('button', { class: 'set-chip-x', title: '删除这个分类', onclick: () => removeGenre(name) }, '×'));
        label.addEventListener('click', () => startRename(chip, name));
        chips.append(chip);
      }
    }

    const createGenre = async () => {
      const name = newInput.value.trim();
      if (!name) { newInput.focus(); return; }
      try {
        const r = await api.post('/genres', { name });
        for (const g of (r.genres || [])) addOption(g);
        newInput.value = '';
        renderChips(r.genres || catalog);
        status.textContent = r.existed
          ? `「${name}」已经存在`
          : `已新增「${name}」，每本书的下拉里都能选到`;
      } catch (err) {
        status.textContent = '新建失败：' + err.message;
      }
    };
    newBtn.addEventListener('click', createGenre);
    newInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') createGenre(); });

    renderChips((genreDir && genreDir.genres) || genreOptions);

    panel.append(
      h('div', { class: 'set-label' }, `归类 · ${books.length} 本`),
      list,
      h('div', { class: 'set-label set-label-sm' }, '分类管理 · 点名字改名，× 删除'),
      chips,
      h('div', { class: 'set-new' }, newInput, newBtn),
      status);
  }
  buildSettings(settingsPanel);

  // 星系索引内容
  const galaxyListEl = h('div', { class: 'glist' });
  galaxyPanel.append(
    h('div', { class: 'panel-head' }, '星 系', h('button', { class: 'panel-x', onclick: closePanels }, '✕')));
  for (const g of galaxies) {
    galaxyListEl.append(h('button', {
      class: 'grow',
      onclick: () => flyToGalaxy(g),
    },
      h('span', { class: 'grow-t' }, g.tag),
      h('span', { class: 'grow-c' }, `${g.books.length}`)));
  }
  if (recoEntries.length) {
    galaxyPanel.append(galaxyListEl, h('div', { class: 'gsub' }, '今日星群'));
    galaxyListEl.append(h('button', {
      class: 'grow reco-row',
      onclick: () => flyToGalaxy({ center: recoCenter, radius: 34 }),
    }, h('span', { class: 'grow-t' }, '今日推荐'), h('span', { class: 'grow-c' }, `${recoEntries.length}`)));
  } else {
    galaxyPanel.append(galaxyListEl);
  }
  galaxyPanel.append(legend.cloneNode(true));

  function toggleQuote() {
    const off = quoteBar.classList.toggle('gone');
    localStorage.setItem('space-quote', off ? 'off' : 'on');
    toast(off ? '顶部那句话已隐藏' : '顶部那句话已显示');
  }

  // ================= 主循环 =================
  const clock = new THREE.Clock();
  const fwd = new THREE.Vector3();
  let frames = 0, lastMap = 0;

  function animate() {
    if (disposed) return;
    raf = requestAnimationFrame(animate);
    const dt = Math.min(0.05, clock.getDelta());
    const t = clock.elapsedTime;

    if (flying) {
      flying.t += dt / flying.dur;
      const k = flying.t >= 1 ? 1 : easeInOutCubic(flying.t);
      camera.position.lerpVectors(flying.from, flying.to, k);
      const d = flying.look.clone().sub(camera.position).normalize();
      const ty = Math.atan2(-d.x, -d.z);
      const tp = Math.asin(THREE.MathUtils.clamp(d.y, -1, 1));
      yaw = lerpAngle(yaw, ty, Math.min(1, dt * 6.5));
      pitch += (tp - pitch) * Math.min(1, dt * 6.5);
      camera.rotation.set(pitch, yaw, 0, 'YXZ');
      if (flying.t >= 1) {
        const e = flying.entry;
        flying = null;
        if (e && e.data) showCard(e);
      }
    } else {
      camera.rotation.set(pitch, yaw, 0, 'YXZ');
      camera.getWorldDirection(fwd);
      const right = new THREE.Vector3().crossVectors(fwd, camera.up).normalize();
      const acc = new THREE.Vector3();
      if (keys.has('w') || keys.has('arrowup')) acc.add(fwd);
      if (keys.has('s') || keys.has('arrowdown')) acc.sub(fwd);
      if (keys.has('a') || keys.has('arrowleft')) acc.sub(right);
      if (keys.has('d') || keys.has('arrowright')) acc.add(right);
      if (keys.has('q')) acc.y -= 1;
      if (keys.has('e')) acc.y += 1;
      if (acc.lengthSq() > 0) {
        acc.normalize().multiplyScalar(CFG.accel * (keys.has('shift') ? 2.6 : 1));
        vel.addScaledVector(acc, dt);
      }
      vel.multiplyScalar(Math.pow(0.86, dt * 60));
      if (vel.length() > CFG.maxSpeed) vel.setLength(CFG.maxSpeed);
      camera.position.addScaledVector(vel, dt);

      // 滚轮的巡航速度直接作用在位置上，滑行长度由「惯性」滑杆决定
      camera.position.addScaledVector(fwd, speed * dt);
      speed *= Math.pow(feel.glide, dt * 60);
      if (Math.abs(speed) < 0.06) speed = 0;
    }

    camera.position.y += Math.sin(t * 0.5) * 0.0018;

    // 星野
    starfield.rotation.y = t * 0.0012;
    starfield.children.forEach((c, i) => {
      if (c.isPoints) c.material.opacity = c.userData.baseOpacity * (0.9 + 0.1 * Math.sin(t * (0.5 + i * 0.13) + i * 1.7));
    });
    nebula.rotation.y = t * 0.0035;

    // 星星
    const { best, bestD } = updateStars(t);

    // 星系标签投影
    updateLabels();

    if (!flying) {
      const target = bestD < CFG.reach ? best : null;
      if (target && target !== near) {
        near = target;
        if (cardFor !== target.id) showCard(target);
      } else if (!target && near) {
        near = null;
        hideCard();
      }
    }

    if (panelOpen === 'map') {
      const now = performance.now();
      if (now - lastMap > 100) { lastMap = now; drawMap(); }
    }

    renderer.render(scene, camera);
  }

  function updateStars(t) {
    let best = null, bestD = Infinity;
    for (const e of allHits) {
      if (!e.group.visible) { if (e.plane) e.plane.visible = false; continue; }
      const d = camera.position.distanceTo(e.pos);
      e.dist = d;
      const s = THREE.MathUtils.clamp(1.2 - d / 900, 0.2, 1.2);
      const pulse = e.reco ? 1 + Math.sin(t * 2.2 + e.phase) * 0.22 : 1 + Math.sin(t * 1.5 + e.phase) * 0.06;
      e.glow.scale.setScalar(e.baseScale * s * pulse);
      e.core.material.opacity = THREE.MathUtils.clamp(1.15 - d / 1500, 0.25, 1);

      const show = THREE.MathUtils.clamp((26 - d) / 15, 0, 1);
      if (show > 0.01) {
        if (!e.planeLoaded) { e.planeLoaded = true; loadCover(e); }
        e.plane.visible = true;
        e.plane.material.opacity = show * 0.96;
        e.plane.scale.setScalar(THREE.MathUtils.lerp(0.62, 1, show));
        e.plane.lookAt(camera.position);
        e.glow.material.opacity = 0.95 * Math.max(0, 1 - show * 1.35);
        e.core.visible = show < 0.3;
      } else {
        e.plane.visible = false;
        e.glow.material.opacity = 0.95;
        e.core.visible = true;
      }

      if (d < bestD) { bestD = d; best = e; }
    }
    return { best, bestD };
  }

  const projected = new THREE.Vector3();
  function updateLabels() {
    for (const L of labelsList) {
      const gc = L.g.currentCenter || L.g.center;
      const d = camera.position.distanceTo(gc);
      if (d > 2200) { L.el.style.opacity = '0'; continue; }
      projected.copy(gc).project(camera);
      const behind = projected.z > 1;
      if (behind) { L.el.style.opacity = '0'; continue; }
      const x = (projected.x * 0.5 + 0.5) * window.innerWidth;
      const y = (-projected.y * 0.5 + 0.5) * window.innerHeight;
      L.el.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px)`;
      const near = THREE.MathUtils.clamp(1.4 - d / (L.g.radius * 8 + 600), 0.15, 0.85);
      L.el.style.opacity = String(near);
    }
  }

  function drawMap() {
    const ctx = mapCanvas.getContext('2d');
    const W = mapCanvas.width, H = mapCanvas.height;
    ctx.clearRect(0, 0, W, H);
    const camDir = new THREE.Vector3();
    camera.getWorldDirection(camDir);
    const camYaw = Math.atan2(camDir.x, camDir.z);
    const maxR = span * 0.75 + 200;
    const R = Math.min(W, H) / 2 - 12;
    const scale = R / maxR;
    ctx.save();
    ctx.translate(W / 2, H / 2);
    for (const g of galaxies) {
      const gc = g.currentCenter || g.center;
      const dx = gc.x - camera.position.x;
      const dz = gc.z - camera.position.z;
      const rot = -camYaw;
      const x = (dx * Math.cos(rot) - dz * Math.sin(rot)) * scale;
      const z = (dx * Math.sin(rot) + dz * Math.cos(rot)) * scale;
      ctx.beginPath();
      ctx.arc(x, z, Math.max(2.5, g.radius * scale), 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(150,170,255,.12)';
      ctx.fill();
    }
    for (const e of allHits) {
      const dx = e.pos.x - camera.position.x;
      const dz = e.pos.z - camera.position.z;
      const rot = -camYaw;
      const x = (dx * Math.cos(rot) - dz * Math.sin(rot)) * scale;
      const z = (dx * Math.sin(rot) + dz * Math.cos(rot)) * scale;
      if (Math.hypot(x, z) > R) continue;
      ctx.beginPath();
      ctx.arc(x, z, 1.9, 0, Math.PI * 2);
      ctx.fillStyle = '#' + e.colorHex.toString(16).padStart(6, '0');
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(0, 0, 3.2, 0, Math.PI * 2);
    ctx.fillStyle = '#f5d8a0';
    ctx.fill();
    ctx.restore();
  }

  function loadCover(e) {
    const b = e.data;
    if (!b.cover_path) {
      e.plane.material.map = makeTypoCoverTexture(b);
      e.plane.material.needsUpdate = true;
      return;
    }
    new THREE.TextureLoader().load(`/media/${b.cover_path}`, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      e.plane.material.map = tex;
      e.plane.material.needsUpdate = true;
    }, undefined, () => {
      e.plane.material.map = makeTypoCoverTexture(b);
      e.plane.material.needsUpdate = true;
    });
  }

  function paintStar(entry, isReco) {
    const hex = isReco ? C.reco : (C[entry.data.status] || C.unread);
    entry.colorHex = hex;
    entry.glow.material.color.setHex(hex);
    entry.core.material.color.setHex(hex);
  }

  // ================= 统计面板 =================
  function buildStats(panel, s, noteList, bookList) {
    panel.innerHTML = '';
    const collapsed = h('button', { class: 'stat-collapsed', onclick: () => togglePanel('stats') },
      h('span', { class: 'sc-main' }, s ? `${s.total} 本 · 已读 ${s.byStatus?.finished || 0}` : '星轨'),
      h('span', { class: 'sc-sub' }, s ? `连续 ${s.streak} 天` : ''));
    panel.append(collapsed);

    const body = h('div', { class: 'stat-body' },
      h('div', { class: 'panel-head' }, '星 轨', h('button', { class: 'panel-x', onclick: closePanels }, '✕')));

    if (s) {
      const rows = [
        ['藏书', s.total], ['已读完', s.byStatus?.finished || 0], ['在读', s.byStatus?.reading || 0],
        ['笔记', s.notes], ['连续', s.streak + ' 天'],
        ['时长', s.minutes >= 60 ? (s.minutes / 60).toFixed(1) + 'h' : s.minutes + 'm'],
      ];
      const grid = h('div', { class: 'stat-grid2' });
      for (const [k, v] of rows) {
        grid.append(h('div', { class: 'sg' }, h('b', {}, String(v)), h('span', {}, k)));
      }
      body.append(grid);

      // 最近读完
      if (s.recentFinished?.length) {
        body.append(h('div', { class: 'stat-label' }, '最近读完'));
        for (const b of s.recentFinished.slice(0, 4)) {
          body.append(h('div', { class: 'stat-row' },
            h('span', { class: 'sr-t' }, b.title), h('span', { class: 'sr-d' }, fmtDate(b.finished_at))));
        }
      }
    }

    // 最近笔记
    if (noteList?.length) {
      body.append(h('div', { class: 'stat-label' }, '最近笔记'));
      for (const n of noteList.slice(0, 3)) {
        body.append(h('div', { class: 'stat-note' },
          h('div', { class: 'sn-t' }, (n.excerpt || n.body || '').slice(0, 42)),
          h('div', { class: 'sn-b' }, `《${n.book_title}》`)));
      }
    }

    panel.append(body);
    panel.addEventListener('click', (e) => {
      if (e.target.closest('.stat-collapsed')) { closePanels(); statPanel.classList.add('open'); }
    });
  }

  async function refreshStats() {
    try {
      const [s, n] = await Promise.all([api.get('/stats'), api.get('/notes')]);
      buildStats(statPanel, s, n, books);
    } catch { /* ignore */ }
  }

  // ================= 巡游（录制用） =================
  const qp = new URLSearchParams(location.hash.split('?')[1] || '');
  const tourMode = qp.has('tour');

  function buildTourPath() {
    const picks = entries.slice().sort((a, b) => b.weight - a.weight).slice(0, 3);
    const pts = [], looks = [];
    const push = (p, l) => { pts.push(p); looks.push(l); };
    push(camera.position.clone(), center.clone());
    for (const e of picks) {
      const dir = e.pos.clone().sub(bounds.getCenter(new THREE.Vector3())).normalize();
      push(e.pos.clone().add(dir.clone().multiplyScalar(26)), e.pos.clone());
      push(e.pos.clone().add(dir.clone().multiplyScalar(9.2)), e.pos.clone());
    }
    const last = picks[picks.length - 1];
    const out = last ? last.pos.clone().sub(center).normalize() : new THREE.Vector3(0, 0, 1);
    const from = pts[pts.length - 1];
    push(from.clone().addScaledVector(out, 190), center.clone());

    const posCurve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.32);
    const lookCurve = new THREE.CatmullRomCurve3(looks, false, 'catmullrom', 0.18);
    const total = 19;
    return {
      total,
      sample(t) {
        const raw = THREE.MathUtils.clamp(t / total, 0, 1);
        const u = Math.pow(raw, 1.32);
        return { pos: posCurve.getPointAt(u), look: lookCurve.getPointAt(u), fov: 62 + 13 * Math.pow(raw, 1.8) };
      },
    };
  }

  if (tourMode) {
    root.classList.add('cinema');
    loading.remove();
    const path = buildTourPath();
    window.__seek = (sec) => {
      const st = path.sample(sec);
      camera.position.copy(st.pos);
      camera.lookAt(st.look);
      if (Math.abs(camera.fov - st.fov) > 0.001) { camera.fov = st.fov; camera.updateProjectionMatrix(); }
      starfield.rotation.y = sec * 0.0012;
      nebula.rotation.y = sec * 0.0035;
      updateStars(sec);
      renderer.render(scene, camera);
    };
    window.__duration = path.total;
    window.__seek(0);
    window.__ready = true;
    return { cleanup, refresh: () => {}, setExit };
  }

  animate();
  setTimeout(() => loading.classList.add('gone'), 260);
  setTimeout(() => { hint.classList.add('fade'); }, 9000);
  statPanel.classList.add('show-collapsed');

  // 便于直达： #/?panel=galaxies 或 #/?near=<书 id>
  try {
    const p = new URLSearchParams(location.hash.split('?')[1] || '');
    if (p.get('panel')) togglePanel(p.get('panel'));
    const nearId = Number(p.get('near'));
    if (nearId) {
      const entry = allHits.find((x) => !x.reco && x.data.id === nearId);
      if (entry) {
        const dir = new THREE.Vector3(0.42, 0.18, 0.89).normalize();
        camera.position.copy(entry.pos).add(dir.multiplyScalar(CFG.startDist));
        const look = entry.pos.clone().add(new THREE.Vector3(0, 1.35, 0));
        const d = look.clone().sub(camera.position).normalize();
        yaw = Math.atan2(-d.x, -d.z);
        pitch = Math.asin(THREE.MathUtils.clamp(d.y, -1, 1));
        camera.rotation.set(pitch, yaw, 0, 'YXZ');
        near = entry;
        showCard(entry);
      }
    }
  } catch { /* ignore */ }

  // ================= 清理 =================
  function cleanup() {
    disposed = true;
    cancelAnimationFrame(raf);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('resize', onResize);
    disposeTree(galaxyLayer);
    for (const e of allHits) {
      e.glow.material.dispose();
      e.core.geometry?.dispose();
      e.core.material?.dispose();
      e.plane.material.map?.dispose();
      e.plane.material.dispose();
      e.plane.geometry.dispose();
    }
    glowTex.dispose();
    disposeTree(nebula);
    disposeTree(starfield);
    renderer.dispose();
    root?.remove();
    root = null;
  }

  setExit(() => dispatchEvent(new CustomEvent('space:exit')));

  return {
    cleanup,
    refresh: () => refreshStats(),
    setExit,
    flyToBook: (id) => {
      const e = entries.find((x) => x.data.id === Number(id));
      if (e) flyToStar(e);
    },
  };
}

export function closeSpace() {
  disposed = true;
  cancelAnimationFrame(raf);
  document.getElementById('space-root')?.remove();
  root = null;
}

// ================= 场景构建 =================

function countGalaxies(books) {
  const s = new Set();
  for (const b of books) s.add(b.genre || '未分类');
  return s.size;
}

function buildGalaxies(books) {
  const map = new Map();
  for (const b of books) {
    const tag = (b.genre || '').trim() || '未分类';
    if (!map.has(tag)) map.set(tag, []);
    map.get(tag).push(b);
  }
  // 大星系在前，位置沿一条螺旋分布
  const list = [...map.entries()]
    .map(([tag, bs]) => ({ tag, books: bs }))
    .sort((a, b) => b.books.length - a.books.length);

  const n = list.length;
  list.forEach((g, i) => {
    const angle = i * 2.399963 + 0.6;                    // 黄金角，避免排成一条线
    const ring = 210 + (i % 3) * 95;
    g.center = new THREE.Vector3(
      Math.cos(angle) * ring,
      ((i % 4) - 1.5) * 70,
      Math.sin(angle) * ring
    );
    g.radius = 14 + Math.sqrt(g.books.length) * 10;
    g.color = new THREE.Color().setHSL((hash01(g.tag) * 0.14 + 0.56) % 1, 0.5, 0.6);
    g.index = i;
    g.total = n;
  });
  return list;
}

function makeStar(book, galaxy, index, glowTex) {
  const status = book.status || 'unread';
  const hex = C[status] ?? C.unread;
  const col = new THREE.Color(hex);

  // 星系内的位置：扁平螺旋，看起来像一个星系
  const n = galaxy.books.length;
  const r = galaxy.radius * Math.sqrt((index + 0.6) / n) * (0.55 + hash01(book.id + 'r') * 0.7);
  const th = index * 2.399963 + hash01(book.id + 't') * 0.7;
  const y = (hash01(book.id + 'y') - 0.5) * galaxy.radius * 0.42;
  const pos = galaxy.center.clone().add(new THREE.Vector3(Math.cos(th) * r, y, Math.sin(th) * r));

  const weight = 1
    + (book.word_count ? Math.min(0.9, book.word_count / 400000) : 0)
    + (book.favorite ? 0.45 : 0)
    + (book.rating ? book.rating * 0.07 : 0)
    + Math.min(0.35, (book.note_count || 0) * 0.05);

  const group = new THREE.Group();
  group.position.copy(pos);

  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, color: col, transparent: true, opacity: 0.95,
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, fog: false,
  }));
  const baseScale = (1.3 + weight * 0.9) * 8.5;
  glow.scale.setScalar(baseScale);
  glow.renderOrder = 1;
  group.add(glow);

  const core = new THREE.Mesh(
    new THREE.SphereGeometry(0.2 * weight, 8, 8),
    new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 1, fog: false })
  );
  group.add(core);

  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(2.4, 3.6),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, fog: false })
  );
  plane.visible = false;
  group.add(plane);

  const hit = new THREE.Mesh(
    new THREE.SphereGeometry(2.2 + weight * 0.5, 8, 8),
    new THREE.MeshBasicMaterial({ visible: false })
  );
  group.add(hit);

  return {
    id: 'b' + book.id, data: book, reco: false, group, glow, core, plane, hit,
    pos, baseScale, colorHex: hex, weight,
    galaxy, local: pos.clone().sub(galaxy.center),
    phase: hash01(book.id + 'p') * Math.PI * 2, planeLoaded: false,
  };
}

function makeRecoStar(reco, group_, index, total, glowTex) {
  const col = new THREE.Color(C.reco);
  const n = Math.max(1, total);
  const r = 18 + Math.sqrt(index + 1) * 11;
  const th = index * 2.399963;
  const center = group_.center;
  const pos = center.clone().add(new THREE.Vector3(Math.cos(th) * r, (hash01(reco.id + 'y') - 0.5) * 22, Math.sin(th) * r));

  const group = new THREE.Group();
  group.position.copy(pos);

  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, color: col, transparent: true, opacity: 0.85,
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, fog: false,
  }));
  const baseScale = 7.5;
  glow.scale.setScalar(baseScale);
  glow.renderOrder = 1;
  group.add(glow);

  const core = new THREE.Mesh(
    new THREE.SphereGeometry(0.22, 8, 8),
    new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 1, fog: false })
  );
  group.add(core);

  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(2.4, 3.6),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, fog: false })
  );
  plane.visible = false;
  group.add(plane);

  const hit = new THREE.Mesh(
    new THREE.SphereGeometry(2.6, 8, 8),
    new THREE.MeshBasicMaterial({ visible: false })
  );
  group.add(hit);

  return {
    id: 'r' + reco.id,
    data: { ...reco, genre: '豆瓣' },
    reco: true, group, glow, core, plane, hit, pos, baseScale,
    colorHex: C.reco, weight: 1,
    galaxy: group_, local: pos.clone().sub(group_.center),
    phase: hash01(reco.id + 'p') * Math.PI * 2, planeLoaded: false,
  };
}

function buildNebula(tex) {
  const group = new THREE.Group();
  const texture = tex || makeNebulaTexture();
  const palettes = [
    [0x3b2d6b, 0.1], [0x1f3a52, 0.09], [0x33284f, 0.08],
    [0x203c42, 0.08], [0x2e2a55, 0.07], [0x241f38, 0.06],
  ];
  for (let i = 0; i < 9; i++) {
    const [color, opacity] = palettes[i % palettes.length];
    const mat = new THREE.SpriteMaterial({
      map: texture, color, transparent: true, opacity,
      depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, fog: false,
    });
    const sprite = new THREE.Sprite(mat);
    const r = 1200 + Math.random() * 900;
    const th = Math.random() * Math.PI * 2;
    const ph = Math.acos(2 * Math.random() - 1);
    sprite.position.set(r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph) * 0.7, r * Math.sin(ph) * Math.sin(th));
    const s = 1100 + Math.random() * 1300;
    sprite.scale.set(s, s * (0.6 + Math.random() * 0.6), 1);
    sprite.renderOrder = -10;
    group.add(sprite);
  }
  return group;
}

/** 银河：沿一条大圆铺开的极淡光带，让天空有一条"河" */
function buildMilkyWay(nebTex) {
  const group = new THREE.Group();
  const n = new THREE.Vector3(0.36, 0.86, -0.36).normalize();
  const a = new THREE.Vector3().crossVectors(n, new THREE.Vector3(0, 1, 0)).normalize();
  const b = new THREE.Vector3().crossVectors(n, a).normalize();
  const colors = [0x9aa8d8, 0xc8c0e0, 0x8fa3c8, 0xd8cbb0, 0xa9b6dd];

  for (let i = 0; i < 40; i++) {
    const t = (i / 40) * Math.PI * 2 + (Math.random() - 0.5) * 0.06;
    const dir = a.clone().multiplyScalar(Math.cos(t))
      .add(b.clone().multiplyScalar(Math.sin(t)))
      .addScaledVector(n, (Math.random() - 0.5) * 0.055)
      .normalize();
    const r = 1100 + Math.random() * 320;
    const mat = new THREE.SpriteMaterial({
      map: nebTex,
      color: colors[i % colors.length],
      transparent: true,
      opacity: 0.045 + Math.random() * 0.05,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    const s = new THREE.Sprite(mat);
    s.position.copy(dir).multiplyScalar(r);
    const size = 620 + Math.random() * 520;
    s.scale.set(size, size * 0.45, 1);
    s.renderOrder = -9;
    group.add(s);
  }
  return group;
}

function buildStarfield(glowTex) {
  const group = new THREE.Group();

  function points({ count, size, opacity, rMin, rMax, band = 0 }) {
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const c = new THREE.Color();
    const n = new THREE.Vector3(0.36, 0.86, -0.36).normalize();
    const a = new THREE.Vector3().crossVectors(n, new THREE.Vector3(0, 1, 0)).normalize();
    const b = new THREE.Vector3().crossVectors(n, a).normalize();

    for (let i = 0; i < count; i++) {
      let x, y, z;
      if (band > 0 && Math.random() < band) {
        const th = Math.random() * Math.PI * 2;
        const dir = a.clone().multiplyScalar(Math.cos(th)).add(b.clone().multiplyScalar(Math.sin(th)));
        dir.addScaledVector(n, (Math.random() + Math.random() + Math.random() - 1.5) * 0.16).normalize();
        const r = rMin + Math.random() * (rMax - rMin);
        x = dir.x * r; y = dir.y * r; z = dir.z * r;
      } else {
        const r = rMin + Math.pow(Math.random(), 0.7) * (rMax - rMin);
        const th = Math.random() * Math.PI * 2;
        const ph = Math.acos(2 * Math.random() - 1);
        x = r * Math.sin(ph) * Math.cos(th);
        y = r * Math.cos(ph);
        z = r * Math.sin(ph) * Math.sin(th);
      }
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
      const t = Math.random();
      if (t < 0.62) c.setRGB(1, 1, 1);
      else if (t < 0.8) c.setRGB(0.78, 0.86, 1.0);
      else if (t < 0.94) c.setRGB(1.0, 0.93, 0.78);
      else c.setRGB(1.0, 0.8, 0.62);
      const br = 0.55 + Math.random() * 0.45;
      col[i * 3] = c.r * br; col[i * 3 + 1] = c.g * br; col[i * 3 + 2] = c.b * br;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const mat = new THREE.PointsMaterial({
      size, sizeAttenuation: false, vertexColors: true, transparent: true, opacity,
      depthWrite: false, depthTest: false, fog: false,
      blending: THREE.AdditiveBlending, map: makeDotTexture(),
    });
    const p = new THREE.Points(geo, mat);
    p.renderOrder = -8;
    p.userData.baseOpacity = opacity;
    return p;
  }

  group.add(points({ count: 7000, size: 1.9, opacity: 0.72, rMin: 700, rMax: 2300 }));
  group.add(points({ count: 1600, size: 2.8, opacity: 0.92, rMin: 520, rMax: 1900 }));
  group.add(points({ count: 5200, size: 1.6, opacity: 0.58, rMin: 800, rMax: 2400, band: 0.85 }));
  group.add(points({ count: 240, size: 4.0, opacity: 0.96, rMin: 300, rMax: 900 }));

  const heroColors = [0xffffff, 0xcfe0ff, 0xfff0cf, 0xffd9b0];
  for (let i = 0; i < 18; i++) {
    const mat = new THREE.SpriteMaterial({
      map: glowTex, color: heroColors[i % heroColors.length], transparent: true,
      opacity: 0.5 + Math.random() * 0.4, depthWrite: false, depthTest: false,
      blending: THREE.AdditiveBlending, fog: false,
    });
    const s = new THREE.Sprite(mat);
    const r = 500 + Math.random() * 1500;
    const th = Math.random() * Math.PI * 2;
    const ph = Math.acos(2 * Math.random() - 1);
    s.position.set(r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph), r * Math.sin(ph) * Math.sin(th));
    const sc = 26 + Math.random() * 54;
    s.scale.set(sc, sc, 1);
    s.renderOrder = -7;
    group.add(s);
  }
  return group;
}

// ================= 素材 =================
function makeGlowTexture() {
  const S = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.12, 'rgba(255,250,235,0.95)');
  g.addColorStop(0.32, 'rgba(255,236,200,0.42)');
  g.addColorStop(0.62, 'rgba(190,180,255,0.10)');
  g.addColorStop(1, 'rgba(120,120,200,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  ctx.globalCompositeOperation = 'lighter';
  const streak = ctx.createLinearGradient(0, S / 2, S, S / 2);
  streak.addColorStop(0, 'rgba(255,255,255,0)');
  streak.addColorStop(0.5, 'rgba(255,255,255,0.45)');
  streak.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = streak;
  ctx.fillRect(0, S / 2 - 1, S, 2);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeNebulaTexture() {
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  for (let i = 0; i < 14; i++) {
    const x = S / 2 + (Math.random() - 0.5) * S * 0.55;
    const y = S / 2 + (Math.random() - 0.5) * S * 0.55;
    const r = S * (0.12 + Math.random() * 0.26);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(255,255,255,${0.05 + Math.random() * 0.09})`);
    g.addColorStop(0.55, 'rgba(255,255,255,0.03)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const mask = ctx.createRadialGradient(S / 2, S / 2, S * 0.18, S / 2, S / 2, S / 2);
  mask.addColorStop(0, 'rgba(255,255,255,1)');
  mask.addColorStop(0.7, 'rgba(255,255,255,0.45)');
  mask.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillStyle = mask;
  ctx.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

let dotTex = null;
function makeDotTexture() {
  if (dotTex) return dotTex;
  const S = 32;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  dotTex = new THREE.CanvasTexture(cv);
  return dotTex;
}

function makeTypoCoverTexture(book) {
  const W = 512, H = 768;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#1b1d2a';
  ctx.fillRect(0, 0, W, H);
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, 'rgba(255,255,255,0.10)');
  g.addColorStop(1, 'rgba(0,0,0,0.25)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#e8dcc4';
  ctx.globalAlpha = 0.3;
  ctx.lineWidth = 2;
  ctx.strokeRect(34, 40, W - 68, H - 80);
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#efe3c9';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const title = String(book.title || '').slice(0, 9);
  const perCol = 6;
  const fs = title.length > 6 ? 62 : 76;
  ctx.font = `${fs}px "Songti SC","SimSun",serif`;
  const cols = Math.ceil(title.length / perCol);
  const colGap = fs * 1.24;
  const startX = W / 2 + ((cols - 1) * colGap) / 2;
  for (let i = 0; i < title.length; i++) {
    ctx.fillText(title[i], startX - Math.floor(i / perCol) * colGap, H * 0.28 + (i % perCol) * fs * 1.18);
  }
  ctx.font = '24px "Microsoft YaHei",sans-serif';
  ctx.globalAlpha = 0.6;
  ctx.fillText(String(book.author || '').slice(0, 12), W / 2, H - 70);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// ================= 工具 =================
function hasWebGL() {
  try {
    const c = document.createElement('canvas');
    return Boolean(window.WebGL2RenderingContext && c.getContext('webgl2'))
      || Boolean(c.getContext('webgl') || c.getContext('experimental-webgl'));
  } catch { return false; }
}

function disposeTree(obj) {
  obj.traverse?.((o) => {
    o.geometry?.dispose?.();
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of mats) { m.map?.dispose?.(); m.dispose?.(); }
  });
}

function hash01(seed) {
  let h = 2166136261;
  const s = String(seed);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

function easeInOutCubic(x) {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

function lerpAngle(a, b, t) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
