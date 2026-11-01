'use strict';
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  phone       TEXT NOT NULL UNIQUE,            -- normalised 2547XXXXXXXX
  name        TEXT NOT NULL,
  pass_hash   TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen')),
  balance     INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),   -- whole KES
  due_date    TEXT,                            -- ISO UTC; NULL = no lock set
  released    INTEGER NOT NULL DEFAULT 0,      -- admin early-release flag
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  type         TEXT NOT NULL CHECK (type IN ('deposit','withdrawal','adjustment')),
  amount       INTEGER NOT NULL,               -- adjustments may be negative
  status       TEXT NOT NULL CHECK (status IN ('pending','completed','rejected')),
  mpesa_code   TEXT,                           -- user's code (deposit) / admin payout ref (withdrawal)
  lock_days    INTEGER,                        -- requested lock length for a deposit
  note         TEXT,
  created_at   TEXT NOT NULL,
  resolved_at  TEXT,
  resolved_by  INTEGER REFERENCES users(id)
);
-- A deposit code can be used once (a rejected one may be re-submitted).
CREATE UNIQUE INDEX IF NOT EXISTS ux_deposit_code
  ON transactions(mpesa_code) WHERE type = 'deposit' AND status <> 'rejected';
CREATE INDEX IF NOT EXISTS ix_tx_user ON transactions(user_id, id DESC);
CREATE INDEX IF NOT EXISTS ix_tx_status ON transactions(status, type);

CREATE TABLE IF NOT EXISTS audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id   INTEGER REFERENCES users(id),
  action     TEXT NOT NULL,
  target_id  INTEGER REFERENCES users(id),
  detail     TEXT,
  created_at TEXT NOT NULL
);
`;

function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

/** Run fn inside one atomic transaction; any throw rolls everything back. */
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { openDb, tx };
