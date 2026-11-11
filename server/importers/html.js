// 电子书 HTML 清洗：只保留可排版的标签，剥离脚本与样式，重写图片地址。

const VOID = new Set(['br', 'hr', 'img', 'meta', 'link', 'input', 'col', 'source', 'wbr', 'area', 'base']);

// 保留标签（白名单）
const ALLOW = new Set([
  'p', 'div', 'br', 'hr', 'em', 'strong', 'i', 'b', 'u', 's', 'span', 'small', 'sub', 'sup',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'img', 'a',
  'figure', 'figcaption', 'section', 'article', 'aside', 'header', 'footer',
  'ruby', 'rt', 'rp', 'pre', 'code', 'q', 'cite', 'abbr', 'mark', 'del', 'ins', 'center',
]);

// 连同内容一起丢弃
const DROP_CONTENT = new Set(['script', 'style', 'head', 'title', 'meta', 'link', 'iframe',
  'object', 'embed', 'form', 'input', 'button', 'select', 'textarea', 'svg', 'canvas', 'audio', 'video', 'noscript']);

// 保留的 style 属性（极少数情况下电子书靠它排版）
const STYLE_KEEP = /^(text-align|text-indent|font-style|font-weight|margin-left|line-height|letter-spacing|padding-left)\s*:/i;

const ATTR_KEEP = {
  img: ['src', 'alt', 'title'],
  a: ['href', 'title'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan'],
  ol: ['start', 'type'],
  '*': ['id'],
};

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function decodeEntities(s) {
  if (!s) return '';
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&([a-z]+|#39);/gi, (m, n) => (ENTITIES[n.toLowerCase()] ?? m));
}

function safeChar(code) {
  try { return String.fromCodePoint(code); } catch { return ''; }
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function parseAttrs(raw) {
  const out = [];
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(raw))) {
    out.push([m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? '']);
  }
  return out;
}

/**
 * 清洗 HTML 片段。
 * @param {string} html
 * @param {{rewriteSrc?: (src:string)=>string|null, dropIds?: boolean}} opt
 */
export function sanitizeFragment(html, opt = {}) {
  const { rewriteSrc = () => null } = opt;
  if (!html) return '';

  // 去掉注释与 CDATA
  let src = String(html).replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');

  const out = [];
  const stack = [];
  let dropping = null;   // 正在整体丢弃的标签名
  let dropDepth = 0;
  let i = 0;

  const pushText = (text) => {
    if (dropping) return;
    out.push(text);
  };

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) { pushText(src.slice(i)); break; }
    if (lt > i) pushText(src.slice(i, lt));

    const gt = findTagEnd(src, lt);
    if (gt === -1) { pushText(src.slice(lt)); break; }

    const rawTag = src.slice(lt + 1, gt).trim();
    i = gt + 1;

    if (!rawTag || rawTag[0] === '!' || rawTag[0] === '?') continue;

    const closing = rawTag[0] === '/';
    const selfClose = /\/$/.test(rawTag);
    const body = closing ? rawTag.slice(1).trim() : rawTag.replace(/\/$/, '').trim();
    const nameMatch = body.match(/^([a-zA-Z][-a-zA-Z0-9]*)/);
    if (!nameMatch) continue;
    const name = nameMatch[1].toLowerCase();
    const attrRaw = body.slice(nameMatch[1].length);

    if (dropping) {
      if (name === dropping) {
        if (closing) { dropDepth--; if (dropDepth <= 0) dropping = null; }
        else if (!selfClose && !VOID.has(name)) dropDepth++;
      }
      continue;
    }

    if (!closing && DROP_CONTENT.has(name)) {
      if (!selfClose) { dropping = name; dropDepth = 1; }
      continue;
    }

    if (!ALLOW.has(name)) continue;           // 未知标签：去壳留文

    if (closing) {
      const idx = stack.lastIndexOf(name);
      if (idx === -1) continue;               // 多余的闭合标签
      // 补齐中间未闭合的标签
      while (stack.length > idx) {
        const open = stack.pop();
        out.push(`</${open}>`);
      }
      continue;
    }

    const attrs = parseAttrs(attrRaw);
    const kept = [];
    const allowList = [...(ATTR_KEEP[name] || []), ...(ATTR_KEEP['*'] || [])];
    for (const [k, v] of attrs) {
      if (k === 'class' && (name === 'span' || name === 'p' || name === 'div')) {
        const clean = v.split(/\s+/).filter((c) => /^[a-z0-9_-]{1,40}$/i.test(c)).slice(0, 4).join(' ');
        if (clean) kept.push(`class="${clean}"`);
        continue;
      }
      if (k === 'style') {
        const decls = v.split(';').map((s) => s.trim()).filter((s) => STYLE_KEEP.test(s))
          .filter((s) => !/expression|url\s*\(|javascript/i.test(s)).slice(0, 6);
        if (decls.length) kept.push(`style="${escapeHtml(decls.join(';'))}"`);
        continue;
      }
      if (!allowList.includes(k)) continue;
      if (k === 'src') {
        const next = rewriteSrc(decodeEntities(v));
        if (!next) continue;
        kept.push(`src="${escapeHtml(next)}"`);
        continue;
      }
      if (k === 'href') {
        const href = decodeEntities(v);
        if (!/^(https?:|mailto:|#)/i.test(href)) continue;
        kept.push(`href="${escapeHtml(href)}" rel="noopener noreferrer"`);
        continue;
      }
      if (k === 'id' && opt.dropIds) continue;
      kept.push(`${k}="${escapeHtml(decodeEntities(v))}"`);
    }

    if (name === 'img' && !kept.some((a) => a.startsWith('src='))) continue;  // 没有有效图源就丢弃

    const attrStr = kept.length ? ' ' + kept.join(' ') : '';
    if (VOID.has(name) || selfClose) {
      out.push(`<${name}${attrStr}>`);
    } else {
      out.push(`<${name}${attrStr}>`);
      stack.push(name);
    }
  }

  while (stack.length) out.push(`</${stack.pop()}>`);

  return out.join('')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

function findTagEnd(s, start) {
  let i = start + 1;
  let quote = null;
  while (i < s.length) {
    const c = s[i];
    if (quote) { if (c === quote) quote = null; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i;
    i++;
  }
  return -1;
}

export function textOf(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|blockquote|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  ).replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

export function countWords(text) {
  const t = String(text || '');
  const cjk = (t.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
  const latin = (t.match(/[A-Za-z0-9]+(?:['-][A-Za-z0-9]+)*/g) || []).length;
  return cjk + latin;
}

export function cnNum(s) {
  const map = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  // 支持 十一 / 二十三 / 一百 之类
  let total = 0, section = 0, number = 0;
  for (const ch of s) {
    if (/[两二]/.test(ch)) number = 2;
    else if (ch in map) {
      number = map[ch];
      if (ch === '十') { section += (number === 0 ? 1 : number) * 10; number = 0; }
      else if (ch === '百') { section += number * 100; number = 0; }
    }
  }
  total = section + number;
  return total || null;
}

/** 按“第X章 / Chapter N / 卷”等标题把长文本切成章节。 */
export function splitPlainText(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const chapterRe = new RegExp(
    '^\\s*(' +
    [
      '第\\s*[0-9零一二三四五六七八九十百千两]+\\s*[章回节卷部篇](?:\\s|$|[：:、.．])',
      '序章', '楔子', '尾声', '后记', '序言', '前言', '引子', '终章', '跋',
      'Chapter\\s+[0-9IVXLC]+', 'CHAPTER\\s+[0-9IVXLC]+',
      '\\d{1,3}\\s*[.、．]\\s*\\S',                    // 1. 關睢
      '[一二三四五六七八九十百]{1,4}\\s*[、.]\\s*\\S',   // 一、…
      '^\\s*【[^】]{1,20}】\\s*$',
    ].join('|') + ')'
  );
  const marks = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.length > 60) continue;
    if (chapterRe.test(line)) marks.push({ line: i, title: line.replace(/^[\s　]+/, '').slice(0, 60) });
  }

  if (marks.length < 2) {
    // 没有章节：按约 6000 字切块
    const chunks = [];
    let buf = [];
    let size = 0;
    for (const line of lines) {
      buf.push(line); size += line.length;
      if (size > 6000 && !line.trim()) { chunks.push(buf); buf = []; size = 0; }
    }
    if (buf.join('').trim()) chunks.push(buf);
    return chunks.map((c, i) => ({
      title: chunks.length > 1 ? `片段 ${i + 1}` : '正文',
      text: c.join('\n').trim(),
    })).filter((c) => c.text);
  }

  const out = [];
  const head = lines.slice(0, marks[0].line).join('\n').trim();
  if (head) out.push({ title: '扉页', text: head });
  for (let k = 0; k < marks.length; k++) {
    const start = marks[k].line;
    const end = k + 1 < marks.length ? marks[k + 1].line : lines.length;
    const body = lines.slice(start + 1, end).join('\n').trim();
    out.push({ title: marks[k].title, text: body });
  }
  return out;
}

export function textToParagraphsHtml(text) {
  const out = [];
  for (const block of String(text).split(/\n{2,}/)) {
    const lines = block.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
    if (!lines.length) continue;
    // 纯分隔线（---- / ==== / ＊＊＊）不当作正文
    if (lines.every((l) => /^[\s\-—－_=*~·.．。]{3,}$/.test(l))) continue;

    // 判断这一块是「硬折行的散文」还是「一行一句的诗」
    const long = lines.filter((l) => l.trim().length >= 28).length;
    const wrapped = lines.length >= 2 && long / lines.length >= 0.6;

    if (!wrapped) {
      for (const line of lines) out.push(`<p>${escapeHtml(line.trim())}</p>`);
      continue;
    }

    const paras = [];
    for (const raw of lines) {
      const line = raw.trim();
      const indented = /^[\u3000\u00a0]/.test(raw) || /^\s{2,}/.test(raw);
      const isCJK = /[\u4e00-\u9fff]/.test(line);
      if (indented || paras.length === 0) paras.push(line.replace(/^[\u3000\u00a0\s]+/, ''));
      else paras[paras.length - 1] += (isCJK ? '' : ' ') + line;
    }
    // 古典文本常有整段数千字，按句读切成可读的段
    for (const p of paras) {
      for (const chunk of splitLongParagraph(p)) out.push(`<p>${escapeHtml(chunk)}</p>`);
    }
  }
  return out.join('\n');
}

/** 超长段落按句末标点切开，尽量每段 260–460 字 */
function splitLongParagraph(text, max = 460, min = 240) {
  const s = String(text || '');
  if (s.length <= max) return [s];
  const parts = [];
  let rest = s;
  while (rest.length > max) {
    let cut = -1;
    for (let i = Math.min(max, rest.length - 1); i >= min; i--) {
      if ('。！？；」』…”'.includes(rest[i])) { cut = i + 1; break; }
    }
    if (cut <= 0) {
      for (let i = max; i >= min; i--) {
        if ('，、：'.includes(rest[i])) { cut = i + 1; break; }
      }
    }
    if (cut <= 0) cut = max;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts.filter(Boolean);
}
