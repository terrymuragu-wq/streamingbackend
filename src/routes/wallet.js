const express = require('express');
const { db, getWallet, credit, debit, notify } = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/', authRequired, (req, res) => {
  const wallet = getWallet(req.user.id);
  const transactions = db.prepare(
    'SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 50'
  ).all(req.user.id);
  res.json({ wallet, transactions });
});

// Demo top-up (swap for Stripe/Paystack in production)
router.post('/topup', authRequired, (req, res) => {
  const amount = Math.max(100, Math.min(1000000, parseInt(req.body && req.body.amountCents, 10) || 0));
  credit(req.user.id, amount, 'topup', 'Wallet top-up (demo gateway)');
  res.json({ ok: true, balance: getWallet(req.user.id).balance_cents });
});

// Coach: request a withdrawal (goes to manager/admin for approval)
router.post('/withdraw', authRequired, requireRole('coach'), (req, res) => {
  const amount = Math.max(500, parseInt(req.body && req.body.amountCents, 10) || 0);
  const wallet = getWallet(req.user.id);
  if (wallet.balance_cents < amount) {
    return res.status(402).json({ error: 'Insufficient balance (minimum withdrawal is $5.00)' });
  }
  const pending = db.prepare(
    "SELECT COALESCE(SUM(amount_cents),0) s FROM withdrawals WHERE coach_id = ? AND status = 'pending'"
  ).get(req.user.id).s;
  if (wallet.balance_cents - pending < amount) {
    return res.status(402).json({ error: 'You already have pending withdrawals covering your balance' });
  }
  db.prepare('INSERT INTO withdrawals (coach_id, amount_cents) VALUES (?,?)').run(req.user.id, amount);
  const coach = db.prepare('SELECT agency_id FROM coaches WHERE user_id = ?').get(req.user.id);
  if (coach && coach.agency_id) {
    const agency = db.prepare('SELECT manager_id FROM agencies WHERE id = ?').get(coach.agency_id);
    if (agency) notify(agency.manager_id, `🏦 ${req.user.name} requested a withdrawal of $${(amount / 100).toFixed(2)}`);
  }
  db.prepare("SELECT id FROM users WHERE role = 'admin'").all()
    .forEach(a => notify(a.id, `🏦 Withdrawal request: ${req.user.name} — $${(amount / 100).toFixed(2)}`));
  res.status(201).json({ ok: true });
});

router.get('/withdrawals', authRequired, (req, res) => {
  if (req.user.role === 'coach') {
    return res.json(db.prepare('SELECT * FROM withdrawals WHERE coach_id = ? ORDER BY id DESC').all(req.user.id));
  }
  if (req.user.role === 'manager') {
    return res.json(db.prepare(`
      SELECT w.*, u.name AS coach_name FROM withdrawals w
      JOIN coaches c ON c.user_id = w.coach_id
      JOIN agencies a ON a.id = c.agency_id
      JOIN users u ON u.id = w.coach_id
      WHERE a.manager_id = ? ORDER BY w.id DESC
    `).all(req.user.id));
  }
  if (req.user.role === 'admin') {
    return res.json(db.prepare(`
      SELECT w.*, u.name AS coach_name FROM withdrawals w JOIN users u ON u.id = w.coach_id
      ORDER BY w.id DESC
    `).all());
  }
  res.status(403).json({ error: 'Not allowed' });
});

// Manager or admin decides a withdrawal
router.post('/withdrawals/:id/decide', authRequired, requireRole('manager', 'admin'), (req, res) => {
  const w = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(req.params.id);
  if (!w) return res.status(404).json({ error: 'Withdrawal not found' });
  if (w.status !== 'pending') return res.status(400).json({ error: 'Already decided' });
  if (req.user.role === 'manager') {
    const mine = db.prepare(`
      SELECT 1 FROM coaches c JOIN agencies a ON a.id = c.agency_id
      WHERE c.user_id = ? AND a.manager_id = ?
    `).get(w.coach_id, req.user.id);
    if (!mine) return res.status(403).json({ error: 'This coach is not in your agency' });
  }
  const approve = !!(req.body && req.body.approve);
  if (approve) {
    if (!debit(w.coach_id, w.amount_cents, 'withdrawal', 'Withdrawal approved')) {
      return res.status(402).json({ error: 'Coach balance no longer covers this withdrawal' });
    }
    db.prepare("UPDATE withdrawals SET status = 'approved', decided_by = ? WHERE id = ?").run(req.user.id, w.id);
    notify(w.coach_id, `✅ Your withdrawal of $${(w.amount_cents / 100).toFixed(2)} was approved.`);
  } else {
    db.prepare("UPDATE withdrawals SET status = 'rejected', decided_by = ? WHERE id = ?").run(req.user.id, w.id);
    notify(w.coach_id, `❌ Your withdrawal of $${(w.amount_cents / 100).toFixed(2)} was rejected. Contact your manager.`);
  }
  res.json({ ok: true });
});

module.exports = router;
