const express = require('express');
const bcrypt = require('bcryptjs');
const { db, getWallet, notify, publicUser } = require('../db');
const { sign, authRequired } = require('../middleware/auth');

const router = express.Router();
const COLORS = ['#6c5ce7', '#00b894', '#e17055', '#0984e3', '#d63031', '#e84393', '#00cec9', '#fdcb6e'];

const emailOk = (e) => typeof e === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

router.post('/register', (req, res) => {
  const { email, password, name, role, agencyName, specialty, bio } = req.body || {};
  if (!emailOk(email)) return res.status(400).json({ error: 'Please enter a valid email address' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (!name || name.trim().length < 2) return res.status(400).json({ error: 'Please enter your name' });
  if (!['client', 'coach', 'manager'].includes(role)) return res.status(400).json({ error: 'Invalid account type' });

  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (exists) return res.status(409).json({ error: 'An account with this email already exists' });

  const hash = bcrypt.hashSync(password, 10);
  const color = COLORS[Math.floor(Math.random() * COLORS.length)];
  const status = role === 'coach' ? 'pending' : 'active'; // coaches need agency + admin approval

  const info = db.prepare(
    'INSERT INTO users (email, password_hash, name, role, status, avatar_color) VALUES (?,?,?,?,?,?)'
  ).run(email.toLowerCase(), hash, name.trim(), role, status, color);
  const userId = info.lastInsertRowid;
  getWallet(userId);

  if (role === 'manager') {
    if (!agencyName || agencyName.trim().length < 2) {
      db.prepare('DELETE FROM users WHERE id = ?').run(userId);
      return res.status(400).json({ error: 'Agency name is required for manager accounts' });
    }
    db.prepare('INSERT INTO agencies (name, manager_id) VALUES (?,?)').run(agencyName.trim(), userId);
  }
  if (role === 'coach') {
    db.prepare('INSERT INTO coaches (user_id, bio, specialty) VALUES (?,?,?)')
      .run(userId, (bio || '').slice(0, 500), specialty || 'General Fitness');
    notify(userId, 'Welcome to FitStream! Apply to an agency to get approved and start streaming.');
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  res.status(201).json({ token: sign(user), user: publicUser(user) });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!emailOk(email) || !password) return res.status(400).json({ error: 'Email and password are required' });
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Incorrect email or password' });
  }
  if (user.status === 'suspended') return res.status(403).json({ error: 'This account has been suspended' });
  res.json({ token: sign(user), user: publicUser(user) });
});

router.get('/me', authRequired, (req, res) => {
  const wallet = getWallet(req.user.id);
  const extra = {};
  if (req.user.role === 'coach') {
    extra.coach = db.prepare('SELECT * FROM coaches WHERE user_id = ?').get(req.user.id);
    const rating = db.prepare('SELECT AVG(stars) avg, COUNT(*) n FROM ratings WHERE coach_id = ?').get(req.user.id);
    extra.rating = { avg: rating.avg ? Math.round(rating.avg * 10) / 10 : null, count: rating.n };
  }
  if (req.user.role === 'manager') {
    extra.agency = db.prepare('SELECT * FROM agencies WHERE manager_id = ?').get(req.user.id);
  }
  const unread = db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read = 0').get(req.user.id).n;
  res.json({ user: publicUser(req.user), wallet, unread, ...extra });
});

router.get('/notifications', authRequired, (req, res) => {
  const rows = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(req.user.id);
  res.json(rows);
});

router.post('/notifications/read', authRequired, (req, res) => {
  db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

module.exports = router;
