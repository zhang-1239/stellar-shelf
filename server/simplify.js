// 繁体 → 简体。只转文字，绝不碰标签与属性（否则会改坏图片路径、class）。
import * as OpenCC from 'opencc-js';

const convert = OpenCC.Converter({ from: 'tw', to: 'cn' });

let enabled = true;
export function setSimplify(on) { enabled = Boolean(on); }

export function toSimplified(str) {
  if (!enabled || str == null) return str;
  const s = String(str);
  if (!/[\u4e00-\u9fff]/.test(s)) return s;
  try { return convert(s); } catch { return s; }
}

const TAG_SPLIT = /(<[^>]*>)/;

export function simplifyHtml(html) {
  if (!enabled || !html) return html;
  return String(html)
    .split(TAG_SPLIT)
    .map((part) => (part.startsWith('<') ? part : toSimplified(part)))
    .join('');
}
