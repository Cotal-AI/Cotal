#!/usr/bin/env node
// serve-wall.mjs — serve web/ AND reverse-proxy the OpenCode API on one origin, so the
// browser wall (web/wall.html) is same-origin and never hits CORS.
//
//   opencode serve --port 4096        # the agent server (or reuse a running one)
//   node tools/serve-wall.mjs         # then open the printed URL
//
// Env: PORT (4097, this server) · OPENCODE (http://127.0.0.1:4096, the upstream agent server).
import { createServer, request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..'); // the example dir — serves web/ and personas.mjs
const PORT = Number(process.env.PORT || 4097);
const UPSTREAM = new URL(process.env.OPENCODE || 'http://127.0.0.1:4096');

// Paths owned by the opencode server (what face-term/cotal-opencode call) — proxied upstream.
// Everything else is a static file from web/.
const API = [/^\/session(\/|$)/, /^\/global\/event$/, /^\/event$/];
const isApi = (p) => API.some((re) => re.test(p));

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
};

function proxy(req, res) {
  const up = httpRequest(
    {
      hostname: UPSTREAM.hostname, port: UPSTREAM.port, path: req.url, method: req.method,
      headers: { ...req.headers, host: UPSTREAM.host },
    },
    (upRes) => { res.writeHead(upRes.statusCode || 502, upRes.headers); upRes.pipe(res); },
  );
  up.on('error', () => {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`upstream ${UPSTREAM.origin} unreachable — is \`opencode serve --port ${UPSTREAM.port}\` running?`);
  });
  req.pipe(up);
}

async function serveStatic(req, res) {
  let p = new URL(req.url, 'http://x').pathname;
  if (p === '/') p = '/wall.html';
  const name = decodeURIComponent(p).replace(/^\/+/, '');
  if (name.includes('..')) { res.writeHead(403); res.end('nope'); return; }
  // pages live in web/; personas.mjs and qr-cotal.mjs sit one level up (imported as ../*.mjs,
  // which the browser collapses to /<name> at the served root).
  const file = name === 'personas.mjs' || name === 'qr-cotal.mjs'
    ? join(ROOT, name) : join(ROOT, 'web', name);
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found: ' + name);
  }
}

createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (isApi(p)) proxy(req, res);
  else serveStatic(req, res);
}).listen(PORT, () => {
  console.log(`face wall: http://127.0.0.1:${PORT}/wall.html  (API -> ${UPSTREAM.origin})`);
});
