const express = require('express');
const { db, notify, getWallet } = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired, requireRole('manager'));

function myAgency(req) {
  return db.prepare('SELECT * FROM agencies WHERE manager_id = ?').get(req.user.id);
}

router.get('/overview', (req, res) => {
  const agency = myAgency(req);
  if (!agency) return res.status(404).json({ error: 'No agency found for this account' });
  const coaches = db.prepare(`
    SELECT u.id, u.name, u.avatar_color, u.status, c.specialty, c.approved, c.live_now,
      (SELECT COALESCE(SUM(amount_cents),0) FROM transactions WHERE user_id = u.id AND kind IN ('earning','commission')) AS earned_cents
    FROM coaches c JOIN users u ON u.id = c.user_id
    WHERE c.agency_id = ? ORDER BY c.live_now DESC, u.name
  `).all(agency.id);
  const pendingApps = db.prepare(
    "SELECT COUNT(*) n FROM coach_applications WHERE agency_id = ? AND status = 'pending'"
  ).get(agency.id).n;
  const pendingWithdrawals = db.prepare(`
    SELECT COUNT(*) n FROM withdrawals w JOIN coaches c ON c.user_id = w.coach_id
    WHERE c.agency_id = ? AND w.status = 'pending'
  `).get(agency.id).n;
  res.json({ agency, coaches, pendingApps, pendingWithdrawals, wallet: getWallet(req.user.id) });
});

router.get('/applications', (req, res) => {
  const agency = myAgency(req);
  res.json(db.prepare(`
    SELECT a.*, u.name AS coach_name, u.email AS coach_email, u.avatar_color, c.specialty, c.bio
    FROM coach_applications a
    JOIN users u ON u.id = a.coach_id
    JOIN coaches c ON c.user_id = a.coach_id
    WHERE a.agency_id = ? ORDER BY a.id DESC
  `).all(agency.id));
});

router.post('/applications/:id/decide', (req, res) => {
  const agency = myAgency(req);
  const app = db.prepare('SELECT * FROM coach_applications WHERE id = ? AND agency_id = ?')
    .get(req.params.id, agency.id);
  if (!app) return res.status(404).json({ error: 'Application not found' });
  if (app.status !== 'pending') return res.status(400).json({ error: 'Already decided' });
  const approve = !!(req.body && req.body.approve);
  db.prepare('UPDATE coach_applications SET status = ? WHERE id = ?')
    .run(approve ? 'approved' : 'rejected', app.id);
  if (approve) {
    db.prepare('UPDATE coaches SET agency_id = ? WHERE user_id = ?').run(agency.id, app.coach_id);
    db.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(app.coach_id);
    notify(app.coach_id, `🎉 ${agency.name} accepted you! The platform admin will complete your final review.`);
    db.prepare("SELECT id FROM users WHERE role = 'admin'").all()
      .forEach(a => notify(a.id, `Coach application approved by ${agency.name} — final eligibility review needed.`));
  } else {
    notify(app.coach_id, `Your application to ${agency.name} was declined.`);
  }
  res.json({ ok: true });
});

// Manager: send an instruction/message to a coach
router.post('/coaches/:id/message', (req, res) => {
  const agency = myAgency(req);
  const coach = db.prepare('SELECT * FROM coaches WHERE user_id = ? AND agency_id = ?')
    .get(req.params.id, agency.id);
  if (!coach) return res.status(404).json({ error: 'Coach not found in your agency' });
  const text = String((req.body && req.body.text) || '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: 'Message cannot be empty' });
  notify(req.params.id, `📣 Message from your manager: ${text}`);
  res.json({ ok: true });
});

module.exports = router;
