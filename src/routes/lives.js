const express = require('express');
const { db, credit, debit, notify, notifyAll } = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();

function splitPayment(clientId, coachId, amountCents, label) {
  const coach = db.prepare('SELECT agency_id FROM coaches WHERE user_id = ?').get(coachId);
  const agency = coach && coach.agency_id
    ? db.prepare('SELECT manager_id FROM agencies WHERE id = ?').get(coach.agency_id) : null;
  const coachShare = Math.round(amountCents * 0.70);
  const agencyShare = agency ? Math.round(amountCents * 0.10) : 0;
  const platformShare = amountCents - coachShare - agencyShare;
  credit(coachId, coachShare, 'earning', label);
  if (agency) credit(agency.manager_id, agencyShare, 'commission', label);
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
  if (admin) credit(admin.id, platformShare, 'platform_fee', label);
}

function hasAccess(userId, live) {
  if (live.price_cents <= 0) return true;
  if (live.coach_id === userId) return true;
  const u = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
  if (u && (u.role === 'admin' || u.role === 'manager')) return true;
  return !!db.prepare("SELECT id FROM purchases WHERE client_id = ? AND item_type = 'live' AND item_id = ?")
    .get(userId, live.id);
}

router.get('/live', (req, res) => {
  res.json(db.prepare(`
    SELECT l.id, l.title, l.description, l.price_cents, l.viewers, l.started_at,
           u.id AS coach_id, u.name AS coach_name, u.avatar_color, c.specialty
    FROM live_sessions l JOIN users u ON u.id = l.coach_id JOIN coaches c ON c.user_id = u.id
    WHERE l.status = 'live' AND c.approved = 1 AND u.status = 'active'
    ORDER BY l.started_at DESC
  `).all());
});

router.get('/scheduled', (req, res) => {
  res.json(db.prepare(`
    SELECT l.id, l.title, l.description, l.price_cents, l.scheduled_at,
           u.id AS coach_id, u.name AS coach_name, u.avatar_color, c.specialty
    FROM live_sessions l JOIN users u ON u.id = l.coach_id JOIN coaches c ON c.user_id = u.id
    WHERE l.status = 'scheduled' AND c.approved = 1 AND u.status = 'active'
    ORDER BY l.scheduled_at ASC
  `).all());
});

router.get('/mine', authRequired, requireRole('coach'), (req, res) => {
  res.json(db.prepare('SELECT * FROM live_sessions WHERE coach_id = ? ORDER BY id DESC LIMIT 50').all(req.user.id));
});

router.get('/:id', (req, res) => {
  const live = db.prepare(`
    SELECT l.*, u.name AS coach_name, u.avatar_color, c.specialty
    FROM live_sessions l JOIN users u ON u.id = l.coach_id JOIN coaches c ON c.user_id = u.id
    WHERE l.id = ?
  `).get(req.params.id);
  if (!live) return res.status(404).json({ error: 'Session not found' });
  let access = live.price_cents <= 0;
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) {
    try {
      const jwt = require('jsonwebtoken');
      const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET || 'dev-secret-change-me');
      access = hasAccess(payload.id, live);
    } catch { /* anonymous */ }
  }
  const safe = { ...live };
  if (!access) delete safe.stream_url;
  res.json({ live: safe, access });
});

// Coach: schedule a live
router.post('/', authRequired, requireRole('coach'), (req, res) => {
  const c = db.prepare('SELECT approved FROM coaches WHERE user_id = ?').get(req.user.id);
  if (!c || !c.approved) return res.status(403).json({ error: 'Your coach account must be approved before scheduling sessions' });
  const { title, description, priceCents, scheduledAt } = req.body || {};
  if (!title || title.trim().length < 3) return res.status(400).json({ error: 'Please give your session a title' });
  const price = Math.max(0, Math.min(100000, parseInt(priceCents, 10) || 0));
  const when = scheduledAt ? new Date(scheduledAt) : new Date(Date.now() + 86400000);
  if (isNaN(when.getTime())) return res.status(400).json({ error: 'Invalid schedule date' });
  const info = db.prepare(`INSERT INTO live_sessions (coach_id, title, description, price_cents, scheduled_at)
    VALUES (?,?,?,?,?)`).run(req.user.id, title.trim().slice(0, 120), String(description || '').slice(0, 500), price, when.toISOString());
  notifyAll(`📅 ${req.user.name} scheduled "${title.trim()}" for ${when.toUTCString()}`, 'client');
  res.status(201).json({ id: info.lastInsertRowid });
});

// Coach: go live
router.post('/:id/go-live', authRequired, requireRole('coach'), (req, res) => {
  const live = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(req.params.id);
  if (!live || live.coach_id !== req.user.id) return res.status(404).json({ error: 'Session not found' });
  if (live.status === 'live') return res.json({ ok: true, already: true });
  if (live.status === 'ended') return res.status(400).json({ error: 'This session has already ended' });
  const streamUrl = String((req.body && req.body.streamUrl) || '').trim()
    || 'https://www.youtube.com/embed/jfKfPfyJRdk';
  if (!/^https?:\/\//.test(streamUrl)) return res.status(400).json({ error: 'Stream URL must start with http(s)://' });
  db.prepare(`UPDATE live_sessions SET status = 'live', started_at = datetime('now'), stream_url = ? WHERE id = ?`)
    .run(streamUrl, live.id);
  db.prepare('UPDATE coaches SET live_now = 1 WHERE user_id = ?').run(req.user.id);
  notifyAll(`🔴 ${req.user.name} is LIVE: "${live.title}"`, 'client');
  req.app.get('io').emit('live-started', { id: live.id, title: live.title, coach: req.user.name });
  res.json({ ok: true });
});

// Coach (or admin): end a live
router.post('/:id/end', authRequired, (req, res) => {
  const live = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(req.params.id);
  if (!live) return res.status(404).json({ error: 'Session not found' });
  if (live.coach_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only the host can end this session' });
  }
  db.prepare(`UPDATE live_sessions SET status = 'ended', ended_at = datetime('now') WHERE id = ?`).run(live.id);
  db.prepare('UPDATE coaches SET live_now = 0 WHERE user_id = ?').run(live.coach_id);
  req.app.get('io').to(`live-${live.id}`).emit('live-ended', { id: live.id });
  res.json({ ok: true });
});

// Client: buy access
router.post('/:id/purchase', authRequired, requireRole('client'), (req, res) => {
  const live = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(req.params.id);
  if (!live) return res.status(404).json({ error: 'Session not found' });
  if (live.status === 'ended') return res.status(400).json({ error: 'This session has ended' });
  if (live.price_cents <= 0) return res.json({ ok: true, free: true });
  if (hasAccess(req.user.id, live)) return res.json({ ok: true, already: true });
  if (!debit(req.user.id, live.price_cents, 'purchase', `Live access: ${live.title}`)) {
    return res.status(402).json({ error: 'Not enough credits. Top up your wallet first.' });
  }
  db.prepare(`INSERT INTO purchases (client_id, item_type, item_id, amount_cents) VALUES (?, 'live', ?, ?)`)
    .run(req.user.id, live.id, live.price_cents);
  splitPayment(req.user.id, live.coach_id, live.price_cents, `Live access: ${live.title}`);
  notify(live.coach_id, `💰 ${req.user.name} purchased access to "${live.title}"`);
  res.json({ ok: true });
});

// Client: tip the coach
router.post('/:id/tip', authRequired, requireRole('client'), (req, res) => {
  const amount = Math.max(50, Math.min(100000, parseInt(req.body && req.body.amountCents, 10) || 0));
  const live = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(req.params.id);
  if (!live) return res.status(404).json({ error: 'Session not found' });
  if (!debit(req.user.id, amount, 'tip', `Tip for ${live.coach_id}`)) {
    return res.status(402).json({ error: 'Not enough credits. Top up your wallet first.' });
  }
  db.prepare('INSERT INTO tips (client_id, coach_id, live_id, amount_cents) VALUES (?,?,?,?)')
    .run(req.user.id, live.coach_id, live.id, amount);
  splitPayment(req.user.id, live.coach_id, amount, 'Tip');
  notify(live.coach_id, `💸 ${req.user.name} tipped you $${(amount / 100).toFixed(2)}!`);
  req.app.get('io').to(`live-${live.id}`).emit('tip', { from: req.user.name, amountCents: amount });
  res.json({ ok: true });
});

// Chat history
router.get('/:id/messages', authRequired, (req, res) => {
  const rows = db.prepare(`
    SELECT m.id, m.text, m.created_at, u.name, u.avatar_color, u.role
    FROM messages m JOIN users u ON u.id = m.user_id
    WHERE m.live_id = ? ORDER BY m.id DESC LIMIT 50
  `).all(req.params.id);
  res.json(rows.reverse());
});

module.exports = router;
