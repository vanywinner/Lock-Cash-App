'use strict';
const L = require('./lib');
const { HttpError } = L;
const { tx } = require('./db');

const DAY = 86400000;
const nowIso = () => new Date().toISOString();

/**
 * All routes. Each handler gets ctx = { db, cfg, user, body, params, query, ip, setSession, clearSession }
 * and returns JSON-able data (or { csv, filename }).
 */
function buildRoutes({ db, cfg }) {
  const routes = [];
  const limiter = L.createLimiter();
  const add = (method, path, auth, handler) => {
    const keys = [];
    const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    routes.push({ method, re, keys, auth, handler });
  };

  /* ---------- helpers ---------- */

  const audit = (actorId, action, targetId, detail) =>
    db.prepare('INSERT INTO audit (actor_id, action, target_id, detail, created_at) VALUES (?,?,?,?,?)')
      .run(actorId, action, targetId ?? null, detail ? JSON.stringify(detail) : null, nowIso());

  const getUser = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

  const isLockActive = (u) => !!u.due_date && Date.parse(u.due_date) > Date.now();
  const canWithdrawNow = (u) =>
    u.balance > 0 && u.status === 'active' && (u.released === 1 || (!!u.due_date && Date.parse(u.due_date) <= Date.now()));

  const publicUser = (u) => ({
    id: u.id,
    name: u.name,
    phone: u.phone,
    phoneDisplay: L.displayPhone(u.phone),
    role: u.role,
    status: u.status,
    balance: u.balance,
    dueDate: u.due_date,
    released: u.released === 1,
    lockActive: isLockActive(u) && u.released !== 1,
    canWithdraw: canWithdrawNow(u),
    createdAt: u.created_at,
  });

  const txRow = (r) => ({
    id: r.id, userId: r.user_id, type: r.type, amount: r.amount, status: r.status,
    mpesaCode: r.mpesa_code, lockDays: r.lock_days, note: r.note,
    createdAt: r.created_at, resolvedAt: r.resolved_at,
    ...(r.phone ? { phone: L.displayPhone(r.phone), name: r.name } : {}),
  });

  const startSession = (ctx, userId, role) => {
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso());
    const token = L.newToken();
    const hours = role === 'admin' ? 8 : 24 * 7;
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)')
      .run(L.sha256(token), userId, new Date(Date.now() + hours * 3600000).toISOString());
    ctx.setSession(token, hours * 3600);
  };

  const requireObject = (body) => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Invalid request.');
    return body;
  };

  /* ---------- public ---------- */

  add('GET', '/api/config', false, () => ({
    appName: cfg.appName,
    pochiPhone: cfg.pochiPhone,
    pochiName: cfg.pochiName,
    supportPhone: cfg.supportPhone,
    minDeposit: cfg.minDeposit,
    maxDeposit: cfg.maxDeposit,
    minLockDays: cfg.minLockDays,
    maxLockDays: cfg.maxLockDays,
    inviteRequired: !!cfg.inviteCode,
  }));

  add('POST', '/api/signup', false, (ctx) => {
    limiter.hit(`signup:${ctx.ip}`, cfg.signupsPerHour, 3600000);
    const b = requireObject(ctx.body);
    if (cfg.inviteCode && String(b.inviteCode ?? '').trim().toLowerCase() !== cfg.inviteCode.toLowerCase()) {
      throw new HttpError(403, 'That family invite code is not correct. Ask the admin for the code.');
    }
    const name = L.cleanName(b.name);
    const phone = L.normalisePhone(b.phone);
    if (!phone) throw new HttpError(400, 'Enter a valid Safaricom/Airtel number, e.g. 0712 345 678.');
    L.checkPassword(b.password);
    if (b.password !== b.confirmPassword) throw new HttpError(400, 'Passwords do not match.');
    if (db.prepare('SELECT 1 FROM users WHERE phone = ?').get(phone)) {
      throw new HttpError(409, 'An account with this phone number already exists. Try logging in.');
    }
    const res = db.prepare('INSERT INTO users (phone, name, pass_hash, created_at) VALUES (?,?,?,?)')
      .run(phone, name, L.hashPassword(b.password), nowIso());
    startSession(ctx, Number(res.lastInsertRowid), 'user');
    return { user: publicUser(getUser(res.lastInsertRowid)) };
  });

  add('POST', '/api/login', false, (ctx) => {
    const b = requireObject(ctx.body);
    const phone = L.normalisePhone(b.phone);
    const key = `login:${ctx.ip}:${phone || 'x'}`;
    limiter.hit(key, 8, 15 * 60000);
    const u = phone && db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
    // Always run a hash comparison so timing does not reveal whether the phone exists.
    const ok = L.verifyPassword(String(b.password ?? ''), u ? u.pass_hash : 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86) + '==');
    if (!u || !ok) throw new HttpError(401, 'Wrong phone number or password.');
    limiter.clear(key);
    startSession(ctx, u.id, u.role);
    return { user: publicUser(u) };
  });

  add('POST', '/api/logout', false, (ctx) => {
    if (ctx.tokenHash) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(ctx.tokenHash);
    ctx.clearSession();
    return { ok: true };
  });

  /* ---------- signed-in user ---------- */

  add('GET', '/api/me', 'user', (ctx) => ({ user: publicUser(getUser(ctx.user.id)) }));

  add('GET', '/api/transactions', 'user', (ctx) => ({
    transactions: db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 50')
      .all(ctx.user.id).map(txRow),
  }));

  add('POST', '/api/deposits', 'user', (ctx) => {
    const b = requireObject(ctx.body);
    limiter.hit(`deposit:${ctx.user.id}`, 15, 3600000);
    const u = getUser(ctx.user.id);
    if (u.status !== 'active') throw new HttpError(403, 'Your account is frozen. Please contact support.');
    const amount = L.wholeNumber(b.amount, cfg.minDeposit, cfg.maxDeposit, 'Amount');
    const code = L.mpesaCode(b.mpesaCode);

    // A new lock length is required unless a lock is already running (then it can only be extended).
    const hasRunningLock = isLockActive(u) && u.released !== 1;
    let lockDays = null;
    if (b.lockDays !== undefined && b.lockDays !== null && b.lockDays !== '') {
      lockDays = L.wholeNumber(b.lockDays, cfg.minLockDays, cfg.maxLockDays, 'Lock period (days)');
    } else if (!hasRunningLock) {
      throw new HttpError(400, 'Choose how long to lock this money.');
    }
    try {
      const res = db.prepare(
        `INSERT INTO transactions (user_id, type, amount, status, mpesa_code, lock_days, created_at)
         VALUES (?, 'deposit', ?, 'pending', ?, ?, ?)`
      ).run(u.id, amount, code, lockDays, nowIso());
      return { transaction: txRow(db.prepare('SELECT * FROM transactions WHERE id = ?').get(res.lastInsertRowid)) };
    } catch (e) {
      if (/UNIQUE/i.test(String(e.message))) throw new HttpError(409, 'That M-Pesa code has already been submitted.');
      throw e;
    }
  });

  add('POST', '/api/withdrawals', 'user', (ctx) => {
    const b = requireObject(ctx.body);
    limiter.hit(`withdraw:${ctx.user.id}`, 10, 3600000);
    return tx(db, () => {
      const u = getUser(ctx.user.id);
      if (!L.verifyPassword(String(b.password ?? ''), u.pass_hash)) throw new HttpError(401, 'Wrong password.');
      if (u.status !== 'active') throw new HttpError(403, 'Your account is frozen. Please contact support.');
      if (!canWithdrawNow(u)) {
        throw new HttpError(403, u.due_date
          ? `Your savings are locked until ${new Date(u.due_date).toLocaleDateString('en-KE', { dateStyle: 'long', timeZone: 'Africa/Nairobi' })}.`
          : 'You have no savings to withdraw.');
      }
      if (db.prepare("SELECT 1 FROM transactions WHERE user_id = ? AND type='withdrawal' AND status='pending'").get(u.id)) {
        throw new HttpError(409, 'You already have a withdrawal waiting to be paid.');
      }
      const amount = L.wholeNumber(b.amount, 1, u.balance, 'Amount');
      // Money is held (removed from balance) at once; it returns if the admin rejects.
      db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(amount, u.id);
      const res = db.prepare(
        `INSERT INTO transactions (user_id, type, amount, status, created_at) VALUES (?, 'withdrawal', ?, 'pending', ?)`
      ).run(u.id, amount, nowIso());
      return { transaction: txRow(db.prepare('SELECT * FROM transactions WHERE id = ?').get(res.lastInsertRowid)), user: publicUser(getUser(u.id)) };
    });
  });

  /* ---------- admin ---------- */

  add('GET', '/api/admin/overview', 'admin', () => {
    const now = nowIso();
    const one = (sql, ...p) => db.prepare(sql).get(...p);
    const users = one("SELECT COUNT(*) n, COALESCE(SUM(balance),0) total FROM users WHERE role='user'");
    const locked = one("SELECT COALESCE(SUM(balance),0) s FROM users WHERE role='user' AND released=0 AND due_date > ?", now);
    const pd = one("SELECT COUNT(*) n, COALESCE(SUM(amount),0) s FROM transactions WHERE type='deposit' AND status='pending'");
    const pw = one("SELECT COUNT(*) n, COALESCE(SUM(amount),0) s FROM transactions WHERE type='withdrawal' AND status='pending'");
    const dep = one("SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE type='deposit' AND status='completed'");
    const paid = one("SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE type='withdrawal' AND status='completed'");
    const soon = one("SELECT COUNT(*) n FROM users WHERE role='user' AND balance>0 AND due_date BETWEEN ? AND ?",
      now, new Date(Date.now() + 7 * DAY).toISOString());
    return {
      users: users.n,
      totalHeld: users.total,
      locked: locked.s,
      available: users.total - locked.s,
      pendingDeposits: { count: pd.n, amount: pd.s },
      pendingWithdrawals: { count: pw.n, amount: pw.s },
      totalDeposited: dep.s,
      totalPaidOut: paid.s,
      dueThisWeek: soon.n,
    };
  });

  add('GET', '/api/admin/users', 'admin', (ctx) => {
    const q = String(ctx.query.get('q') || '').trim();
    const rows = q
      ? db.prepare("SELECT * FROM users WHERE role='user' AND (phone LIKE ? OR name LIKE ?) ORDER BY id DESC LIMIT 500")
          .all(`%${q.replace(/[^\d]/g, '') || '\u0000'}%`, `%${q}%`)
      : db.prepare("SELECT * FROM users WHERE role='user' ORDER BY id DESC LIMIT 500").all();
    return { users: rows.map(publicUser) };
  });

  add('GET', '/api/admin/users/:id', 'admin', (ctx) => {
    const u = getUser(Number(ctx.params.id));
    if (!u || u.role !== 'user') throw new HttpError(404, 'User not found.');
    return {
      user: publicUser(u),
      transactions: db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(u.id).map(txRow),
    };
  });

  add('PATCH', '/api/admin/users/:id', 'admin', (ctx) => {
    const b = requireObject(ctx.body);
    return tx(db, () => {
      const u = getUser(Number(ctx.params.id));
      if (!u || u.role !== 'user') throw new HttpError(404, 'User not found.');
      const changes = {};
      if (b.status !== undefined) {
        if (!['active', 'frozen'].includes(b.status)) throw new HttpError(400, 'Invalid status.');
        changes.status = b.status;
      }
      if (b.released !== undefined) changes.released = b.released ? 1 : 0;
      if (b.dueDate !== undefined) {
        if (b.dueDate === null) changes.due_date = null;
        else {
          const t = Date.parse(b.dueDate);
          if (Number.isNaN(t)) throw new HttpError(400, 'Invalid due date.');
          changes.due_date = new Date(t).toISOString();
        }
      }
      if (b.name !== undefined) changes.name = L.cleanName(b.name);
      const cols = Object.keys(changes);
      if (!cols.length) throw new HttpError(400, 'Nothing to change.');
      db.prepare(`UPDATE users SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => changes[c]), u.id);
      if (changes.status === 'frozen') db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
      audit(ctx.user.id, 'user.update', u.id, { reason: String(b.reason || '').slice(0, 200), changes, before: { status: u.status, due_date: u.due_date, released: u.released } });
      return { user: publicUser(getUser(u.id)) };
    });
  });

  add('POST', '/api/admin/users/:id/adjust', 'admin', (ctx) => {
    const b = requireObject(ctx.body);
    return tx(db, () => {
      const u = getUser(Number(ctx.params.id));
      if (!u || u.role !== 'user') throw new HttpError(404, 'User not found.');
      const amount = typeof b.amount === 'string' ? Number(b.amount) : b.amount;
      if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 10000000) throw new HttpError(400, 'Enter a non-zero whole amount (use a minus sign to deduct).');
      const reason = String(b.reason || '').trim();
      if (reason.length < 3) throw new HttpError(400, 'A reason is required for balance adjustments.');
      if (u.balance + amount < 0) throw new HttpError(400, 'That would make the balance negative.');
      db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(amount, u.id);
      db.prepare(`INSERT INTO transactions (user_id, type, amount, status, note, created_at, resolved_at, resolved_by)
                  VALUES (?, 'adjustment', ?, 'completed', ?, ?, ?, ?)`).run(u.id, amount, reason.slice(0, 200), nowIso(), nowIso(), ctx.user.id);
      audit(ctx.user.id, 'balance.adjust', u.id, { amount, reason: reason.slice(0, 200), from: u.balance, to: u.balance + amount });
      return { user: publicUser(getUser(u.id)) };
    });
  });

  add('POST', '/api/admin/users/:id/password', 'admin', (ctx) => {
    const b = requireObject(ctx.body);
    const u = getUser(Number(ctx.params.id));
    if (!u || u.role !== 'user') throw new HttpError(404, 'User not found.');
    L.checkPassword(b.password);
    db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(L.hashPassword(b.password), u.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    audit(ctx.user.id, 'user.password_reset', u.id, null);
    return { ok: true };
  });

  add('GET', '/api/admin/transactions', 'admin', (ctx) => {
    const where = []; const p = [];
    const status = ctx.query.get('status'); const type = ctx.query.get('type'); const uid = ctx.query.get('userId');
    if (status) { where.push('t.status = ?'); p.push(status); }
    if (type) { where.push('t.type = ?'); p.push(type); }
    if (uid) { where.push('t.user_id = ?'); p.push(Number(uid)); }
    const rows = db.prepare(
      `SELECT t.*, u.phone, u.name FROM transactions t JOIN users u ON u.id = t.user_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.id DESC LIMIT 300`
    ).all(...p);
    return { transactions: rows.map(txRow) };
  });

  add('POST', '/api/admin/transactions/:id/approve', 'admin', (ctx) => {
    const b = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
    return tx(db, () => {
      const t = db.prepare('SELECT * FROM transactions WHERE id = ?').get(Number(ctx.params.id));
      if (!t || t.status !== 'pending') throw new HttpError(404, 'No pending transaction with that id.');
      const u = getUser(t.user_id);
      const now = nowIso();

      if (t.type === 'deposit') {
        // Admin may correct the amount to what actually arrived in Pochi.
        const amount = b.amount !== undefined && b.amount !== '' ? L.wholeNumber(b.amount, 1, cfg.maxDeposit, 'Amount') : t.amount;
        let due = u.due_date;
        let released = u.released;
        if (t.lock_days) {
          const candidate = Date.now() + t.lock_days * DAY;
          const runningUntil = u.due_date && u.released !== 1 ? Date.parse(u.due_date) : 0;
          due = new Date(Math.max(candidate, runningUntil)).toISOString();
          released = 0;
        }
        db.prepare('UPDATE users SET balance = balance + ?, due_date = ?, released = ? WHERE id = ?').run(amount, due, released, u.id);
        db.prepare("UPDATE transactions SET status='completed', amount=?, resolved_at=?, resolved_by=? WHERE id=?").run(amount, now, ctx.user.id, t.id);
        audit(ctx.user.id, 'deposit.approve', u.id, { txId: t.id, requested: t.amount, credited: amount, code: t.mpesa_code, dueDate: due });
      } else if (t.type === 'withdrawal') {
        // Admin has paid the user out by M-Pesa and records the reference.
        const ref = L.mpesaCode(b.mpesaCode);
        db.prepare("UPDATE transactions SET status='completed', mpesa_code=?, resolved_at=?, resolved_by=? WHERE id=?").run(ref, now, ctx.user.id, t.id);
        if (u.balance === 0) db.prepare('UPDATE users SET due_date = NULL, released = 0 WHERE id = ?').run(u.id);
        audit(ctx.user.id, 'withdrawal.paid', u.id, { txId: t.id, amount: t.amount, ref });
      } else {
        throw new HttpError(400, 'This transaction cannot be approved.');
      }
      return { ok: true };
    });
  });

  add('POST', '/api/admin/transactions/:id/reject', 'admin', (ctx) => {
    const b = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
    return tx(db, () => {
      const t = db.prepare('SELECT * FROM transactions WHERE id = ?').get(Number(ctx.params.id));
      if (!t || t.status !== 'pending') throw new HttpError(404, 'No pending transaction with that id.');
      const reason = String(b.reason || '').trim().slice(0, 200);
      if (reason.length < 3) throw new HttpError(400, 'Give the user a short reason.');
      db.prepare("UPDATE transactions SET status='rejected', note=?, resolved_at=?, resolved_by=? WHERE id=?").run(reason, nowIso(), ctx.user.id, t.id);
      if (t.type === 'withdrawal') db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(t.amount, t.user_id); // return held money
      audit(ctx.user.id, `${t.type}.reject`, t.user_id, { txId: t.id, amount: t.amount, reason });
      return { ok: true };
    });
  });

  add('GET', '/api/admin/audit', 'admin', () => ({
    audit: db.prepare(
      `SELECT a.*, actor.name AS actor_name, target.phone AS target_phone, target.name AS target_name
       FROM audit a LEFT JOIN users actor ON actor.id = a.actor_id LEFT JOIN users target ON target.id = a.target_id
       ORDER BY a.id DESC LIMIT 200`
    ).all().map((r) => ({
      id: r.id, action: r.action, actor: r.actor_name, createdAt: r.created_at,
      target: r.target_phone ? `${r.target_name} (${L.displayPhone(r.target_phone)})` : null,
      detail: r.detail ? JSON.parse(r.detail) : null,
    })),
  }));

  add('GET', '/api/admin/export/transactions.csv', 'admin', () => {
    const rows = db.prepare(
      `SELECT t.*, u.phone, u.name FROM transactions t JOIN users u ON u.id = t.user_id ORDER BY t.id DESC`
    ).all();
    const head = ['id', 'date', 'name', 'phone', 'type', 'amount_kes', 'status', 'mpesa_code', 'note'];
    const lines = [head.join(',')].concat(rows.map((r) =>
      [r.id, r.created_at, r.name, L.displayPhone(r.phone), r.type, r.amount, r.status, r.mpesa_code, r.note].map(L.csvCell).join(',')));
    return { csv: lines.join('\n') + '\n', filename: `lock-cash-transactions-${new Date().toISOString().slice(0, 10)}.csv` };
  });

  return routes;
}

module.exports = { buildRoutes };
