import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const PROJECT = fileURLToPath(new URL('../', import.meta.url));
const ROUTES = new Map([
  ['/', 'index.html'], ['/index.html', 'index.html'], ['/favicon.svg', 'public/favicon.svg'],
  ['/src/app.js', 'src/app.js'], ['/src/catalog.js', 'src/catalog.js'], ['/src/domain.js', 'src/domain.js'], ['/src/styles.css', 'src/styles.css'],
  ['/data/catalog.json', 'public/data/catalog.json'], ['/data/source-tariff.pdf', 'public/data/source-tariff.pdf'],
  ['/data/source-shorttext.pdf', 'public/data/source-shorttext.pdf'],
]);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf' };

export function acceptsGzip(header = '') {
  const entries = header.split(',').map(part => part.trim().toLowerCase().split(';').map(p => p.trim()));
  const explicit = entries.find(parts => parts[0] === 'gzip');
  const chosen = explicit || entries.find(parts => parts[0] === '*');
  if (!chosen) return false;
  const quality = chosen.find(p => p.startsWith('q='));
  const q = quality ? Number(quality.slice(2)) : 1;
  return Number.isFinite(q) && q > 0 && q <= 1;
}

export function createAppServer({ root = PROJECT, dist = false } = {}) {
  const cache = new Map();
  return http.createServer(async (req, res) => {
    const headers = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'",
      'Cross-Origin-Resource-Policy': 'same-origin', 'Cache-Control': 'no-cache' };
    const fail = (status, message) => { res.writeHead(status, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' }); res.end(message); };
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return fail(405, 'Nur GET und HEAD erlaubt.');
      const host = req.headers.host || '';
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return fail(403, 'Nur lokaler Zugriff.');
      const pathname = decodeURIComponent((req.url || '').split('?')[0]);
      let relative = ROUTES.get(pathname);
      if (!relative) return fail(404, 'Nicht gefunden.');
      if (dist && relative.startsWith('public/')) relative = relative.slice(7);
      const base = await realpath(root);
      const target = await realpath(path.join(base, relative));
      if (!target.startsWith(base + path.sep)) return fail(403, 'Pfad nicht erlaubt.');
      const info = await stat(target);
      const key = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      let cached = cache.get(target);
      if (!cached || cached.key !== key) {
        const raw = await readFile(target);
        const text = ['.html', '.js', '.css', '.json', '.svg'].includes(path.extname(target));
        cached = { key, raw, gzip: text && raw.length > 1024 ? gzipSync(raw) : null };
        cached.etag = createHash('sha256').update(raw).digest('hex');
        cache.set(target, cached);
      }
      const compressed = cached.gzip && acceptsGzip(req.headers['accept-encoding']);
      const body = compressed ? cached.gzip : cached.raw;
      const etag = `"${cached.etag}${compressed ? '-gzip' : ''}"`;
      Object.assign(headers, { 'Content-Type': TYPES[path.extname(target)] || 'application/octet-stream',
        'Content-Length': body.length, ETag: etag, Vary: 'Accept-Encoding' });
      if (compressed) headers['Content-Encoding'] = 'gzip';
      if (req.headers['if-none-match'] === etag) { delete headers['Content-Length']; res.writeHead(304, headers); return res.end(); }
      res.writeHead(200, headers); res.end(req.method === 'HEAD' ? undefined : body);
    } catch (error) { fail(error.code === 'ENOENT' ? 404 : 500, error.code === 'ENOENT' ? 'Datei fehlt. README / npm run data beachten.' : 'Datei konnte nicht geladen werden.'); }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const portIndex = process.argv.indexOf('--port');
  const port = Number(portIndex >= 0 ? process.argv[portIndex + 1] : process.env.PORT || 5173);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Ungültiger Port.');
  const dist = process.argv.includes('--dist');
  const server = createAppServer({ root: dist ? path.join(PROJECT, 'dist') : PROJECT, dist });
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`DENTOTAR Browser: http://127.0.0.1:${port}${dist ? ' (Build)' : ''}`));
}
