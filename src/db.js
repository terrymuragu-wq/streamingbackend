/**
 * AdultBlog - database layer (SQLite via better-sqlite3, WAL mode).
 * On Render: set env DB_PATH=/var/data/adultblog.db and attach a persistent Disk at /var/data
 * so data survives redeploys. Locally it defaults to ./data/adultblog.db.
 */
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

let DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'adultblog.db');
try {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
} catch (err) {
  // /var/data not writable (no Render disk attached yet) — fall back to ./data so the app still boots
  console.error(`[db] mkdir failed for ${path.dirname(DB_PATH)} (${err.code}); falling back to ./data — data will NOT persist across redeploys until a disk is attached`);
  DB_PATH = path.join(__dirname, '..', 'data', 'adultblog.db');
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('client','model','manager','admin')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','suspended','rejected')),
  dob TEXT,                       -- ISO date, must be >= 18 years old
  avatar TEXT,
  wallet_cents INTEGER NOT NULL DEFAULT 0,
  agency_id INTEGER,
  agency_approved INTEGER NOT NULL DEFAULT 0,   -- manager approval for models
  eligible INTEGER NOT NULL DEFAULT 0,          -- admin assessment passed (models)
  verified INTEGER NOT NULL DEFAULT 0,          -- ID + selfie verified
  restricted INTEGER NOT NULL DEFAULT 0,        -- admin restriction flag (clients)
  last_seen TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  id_type TEXT NOT NULL,            -- 'passport' | 'national_id' | 'drivers_license'
  id_number TEXT NOT NULL,
  dob_declared TEXT NOT NULL,       -- DOB read from the ID document
  id_file TEXT NOT NULL,            -- stored file path
  selfie_file TEXT NOT NULL,        -- stored file path
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  auto_checks TEXT,                 -- JSON of automated check results
  notes TEXT,
  reviewer_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT
);

CREATE TABLE IF NOT EXISTS agencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,        -- models join with this code
  name TEXT NOT NULL,
  manager_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS model_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  display_name TEXT,
  bio TEXT,
  category TEXT DEFAULT 'general',
  rate_per_min_cents INTEGER DEFAULT 0,
  sub_price_cents INTEGER DEFAULT 1999,
  is_live INTEGER NOT NULL DEFAULT 0,
  live_title TEXT,
  total_earned_cents INTEGER NOT NULL DEFAULT 0,
  avg_rating REAL DEFAULT 0,
  rating_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS lives (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  price_cents INTEGER NOT NULL DEFAULT 0,  -- 0 = subscribers only
  scheduled_at TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','live','ended','cancelled')),
  started_at TEXT,
  ended_at TEXT,
  peak_viewers INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS live_access (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  live_id INTEGER NOT NULL REFERENCES lives(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  paid_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(live_id, user_id)
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id INTEGER NOT NULL REFERENCES users(id),
  client_id INTEGER NOT NULL REFERENCES users(id),
  price_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(model_id, client_id)
);

CREATE TABLE IF NOT EXISTS content (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'video' CHECK(kind IN ('video','image','audio')),
  file_path TEXT NOT NULL,
  price_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS content_unlocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_id INTEGER NOT NULL REFERENCES content(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  paid_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(content_id, user_id)
);

CREATE TABLE IF NOT EXISTS tips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user INTEGER NOT NULL REFERENCES users(id),
  to_model INTEGER NOT NULL REFERENCES users(id),
  live_id INTEGER,
  amount_cents INTEGER NOT NULL,
  message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id INTEGER NOT NULL REFERENCES users(id),
  client_id INTEGER NOT NULL REFERENCES users(id),
  live_id INTEGER,
  stars INTEGER NOT NULL CHECK(stars BETWEEN 1 AND 5),
  comment TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(model_id, client_id, live_id)
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,     -- topup|subscribe|live_ticket|tip|content_unlock|payout|fee|earning
  amount_cents INTEGER NOT NULL,   -- signed
  ref TEXT,
  meta TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id INTEGER NOT NULL REFERENCES users(id),
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_manager'
    CHECK(status IN ('pending_manager','pending_admin','paid','rejected')),
  manager_note TEXT,
  admin_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS directives (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id INTEGER NOT NULL REFERENCES users(id),
  from_role TEXT NOT NULL,          -- 'manager' | 'admin'
  to_model INTEGER NOT NULL REFERENCES users(id),
  message TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  link TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  live_id INTEGER NOT NULL REFERENCES lives(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER,
  action TEXT NOT NULL,
  target TEXT,
  meta TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// ---------- settings helpers ----------
const getSetting = (k, d) => {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k);
  return r ? r.value : d;
};
const setSetting = (k, v) =>
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));

if (!getSetting('platform_fee_pct')) setSetting('platform_fee_pct', '20');
if (!getSetting('min_withdraw_cents')) setSetting('min_withdraw_cents', '5000');
if (!getSetting('min_age')) setSetting('min_age', '18');

// ---------- seed admin ----------
function seedAdmin() {
  const email = (process.env.ADMIN_EMAIL || 'admin@adultblog.com').toLowerCase();
  const password = process.env.ADMIN_PASSWORD || 'Admin@12345';
  const exists = db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get();
  if (!exists) {
    db.prepare(`INSERT INTO users(email,pass_hash,name,role,status,verified,eligible)
                VALUES(?,?,?,?, 'active',1,1)`)
      .run(email, bcrypt.hashSync(password, 10), 'Platform Admin', 'admin');
    console.log(`[seed] admin created: ${email} (change ADMIN_EMAIL/ADMIN_PASSWORD in production)`);
  }
}
seedAdmin();

// ---------- generic helpers ----------
const q = {
  get: (sql, ...a) => db.prepare(sql).get(...a),
  all: (sql, ...a) => db.prepare(sql).all(...a),
  run: (sql, ...a) => db.prepare(sql).run(...a),
  tx: (fn) => db.transaction(fn),
};

function notify(userId, type, message, link) {
  q.run('INSERT INTO notifications(user_id,type,message,link) VALUES(?,?,?,?)', userId, type, message, link || null);
}

function audit(actorId, action, target, meta) {
  q.run('INSERT INTO audit_log(actor_id,action,target,meta) VALUES(?,?,?,?)',
    actorId || null, action, target || null, meta ? JSON.stringify(meta) : null);
}

/** Move money from a paying user to a model, taking the platform fee. */
function creditModel(modelId, grossCents, kind, ref) {
  const feePct = parseInt(getSetting('platform_fee_pct', '20'), 10);
  const fee = Math.round(grossCents * feePct / 100);
  const net = grossCents - fee;
  q.run('UPDATE users SET wallet_cents = wallet_cents + ? WHERE id=?', net, modelId);
  q.run(`UPDATE model_profiles SET total_earned_cents = total_earned_cents + ? WHERE user_id=?`, net, modelId);
  q.run('INSERT INTO transactions(user_id,kind,amount_cents,ref) VALUES(?,?,?,?)', modelId, 'earning', net, ref);
  q.run('INSERT INTO transactions(user_id,kind,amount_cents,ref) VALUES(?,?,?,?)', modelId, 'fee', -fee, ref);
  return { fee, net };
}

function debitWallet(userId, cents, kind, ref) {
  const u = q.get('SELECT wallet_cents FROM users WHERE id=?', userId);
  if (!u || u.wallet_cents < cents) return false;
  q.run('UPDATE users SET wallet_cents = wallet_cents - ? WHERE id=?', cents, userId);
  q.run('INSERT INTO transactions(user_id,kind,amount_cents,ref) VALUES(?,?,?,?)', userId, kind, -cents, ref);
  return true;
}

module.exports = { db, q, notify, audit, getSetting, setSetting, creditModel, debitWallet };
