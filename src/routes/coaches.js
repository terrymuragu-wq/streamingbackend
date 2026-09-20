const express = require('express');
const { db, notify } = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();

// Public: list approved coaches with rating + live status
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.name, u.avatar_color, c.bio, c.specialty, c.price_cents, c.live_now,
           (SELECT AVG(stars) FROM ratings WHERE coach_id = u.id) AS avg_rating,
           (SELECT COUNT(*) FROM ratings WHERE coach_id = u.id) AS rating_count,
           (SELECT id FROM live_sessions WHERE coach_id = u.id AND status = 'live' ORDER BY id DESC LIMIT 1) AS live_id
    FROM coaches c JOIN users u ON u.id = c.user_id
    WHERE c.approved = 1 AND u.status = 'active'
    ORDER BY c.live_now DESC, avg_rating DESC
  `).all();
  res.json(rows.map(r => ({ ...r, avg_rating: r.avg_rating ? Math.round(r.avg_rating * 10) / 10 : null })));
});

// Public: agencies list (for coach application dropdown)
router.get('/agencies', (req, res) => {
  res.json(db.prepare(`
    SELECT a.id, a.name, u.name AS manager_name,
      (SELECT COUNT(*) FROM coaches WHERE agency_id = a.id AND approved = 1) AS coach_count
    FROM agencies a JOIN users u ON u.id = a.manager_id
    WHERE a.status = 'active' AND u.status = 'active'
  `).all());
});

// Public: coach profile
router.get('/:id', (req, res) => {
  const coach = db.prepare(`
    SELECT u.id, u.name, u.avatar_color, c.bio, c.specialty, c.price_cents, c.live_now
    FROM coaches c JOIN users u ON u.id = c.user_id
    WHERE u.id = ? AND c.approved = 1 AND u.status = 'active'
  `).get(req.params.id);
  if (!coach) return res.status(404).json({ error: 'Coach not found' });
  const rating = db.prepare('SELECT AVG(stars) a, COUNT(*) n FROM ratings WHERE coach_id = ?').get(req.params.id);
  const reviews = db.prepare(`
    SELECT r.stars, r.review, r.created_at, u.name AS client_name
    FROM ratings r JOIN users u ON u.id = r.client_id
    WHERE r.coach_id = ? ORDER BY r.id DESC LIMIT 20
  `).all(req.params.id);
  const content = db.prepare(`
    SELECT id, title, description, type, price_cents, created_at
    FROM content WHERE coach_id = ? AND status = 'approved' ORDER BY id DESC
  `).all(req.params.id);
  const upcoming = db.prepare(`
    SELECT id, title, description, price_cents, scheduled_at
    FROM live_sessions WHERE coach_id = ? AND status IN ('scheduled','live') ORDER BY scheduled_at ASC
  `).all(req.params.id);
  res.json({ coach, rating: { avg: rating.a ? Math.round(rating.a * 10) / 10 : null, count: rating.n }, reviews, content, upcoming });
});

// Coach: update own profile
router.put('/me', authRequired, requireRole('coach'), (req, res) => {
  const { bio, specialty, priceCents } = req.body || {};
  const price = Math.max(0, Math.min(100000, parseInt(priceCents, 10) || 0));
  db.prepare('UPDATE coaches SET bio = ?, specialty = ?, price_cents = ? WHERE user_id = ?')
    .run(String(bio || '').slice(0, 500), String(specialty || 'General Fitness').slice(0, 80), price, req.user.id);
  res.json({ ok: true });
});

// Coach: apply to an agency
router.post('/apply', authRequired, requireRole('coach'), (req, res) => {
  const agencyId = parseInt(req.body && req.body.agencyId, 10);
  const agency = db.prepare("SELECT * FROM agencies WHERE id = ? AND status = 'active'").get(agencyId);
  if (!agency) return res.status(404).json({ error: 'Agency not found' });
  const existing = db.prepare("SELECT * FROM coach_applications WHERE coach_id = ? AND status = 'pending'").get(req.user.id);
  if (existing) return res.status(409).json({ error: 'You already have a pending application' });
  db.prepare('INSERT INTO coach_applications (coach_id, agency_id) VALUES (?,?)').run(req.user.id, agencyId);
  notify(agency.manager_id, `${req.user.name} applied to join your agency.`);
  res.status(201).json({ ok: true });
});

// Client: rate a coach
router.post('/:id/rate', authRequired, requireRole('client'), (req, res) => {
  const stars = parseInt(req.body && req.body.stars, 10);
  const review = String((req.body && req.body.review) || '').slice(0, 300);
  if (!(stars >= 1 && stars <= 5)) return res.status(400).json({ error: 'Rating must be between 1 and 5 stars' });
  const coach = db.prepare('SELECT user_id FROM coaches WHERE user_id = ? AND approved = 1').get(req.params.id);
  if (!coach) return res.status(404).json({ error: 'Coach not found' });
  db.prepare(`INSERT INTO ratings (client_id, coach_id, stars, review) VALUES (?,?,?,?)
              ON CONFLICT(client_id, coach_id) DO UPDATE SET stars = excluded.stars, review = excluded.review`)
    .run(req.user.id, req.params.id, stars, review);
  notify(req.params.id, `${req.user.name} rated you ${stars}★${review ? ': "' + review + '"' : ''}`);
  res.json({ ok: true });
});

module.exports = router;
