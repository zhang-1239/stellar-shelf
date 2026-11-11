// 路径与全局常量
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 数据目录：优先用环境变量（插件安装时指向用户目录），
 * 否则用应用目录下的 data/。两者都不可写时退回用户主目录。
 */
function resolveDataDir() {
  const candidates = [
    process.env.SHELF_DATA_DIR,
    path.join(ROOT, 'data'),
    path.join(os.homedir(), '.stellar-shelf'),
  ];
  for (const dir of candidates) {
    if (!dir) continue;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch { /* 试下一个 */ }
  }
  const fallback = path.join(os.tmpdir(), 'stellar-shelf');
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

export const DATA = resolveDataDir();

export const DIR = {
  data: DATA,
  books: path.join(DATA, 'books'),
  content: path.join(DATA, 'content'),
  covers: path.join(DATA, 'covers'),
  db: path.join(DATA, 'shelf.db'),
  public: path.join(ROOT, 'public'),
  demo: path.join(ROOT, 'server', 'demo'),
};

for (const d of [DIR.data, DIR.books, DIR.content, DIR.covers]) {
  fs.mkdirSync(d, { recursive: true });
}

export const HOST = '127.0.0.1';
// 默认端口；被占用时会往后找（见 index.js）
export const PORT = Number(process.env.SHELF_PORT || 7317);
export const PORT_MAX = PORT + 12;

export function bookFilePath(id, ext) {
  return path.join(DIR.books, `${id}${ext.startsWith('.') ? ext : '.' + ext}`);
}
export function contentDir(id) {
  return path.join(DIR.content, String(id));
}
export function coverPath(name) {
  return path.join(DIR.covers, name);
}
