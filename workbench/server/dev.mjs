import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createApi } from './api.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const production = process.argv.includes('--production');
const port = Number(process.env.WORKBENCH_PORT ?? 3088);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('WORKBENCH_PORT must be 1024–65535');
const api = createApi();
const vite = production ? null : await (await import('vite')).createServer({
  root, configFile: path.join(root, 'vite.config.ts'),
  server: { middlewareMode: true, host: '127.0.0.1', allowedHosts: ['localhost', '127.0.0.1'] },
});
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = http.createServer(async (req, res) => {
  const host = req.headers.host ?? '';
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host)) {
    res.writeHead(403, { 'Content-Type': 'application/json' }); res.end('{"error":"Only the local workbench host is allowed"}'); return;
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  try {
    if ((req.url ?? '').startsWith('/api/')) { await api(req, res); return; }
    if (vite) { vite.middlewares(req, res); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    const pathname = decodeURIComponent(new URL(req.url, `http://${host}`).pathname);
    const output = path.join(root, 'dist');
    let file = path.resolve(output, '.' + pathname);
    if (!file.startsWith(output + path.sep)) file = path.join(output, 'index.html');
    try { if (!(await fs.stat(file)).isFile()) file = path.join(output, 'index.html'); }
    catch { file = path.join(output, 'index.html'); }
    await fs.access(file);
    res.setHeader('Content-Type', mime[path.extname(file)] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', path.extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600');
    if (req.method === 'HEAD') res.end();
    else createReadStream(file).on('error', () => res.destroy()).pipe(res);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Workbench request failed');
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '工作台無法完成請求，請查看本機服務狀態。' }));
  }
});
server.listen(port, '127.0.0.1', () => console.log(`JEV Studio: http://127.0.0.1:${port} (${production ? 'production' : 'development'})`));
const shutdown = async () => { server.close(); await vite?.close(); process.exit(0); };
process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
