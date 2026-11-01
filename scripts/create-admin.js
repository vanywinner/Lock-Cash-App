'use strict';
// Usage: npm run create-admin -- 0712345678 "a-strong-password" "Your Name"
// Creates the admin, or promotes/resets an existing account with that phone number.
const { openDb } = require('../server/db');
const { loadConfig } = require('../server/server');
const L = require('../server/lib');

const [phoneArg, password, name = 'Admin'] = process.argv.slice(2);
const phone = L.normalisePhone(phoneArg);
if (!phone || !password) {
  console.error('Usage: npm run create-admin -- <phone> "<password>" ["Full name"]');
  process.exit(1);
}
try { L.checkPassword(password); } catch (e) { console.error(e.message); process.exit(1); }

const cfg = loadConfig();
require('node:fs').mkdirSync(require('node:path').dirname(cfg.dbFile), { recursive: true });
const db = openDb(cfg.dbFile);
const hash = L.hashPassword(password);
const existing = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
if (existing) {
  db.prepare("UPDATE users SET role='admin', pass_hash=?, status='active' WHERE id=?").run(hash, existing.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existing.id);
  console.log(`Updated ${L.displayPhone(phone)} → admin (password reset).`);
} else {
  db.prepare("INSERT INTO users (phone, name, pass_hash, role, created_at) VALUES (?,?,?, 'admin', ?)")
    .run(phone, L.cleanName(name), hash, new Date().toISOString());
  console.log(`Admin created: ${L.displayPhone(phone)}`);
}
