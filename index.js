/**
 * 宿主半身：保证本地书架服务在运行时是活的。
 * 页面由 Client 半身用 iframe 呈现，这里只管进程、目录与端口。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE_PORT = Number(process.env.SHELF_PORT || 7317);

/** 找到应用根目录：打包版（server 在包内）优先，其次开发时的上一级 */
function findApp() {
  const candidates = [
    process.env.SHELF_APP_DIR,
    HERE,                              // dist 结构：server/ 与 public/ 就在包根
    path.resolve(HERE, '..'),          // 开发结构：plugin/ 的上一级是仓库根
    'D:\\Reading',
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'server', 'index.js'))) return dir;
    } catch { /* ignore */ }
  }
  return null;
}

/** 打包安装时，数据写到用户目录，别写进 node_modules */
function dataDirFor(appRoot) {
  if (appRoot !== HERE) return undefined;             // 开发时用仓库自带 data/
  const dir = path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'stellar-shelf'
  );
  try { fs.mkdirSync(dir, { recursive: true }); return dir; } catch { return undefined; }
}

async function isUp(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1200) });
    return res.ok;
  } catch {
    return false;
  }
}

/** 端口可能被占，服务会自己往后找；这里先在区间内探一遍 */
async function findRunning() {
  const ports = Array.from({ length: 13 }, (_, i) => BASE_PORT + i);
  const hits = await Promise.all(ports.map(async (p) => ((await isUp(p)) ? p : 0)));
  return hits.find(Boolean) || 0;
}

export function apply(ctx) {
  const appRoot = findApp();
  let child = null;

  if (!appRoot) {
    console.error('[stellar-shelf] 找不到 server/index.js，请用 SHELF_APP_DIR 指向应用目录');
  } else {
    (async () => {
      if (await findRunning()) return;               // 已经在跑，不重复启动
      const dataDir = dataDirFor(appRoot);
      try {
        child = spawn(process.execPath, [path.join(appRoot, 'server', 'index.js')], {
          cwd: appRoot,
          detached: false,
          windowsHide: true,
          stdio: 'ignore',
          env: { ...process.env, ...(dataDir ? { SHELF_DATA_DIR: dataDir } : {}) },
        });
        child.on('error', (err) => {
          console.error('[stellar-shelf] 启动本地服务失败:', err.message);
          child = null;
        });
        child.on('exit', () => { child = null; });
      } catch (err) {
        console.error('[stellar-shelf] 启动本地服务异常:', err.message);
      }
    })();
  }

  ctx.effect(() => () => {
    if (child) {
      try { child.kill(); } catch { /* ignore */ }
      child = null;
    }
  }, 'stellar-shelf local server');
}
