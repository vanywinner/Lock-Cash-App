'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('./db');
const { buildRoutes } = require('./api');
const { HttpError, sha256 } = require('./lib');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};
const COOKIE = 'lc_session';

function loadConfig(env = process.env) {
  const int = (v, d) => (Number.isInteger(Number(v)) && v !== undefined && v !== '' ? Number(v) : d);
  return {
    port: int(env.PORT, 3000),
    dbFile: env.DB_FILE || path.join(__dirname, '..', 'data', 'lockcash.db'),
    appName: env.APP_NAME || 'Lock Cash',
    pochiPhone: env.POCHI_PHONE || '0700 000 000',
    pochiName: env.POCHI_NAME || 'Lock Cash',
    supportPhone: env.SUPPORT_PHONE || '+254700000000',
    minDeposit: int(env.MIN_DEPOSIT, 50),
    maxDeposit: int(env.MAX_DEPOSIT, 250000),
    minLockDays: int(env.MIN_LOCK_DAYS, 7),
    maxLockDays: int(env.MAX_LOCK_DAYS, 1095),
    basePath: ((env.BASE_PATH || '').replace(/\/+$/, '') && '/' + (env.BASE_PATH || '').replace(/^\/+|\/+$/g, '')),
    inviteCode: env.INVITE_CODE || '',
    signupsPerHour: int(env.SIGNUPS_PER_HOUR, 10),
    trustProxy: env.TRUST_PROXY === '1',
    secureCookie: env.COOKIE_SECURE === '1',
  };
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

function createServer(cfg = loadConfig()) {
  if (cfg.dbFile !== ':memory:') fs.mkdirSync(path.dirname(cfg.dbFile), { recursive: true });
  const db = openDb(cfg.dbFile);
  const routes = buildRoutes({ db, cfg });

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
    res.end(body);
  }
  const sendJson = (res, status, data, headers) =>
    send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > 20 * 1024) { reject(new HttpError(413, 'Request too large.')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve(null);
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new HttpError(400, 'Invalid JSON.')); }
      });
      req.on('error', reject);
    });
  }

  async function handleApi(req, res, url) {
    const route = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
    if (!route) {
      if (routes.some((r) => r.re.test(url.pathname))) throw new HttpError(405, 'Method not allowed.');
      throw new HttpError(404, 'Not found.');
    }

    // CSRF defence in depth (cookies are also SameSite=Strict): same-origin only, JSON only.
    if (req.method !== 'GET') {
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Cross-site request blocked.');
      if (!(req.headers['content-type'] || '').startsWith('application/json') && Number(req.headers['content-length'] || 0) > 0) {
        throw new HttpError(415, 'JSON required.');
      }
    }

    // Session lookup
    const token = parseCookies(req.headers.cookie)[COOKIE];
    const tokenHash = token ? sha256(token) : null;
    let user = null;
    if (tokenHash) {
      user = db.prepare(
        `SELECT u.id, u.role, u.status FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?`).get(tokenHash, new Date().toISOString()) || null;
    }
    if (route.auth && !user) throw new HttpError(401, 'Please log in.');
    if (route.auth === 'admin' && user.role !== 'admin') throw new HttpError(403, 'Admins only.');

    const cookieBase = `${COOKIE}=`;
    const flags = `; Path=${cfg.basePath || '/'}; HttpOnly; SameSite=Strict${cfg.secureCookie || (cfg.trustProxy && req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : ''}`;
    const extraHeaders = {};
    const ctx = {
      db, cfg, user, tokenHash, query: url.searchParams,
      params: Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(url.pathname.match(route.re)[i + 1])])),
      ip: (cfg.trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || 'unknown',
      body: req.method === 'GET' ? null : await readBody(req),
      setSession: (t, maxAge) => { extraHeaders['Set-Cookie'] = `${cookieBase}${t}${flags}; Max-Age=${maxAge}`; },
      clearSession: () => { extraHeaders['Set-Cookie'] = `${cookieBase}${flags}; Max-Age=0`; },
    };
    const result = route.handler(ctx);
    if (result && result.csv !== undefined) {
      return send(res, 200, result.csv, {
        'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="${result.filename}"`, ...extraHeaders,
      });
    }
    sendJson(res, 200, result, extraHeaders);
  }

  function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return send(res, 404, 'Page not found', { 'Content-Type': 'text/plain; charset=utf-8' });
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': ext === '.html' || file.endsWith('sw.js') ? 'no-cache' : 'public, max-age=3600',
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      // Served under a sub-path (e.g. /lock-cash)? Accept it with or without the prefix, so it works
      // whether or not the reverse proxy strips it.
      const base = cfg.basePath;
      if (base) {
        if (url.pathname === base) { res.writeHead(301, { Location: base + '/' + url.search }); return res.end(); }
        if (url.pathname.startsWith(base + '/')) url.pathname = url.pathname.slice(base.length);
      }
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else serveStatic(req, res, url);
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      console.error(err);
      sendJson(res, 500, { error: 'Something went wrong on our side. Please try again.' });
    }
  });
  server.db = db;
  return server;
}

if (require.main === module) {
  const cfg = loadConfig();
  const server = createServer(cfg);
  server.listen(cfg.port, () => {
    console.log(`${cfg.appName} running on http://localhost:${cfg.port}`);
    if (!server.db.prepare("SELECT 1 FROM users WHERE role='admin'").get()) {
      console.log('No admin yet. Create one with:  npm run create-admin -- 0712345678 "a-strong-password" "Your Name"');
    }
  });
}

module.exports = { createServer, loadConfig };
