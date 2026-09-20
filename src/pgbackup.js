/**
 * AdultBlog - Neon PostgreSQL backup / restore layer.
 *
 * The app continues to run on its local SQLite database (zero changes to the
 * rest of the codebase). This module mirrors ALL data to Neon PostgreSQL:
 *
 *  - BACKUP:  every SYNC_INTERVAL_MS (default 4 minutes) every table is
 *             upserted into Neon, and rows deleted locally are removed there too,
 *             so Neon is always an exact, current copy of the admin panel data.
 *  - RESTORE: on boot, if the local SQLite DB has lost its data (fresh deploy,
 *             lost disk, wiped instance), everything is pulled back from Neon
 *             immediately, before the server starts accepting traffic.
 *  - WATCHER: after every successful backup the local DB is checked; if data
 *             disappeared since the last sync it is restored on the spot.
 *  - KEEP-ALIVE: pings SELF_URL/api/health every 4 minutes so the Render
 *             instance (and therefore the admin panel) never goes to sleep.
 *
 * Required env: DATABASE_URL (Neon connection string).
 * Optional env: SYNC_INTERVAL_MS (default 240000 = 4 min),
 *               SELF_URL (public Render URL, e.g. https://your-app.onrender.com).
 */
const { db, q } = require('./db');

const DATABASE_URL = process.env.DATABASE_URL || '';
const SYNC_MS = parseInt(process.env.SYNC_INTERVAL_MS || '240000', 10); // 4 minutes
const PORT = process.env.PORT || 3000;
const SELF_URL = (process.env.SELF_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

// Every table mirrored to Neon, in FK-safe restore order.
const TABLES = [
  'settings', 'users', 'agencies', 'verifications', 'model_profiles',
  'lives', 'live_access', 'subscriptions', 'content', 'content_unlocks',
  'tips', 'ratings', 'transactions', 'withdrawals', 'directives',
  'notifications', 'chat', 'audit_log',
];

let pg = null;
let busy = false;
const lastCounts = new Map(); // table -> row count at last successful backup

async function connect() {
  if (!DATABASE_URL) {
    console.log('[pgbackup] DATABASE_URL not set — Neon backup disabled (running on local SQLite only)');
    return false;
  }
  try {
    const { Client } = require('pg');
    pg = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await pg.connect();
    await pg.query(`CREATE TABLE IF NOT EXISTS app_backup (
      table_name TEXT NOT NULL,
      row_id TEXT NOT NULL,
      data JSONB NOT NULL,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (table_name, row_id)
    )`);
    console.log('[pgbackup] connected to Neon PostgreSQL');
    return true;
  } catch (e) {
    console.error('[pgbackup] Neon connection failed:', e.message);
    pg = null;
    return false;
  }
}

const pkOf = (table) => {
  const col = db.prepare(`PRAGMA table_info(${table})`).all().find(c => c.pk);
  return col ? col.name : 'rowid';
};

/** Push a full mirror of the local SQLite DB to Neon (upsert + prune deleted rows). */
async function backup() {
  for (const t of TABLES) {
    const pk = pkOf(t);
    const rows = db.prepare(`SELECT * FROM ${t}`).all();
    const ids = [];
    for (const r of rows) {
      const id = String(r[pk]);
      ids.push(id);
      await pg.query(
        'INSERT INTO app_backup(table_name,row_id,data,synced_at) VALUES($1,$2,$3,now()) ' +
        'ON CONFLICT (table_name,row_id) DO UPDATE SET data=EXCLUDED.data, synced_at=now()',
        [t, id, JSON.stringify(r)]
      );
    }
    // remove rows that were deleted locally so Neon stays an exact mirror
    if (ids.length) {
      await pg.query('DELETE FROM app_backup WHERE table_name=$1 AND NOT (row_id = ANY($2))', [t, ids]);
    } else {
      await pg.query('DELETE FROM app_backup WHERE table_name=$1', [t]);
    }
    lastCounts.set(t, rows.length);
  }
  console.log(`[pgbackup] backup complete at ${new Date().toISOString()}`);
}

/** Pull everything back from Neon into the local SQLite DB. */
async function restore(reason) {
  const probe = await pg.query('SELECT 1 FROM app_backup LIMIT 1');
  if (!probe.rows.length) { console.log('[pgbackup] nothing in Neon to restore'); return false; }
  console.log(`[pgbackup] RESTORING data from Neon (${reason})...`);
  for (const t of TABLES) {
    const r = await pg.query('SELECT row_id, data FROM app_backup WHERE table_name=$1', [t]);
    if (!r.rows.length) continue;
    const insert = db.transaction((rows) => {
      for (const row of rows) {
        const d = row.data;
        const keys = Object.keys(d);
        db.prepare(
          `INSERT OR REPLACE INTO ${t}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`
        ).run(...keys.map(k => d[k]));
      }
    });
    insert(r.rows);
    lastCounts.set(t, r.rows.length);
    console.log(`[pgbackup] restored ${r.rows.length} row(s) into ${t}`);
  }
  console.log('[pgbackup] restore complete');
  return true;
}

/** True when the local DB has lost data (no users at all, or a table shrank since last sync). */
function dataLost() {
  try {
    if (!q.get('SELECT id FROM users LIMIT 1')) return true;
    for (const [t, n] of lastCounts) {
      if (n > 0) {
        const c = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
        if (c < n) return true;
      }
    }
  } catch (e) { return false; }
  return false;
}

/** Keep the Render instance awake + verify the API (admin panel backend) is alive. */
async function keepAlive() {
  try {
    const r = await fetch(SELF_URL + '/api/health');
    if (!r.ok) console.error(`[pgbackup] keep-alive ping got HTTP ${r.status}`);
  } catch (e) {
    console.error('[pgbackup] keep-alive ping failed:', e.message);
  }
}

async function cycle() {
  if (busy || !pg) return;
  busy = true;
  try {
    if (dataLost()) {
      await restore('local data loss detected by watcher');
    }
    await backup();
    await keepAlive();
  } catch (e) {
    console.error('[pgbackup] sync cycle error:', e.message);
    if (e && /connection|terminat|ECONN|ETIMEDOUT|timeout/i.test(String(e.message))) {
      try { await pg.end().catch(() => {}); } catch (_) {}
      await connect();
    }
  } finally {
    busy = false;
  }
}

async function start() {
  if (!(await connect())) return;
  // On boot / redeploy: restore immediately if the local DB lost its data.
  try {
    const hasLocal = !!q.get('SELECT id FROM users LIMIT 1');
    const remote = await pg.query("SELECT 1 FROM app_backup WHERE table_name='users' LIMIT 1");
    if (!hasLocal && remote.rows.length) {
      await restore('fresh deploy / empty local database');
      await backup(); // refresh counters after restore
    }
  } catch (e) {
    console.error('[pgbackup] boot restore check failed:', e.message);
  }
  await cycle();
  setInterval(cycle, SYNC_MS);
  console.log(`[pgbackup] Neon sync active — backup + health check every ${SYNC_MS / 60000} minute(s)`);
}

module.exports = { start };
