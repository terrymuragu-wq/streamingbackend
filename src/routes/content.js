const express = require('express');
const path = require('path');
const multer = require('multer');
const { db, DATA_DIR, credit, debit, notify } = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();
const upload = multer({
  dest: path.join(DATA_DIR, 'uploads'),
  limits: { fileSize: 500 * 1024 * 1024 },
});

function hasAccess(userId, item) {
  if (item.price_cents <= 0 || item.coach_id === userId) return true;
  const u = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
  if (u && u.role === 'admin') return true;
  return !!db.prepare("SELECT id FROM purchases WHERE client_id = ? AND item_type = 'content' AND item_id = ?")
    .get(userId, item.id);
}

// Public: approved content catalog
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT c.id, c.title, c.description, c.type, c.price_cents, c.created_at,
           u.id AS coach_id, u.name AS coach_name, u.avatar_color
    FROM content c JOIN users u ON u.id = c.coach_id
    WHERE c.status = 'approved' AND u.status = 'active'
    ORDER BY c.id DESC
  `).all();
  res.json(rows);
});

// Coach: my content (any status)
router.get('/mine', authRequired, requireRole('coach'), (req, res) => {
  res.json(db.prepare('SELECT * FROM content WHERE coach_id = ? ORDER BY id DESC').all(req.user.id));
});

// Client: my purchases (content + lives)
router.get('/purchases', authRequired, requireRole('client'), (req, res) => {
  const content = db.prepare(`
    SELECT p.id AS purchase_id, p.amount_cents, p.created_at, c.id, c.title, c.description, c.type, c.url,
           u.name AS coach_name
    FROM purchases p JOIN content c ON c.id = p.item_id JOIN users u ON u.id = c.coach_id
    WHERE p.client_id = ? AND p.item_type = 'content' ORDER BY p.id DESC
  `).all(req.user.id);
  const lives = db.prepare(`
    SELECT p.id AS purchase_id, p.amount_cents, p.created_at, l.id, l.title, l.status, l.scheduled_at,
           u.name AS coach_name
    FROM purchases p JOIN live_sessions l ON l.id = p.item_id JOIN users u ON u.id = l.coach_id
    WHERE p.client_id = ? AND p.item_type = 'live' ORDER BY p.id DESC
  `).all(req.user.id);
  res.json({ content, lives });
});

// Get one item (url hidden unless access)
router.get('/:id', authRequired, (req, res) => {
  const item = db.prepare(`
    SELECT c.*, u.name AS coach_name FROM content c JOIN users u ON u.id = c.coach_id WHERE c.id = ?
  `).get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Content not found' });
  if (item.status !== 'approved' && item.coach_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'This content is not available yet' });
  }
  const access = hasAccess(req.user.id, item);
  const safe = { ...item };
  if (!access) delete safe.url;
  res.json({ content: safe, access });
});

// Coach: submit content (URL or uploaded file)
router.post('/', authRequired, requireRole('coach'), upload.single('file'), (req, res) => {
  const c = db.prepare('SELECT approved FROM coaches WHERE user_id = ?').get(req.user.id);
  if (!c || !c.approved) return res.status(403).json({ error: 'Your coach account must be approved before publishing content' });
  const { title, description, type, priceCents } = req.body || {};
  if (!title || title.trim().length < 3) return res.status(400).json({ error: 'Please give your content a title' });
  const price = Math.max(0, Math.min(100000, parseInt(priceCents, 10) || 0));
  let url = String((req.body && req.body.url) || '').trim();
  if (req.file) url = '/uploads/' + req.file.filename;
  if (!url) return res.status(400).json({ error: 'Add a video URL or upload a file' });
  if (url && !req.file && !/^https?:\/\//.test(url)) {
    return res.status(400).json({ error: 'URL must start with http(s)://' });
  }
  const info = db.prepare(`INSERT INTO content (coach_id, title, description, type, price_cents, url)
    VALUES (?,?,?,?,?,?)`)
    .run(req.user.id, title.trim().slice(0, 120), String(description || '').slice(0, 500),
      ['video', 'program', 'guide'].includes(type) ? type : 'video', price, url);
  db.prepare("SELECT id FROM users WHERE role = 'admin'").all()
    .forEach(a => notify(a.id, `📥 New content "${title.trim()}" from ${req.user.name} awaiting review.`));
  res.status(201).json({ id: info.lastInsertRowid });
});

// Client: purchase content
router.post('/:id/purchase', authRequired, requireRole('client'), (req, res) => {
  const item = db.prepare("SELECT * FROM content WHERE id = ? AND status = 'approved'").get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Content not found' });
  if (item.price_cents <= 0) return res.json({ ok: true, free: true });
  if (hasAccess(req.user.id, item)) return res.json({ ok: true, already: true });
  if (!debit(req.user.id, item.price_cents, 'purchase', `Content: ${item.title}`)) {
    return res.status(402).json({ error: 'Not enough credits. Top up your wallet first.' });
  }
  db.prepare(`INSERT INTO purchases (client_id, item_type, item_id, amount_cents) VALUES (?, 'content', ?, ?)`)
    .run(req.user.id, item.id, item.price_cents);
  const coach = db.prepare('SELECT agency_id FROM coaches WHERE user_id = ?').get(item.coach_id);
  const agency = coach && coach.agency_id
    ? db.prepare('SELECT manager_id FROM agencies WHERE id = ?').get(coach.agency_id) : null;
  const coachShare = Math.round(item.price_cents * 0.70);
  const agencyShare = agency ? Math.round(item.price_cents * 0.10) : 0;
  credit(item.coach_id, coachShare, 'earning', `Content sale: ${item.title}`);
  if (agency) credit(agency.manager_id, agencyShare, 'commission', `Content sale: ${item.title}`);
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
  if (admin) credit(admin.id, item.price_cents - coachShare - agencyShare, 'platform_fee', `Content sale: ${item.title}`);
  notify(item.coach_id, `💰 ${req.user.name} unlocked "${item.title}"`);
  res.json({ ok: true });
});

module.exports = router;
