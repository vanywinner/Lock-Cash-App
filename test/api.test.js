'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createServer, loadConfig } = require('../server/server');
const L = require('../server/lib');

let server, base;

before(async () => {
  server = createServer({ ...loadConfig({}), dbFile: ':memory:', signupsPerHour: 10000 });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  server.db.prepare("INSERT INTO users (phone,name,pass_hash,role,created_at) VALUES (?,?,?,?,?)")
    .run('254711000000', 'Boss', L.hashPassword('adminpass1'), 'admin', new Date().toISOString());
});
after(() => server.close());

/** Minimal client with its own cookie jar. */
function client() {
  let cookie = '';
  return async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
}

async function newUser(phone, name = 'Test User') {
  const c = client();
  const r = await c('POST', '/api/signup', { name, phone, password: 'secret123', confirmPassword: 'secret123' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return c;
}
async function adminClient() {
  const c = client();
  const r = await c('POST', '/api/login', { phone: '0711000000', password: 'adminpass1' });
  assert.equal(r.status, 200);
  return c;
}
async function fundedUser(phone, amount, lockDays, code) {
  const u = await newUser(phone);
  const dep = await u('POST', '/api/deposits', { amount, lockDays, mpesaCode: code });
  assert.equal(dep.status, 200, JSON.stringify(dep.data));
  const a = await adminClient();
  const ok = await a('POST', `/api/admin/transactions/${dep.data.transaction.id}/approve`, {});
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  return { u, a, txId: dep.data.transaction.id };
}

test('phone normalisation accepts local and international forms', () => {
  for (const p of ['0712345678', '+254712345678', '254712345678', '712345678', '0712 345 678']) {
    assert.equal(L.normalisePhone(p), '254712345678');
  }
  assert.equal(L.normalisePhone('0112345678'), '254112345678');
  assert.equal(L.normalisePhone('12345'), null);
  assert.equal(L.normalisePhone('0212345678'), null);
});

test('signup validates and rejects duplicates', async () => {
  const c = client();
  assert.equal((await c('POST', '/api/signup', { name: 'A', phone: '0712000001', password: 'secret123', confirmPassword: 'secret123' })).status, 400);
  assert.equal((await c('POST', '/api/signup', { name: 'Ann Lee', phone: '0712000001', password: 'short', confirmPassword: 'short' })).status, 400);
  assert.equal((await c('POST', '/api/signup', { name: 'Ann Lee', phone: '0712000001', password: 'secret123', confirmPassword: 'different1' })).status, 400);
  assert.equal((await c('POST', '/api/signup', { name: 'Ann Lee', phone: '0712000001', password: 'secret123', confirmPassword: 'secret123' })).status, 200);
  assert.equal((await client()('POST', '/api/signup', { name: 'Ann Two', phone: '+254712000001', password: 'secret123', confirmPassword: 'secret123' })).status, 409);
});

test('login: wrong password rejected, right one works, logout ends session', async () => {
  await newUser('0712000002');
  const c = client();
  assert.equal((await c('POST', '/api/login', { phone: '0712000002', password: 'nope-nope' })).status, 401);
  assert.equal((await c('POST', '/api/login', { phone: '0712000002', password: 'secret123' })).status, 200);
  assert.equal((await c('GET', '/api/me')).status, 200);
  await c('POST', '/api/logout');
  assert.equal((await c('GET', '/api/me')).status, 401);
});

test('deposit stays pending and does not change balance until admin approves', async () => {
  const u = await newUser('0712000003');
  const dep = await u('POST', '/api/deposits', { amount: 1000, lockDays: 30, mpesaCode: 'abc1234xyz' });
  assert.equal(dep.status, 200);
  assert.equal(dep.data.transaction.mpesaCode, 'ABC1234XYZ');
  assert.equal((await u('GET', '/api/me')).data.user.balance, 0);

  const a = await adminClient();
  assert.equal((await a('POST', `/api/admin/transactions/${dep.data.transaction.id}/approve`, {})).status, 200);
  const me = (await u('GET', '/api/me')).data.user;
  assert.equal(me.balance, 1000);
  assert.ok(me.lockActive);
  const days = (Date.parse(me.dueDate) - Date.now()) / 86400000;
  assert.ok(days > 29.9 && days <= 30);
});

test('deposit needs a lock period when none is running; duplicate codes blocked', async () => {
  const u = await newUser('0712000004');
  assert.equal((await u('POST', '/api/deposits', { amount: 500, mpesaCode: 'DUP1234567' })).status, 400);
  assert.equal((await u('POST', '/api/deposits', { amount: 500, lockDays: 3, mpesaCode: 'DUP1234567' })).status, 400); // below minimum lock
  assert.equal((await u('POST', '/api/deposits', { amount: 500, lockDays: 30, mpesaCode: 'DUP1234567' })).status, 200);
  assert.equal((await u('POST', '/api/deposits', { amount: 500, lockDays: 30, mpesaCode: 'dup1234567' })).status, 409);
  assert.equal((await u('POST', '/api/deposits', { amount: 500, lockDays: 30, mpesaCode: 'bad' })).status, 400);
  assert.equal((await u('POST', '/api/deposits', { amount: 10, lockDays: 30, mpesaCode: 'LOW1234567' })).status, 400);
});

test('THE LOCK: cannot withdraw before the due date', async () => {
  const { u } = await fundedUser('0712000005', 2000, 30, 'LOCK123456');
  const r = await u('POST', '/api/withdrawals', { amount: 500, password: 'secret123' });
  assert.equal(r.status, 403);
  assert.match(r.data.error, /locked until/i);
  assert.equal((await u('GET', '/api/me')).data.user.balance, 2000);
});

test('withdrawal works once due: holds money, admin pays, lock clears at zero', async () => {
  const { u, a } = await fundedUser('0712000006', 3000, 30, 'DUE1234567');
  const id = (await u('GET', '/api/me')).data.user.id;
  // Time passes: move the due date into the past directly in the DB.
  server.db.prepare('UPDATE users SET due_date = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), id);

  assert.equal((await u('POST', '/api/withdrawals', { amount: 1000, password: 'wrong-pass' })).status, 401);
  assert.equal((await u('POST', '/api/withdrawals', { amount: 99999, password: 'secret123' })).status, 400);
  const w = await u('POST', '/api/withdrawals', { amount: 3000, password: 'secret123' });
  assert.equal(w.status, 200, JSON.stringify(w.data));
  assert.equal(w.data.user.balance, 0);
  assert.equal((await u('POST', '/api/withdrawals', { amount: 1, password: 'secret123' })).status, 403); // nothing left

  assert.equal((await a('POST', `/api/admin/transactions/${w.data.transaction.id}/approve`, { mpesaCode: 'short' })).status, 400);
  assert.equal((await a('POST', `/api/admin/transactions/${w.data.transaction.id}/approve`, { mpesaCode: 'PAY1234567' })).status, 200);
  const me = (await u('GET', '/api/me')).data.user;
  assert.equal(me.balance, 0);
  assert.equal(me.dueDate, null);
});

test('rejected withdrawal returns the held money', async () => {
  const { u, a } = await fundedUser('0712000007', 1500, 30, 'REJ1234567');
  const id = (await u('GET', '/api/me')).data.user.id;
  server.db.prepare('UPDATE users SET due_date = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), id);
  const w = await u('POST', '/api/withdrawals', { amount: 1500, password: 'secret123' });
  assert.equal(w.data.user.balance, 0);
  assert.equal((await a('POST', `/api/admin/transactions/${w.data.transaction.id}/reject`, { reason: 'Wrong number' })).status, 200);
  assert.equal((await u('GET', '/api/me')).data.user.balance, 1500);
});

test('top-up can extend the lock but never shorten it', async () => {
  const { u, a } = await fundedUser('0712000008', 1000, 90, 'EXT1234567');
  const before = (await u('GET', '/api/me')).data.user.dueDate;
  const d = await u('POST', '/api/deposits', { amount: 500, lockDays: 10, mpesaCode: 'EXT7654321' });
  await a('POST', `/api/admin/transactions/${d.data.transaction.id}/approve`, {});
  const me = (await u('GET', '/api/me')).data.user;
  assert.equal(me.balance, 1500);
  assert.equal(me.dueDate, before); // 10 days < remaining 90 → unchanged
  const d2 = await u('POST', '/api/deposits', { amount: 500, lockDays: 365, mpesaCode: 'EXT1111111' });
  await a('POST', `/api/admin/transactions/${d2.data.transaction.id}/approve`, {});
  assert.ok(Date.parse((await u('GET', '/api/me')).data.user.dueDate) > Date.parse(before));
});

test('admin: can correct the credited amount, adjust, release early, freeze', async () => {
  const u = await newUser('0712000009');
  const a = await adminClient();
  const d = await u('POST', '/api/deposits', { amount: 5000, lockDays: 60, mpesaCode: 'ADM1234567' });
  await a('POST', `/api/admin/transactions/${d.data.transaction.id}/approve`, { amount: 4000 });
  const id = (await u('GET', '/api/me')).data.user.id;
  assert.equal((await u('GET', '/api/me')).data.user.balance, 4000);

  assert.equal((await a('POST', `/api/admin/users/${id}/adjust`, { amount: -100 })).status, 400); // reason required
  assert.equal((await a('POST', `/api/admin/users/${id}/adjust`, { amount: -9999, reason: 'too much' })).status, 400);
  assert.equal((await a('POST', `/api/admin/users/${id}/adjust`, { amount: 250, reason: 'Bonus' })).data.user.balance, 4250);

  assert.equal((await a('PATCH', `/api/admin/users/${id}`, { released: true, reason: 'Emergency' })).data.user.canWithdraw, true);
  assert.equal((await a('PATCH', `/api/admin/users/${id}`, { status: 'frozen' })).status, 200);
  assert.equal((await u('GET', '/api/me')).status, 401); // sessions killed
  const c = client();
  await c('POST', '/api/login', { phone: '0712000009', password: 'secret123' });
  assert.equal((await c('POST', '/api/withdrawals', { amount: 1, password: 'secret123' })).status, 403);

  const log = (await a('GET', '/api/admin/audit')).data.audit;
  assert.ok(log.some((e) => e.action === 'balance.adjust'));
  assert.ok(log.some((e) => e.action === 'deposit.approve'));
});

test('normal users cannot touch admin routes; anonymous gets 401', async () => {
  const u = await newUser('0712000010');
  assert.equal((await u('GET', '/api/admin/users')).status, 403);
  assert.equal((await u('POST', '/api/admin/transactions/1/approve', {})).status, 403);
  assert.equal((await client()('GET', '/api/admin/overview')).status, 401);
});

test('admin overview and CSV export are consistent', async () => {
  const a = await adminClient();
  const o = (await a('GET', '/api/admin/overview')).data;
  const sum = (await a('GET', '/api/admin/users')).data.users.reduce((s, x) => s + x.balance, 0);
  assert.equal(o.totalHeld, sum);
  assert.equal(o.locked + o.available, o.totalHeld);
  const res = await fetch(base + '/api/admin/export/transactions.csv', {
    headers: { Cookie: 'lc_session=' } });
  assert.equal(res.status, 401);
  assert.equal(L.csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
});

test('static files served; path traversal blocked; security headers present', async () => {
  const r = await fetch(base + '/../server/db.js');
  assert.ok([403, 404].includes(r.status));
  const r2 = await fetch(base + '/api/config');
  assert.equal(r2.status, 200);
  assert.ok(r2.headers.get('content-security-policy'));
});

test('invite code: signup blocked without it, allowed with it (any case)', async () => {
  const s2 = createServer({ ...loadConfig({}), dbFile: ':memory:', inviteCode: 'Family2026', signupsPerHour: 100 });
  await new Promise((r) => s2.listen(0, r));
  const url = `http://127.0.0.1:${s2.address().port}/api/signup`;
  const post = (inviteCode) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inviteCode, name: 'Fam Member', phone: '0733000001', password: 'secret123', confirmPassword: 'secret123' }) });
  assert.equal((await post(undefined)).status, 403);
  assert.equal((await post('wrong')).status, 403);
  assert.equal((await post('family2026')).status, 200);
  s2.close();
});

test('served under /lock-cash: prefix stripped, bare path redirects, cookie scoped', async () => {
  const s3 = createServer({ ...loadConfig({}), dbFile: ':memory:', basePath: '/lock-cash', signupsPerHour: 100 });
  await new Promise((r) => s3.listen(0, r));
  const o = `http://127.0.0.1:${s3.address().port}`;
  assert.equal((await fetch(o + '/lock-cash', { redirect: 'manual' })).status, 301);
  assert.equal((await fetch(o + '/lock-cash/login.html')).status, 200);
  assert.equal((await fetch(o + '/login.html')).status, 200); // proxy-stripped form also works
  const r = await fetch(o + '/lock-cash/api/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Path Test', phone: '0733000002', password: 'secret123', confirmPassword: 'secret123' }) });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('set-cookie'), /Path=\/lock-cash;/);
  s3.close();
});
