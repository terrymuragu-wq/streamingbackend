const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

const db = new Database(path.join(DATA_DIR, 'fitstream.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('client','coach','manager','admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','pending')),
  avatar_color TEXT DEFAULT '#6c5ce7',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  manager_id INTEGER UNIQUE NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS coaches (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  agency_id INTEGER REFERENCES agencies(id),
  bio TEXT DEFAULT '',
  specialty TEXT DEFAULT 'General Fitness',
  price_cents INTEGER DEFAULT 499,
  approved INTEGER DEFAULT 0,
  live_now INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS coach_applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  coach_id INTEGER NOT NULL REFERENCES users(id),
  agency_id INTEGER NOT NULL REFERENCES agencies(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  note TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS live_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  coach_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  price_cents INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','live','ended')),
  stream_url TEXT DEFAULT '',
  scheduled_at TEXT,
  started_at TEXT,
  ended_at TEXT,
  viewers INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS content (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  coach_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  type TEXT NOT NULL DEFAULT 'video',
  price_cents INTEGER DEFAULT 0,
  url TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES users(id),
  item_type TEXT NOT NULL CHECK(item_type IN ('live','content')),
  item_id INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(client_id, item_type, item_id)
);

CREATE TABLE IF NOT EXISTS tips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES users(id),
  coach_id INTEGER NOT NULL REFERENCES users(id),
  live_id INTEGER,
  amount_cents INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  live_id INTEGER NOT NULL REFERENCES live_sessions(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  text TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES users(id),
  coach_id INTEGER NOT NULL REFERENCES users(id),
  stars INTEGER NOT NULL CHECK(stars BETWEEN 1 AND 5),
  review TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(client_id, coach_id)
);

CREATE TABLE IF NOT EXISTS wallets (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  balance_cents INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  note TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  coach_id INTEGER NOT NULL REFERENCES users(id),
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  decided_by INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  text TEXT NOT NULL,
  read INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

// ---- helpers ----
function getWallet(userId) {
  db.prepare('INSERT OR IGNORE INTO wallets (user_id, balance_cents) VALUES (?, 0)').run(userId);
  return db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(userId);
}
function addTx(userId, kind, amountCents, note = '') {
  db.prepare('INSERT INTO transactions (user_id, kind, amount_cents, note) VALUES (?,?,?,?)')
    .run(userId, kind, amountCents, note);
}
function credit(userId, amountCents, kind, note = '') {
  getWallet(userId);
  db.prepare('UPDATE wallets SET balance_cents = balance_cents + ? WHERE user_id = ?').run(amountCents, userId);
  addTx(userId, kind, amountCents, note);
}
function debit(userId, amountCents, kind, note = '') {
  const w = getWallet(userId);
  if (w.balance_cents < amountCents) return false;
  db.prepare('UPDATE wallets SET balance_cents = balance_cents - ? WHERE user_id = ?').run(amountCents, userId);
  addTx(userId, kind, -amountCents, note);
  return true;
}
function notify(userId, text) {
  db.prepare('INSERT INTO notifications (user_id, text) VALUES (?,?)').run(userId, text);
}
function notifyAll(text, role = null) {
  const users = role
    ? db.prepare("SELECT id FROM users WHERE role = ? AND status = 'active'").all(role)
    : db.prepare("SELECT id FROM users WHERE status = 'active'").all();
  const ins = db.prepare('INSERT INTO notifications (user_id, text) VALUES (?,?)');
  for (const u of users) ins.run(u.id, text);
}
function publicUser(u) {
  if (!u) return null;
  const { password_hash, ...rest } = u;
  return rest;
}

module.exports = { db, DATA_DIR, getWallet, credit, debit, addTx, notify, notifyAll, publicUser };
