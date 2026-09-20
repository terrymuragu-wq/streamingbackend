const express = require('express');
const { q, notify } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);

// Any signed-in user (client / model / manager) can ask the admin for help.
router.post('/', (req, res) => {
  const message = String(req.body.message || '').trim().slice(0, 1000);
  const subject = String(req.body.subject || '').trim().slice(0, 120);
  if (!message) return res.status(400).json({ error: 'Please type your problem first' });
  const id = q.run('INSERT INTO support_tickets(user_id,role,subject,message) VALUES(?,?,?,?)',
    req.user.id, req.user.role, subject || null, message).lastInsertRowid;
  const admins = q.all("SELECT id FROM users WHERE role='admin'");
  admins.forEach(a => notify(a.id, 'support', `Help request from ${req.user.name} (${req.user.role}): ${(subject || message).slice(0, 80)}`));
  res.json({ ok: true, ticket_id: id });
});

router.get('/mine', (req, res) => {
  res.json({ tickets: q.all('SELECT * FROM support_tickets WHERE user_id=? ORDER BY id DESC LIMIT 30', req.user.id) });
});

module.exports = router;
