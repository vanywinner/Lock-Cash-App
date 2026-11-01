'use strict';
const crypto = require('node:crypto');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/* ---------- passwords & tokens ---------- */

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltB64, hashB64] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const newToken = () => crypto.randomBytes(32).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/* ---------- validation ---------- */

/** Accepts 07XX, 01XX, +2547XX, 2547XX, 7XX... and returns 2547XXXXXXXX / 2541XXXXXXXX. */
function normalisePhone(input) {
  const digits = String(input ?? '').replace(/[\s\-().+]/g, '');
  if (!/^\d+$/.test(digits)) return null;
  let local;
  if (/^254[17]\d{8}$/.test(digits)) local = digits.slice(3);
  else if (/^0[17]\d{8}$/.test(digits)) local = digits.slice(1);
  else if (/^[17]\d{8}$/.test(digits)) local = digits;
  else return null;
  return '254' + local;
}

/** 2547XXXXXXXX -> 07XX XXX XXX */
function displayPhone(p) {
  const l = '0' + String(p).slice(3);
  return `${l.slice(0, 4)} ${l.slice(4, 7)} ${l.slice(7)}`;
}

function cleanName(input) {
  const name = String(input ?? '').replace(/\s+/g, ' ').trim();
  if (name.length < 2 || name.length > 60) throw new HttpError(400, 'Enter your full name (2–60 characters).');
  return name;
}

function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8 || pw.length > 64) {
    throw new HttpError(400, 'Password must be 8–64 characters.');
  }
  return pw;
}

function wholeNumber(value, min, max, label) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new HttpError(400, `${label} must be a whole number between ${min.toLocaleString('en-KE')} and ${max.toLocaleString('en-KE')}.`);
  }
  return n;
}

/** M-Pesa confirmation codes are 10 characters, letters and digits (e.g. SJK1ABCD23). */
function mpesaCode(value) {
  const code = String(value ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(code)) {
    throw new HttpError(400, 'Enter the 10-character M-Pesa confirmation code from your SMS.');
  }
  return code;
}

/** Cell-safe CSV value (blocks spreadsheet formula injection). */
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/* ---------- tiny in-memory rate limiter ---------- */

function createLimiter() {
  const hits = new Map();
  return {
    /** Throws 429 once `max` hits occur inside `windowMs` for this key. */
    hit(key, max, windowMs) {
      const now = Date.now();
      let e = hits.get(key);
      if (!e || e.reset <= now) e = { count: 0, reset: now + windowMs };
      e.count += 1;
      hits.set(key, e);
      if (e.count > max) {
        throw new HttpError(429, `Too many attempts. Try again in ${Math.ceil((e.reset - now) / 60000)} minute(s).`);
      }
    },
    clear(key) { hits.delete(key); },
  };
}

module.exports = {
  HttpError, hashPassword, verifyPassword, newToken, sha256,
  normalisePhone, displayPhone, cleanName, checkPassword, wholeNumber, mpesaCode, csvCell, createLimiter,
};
