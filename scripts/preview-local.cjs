#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { inside } = require('../lib/local-content');
const root = path.resolve(__dirname, '..');
const content = path.join(root, 'local-content');
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const urlPath = value => value.split('/').map(encodeURIComponent).join('/');

function portal() {
  const inventory = JSON.parse(fs.readFileSync(path.join(content, 'drive-current', 'inventory.json'), 'utf8'));
  const work = path.join(content, 'v2', 'projects');
  const packages = fs.existsSync(work) ? fs.readdirSync(work, { withFileTypes: true }).filter(p => p.isDirectory())
    .map(p => ({ directory: p.name, file: path.join(work, p.name, 'project.json') })).filter(p => fs.existsSync(p.file))
    .map(p => ({ ...JSON.parse(fs.readFileSync(p.file, 'utf8')), directory: p.directory })) : [];
  const draftCards = packages.map(p => `<article><span class="badge work">WORK IN PROGRESS</span><h3>${escape(p.title)}</h3><div class="links">${Object.entries(p.pages).map(([role, file]) => `<a href="/work/projects/${urlPath(p.directory + '/' + file)}">${escape(role === 'key_findings' ? 'Key Findings' : 'Workflow')} ↗</a>`).join('')}<a href="/work/${urlPath(p.dataset.page)}">Dataset ↗</a></div></article>`).join('');
  const cards = inventory.projects.map(p => {
    const picture = inventory.files.find(f => f.path.startsWith('projects/' + p.slug + '/') && f.name === 'card-v2.jpg');
    return `<article>${picture ? `<img src="/content/${urlPath(picture.path)}" alt="" loading="lazy">` : ''}<span class="badge">${escape(p.status)}</span><h3>${escape(p.title)}</h3><div class="links"><a href="/site/demos/${urlPath(p.slug)}/index.html">Website view ↗</a><a href="/content/${urlPath(p.primary_path)}">Source page ↗</a></div></article>`;
  }).join('');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AIS local workspace</title><style>
  *{box-sizing:border-box}body{margin:0;background:#f4f6f8;color:#172938;font:15px/1.55 system-ui,sans-serif}main{max-width:1240px;margin:auto;padding:36px 24px 64px}header{margin-bottom:40px}h1{font-size:34px;letter-spacing:-1px;margin:8px 0}h2{font-size:23px;margin-top:36px}p{color:#526675}a{color:#096887;text-decoration:none}a:hover{text-decoration:underline}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:18px}article{padding:20px;background:white;border:1px solid #dce3e8;border-radius:14px}article img{width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:8px;margin-bottom:12px}h3{font-size:18px;line-height:1.35;margin:14px 0 22px}.badge{display:inline-block;background:#e8edf0;color:#455c69;padding:3px 8px;border-radius:5px;font-size:11px;font-weight:650;text-transform:uppercase}.work{background:#e1f1eb;color:#216348}.links{display:flex;gap:16px;flex-wrap:wrap}.primary{display:inline-block;background:#143d50;color:white;padding:10px 16px;border-radius:8px}
  </style><main><header><span class="badge">LOCAL WORKSPACE</span><h1>AIS Instrument Gym</h1><p>Browse the downloaded collection and the pages being redesigned.</p><a class="primary" href="/site/index.html">Open the local website →</a></header><h2>V2 workspace</h2><div class="grid">${draftCards}</div><h2>Current collection · ${inventory.projects.length} projects</h2><p>Snapshot: ${escape(inventory.captured_at)} · Includes Live and Draft projects.</p><div class="grid">${cards}</div></main></html>`;
}

function createServer() {
  const mounts = { site: path.join(root, 'dist'), content: path.join(content, 'drive-current'), work: path.join(content, 'v2') };
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.md': 'text/plain; charset=utf-8' };
  return http.createServer((req, res) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); return res.end(); }
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      let bytes;
      let type;
      if (pathname === '/') { bytes = Buffer.from(portal()); type = types['.html']; }
      else {
        const [, mount, ...segments] = pathname.split('/');
        if (!mounts[mount]) throw new Error('Unknown route');
        if (segments.at(-1) === '') segments[segments.length - 1] = 'index.html';
        const file = inside(mounts[mount], segments.join('/'));
        bytes = fs.readFileSync(file); type = types[path.extname(file)] || 'application/octet-stream';
      }
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': bytes.length });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (_) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Page not found. Run npm run content:build for the website preview.');
    }
  });
}

if (require.main === module) {
  const index = process.argv.indexOf('--port');
  const port = index < 0 ? 4173 : Number(process.argv[index + 1]);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid --port');
  const server = createServer();
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log('Local workspace: http://127.0.0.1:' + server.address().port + '/'));
}
module.exports = { createServer };
