#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { inside } = require('../lib/local-content');
const root = path.resolve(__dirname, '..');

function createServer(siteDirectory = path.join(root, 'local-content', 'site')) {
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon' };
  return http.createServer((req, res) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); return res.end(); }
    try {
      const url = new URL(req.url, 'http://localhost');
      // Preserve earlier preview links while using the same URL layout as Netlify.
      if (url.pathname === '/site' || url.pathname.startsWith('/site/')) {
        const target = url.pathname.slice(5).replace(/^\/+/, '');
        res.writeHead(302, { Location: '/' + target + url.search });
        return res.end();
      }
      let relative = decodeURIComponent(url.pathname).slice(1);
      if (!relative || relative.endsWith('/')) relative += 'index.html';
      else if (!path.posix.extname(relative)) {
        res.writeHead(302, { Location: url.pathname + '/' + url.search });
        return res.end();
      }
      const file = inside(siteDirectory, relative);
      const bytes = fs.readFileSync(file);
      const type = types[path.extname(file)] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': bytes.length });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (_) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Page not found. Run npm run content:build to build the local website.');
    }
  });
}

if (require.main === module) {
  const index = process.argv.indexOf('--port');
  const port = index < 0 ? 4173 : Number(process.argv[index + 1]);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid --port');
  const server = createServer();
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log('Local website: http://127.0.0.1:' + server.address().port + '/'));
}
module.exports = { createServer };
