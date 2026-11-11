// 星槎书斋 · 本地服务
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { PORT, PORT_MAX, HOST, DIR } from './paths.js';
import { handleApi, MIME, send } from './api.js';
import { startScheduler } from './daily.js';
import { q } from './db.js';
import { ensureDemo } from './demo.js';

const PUBLIC = DIR.public;

function safeJoin(base, rel) {
  const clean = String(rel).replace(/^\/+/, '');
  const p = path.resolve(base, decodeURIComponent(clean));
  return p === base || p.startsWith(base + path.sep) ? p : null;
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  let file = safeJoin(PUBLIC, rel);
  if (!file) return send(res, 403, 'forbidden');
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) {
    if (!path.extname(pathname)) {
      const idx = path.join(PUBLIC, 'index.html');
      if (fs.existsSync(idx)) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
        return fs.createReadStream(idx).pipe(res);
      }
    }
    return send(res, 404, 'not found');
  }
  const ext = path.extname(file).toLowerCase();
  const isVendor = file.includes(`${path.sep}vendor${path.sep}`);
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': isVendor ? 'max-age=604800' : 'no-cache',
  });
  return fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' });
    return res.end();
  }

  if (url.pathname.startsWith('/api/')) {
    return handleApi(req, res, url);
  }

  if (url.pathname.startsWith('/media/')) {
    const rel = url.pathname.slice('/media/'.length);
    const file = safeJoin(DIR.data, rel);
    if (!file || !fs.existsSync(file)) return send(res, 404, 'no media');
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': 'max-age=604800',
    });
    return fs.createReadStream(file).pipe(res);
  }

  return serveStatic(req, res, url.pathname);
});

/** 从 PORT 开始找第一个能监听的端口 */
function listenFrom(port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      if (err.code === 'EADDRINUSE' && port < PORT_MAX) {
        server.removeListener('error', onError);
        resolve(listenFrom(port + 1));
      } else {
        reject(err);
      }
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, HOST);
  });
}

const actualPort = await listenFrom(PORT);

try {
  fs.writeFileSync(path.join(DIR.data, 'port'), String(actualPort), 'utf8');
} catch { /* 写不了也无所谓，前端会自己探测 */ }

console.log(`\n  星槎书斋  →  http://${HOST}:${actualPort}`);
console.log(`  数据目录：${DIR.data}`);
console.log(`  书库：${q.get('SELECT COUNT(*) c FROM books').c} 本\n`);

// 空书库时装一套演示书，保证"装完就能看见东西"
try { await ensureDemo(); } catch (err) { console.error('[demo]', err.message); }

startScheduler();

process.on('uncaughtException', (err) => console.error('[uncaught]', err));
process.on('unhandledRejection', (err) => console.error('[unhandled]', err));

export { server };
