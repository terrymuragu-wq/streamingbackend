const express = require('express');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const { q, notify, audit, getSetting, setSetting } = require('../db');
const { requireAuth, requireRole, ageFromDob } = require('../auth');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

// ---------- overview ----------
router.get('/overview', (req, res) => {
  res.json({
    users: q.get("SELECT COUNT(*) c FROM users WHERE role!='admin'").c,
    clients: q.get("SELECT COUNT(*) c FROM users WHERE role='client'").c,
    models: q.get("SELECT COUNT(*) c FROM users WHERE role='model'").c,
    managers: q.get("SELECT COUNT(*) c FROM users WHERE role='manager'").c,
    liveNow: q.get("SELECT COUNT(*) c FROM lives WHERE status='live'").c,
    pendingVerifications: q.get("SELECT COUNT(*) c FROM verifications WHERE status='pending'").c,
    pendingContent: q.get("SELECT COUNT(*) c FROM content WHERE status='pending'").c,
    pendingAssessments: q.get("SELECT COUNT(*) c FROM users WHERE role='model' AND verified=1 AND agency_approved=1 AND eligible=0 AND status='pending'").c,
    pendingPayouts: q.get("SELECT COUNT(*) c FROM withdrawals WHERE status='pending_admin'").c,
    openTickets: q.get("SELECT COUNT(*) c FROM support_tickets WHERE status='open'").c,
    gmv_cents: q.get("SELECT COALESCE(SUM(amount_cents),0) s FROM transactions WHERE amount_cents>0 AND kind IN ('subscribe','live_ticket','tip','content_unlock')").s,
    platform_fees_cents: q.get("SELECT COALESCE(SUM(-amount_cents),0) s FROM transactions WHERE kind='fee'").s,
  });
});

// ---------- users / control ----------
router.get('/users', (req, res) => {
  const role = req.query.role;
  const rows = role
    ? q.all(`SELECT u.id,u.email,u.name,u.role,u.status,u.dob,u.verified,u.eligible,u.restricted,u.agency_approved,u.wallet_cents,u.created_at,a.name AS agency_name
             FROM users u LEFT JOIN agencies a ON a.id=u.agency_id WHERE u.role=? ORDER BY u.id DESC LIMIT 300`, role)
    : q.all(`SELECT u.id,u.email,u.name,u.role,u.status,u.dob,u.verified,u.eligible,u.restricted,u.agency_approved,u.wallet_cents,u.created_at,a.name AS agency_name
             FROM users u LEFT JOIN agencies a ON a.id=u.agency_id WHERE u.role!='admin' ORDER BY u.id DESC LIMIT 300`);
  res.json({ users: rows });
});

router.post('/users/:id/status', (req, res) => {
  const { status } = req.body || {};
  if (!['active', 'suspended', 'rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const u = q.get("SELECT * FROM users WHERE id=? AND role!='admin'", req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  q.run('UPDATE users SET status=? WHERE id=?', status, u.id);
  if (status === 'suspended') {
    q.run("UPDATE lives SET status='ended', ended_at=datetime('now') WHERE model_id=? AND status='live'", u.id);
    q.run('UPDATE model_profiles SET is_live=0 WHERE user_id=?', u.id);
  }
  notify(u.id, 'account', `Your account status was set to "${status}" by the platform administrator.`);
  audit(req.user.id, `admin_status_${status}`, `user:${u.id}`);
  res.json({ ok: true });
});

// Restrict a client (can't spend/comment/tip)
router.post('/users/:id/restrict', (req, res) => {
  const u = q.get("SELECT * FROM users WHERE id=? AND role='client'", req.params.id);
  if (!u) return res.status(404).json({ error: 'Client not found' });
  q.run('UPDATE users SET restricted=? WHERE id=?', u.restricted ? 0 : 1, u.id);
  notify(u.id, 'account', u.restricted ? 'Restrictions removed from your account.' : 'Your account has been restricted by the administrator.');
  audit(req.user.id, u.restricted ? 'admin_unrestrict' : 'admin_restrict', `user:${u.id}`);
  res.json({ ok: true, restricted: u.restricted ? 0 : 1 });
});

// Admin directive to a model ("tell the model what to do")
router.post('/models/:id/directive', (req, res) => {
  const msg = String(req.body.message || '').trim();
  if (!msg) return res.status(400).json({ error: 'message is required' });
  const m = q.get("SELECT * FROM users WHERE id=? AND role='model'", req.params.id);
  if (!m) return res.status(404).json({ error: 'Model not found' });
  q.run("INSERT INTO directives(from_id,from_role,to_model,message) VALUES(?,?,?,?)", req.user.id, 'admin', m.id, msg.slice(0, 500));
  notify(m.id, 'directive', `Message from platform admin: ${msg.slice(0, 80)}`);
  res.json({ ok: true });
});

// ---------- verifications ----------
router.get('/verifications', (req, res) => {
  const rows = q.all(`
    SELECT v.*, u.name, u.email, u.role, u.dob AS account_dob
    FROM verifications v JOIN users u ON u.id=v.user_id
    ORDER BY CASE v.status WHEN 'pending' THEN 0 ELSE 1 END, v.id DESC LIMIT 200`);
  res.json({ verifications: rows.map(v => ({ ...v, age_on_id: ageFromDob(v.dob_declared) })) });
});

router.get('/verifications/:id/file/:which', (req, res) => {
  const v = q.get('SELECT * FROM verifications WHERE id=?', req.params.id);
  if (!v) return res.status(404).json({ error: 'Not found' });
  const fn = req.params.which === 'selfie' ? v.selfie_file : v.id_file;
  const p = path.join(process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads'), path.basename(fn));
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'File missing' });
  res.sendFile(p);
});

router.post('/verifications/:id/decide', (req, res) => {
  const { decision, notes } = req.body || {};
  if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'decision must be approved|rejected' });
  const v = q.get('SELECT * FROM verifications WHERE id=?', req.params.id);
  if (!v) return res.status(404).json({ error: 'Not found' });
  q.run("UPDATE verifications SET status=?, notes=?, reviewer_id=?, reviewed_at=datetime('now') WHERE id=?",
    decision, String(notes || ''), req.user.id, v.id);
  if (decision === 'approved') {
    q.run('UPDATE users SET verified=1 WHERE id=?', v.user_id);
    const u = q.get('SELECT role FROM users WHERE id=?', v.user_id);
    if (u.role === 'client') q.run("UPDATE users SET status='active' WHERE id=?", v.user_id);
    notify(v.user_id, 'verified', 'Your identity verification was approved by our team.');
  } else {
    notify(v.user_id, 'verification_rejected', `Your verification was rejected${notes ? ': ' + notes : ''}. Please re-submit valid documents.`);
  }
  audit(req.user.id, `verification_${decision}`, `verification:${v.id}`);
  res.json({ ok: true });
});

// ---------- model eligibility assessment (age check, must be 18+ / born 2008 or earlier) ----------
router.get('/assessments', (req, res) => {
  const rows = q.all(`
    SELECT u.id,u.name,u.email,u.dob,u.verified,u.agency_approved,u.created_at,a.name AS agency_name,
      (SELECT v.dob_declared FROM verifications v WHERE v.user_id=u.id AND v.status='approved' ORDER BY v.id DESC LIMIT 1) AS id_dob,
      (SELECT v.id_type || ' ' || v.id_number FROM verifications v WHERE v.user_id=u.id AND v.status='approved' ORDER BY v.id DESC LIMIT 1) AS id_ref
    FROM users u LEFT JOIN agencies a ON a.id=u.agency_id
    WHERE u.role='model' AND u.verified=1 AND u.agency_approved=1 AND u.eligible=0 AND u.status IN ('pending','active')
    ORDER BY u.id DESC`);
  res.json({ assessments: rows.map(r => ({ ...r, age: ageFromDob(r.id_dob || r.dob) })) });
});

router.post('/assessments/:id/decide', (req, res) => {
  const { decision, notes } = req.body || {};
  if (!['eligible', 'rejected'].includes(decision)) return res.status(400).json({ error: 'decision must be eligible|rejected' });
  const m = q.get("SELECT * FROM users WHERE id=? AND role='model'", req.params.id);
  if (!m) return res.status(404).json({ error: 'Model not found' });
  const age = ageFromDob(m.dob);
  if (decision === 'eligible') {
    if (age < parseInt(getSetting('min_age', '18'), 10)) {
      return res.status(400).json({ error: `Cannot mark eligible: account DOB indicates age ${age} (< 18). Reject instead.` });
    }
    q.run("UPDATE users SET eligible=1, status='active' WHERE id=?", m.id);
    notify(m.id, 'eligible', 'Assessment passed — you are now eligible to stream and publish content. Go live!');
    const ag = q.get('SELECT manager_id FROM agencies WHERE id=?', m.agency_id);
    if (ag) notify(ag.manager_id, 'eligible', `${m.name} passed the admin eligibility assessment.`);
  } else {
    q.run("UPDATE users SET status='rejected' WHERE id=?", m.id);
    notify(m.id, 'rejected', `Your model application was rejected after assessment${notes ? ': ' + notes : ''}.`);
  }
  audit(req.user.id, `assessment_${decision}`, `user:${m.id}`, { age, notes });
  res.json({ ok: true });
});

// ---------- content moderation ----------
router.get('/content', (req, res) => {
  res.json({
    content: q.all(`SELECT c.*, u.name AS model_name FROM content c JOIN users u ON u.id=c.model_id
                    ORDER BY CASE c.status WHEN 'pending' THEN 0 ELSE 1 END, c.id DESC LIMIT 200`)
  });
});

router.post('/content/:id/decide', (req, res) => {
  const { decision } = req.body || {};
  if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'decision must be approved|rejected' });
  const c = q.get('SELECT * FROM content WHERE id=?', req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  q.run('UPDATE content SET status=? WHERE id=?', decision, c.id);
  notify(c.model_id, 'content', decision === 'approved'
    ? `Your content "${c.title}" was approved and is now on sale.`
    : `Your content "${c.title}" was rejected.`);
  audit(req.user.id, `content_${decision}`, `content:${c.id}`);
  res.json({ ok: true });
});

// ---------- live control ----------
router.get('/lives', (req, res) => {
  res.json({
    lives: q.all(`SELECT l.*, u.name AS model_name,
        (SELECT COUNT(*) FROM live_access la WHERE la.live_id=l.id) AS viewers
      FROM lives l JOIN users u ON u.id=l.model_id ORDER BY l.id DESC LIMIT 100`)
  });
});

router.post('/lives/:id/end', (req, res) => {
  const l = q.get("SELECT * FROM lives WHERE id=? AND status='live'", req.params.id);
  if (!l) return res.status(404).json({ error: 'Live not found' });
  q.run("UPDATE lives SET status='ended', ended_at=datetime('now') WHERE id=?", l.id);
  q.run('UPDATE model_profiles SET is_live=0 WHERE user_id=?', l.model_id);
  const io = req.app.get('io');
  if (io) io.to(`live:${l.id}`).emit('live_ended', { live_id: l.id, by: 'admin' });
  notify(l.model_id, 'live_ended', 'Your live stream was ended by the administrator.');
  audit(req.user.id, 'admin_end_live', `live:${l.id}`);
  res.json({ ok: true });
});

// ---------- payouts ----------
router.get('/withdrawals', (req, res) => {
  res.json({
    withdrawals: q.all(`SELECT w.*, u.name AS model_name, u.email FROM withdrawals w JOIN users u ON u.id=w.model_id
                        ORDER BY CASE w.status WHEN 'pending_admin' THEN 0 WHEN 'pending_manager' THEN 1 ELSE 2 END, w.id DESC LIMIT 100`)
  });
});

router.post('/withdrawals/:id/pay', (req, res) => {
  const w = q.get("SELECT * FROM withdrawals WHERE id=? AND status='pending_admin'", req.params.id);
  if (!w) return res.status(404).json({ error: 'Payout not found or not manager-approved yet' });
  q.run("UPDATE withdrawals SET status='paid', admin_note=?, updated_at=datetime('now') WHERE id=?", String(req.body.note || ''), w.id);
  q.run('UPDATE users SET wallet_cents = MAX(wallet_cents - ?, 0) WHERE id=?', w.amount_cents, w.model_id);
  q.run('INSERT INTO transactions(user_id,kind,amount_cents,ref) VALUES(?,?,?,?)', w.model_id, 'payout', -w.amount_cents, `withdrawal:${w.id}`);
  notify(w.model_id, 'payout', `Your payout of $${(w.amount_cents / 100).toFixed(2)} has been sent.`);
  audit(req.user.id, 'payout_paid', `withdrawal:${w.id}`);
  res.json({ ok: true });
});

router.post('/withdrawals/:id/reject', (req, res) => {
  const w = q.get("SELECT * FROM withdrawals WHERE id=? AND status='pending_admin'", req.params.id);
  if (!w) return res.status(404).json({ error: 'Payout not found' });
  q.run("UPDATE withdrawals SET status='rejected', admin_note=?, updated_at=datetime('now') WHERE id=?", String(req.body.note || ''), w.id);
  notify(w.model_id, 'payout', `Your payout of $${(w.amount_cents / 100).toFixed(2)} was rejected by the platform${req.body.note ? ': ' + req.body.note : ''}.`);
  res.json({ ok: true });
});

// ---------- client wallet top-up (admin adds funds directly from the backend) ----------
router.post('/users/:id/wallet', (req, res) => {
  const u = q.get("SELECT * FROM users WHERE id=? AND role='client'", req.params.id);
  if (!u) return res.status(404).json({ error: 'Client not found' });
  const cents = Math.round(Number(req.body.amount_cents));
  if (!Number.isFinite(cents) || cents <= 0 || cents > 100000000) return res.status(400).json({ error: 'Enter a valid amount (max $1,000,000)' });
  q.run('UPDATE users SET wallet_cents = wallet_cents + ? WHERE id=?', cents, u.id);
  q.run('INSERT INTO transactions(user_id,kind,amount_cents,ref) VALUES(?,?,?,?)', u.id, 'topup', cents, `admin:${req.user.id}`);
  notify(u.id, 'wallet', `$${(cents / 100).toFixed(2)} was added to your wallet by the platform.`);
  audit(req.user.id, 'admin_wallet_topup', `user:${u.id}`, { cents });
  res.json({ ok: true, balance_cents: q.get('SELECT wallet_cents AS w FROM users WHERE id=?', u.id).w });
});

// ---------- agencies & managers (created from the backend, not public signup) ----------
router.get('/agencies', (req, res) => {
  res.json({
    agencies: q.all(`SELECT a.*, u.name AS manager_name, u.email AS manager_email,
        (SELECT COUNT(*) FROM users m WHERE m.agency_id=a.id AND m.role='model') AS model_count
      FROM agencies a JOIN users u ON u.id=a.manager_id ORDER BY a.id DESC LIMIT 100`)
  });
});

router.post('/agencies', (req, res) => {
  const { name, code, managerName, managerEmail, managerPassword } = req.body || {};
  if (!name || !code || !managerName || !managerEmail || !managerPassword)
    return res.status(400).json({ error: 'name, code, managerName, managerEmail and managerPassword are all required' });
  if (String(managerPassword).length < 8) return res.status(400).json({ error: 'Manager password must be at least 8 characters' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(managerEmail)) return res.status(400).json({ error: 'Invalid manager email' });
  const upCode = String(code).trim().toUpperCase();
  if (q.get('SELECT id FROM agencies WHERE code=?', upCode)) return res.status(409).json({ error: 'That joining code is already taken' });
  if (q.get('SELECT id FROM users WHERE email=?', String(managerEmail).toLowerCase().trim()))
    return res.status(409).json({ error: 'A user with that email already exists' });
  const hash = bcrypt.hashSync(String(managerPassword), 10);
  const mid = q.run(`INSERT INTO users(email,pass_hash,name,role,status,verified,eligible) VALUES(?,?,?,?,'active',1,1)`,
    String(managerEmail).toLowerCase().trim(), hash, String(managerName).trim(), 'manager').lastInsertRowid;
  const aid = q.run('INSERT INTO agencies(code,name,manager_id) VALUES(?,?,?)', upCode, String(name).trim(), mid).lastInsertRowid;
  notify(mid, 'agency', `Your agency "${name}" is ready. Joining code for your models: ${upCode}`);
  audit(req.user.id, 'agency_created', `agency:${aid}`, { code: upCode, manager: mid });
  res.json({ ok: true, agency_id: aid, code: upCode, manager_id: mid });
});

router.post('/agencies/:id/status', (req, res) => {
  const { status } = req.body || {};
  if (!['active', 'suspended'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const a = q.get('SELECT * FROM agencies WHERE id=?', req.params.id);
  if (!a) return res.status(404).json({ error: 'Agency not found' });
  q.run('UPDATE agencies SET status=? WHERE id=?', status, a.id);
  notify(a.manager_id, 'agency', `Your agency was ${status === 'active' ? 'reactivated' : 'suspended'} by the platform.`);
  audit(req.user.id, `agency_${status}`, `agency:${a.id}`);
  res.json({ ok: true });
});

// ---------- help desk (problems typed by users land here for the admin to fix) ----------
router.get('/support', (req, res) => {
  res.json({
    tickets: q.all(`SELECT t.*, u.name, u.email FROM support_tickets t JOIN users u ON u.id=t.user_id
                    ORDER BY CASE t.status WHEN 'open' THEN 0 ELSE 1 END, t.id DESC LIMIT 100`)
  });
});

router.post('/support/:id/resolve', (req, res) => {
  const t = q.get('SELECT * FROM support_tickets WHERE id=?', req.params.id);
  if (!t) return res.status(404).json({ error: 'Ticket not found' });
  const reply = String(req.body.reply || '').trim().slice(0, 1000);
  q.run("UPDATE support_tickets SET status='resolved', admin_reply=?, resolved_at=datetime('now') WHERE id=?", reply || null, t.id);
  notify(t.user_id, 'support_resolved', `Your help request was resolved${reply ? ': ' + reply.slice(0, 120) : '.'}`);
  audit(req.user.id, 'ticket_resolved', `ticket:${t.id}`);
  res.json({ ok: true });
});

// ---------- settings & audit ----------
router.get('/settings', (req, res) => {
  res.json({
    platform_fee_pct: getSetting('platform_fee_pct', '20'),
    min_withdraw_cents: getSetting('min_withdraw_cents', '5000'),
    min_age: getSetting('min_age', '18'),
    min_live_price_cents: getSetting('min_live_price_cents', '15000'),
  });
});
router.post('/settings', (req, res) => {
  const { platform_fee_pct, min_withdraw_cents, min_age } = req.body || {};
  if (platform_fee_pct !== undefined) {
    const f = Number(platform_fee_pct);
    if (!(f >= 0 && f <= 50)) return res.status(400).json({ error: 'Fee must be 0-50%' });
    setSetting('platform_fee_pct', f);
  }
  if (min_withdraw_cents !== undefined) setSetting('min_withdraw_cents', Math.max(1000, Math.round(Number(min_withdraw_cents) || 5000)));
  if (min_age !== undefined) setSetting('min_age', Math.max(18, Math.round(Number(min_age) || 18))); // never below 18
  if (req.body.min_live_price_cents !== undefined) setSetting('min_live_price_cents', Math.max(0, Math.round(Number(req.body.min_live_price_cents) || 15000)));
  audit(req.user.id, 'settings_update', 'settings', req.body);
  res.json({ ok: true });
});

router.get('/audit', (req, res) => {
  res.json({ log: q.all(`SELECT a.*, u.name AS actor FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 200`) });
});

module.exports = router;
