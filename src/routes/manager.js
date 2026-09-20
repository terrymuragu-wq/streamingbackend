const express = require('express');
const { q, notify, audit } = require('../db');
const { requireAuth, requireRole } = require('../auth');

const router = express.Router();
router.use(requireAuth, requireRole('manager'));

router.get('/dashboard', (req, res) => {
  const agency = q.get('SELECT * FROM agencies WHERE manager_id=?', req.user.id);
  if (!agency) return res.status(404).json({ error: 'No agency found for this manager' });
  const models = q.all(`
    SELECT u.id,u.name,u.email,u.status,u.verified,u.eligible,u.agency_approved,u.wallet_cents,u.created_at,
           p.display_name,p.is_live,p.avg_rating,p.total_earned_cents
    FROM users u LEFT JOIN model_profiles p ON p.user_id=u.id
    WHERE u.role='model' AND u.agency_id=? ORDER BY u.created_at DESC`, agency.id);
  const withdrawals = q.all(`
    SELECT w.*, u.name AS model_name FROM withdrawals w JOIN users u ON u.id=w.model_id
    JOIN users m ON m.id=w.model_id
    WHERE m.agency_id=? AND w.status='pending_manager' ORDER BY w.id DESC`, agency.id);
  const notifications = q.all('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 30', req.user.id);
  res.json({ agency, models, withdrawals, notifications });
});

// Approve a model into the agency (admin still does final eligibility assessment)
router.post('/models/:id/approve', (req, res) => {
  const m = q.get("SELECT u.* FROM users u JOIN agencies a ON a.id=u.agency_id WHERE u.id=? AND u.role='model' AND a.manager_id=?", req.params.id, req.user.id);
  if (!m) return res.status(404).json({ error: 'Model not found in your agency' });
  q.run('UPDATE users SET agency_approved=1 WHERE id=?', m.id);
  notify(m.id, 'approved', 'Your agency approved you. Admin eligibility assessment is the final step before you can go live.');
  const admins = q.all("SELECT id FROM users WHERE role='admin'");
  admins.forEach(a => notify(a.id, 'assessment', `Model ${m.name} is agency-approved — run the age/eligibility assessment.`));
  audit(req.user.id, 'model_approved', `user:${m.id}`);
  res.json({ ok: true });
});

router.post('/models/:id/reject', (req, res) => {
  const m = q.get("SELECT u.* FROM users u JOIN agencies a ON a.id=u.agency_id WHERE u.id=? AND u.role='model' AND a.manager_id=?", req.params.id, req.user.id);
  if (!m) return res.status(404).json({ error: 'Model not found in your agency' });
  q.run("UPDATE users SET status='rejected' WHERE id=?", m.id);
  audit(req.user.id, 'model_rejected', `user:${m.id}`);
  res.json({ ok: true });
});

router.post('/models/:id/suspend', (req, res) => {
  const m = q.get("SELECT u.* FROM users u JOIN agencies a ON a.id=u.agency_id WHERE u.id=? AND u.role='model' AND a.manager_id=?", req.params.id, req.user.id);
  if (!m) return res.status(404).json({ error: 'Model not found in your agency' });
  const next = m.status === 'suspended' ? 'active' : 'suspended';
  q.run('UPDATE users SET status=? WHERE id=?', next, m.id);
  if (next === 'suspended') {
    q.run("UPDATE lives SET status='ended', ended_at=datetime('now') WHERE model_id=? AND status='live'", m.id);
    q.run('UPDATE model_profiles SET is_live=0 WHERE user_id=?', m.id);
  }
  notify(m.id, 'account', next === 'suspended' ? 'Your account was suspended by your agency manager.' : 'Your account was reactivated by your agency manager.');
  audit(req.user.id, `model_${next}`, `user:${m.id}`);
  res.json({ ok: true, status: next });
});

// Tell the model what to do (directive)
router.post('/models/:id/directive', (req, res) => {
  const msg = String(req.body.message || '').trim();
  if (!msg) return res.status(400).json({ error: 'message is required' });
  const m = q.get("SELECT u.* FROM users u JOIN agencies a ON a.id=u.agency_id WHERE u.id=? AND u.role='model' AND a.manager_id=?", req.params.id, req.user.id);
  if (!m) return res.status(404).json({ error: 'Model not found in your agency' });
  q.run("INSERT INTO directives(from_id,from_role,to_model,message) VALUES(?,?,?,?)", req.user.id, 'manager', m.id, msg.slice(0, 500));
  notify(m.id, 'directive', `Message from your agency manager: ${msg.slice(0, 80)}`);
  res.json({ ok: true });
});

// Manager decides if a model can withdraw
router.post('/withdrawals/:id/approve', (req, res) => {
  const w = q.get(`SELECT w.* FROM withdrawals w JOIN users u ON u.id=w.model_id JOIN agencies a ON a.id=u.agency_id
                   WHERE w.id=? AND a.manager_id=? AND w.status='pending_manager'`, req.params.id, req.user.id);
  if (!w) return res.status(404).json({ error: 'Pending withdrawal not found' });
  q.run("UPDATE withdrawals SET status='pending_admin', manager_note=?, updated_at=datetime('now') WHERE id=?",
    String(req.body.note || ''), w.id);
  const admins = q.all("SELECT id FROM users WHERE role='admin'");
  admins.forEach(a => notify(a.id, 'payout', `Withdrawal #${w.id} ($${(w.amount_cents / 100).toFixed(2)}) manager-approved — pay out.`));
  notify(w.model_id, 'withdrawal', `Your withdrawal of $${(w.amount_cents / 100).toFixed(2)} was approved by your manager and sent to the platform for payout.`);
  audit(req.user.id, 'withdrawal_manager_approved', `withdrawal:${w.id}`);
  res.json({ ok: true });
});

router.post('/withdrawals/:id/reject', (req, res) => {
  const w = q.get(`SELECT w.* FROM withdrawals w JOIN users u ON u.id=w.model_id JOIN agencies a ON a.id=u.agency_id
                   WHERE w.id=? AND a.manager_id=? AND w.status='pending_manager'`, req.params.id, req.user.id);
  if (!w) return res.status(404).json({ error: 'Pending withdrawal not found' });
  q.run("UPDATE withdrawals SET status='rejected', manager_note=?, updated_at=datetime('now') WHERE id=?",
    String(req.body.note || ''), w.id);
  notify(w.model_id, 'withdrawal', `Your withdrawal of $${(w.amount_cents / 100).toFixed(2)} was rejected by your manager${req.body.note ? ': ' + req.body.note : ''}.`);
  res.json({ ok: true });
});

module.exports = router;
