const express = require('express');
const { db, notify, notifyAll, getWallet } = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired, requireRole('admin'));

router.get('/overview', (req, res) => {
  const c = (sql, ...args) => db.prepare(sql).get(...args).n;
  const revenue = db.prepare(
    "SELECT COALESCE(SUM(amount_cents),0) n FROM transactions WHERE kind = 'platform_fee'"
  ).get().n;
  res.json({
    users: c('SELECT COUNT(*) n FROM users'),
    clients: c("SELECT COUNT(*) n FROM users WHERE role = 'client'"),
    coaches: c("SELECT COUNT(*) n FROM users WHERE role = 'coach'"),
    pendingCoaches: c('SELECT COUNT(*) n FROM coaches WHERE approved = 0'),
    pendingContent: c("SELECT COUNT(*) n FROM content WHERE status = 'pending'"),
    pendingWithdrawals: c("SELECT COUNT(*) n FROM withdrawals WHERE status = 'pending'"),
    liveNow: c("SELECT COUNT(*) n FROM live_sessions WHERE status = 'live'"),
    purchases: c('SELECT COUNT(*) n FROM purchases'),
    platformRevenueCents: revenue,
  });
});

router.get('/users', (req, res) => {
  const { role, status } = req.query;
  let sql = 'SELECT id, email, name, role, status, avatar_color, created_at FROM users WHERE 1=1';
  const args = [];
  if (role && ['client', 'coach', 'manager', 'admin'].includes(role)) { sql += ' AND role = ?'; args.push(role); }
  if (status && ['active', 'suspended', 'pending'].includes(status)) { sql += ' AND status = ?'; args.push(status); }
  sql += ' ORDER BY id DESC LIMIT 200';
  res.json(db.prepare(sql).all(...args));
});

router.post('/users/:id/status', (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.role === 'admin') return res.status(400).json({ error: 'Cannot change admin accounts' });
  const status = req.body && req.body.status;
  if (!['active', 'suspended'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, target.id);
  if (status === 'suspended') {
    db.prepare(`UPDATE live_sessions SET status = 'ended', ended_at = datetime('now')
                WHERE coach_id = ? AND status = 'live'`).run(target.id);
    db.prepare('UPDATE coaches SET live_now = 0 WHERE user_id = ?').run(target.id);
  }
  notify(target.id, status === 'suspended'
    ? '⛔ Your account has been suspended by the platform admin.'
    : '✅ Your account has been reactivated.');
  res.json({ ok: true });
});

router.post('/users/:id/message', (req, res) => {
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const text = String((req.body && req.body.text) || '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: 'Message cannot be empty' });
  notify(target.id, `🛡️ Message from platform admin: ${text}`);
  res.json({ ok: true });
});

// Coach eligibility review (final approval before streaming)
router.get('/coaches', (req, res) => {
  res.json(db.prepare(`
    SELECT u.id, u.name, u.email, u.status, u.avatar_color, u.created_at,
           c.specialty, c.bio, c.approved, c.live_now, c.price_cents,
           a.name AS agency_name,
           (SELECT AVG(stars) FROM ratings WHERE coach_id = u.id) AS avg_rating
    FROM coaches c
    JOIN users u ON u.id = c.user_id
    LEFT JOIN agencies a ON a.id = c.agency_id
    ORDER BY c.approved ASC, u.id DESC
  `).all().map(r => ({ ...r, avg_rating: r.avg_rating ? Math.round(r.avg_rating * 10) / 10 : null })));
});

router.post('/coaches/:id/approve', (req, res) => {
  const coach = db.prepare('SELECT * FROM coaches WHERE user_id = ?').get(req.params.id);
  if (!coach) return res.status(404).json({ error: 'Coach not found' });
  const approve = !!(req.body && req.body.approve);
  if (approve && !coach.agency_id) {
    return res.status(400).json({ error: 'Coach must belong to an agency before final approval' });
  }
  db.prepare('UPDATE coaches SET approved = ? WHERE user_id = ?').run(approve ? 1 : 0, req.params.id);
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(approve ? 'active' : 'pending', req.params.id);
  notify(req.params.id, approve
    ? '✅ You passed the platform review — you can now schedule and host live sessions!'
    : '⚠️ Your coach approval was revoked. Contact your agency manager.');
  res.json({ ok: true });
});

// Content moderation
router.get('/content', (req, res) => {
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : null;
  let sql = `SELECT c.*, u.name AS coach_name FROM content c JOIN users u ON u.id = c.coach_id`;
  const args = [];
  if (status) { sql += ' WHERE c.status = ?'; args.push(status); }
  sql += ' ORDER BY CASE c.status WHEN \'pending\' THEN 0 ELSE 1 END, c.id DESC LIMIT 200';
  res.json(db.prepare(sql).all(...args));
});

router.post('/content/:id/decide', (req, res) => {
  const item = db.prepare('SELECT * FROM content WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Content not found' });
  const approve = !!(req.body && req.body.approve);
  db.prepare('UPDATE content SET status = ? WHERE id = ?').run(approve ? 'approved' : 'rejected', item.id);
  notify(item.coach_id, approve
    ? `✅ Your content "${item.title}" was approved and is now listed.`
    : `❌ Your content "${item.title}" was rejected. Review the guidelines and resubmit.`);
  res.json({ ok: true });
});

// Live session supervision
router.get('/lives', (req, res) => {
  res.json(db.prepare(`
    SELECT l.*, u.name AS coach_name FROM live_sessions l
    JOIN users u ON u.id = l.coach_id ORDER BY l.id DESC LIMIT 100
  `).all());
});

// Broadcast to all users (or one role)
router.post('/broadcast', (req, res) => {
  const text = String((req.body && req.body.text) || '').trim().slice(0, 300);
  const role = ['client', 'coach', 'manager'].includes(req.body && req.body.role) ? req.body.role : null;
  if (!text) return res.status(400).json({ error: 'Message cannot be empty' });
  notifyAll(`📢 ${text}`, role);
  res.json({ ok: true });
});

router.get('/agencies', (req, res) => {
  res.json(db.prepare(`
    SELECT a.*, u.name AS manager_name, u.status AS manager_status,
      (SELECT COUNT(*) FROM coaches WHERE agency_id = a.id) AS coach_count
    FROM agencies a JOIN users u ON u.id = a.manager_id ORDER BY a.id DESC
  `).all());
});

router.get('/transactions', (req, res) => {
  res.json(db.prepare(`
    SELECT t.*, u.name, u.email FROM transactions t
    JOIN users u ON u.id = t.user_id ORDER BY t.id DESC LIMIT 200
  `).all());
});

module.exports = router;
