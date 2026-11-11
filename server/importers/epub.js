// EPUB 2/3：adm-zip 读包，fast-xml-parser 读 container/OPF/NCX/nav。
import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';
import { sanitizeFragment, textOf } from './html.js';
import {
  asArray, nodeText, attrOf, cleanMeta, joinPosix, posixDirname, safeDecodeUri,
  decodeHtmlBytes, mergeTinyChapters, splitHtmlByHeadings, sniffImageExt,
} from './util.js';

const MAX_ASSET = 25 * 1024 * 1024; // 单个资源上限 25MB
const MAX_COVER = 25 * 1024 * 1024;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,     // dc:title → title，epub:type → type
  parseTagValue: false,     // ISBN / 日期保持字符串
  parseAttributeValue: false,
  allowBooleanAttributes: true,
  trimValues: true,
});

// XML 只认几个内置实体；电子书里常混入 &nbsp; 之类，先转义再解析。
function xmlSafe(s) {
  return String(s)
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, n) =>
      (n === 'amp' || n === 'lt' || n === 'gt' || n === 'quot' || n === 'apos') ? m : `&#38;${n};`)
    .replace(/&(?!#\d+;|#x[0-9a-fA-F]+;|amp;|lt;|gt;|quot;|apos;)/g, '&amp;');
}

function parseXml(text) {
  return xmlParser.parse(xmlSafe(text));
}

function normZipPath(name) {
  return String(name || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/** zip 内文件索引：精确 / 小写 / basename 三级查找。 */
class ZipIndex {
  constructor(zip) {
    this.exact = new Map();
    this.lower = new Map();
    this.byBase = new Map();
    for (const e of zip.getEntries()) {
      if (e.isDirectory) continue;
      const n = normZipPath(e.entryName);
      if (!n || n.includes('/../') || n.startsWith('..')) continue; // 防路径穿越
      this.exact.set(n, e);
      if (!this.lower.has(n.toLowerCase())) this.lower.set(n.toLowerCase(), e);
      const base = n.slice(n.lastIndexOf('/') + 1).toLowerCase();
      if (!this.byBase.has(base)) this.byBase.set(base, []);
      this.byBase.get(base).push(n);
    }
  }

  get(p) {
    if (!p) return null;
    const dec = safeDecodeUri(p);
    for (const cand of [p, dec]) {
      const hit = this.exact.get(cand) || this.lower.get(cand.toLowerCase());
      if (hit) return hit;
    }
    return null;
  }

  loose(p) {
    const dec = safeDecodeUri(p);
    const base = dec.slice(dec.lastIndexOf('/') + 1).toLowerCase();
    const list = this.byBase.get(base);
    if (list && list.length === 1) return this.exact.get(list[0]) || null;
    return null;
  }
}

/** 把 href 解析成 zip 内路径；fragment 单独返回。 */
function resolveHref(baseDir, href, index) {
  const raw = String(href || '').trim();
  const hashAt = raw.indexOf('#');
  const frag = hashAt >= 0 ? raw.slice(hashAt + 1) : '';
  const noFrag = (hashAt >= 0 ? raw.slice(0, hashAt) : raw).split('?')[0];
  if (!noFrag) return { entry: null, path: '', frag };
  const base = noFrag.startsWith('/') ? '' : baseDir;
  for (const cand of [safeDecodeUri(noFrag), noFrag]) {
    const p = joinPosix(base, cand);
    if (!p) continue;
    const e = index.get(p);
    if (e) return { entry: e, path: p, frag };
  }
  const e2 = index.loose(noFrag);
  if (e2) return { entry: e2, path: normZipPath(e2.entryName), frag };
  return { entry: null, path: '', frag };
}

function entryData(entry, limit = MAX_ASSET) {
  const size = Number(entry.header && entry.header.size) || 0;
  if (size > limit) return null;
  try {
    const data = entry.getData();
    return data && data.length ? data : null;
  } catch {
    return null;
  }
}

/** 简单的 SVG 图片包装 → <img>，否则 sanitizeFragment 会整体丢掉 <svg>。 */
function expandSvgImages(html) {
  if (!/<svg/i.test(html)) return html;
  return html.replace(/<svg\b[^>]*>([\s\S]*?)<\/svg>/gi, (whole, inner) => {
    if (!/<image\b/i.test(inner) || /<text\b/i.test(inner)) return whole;
    const imgs = [];
    const re = /<image\b[^>]*?(?:xlink:href|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
    let m;
    while ((m = re.exec(inner))) imgs.push(`<img src="${m[1] ?? m[2]}"/>`);
    return imgs.length ? imgs.join('') : whole;
  });
}

function bodyOf(html) {
  const m = html.match(/<body\b[^>]*>([\s\S]*)<\/body\s*>/i);
  return m ? m[1] : html;
}

function firstHeading(html) {
  const m = html.match(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1\s*>/i);
  return m ? textOf(m[2]).replace(/\s+/g, ' ').trim().slice(0, 80) : '';
}

function findById(root, name) {
  if (root && root[name] != null) return root[name];
  const hit = Object.entries(root || {}).find(([k]) => k.endsWith(name));
  return hit ? hit[1] : null;
}

// --- 元数据 -----------------------------------------------------------------

function pickIsbn(md) {
  const ids = asArray(md.identifier);
  let fallback = '';
  for (const id of ids) {
    const raw = `${attrOf(id, 'scheme')} ${nodeText(id)}`;
    const digits = nodeText(id).replace(/[^\dxX]/g, '');
    if (/isbn/i.test(raw) && (digits.length === 10 || digits.length === 13)) return digits;
    if ((digits.length === 13 && /^97[89]/.test(digits)) || digits.length === 10) {
      if (!fallback) fallback = digits;
    }
  }
  return fallback;
}

function pickDate(md) {
  const raw = cleanMeta(nodeText(asArray(md.date)[0]), 32);
  const m = raw.match(/(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/);
  if (!m) return raw;
  return m[2] ? (m[3] ? `${m[1]}-${m[2]}-${m[3]}` : `${m[1]}-${m[2]}`) : m[1];
}

function readMeta(md) {
  const creators = asArray(md.creator).map((c) => cleanMeta(nodeText(c), 80)).filter(Boolean);
  const subjects = asArray(md.subject).map((s) => cleanMeta(nodeText(s), 40)).filter(Boolean);
  const title = cleanMeta(nodeText(asArray(md.title)[0]), 200);
  const subtitle = /[:：]\s*/.test(title) ? '' : cleanMeta(nodeText(asArray(md.title)[1]), 200);
  return {
    title,
    author: creators.join(', '),
    publisher: cleanMeta(nodeText(asArray(md.publisher)[0]), 100),
    pubDate: pickDate(md),
    isbn: pickIsbn(md),
    pages: '',
    price: '',
    binding: '',
    translator: '',
    subtitle,
    summary: cleanMeta(nodeText(asArray(md.description)[0]), 600),
    language: cleanMeta(nodeText(asArray(md.language)[0]), 20),
    subject: subjects.join(', '),
  };
}

// --- 目录 -------------------------------------------------------------------

function walkNavList(node, out) {
  for (const li of asArray(node.li)) {
    if (!li || typeof li !== 'object') continue;
    const a = asArray(li.a)[0];
    if (a) {
      const href = attrOf(a, 'href');
      const title = nodeText(a).replace(/\s+/g, ' ').trim();
      if (href && title) out.push({ href, title: title.slice(0, 80) });
    }
    const sub = asArray(li.ol)[0];
    if (sub) walkNavList(sub, out);
  }
}

function parseNav(navXml, navPath) {
  const root = parseXml(navXml);
  const html = findById(root, 'html') || root;
  const body = findById(html, 'body') || html;
  const navs = asArray(findById(body, 'nav')).filter((n) => n && typeof n === 'object');
  const toc = navs.find((n) => /\btoc\b/i.test(attrOf(n, 'type'))) || navs[0];
  if (!toc) return [];
  const ol = findById(toc, 'ol');
  const out = [];
  if (ol) walkNavList(ol, out);
  // nav 里没有 ol 时退化为所有 <a>
  if (!out.length) {
    const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(navXml))) {
      const title = textOf(m[2]).replace(/\s+/g, ' ').trim();
      if (title) out.push({ href: m[1], title: title.slice(0, 80) });
    }
  }
  return out.map((e) => {
    const href = String(e.href).split('#')[0];
    const p = joinPosix(posixDirname(navPath), e.href) || '';
    return { path: p || String(href), frag: (String(e.href).split('#')[1] || ''), title: e.title };
  }).filter((e) => e.path);
}

function walkNavPoints(node, out) {
  for (const np of asArray(node.navPoint)) {
    if (!np || typeof np !== 'object') continue;
    const label = asArray(np.navLabel)[0];
    const title = cleanMeta(nodeText(label && findById(label, 'text')), 80);
    const src = attrOf(asArray(np.content)[0], 'src');
    if (src && title) out.push({ href: src, title });
    if (np.navPoint) walkNavPoints(np, out);
  }
}

function parseNcx(ncxXml, ncxPath) {
  const root = parseXml(ncxXml);
  const navMap = findById(findById(root, 'ncx') || root, 'navMap');
  const out = [];
  if (navMap) walkNavPoints(navMap, out);
  return out.map((e) => {
    const [p, frag] = String(e.href).split('#');
    return { path: joinPosix(posixDirname(ncxPath), p) || p, frag: frag || '', title: e.title };
  }).filter((e) => e.path);
}

// --- 主流程 -----------------------------------------------------------------

export async function parse(filePath, opts = {}) {
  const warnings = [];
  let zip;
  try {
    zip = new AdmZip(filePath);
  } catch (e) {
    throw new Error(`EPUB 文件无法读取：${e.message}`);
  }

  const index = new ZipIndex(zip);
  const containerEntry = index.get('META-INF/container.xml');
  if (!containerEntry) throw new Error('不是有效的 EPUB：缺少 META-INF/container.xml');
  const container = parseXml(entryData(containerEntry, 1024 * 1024)?.toString('utf8') || '');
  const rootfile = asArray(findById(findById(container, 'container') || container, 'rootfiles')?.rootfile)[0];
  let opfPath = joinPosix('', attrOf(rootfile, 'full-path') || '');
  let opfEntry = opfPath ? index.get(opfPath) : null;
  if (!opfEntry) {
    // container.xml 损坏时，退化为扫描 zip 里唯一的 .opf
    const opfs = [...index.exact.keys()].filter((n) => /\.opf$/i.test(n));
    if (opfs.length >= 1) {
      opfPath = opfs[0];
      opfEntry = index.get(opfPath);
    }
  }
  if (!opfEntry) throw new Error('不是有效的 EPUB：找不到 OPF 文件');

  const opfData = entryData(opfEntry, 8 * 1024 * 1024);
  const opf = parseXml(opfData ? decodeHtmlBytes(opfData) : '');
  const pkg = findById(opf, 'package') || opf;
  const md = findById(pkg, 'metadata') || {};
  const opfDir = posixDirname(opfPath);

  const meta = readMeta(md);
  if (!meta.title) meta.title = opts.originalName ? String(opts.originalName).replace(/\.[a-z0-9]+$/i, '') : '';

  // 清单
  const items = asArray(findById(pkg, 'manifest')?.item).filter((i) => i && typeof i === 'object');
  const byId = new Map();
  for (const it of items) {
    byId.set(attrOf(it, 'id'), {
      id: attrOf(it, 'id'),
      href: attrOf(it, 'href'),
      mediaType: attrOf(it, 'media-type').toLowerCase(),
      properties: attrOf(it, 'properties'),
    });
  }

  // 目录：EPUB3 nav 优先，否则 toc.ncx
  let toc = [];
  const navItem = items.find((it) => /\bnav\b/.test(attrOf(it, 'properties')));
  if (navItem) {
    const navPath = joinPosix(opfDir, attrOf(navItem, 'href'));
    const navEntry = navPath ? index.get(navPath) : null;
    if (navEntry) {
      try {
        toc = parseNav(decodeHtmlBytes(entryData(navEntry, 8 * 1024 * 1024) || Buffer.alloc(0)), navPath);
      } catch (e) {
        warnings.push(`EPUB3 导航解析失败：${e.message}`);
      }
    }
  }
  if (!toc.length) {
    const ncxItem = items.find((it) => it.mediaType === 'application/x-dtbncx+xml')
      || byId.get(attrOf(findById(pkg, 'spine') || {}, 'toc'));
    if (ncxItem) {
      const ncxPath = joinPosix(opfDir, ncxItem.href);
      const ncxEntry = ncxPath ? index.get(ncxPath) : null;
      if (ncxEntry) {
        try {
          toc = parseNcx(decodeHtmlBytes(entryData(ncxEntry, 8 * 1024 * 1024) || Buffer.alloc(0)), ncxPath);
        } catch (e) {
          warnings.push(`NCX 目录解析失败：${e.message}`);
        }
      }
    }
  }

  const tocByPath = new Map();
  for (const t of toc) {
    const key = t.path.toLowerCase();
    if (!tocByPath.has(key)) tocByPath.set(key, []);
    tocByPath.get(key).push(t);
  }

  // 封面
  const cover = extractCover({ index, opfDir, items, byId, md, pkg, warnings });

  // 资源与图片重写
  const assets = [];
  const assetByPath = new Map();
  const assetSeq = { n: 0 };

  const addAsset = (zipPath, entry, data) => {
    const ext = sniffImageExt(data) || extFromPath(zipPath);
    if (!ext) return null;
    const name = `img-${String(++assetSeq.n).padStart(3, '0')}.${ext}`;
    assets.push({ path: `assets/${name}`, data });
    assetByPath.set(zipPath, name);
    return name;
  };

  const rewriteSrc = (src) => {
    if (!src || /^(data:|https?:|javascript:)/i.test(src)) return null;
    const hit = resolveHref(opfDir, src, index);
    if (!hit.entry) return null;
    const known = assetByPath.get(hit.path);
    if (known) return `assets/${known}`;
    const data = entryData(hit.entry);
    if (!data) {
      warnings.push(`图片过大或无法读取，已跳过：${hit.path}`);
      return null;
    }
    const name = addAsset(hit.path, hit.entry, data);
    return name ? `assets/${name}` : null;
  };

  // 书脊
  const spine = findById(pkg, 'spine') || {};
  const spineItems = asArray(spine.itemref).filter((x) => x && typeof x === 'object');
  const chapters = [];
  const fallbackRefs = [];

  const renderSpine = (item, ref) => {
    const zipPath = joinPosix(opfDir, item.href);
    const entry = zipPath ? index.get(zipPath) : null;
    if (!entry) {
      warnings.push(`书脊文件缺失：${item.href}`);
      return [];
    }
    const raw = decodeHtmlBytes(entryData(entry, 40 * 1024 * 1024) || Buffer.alloc(0));
    if (!raw.trim()) return [];
    const body = expandSvgImages(bodyOf(raw));
    const clean = sanitizeFragment(body, { rewriteSrc });
    if (!clean.trim()) return [];

    const tocList = tocByPath.get(zipPath.toLowerCase()) || [];
    // 同一文件里多个目录锚点：按锚点位置切分，能还原“一大文件多章”的书
    if (tocList.length > 1) {
      const split = splitAtAnchors(clean, tocList);
      if (split && split.length) return split;
    }
    if (!tocList.length) {
      const heads = clean.match(/<h[12][\s>]/gi) || [];
      if (heads.length >= 2) {
        const parts = splitHtmlByHeadings(clean, [1, 2]);
        if (parts.length >= 2) return parts;
      }
      const head = takeFirstHeading(clean);
      return [{ title: head.title, html: head.html.trim() || clean }];
    }
    return [{ title: tocList[0].title || takeFirstHeading(clean).title, html: clean }];
  };

  for (const ref of spineItems) {
    const item = byId.get(attrOf(ref, 'idref'));
    if (!item) { warnings.push(`书脊引用了不存在的条目：${attrOf(ref, 'idref')}`); continue; }
    if (!/x?html|xml/i.test(item.mediaType) && !/\.x?html?$/i.test(item.href)) continue;
    if (attrOf(ref, 'linear').toLowerCase() === 'no' || /\bnav\b/.test(item.properties)) {
      fallbackRefs.push(ref); // 线性 no 的正文留作兜底
      continue;
    }
    chapters.push(...renderSpine(item, ref));
  }

  // 正文全空时，用 linear="no" 的条目兜底
  if (!chapters.length && fallbackRefs.length) {
    warnings.push('书脊正文为空，已回退使用 linear="no" 的条目');
    for (const ref of fallbackRefs) {
      const item = byId.get(attrOf(ref, 'idref'));
      if (item) chapters.push(...renderSpine(item, ref));
    }
  }

  const merged = mergeTinyChapters(chapters, 300);
  if (!merged.length) warnings.push('EPUB 中没有可解析的正文');
  if (toc.length && merged.length < toc.length) {
    warnings.push(`目录有 ${toc.length} 项，正文按文件合并为 ${merged.length} 章`);
  }

  return {
    meta,
    cover,
    chapters: merged,
    assets,
    warnings: warnings.slice(0, 30),
  };
}

function extFromPath(p) {
  const m = String(p).toLowerCase().match(/\.(jpe?g|png|gif|webp|bmp|svg)$/);
  if (!m) return null;
  return m[1] === 'jpeg' ? 'jpg' : m[1];
}

/** 在 id="frag" 处切分已清洗的 HTML。 */
function splitAtAnchors(html, tocList) {
  const found = [];
  for (const t of tocList) {
    if (!t.frag) continue;
    const frag = t.frag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`id\\s*=\\s*["']${frag}["']`, 'i');
    const m = re.exec(html);
    if (!m) continue;
    const lt = html.lastIndexOf('<', m.index);
    if (lt < 0) continue;
    found.push({ idx: lt, title: t.title });
  }
  if (found.length < 2) return null;
  found.sort((a, b) => a.idx - b.idx);
  const out = [];
  for (let i = 0; i < found.length; i++) {
    const end = i + 1 < found.length ? found[i + 1].idx : html.length;
    const body = html.slice(found[i].idx, end).trim();
    if (body) out.push({ title: found[i].title, html: body });
  }
  const prefix = html.slice(0, found[0].idx).trim();
  if (prefix && out.length) out[0].html = prefix + '\n' + out[0].html;
  return out.length >= 2 ? out : null;
}

function extractCover({ index, opfDir, items, byId, md, pkg, warnings }) {
  const candidates = [];

  // EPUB3: properties="cover-image"
  const propItem = items.find((it) => /\bcover-image\b/.test(attrOf(it, 'properties')));
  if (propItem) candidates.push(attrOf(propItem, 'href'));

  // EPUB2: <meta name="cover" content="id"/>
  const coverId = asArray(findById(md, 'meta')).map((m) => {
    if (!m || typeof m !== 'object') return '';
    return /^cover$/i.test(attrOf(m, 'name')) ? attrOf(m, 'content') : '';
  }).find(Boolean);
  if (coverId && byId.get(coverId)) candidates.push(byId.get(coverId).href);

  // guide: <reference type="cover" href="cover.xhtml"/>
  const guide = findById(pkg, 'guide');
  for (const ref of asArray(guide && guide.reference)) {
    if (!ref || typeof ref !== 'object' || !/cover/i.test(attrOf(ref, 'type'))) continue;
    candidates.push(attrOf(ref, 'href'));
  }

  // 兜底：href 里带 cover 的图片
  const imgItems = items.filter((it) => /^image\//i.test(it.mediaType) || extFromPath(it.href));
  const named = imgItems.find((it) => /cover|封面/i.test(it.href));
  if (named) candidates.push(named.href);

  const seen = new Set();
  for (const href of candidates) {
    if (!href) continue;
    const hit = resolveHref(opfDir, href, index);
    if (!hit.entry || seen.has(hit.path)) continue;
    seen.add(hit.path);

    let data = entryData(hit.entry, MAX_COVER);
    if (!data) continue;
    let ext = sniffImageExt(data) || extFromPath(hit.path);

    // guide 指向的是一个 XHTML 封面页：取里面第一张图
    if (!ext && /x?html?$/i.test(hit.path)) {
      const page = decodeHtmlBytes(data);
      const m = page.match(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i)
        || page.match(/<image\b[^>]*href\s*=\s*["']([^"']+)["']/i);
      if (!m) continue;
      const inner = resolveHref(opfDir, m[1], index);
      if (!inner.entry) continue;
      data = entryData(inner.entry, MAX_COVER);
      if (!data) continue;
      ext = sniffImageExt(data) || extFromPath(inner.path);
    }
    if (!ext) continue;
    return { ext, data };
  }
  warnings.push('未找到封面');
  return null;
}
