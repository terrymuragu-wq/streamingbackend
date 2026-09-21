const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { q, notify, audit, getSetting } = require('../db');
const { requireAuth, requireRole } = require('../auth');

const router = express.Router();
router.use(requireAuth, requireRole('model'));

let UP = process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads');
try {
  fs.mkdirSync(UP, { recursive: true });
} catch (err) {
  // /var/data/uploads not writable (no Render disk attached yet) — fall back to local ./uploads
  console.error(`[uploads] mkdir failed for ${UP} (${err.code}); falling back to local ./uploads`);
  UP = path.join(__dirname, '..', '..', 'uploads');
  fs.mkdirSync(UP, { recursive: true });
}
const upload = multer({
  storage: multer.diskStorage({
    destination: UP,
    filename: (req, file, cb) => cb(null, `c_${Date.now()}_${Math.random().toString(36).slice(2)}${path.extname(file.originalname || '.bin').slice(0, 8)}`)
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
});

const notEligible = (req, res) => {
  if (!req.user.verified) { res.status(403).json({ error: 'Identity verification required first.' }); return true; }
  if (!req.user.agency_approved) { res.status(403).json({ error: 'Waiting for your agency manager to approve you.' }); return true; }
  if (!req.user.eligible) { res.status(403).json({ error: 'Admin age/eligibility assessment pending. You cannot go live yet.' }); return true; }
  return false;
};

router.get('/dashboard', (req, res) => {
  const p = q.get('SELECT * FROM model_profiles WHERE user_id=?', req.user.id);
  const lives = q.all('SELECT * FROM lives WHERE model_id=? ORDER BY id DESC LIMIT 30', req.user.id);
  const content = q.all('SELECT id,title,kind,price_cents,status,created_at FROM content WHERE model_id=? ORDER BY id DESC LIMIT 50', req.user.id);
  const withdrawals = q.all('SELECT * FROM withdrawals WHERE model_id=? ORDER BY id DESC LIMIT 20', req.user.id);
  const directives = q.all("SELECT d.*, u.name AS from_name FROM directives d JOIN users u ON u.id=d.from_id WHERE d.to_model=? ORDER BY d.id DESC LIMIT 20", req.user.id);
  const notifications = q.all('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 30', req.user.id);
  const subs = q.get("SELECT COUNT(*) c FROM subscriptions WHERE model_id=? AND status='active'", req.user.id).c;
  const tips = q.get('SELECT COALESCE(SUM(amount_cents),0) s FROM tips WHERE to_model=?', req.user.id).s;
  // 30-day hold: only earnings older than the hold period can be withdrawn
  const holdDays = parseInt(getSetting('withdrawal_hold_days', '30'), 10);
  const matured = q.get(`SELECT COALESCE(SUM(amount_cents),0) s FROM transactions WHERE user_id=? AND kind='earning' AND created_at <= datetime('now', ?)`, req.user.id, `-${holdDays} days`).s;
  const paidOut = q.get(`SELECT COALESCE(SUM(-amount_cents),0) s FROM transactions WHERE user_id=? AND kind='payout'`, req.user.id).s;
  const pendingW = q.get("SELECT COALESCE(SUM(amount_cents),0) s FROM withdrawals WHERE model_id=? AND status IN ('pending_manager','pending_admin')", req.user.id).s;
  res.json({
    profile: p, lives, content, withdrawals, directives, notifications,
    stats: { wallet_cents: req.user.wallet_cents, subscribers: subs, tips_cents: tips, status: req.user.status,
             available_withdraw_cents: Math.max(0, matured - paidOut - pendingW), hold_days: holdDays,
             verified: req.user.verified, agency_approved: req.user.agency_approved, eligible: req.user.eligible }
  });
});

router.post('/profile', (req, res) => {
  const { display_name, bio, category, sub_price_cents } = req.body || {};
  const price = Math.round(Number(sub_price_cents));
  q.run(`UPDATE model_profiles SET display_name=COALESCE(?,display_name), bio=COALESCE(?,bio),
         category=COALESCE(?,category), sub_price_cents=CASE WHEN ? BETWEEN 0 AND 100000 THEN ? ELSE sub_price_cents END
         WHERE user_id=?`,
    display_name || null, bio || null, category || null,
    Number.isFinite(price) ? price : -1, Number.isFinite(price) ? price : 0, req.user.id);
  res.json({ ok: true });
});

// Schedule a live — subscribers get notified automatically
router.post('/lives/schedule', (req, res) => {
  if (notEligible(req, res)) return;
  const { title, scheduled_at, price_cents } = req.body || {};
  if (!title || !scheduled_at) return res.status(400).json({ error: 'title and scheduled_at are required' });
  if (new Date(scheduled_at).getTime() < Date.now() + 60000) return res.status(400).json({ error: 'Schedule time must be in the future' });
  let price = Math.max(0, Math.round(Number(price_cents) || 0));
  const minLiveSched = parseInt(getSetting('min_live_price_cents', '15000'), 10);
  if (price > 0 && price < minLiveSched) price = minLiveSched; // $150 minimum per stream
  const id = q.run("INSERT INTO lives(model_id,title,price_cents,scheduled_at,status) VALUES(?,?,?,?,'scheduled')",
    req.user.id, String(title).slice(0, 120), price, scheduled_at).lastInsertRowid;
  const subs = q.all("SELECT client_id FROM subscriptions WHERE model_id=? AND status='active'", req.user.id);
  subs.forEach(s => notify(s.client_id, 'live_scheduled', `${req.user.name} scheduled a live: "${title}" at ${new Date(scheduled_at).toLocaleString()}`, `/watch.html?live=${id}`));
  audit(req.user.id, 'live_scheduled', `live:${id}`, { title, scheduled_at, price });
  res.json({ ok: true, live_id: id, notified: subs.length });
});

// Go live (from a scheduled live, or instantly)
router.post('/lives/go-live', (req, res) => {
  if (notEligible(req, res)) return;
  const existing = q.get("SELECT id FROM lives WHERE model_id=? AND status='live'", req.user.id);
  if (existing) return res.json({ ok: true, live_id: existing.id, already: true });
  let liveId = Number(req.body.live_id);
  if (liveId) {
    const l = q.get("SELECT * FROM lives WHERE id=? AND model_id=? AND status='scheduled'", liveId, req.user.id);
    if (!l) return res.status(404).json({ error: 'Scheduled live not found' });
    q.run("UPDATE lives SET status='live', started_at=datetime('now') WHERE id=?", liveId);
  } else {
    const title = String(req.body.title || `${req.user.name} is live`).slice(0, 120);
    let price = Math.max(0, Math.round(Number(req.body.price_cents) || 0));
    const minLive = parseInt(getSetting('min_live_price_cents', '15000'), 10);
    if (price > 0 && price < minLive) price = minLive; // $150 minimum per stream
    liveId = q.run("INSERT INTO lives(model_id,title,price_cents,status,started_at) VALUES(?,?,?,'live',datetime('now'))",
      req.user.id, title, price).lastInsertRowid;
  }
  q.run('UPDATE model_profiles SET is_live=1, live_title=(SELECT title FROM lives WHERE id=?) WHERE user_id=?', liveId, req.user.id);
  const l = q.get('SELECT title FROM lives WHERE id=?', liveId);
  const subs = q.all("SELECT client_id FROM subscriptions WHERE model_id=? AND status='active'", req.user.id);
  subs.forEach(s => notify(s.client_id, 'live_now', `${req.user.name} is LIVE now: "${l.title}"`, `/watch.html?live=${liveId}`));
  // Clients who already paid for this stream get direct access the moment it starts
  const buyers = q.all('SELECT user_id FROM live_access WHERE live_id=?', liveId);
  buyers.forEach(b => notify(b.user_id, 'live_now', `${req.user.name} is LIVE now: "${l.title}" — tap to watch.`, `/watch.html?live=${liveId}`));
  const io = req.app.get('io');
  if (io) io.emit('model_went_live', { model_id: req.user.id, name: req.user.name, live_id: liveId, title: l.title });
  audit(req.user.id, 'went_live', `live:${liveId}`);
  res.json({ ok: true, live_id: liveId });
});

router.post('/lives/:id/end', (req, res) => {
  const l = q.get("SELECT * FROM lives WHERE id=? AND model_id=? AND status='live'", req.params.id, req.user.id);
  if (!l) return res.status(404).json({ error: 'Live not found' });
  q.run("UPDATE lives SET status='ended', ended_at=datetime('now') WHERE id=?", l.id);
  q.run('UPDATE model_profiles SET is_live=0, live_title=NULL WHERE user_id=?', req.user.id);
  const io = req.app.get('io');
  if (io) io.to(`live:${l.id}`).emit('live_ended', { live_id: l.id });
  res.json({ ok: true });
});

// Upload content — locked until admin approves; clients pay to unlock
router.post('/content', upload.single('file'), (req, res) => {
  if (notEligible(req, res)) return;
  if (!req.file) return res.status(400).json({ error: 'File is required' });
  const { title, kind, price_cents } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title is required' });
  const k = ['video', 'image', 'audio'].includes(kind) ? kind : 'video';
  const price = Math.max(0, Math.round(Number(price_cents) || 0));
  const id = q.run("INSERT INTO content(model_id,title,kind,file_path,price_cents,status) VALUES(?,?,?,?,?,'pending')",
    req.user.id, String(title).slice(0, 120), k, req.file.filename, price).lastInsertRowid;
  const admins = q.all("SELECT id FROM users WHERE role='admin'");
  admins.forEach(a => notify(a.id, 'content_review', `${req.user.name} uploaded "${title}" — pending your approval.`));
  res.json({ ok: true, content_id: id, message: 'Uploaded. It goes on sale after admin approval.' });
});

// Withdrawal request — earnings must be 30+ days old, and the ADMIN approves & pays
router.post('/withdraw', (req, res) => {
  const cents = Math.round(Number(req.body.amount_cents));
  const min = parseInt(getSetting('min_withdraw_cents', '5000'), 10);
  if (!Number.isFinite(cents) || cents < min) return res.status(400).json({ error: `Minimum withdrawal is $${(min / 100).toFixed(2)}` });
  const holdDays = parseInt(getSetting('withdrawal_hold_days', '30'), 10);
  const matured = q.get(`SELECT COALESCE(SUM(amount_cents),0) s FROM transactions WHERE user_id=? AND kind='earning' AND created_at <= datetime('now', ?)`, req.user.id, `-${holdDays} days`).s;
  const paidOut = q.get(`SELECT COALESCE(SUM(-amount_cents),0) s FROM transactions WHERE user_id=? AND kind='payout'`, req.user.id).s;
  const pending = q.get("SELECT COALESCE(SUM(amount_cents),0) s FROM withdrawals WHERE model_id=? AND status IN ('pending_manager','pending_admin')", req.user.id).s;
  const available = Math.max(0, matured - paidOut - pending);
  if (cents > available) return res.status(400).json({ error: `Earnings are held for ${holdDays} days before they can be withdrawn. Available now: $${(available / 100).toFixed(2)}` });
  const id = q.run("INSERT INTO withdrawals(model_id,amount_cents,status) VALUES(?,?,'pending_admin')", req.user.id, cents).lastInsertRowid;
  const admins = q.all("SELECT id FROM users WHERE role='admin'");
  admins.forEach(a => notify(a.id, 'payout', `${req.user.name} requested a withdrawal of $${(cents / 100).toFixed(2)} — your approval needed.`));
  const ag = q.get('SELECT manager_id FROM agencies WHERE id=?', req.user.agency_id);
  if (ag) notify(ag.manager_id, 'withdrawal', `${req.user.name} requested a withdrawal of $${(cents / 100).toFixed(2)} (sent to admin for approval).`);
  res.json({ ok: true, withdrawal_id: id });
});

router.post('/directives/:id/read', (req, res) => {
  q.run('UPDATE directives SET read=1 WHERE id=? AND to_model=?', req.params.id, req.user.id);
  res.json({ ok: true });
});

module.exports = router;
