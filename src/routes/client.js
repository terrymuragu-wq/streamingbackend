const express = require('express');
const { q, notify, audit, creditModel, debitWallet } = require('../db');
const { requireAuth, requireRole } = require('../auth');

const router = express.Router();
router.use(requireAuth, requireRole('client'));

const blocked = (req, res) => {
  if (req.user.restricted) { res.status(403).json({ error: 'Your account is restricted by the platform administrator.' }); return true; }
  if (!req.user.verified) { res.status(403).json({ error: 'Complete identity verification first.' }); return true; }
  return false;
};

// Discover models: live now, upcoming scheduled, all approved models
router.get('/discover', (req, res) => {
  const live = q.all(`
    SELECT u.id, p.display_name, p.bio, p.category, p.avg_rating, p.rating_count, p.sub_price_cents,
           u.avatar, l.id AS live_id, l.title AS live_title, l.price_cents, l.started_at,
           EXISTS(SELECT 1 FROM live_access la WHERE la.live_id=l.id AND la.user_id=?) AS has_access
    FROM lives l JOIN users u ON u.id=l.model_id JOIN model_profiles p ON p.user_id=u.id
    WHERE l.status='live' AND u.status='active' AND u.eligible=1
    ORDER BY l.started_at DESC`, req.user.id);
  const upcoming = q.all(`
    SELECT l.id AS live_id, l.title, l.scheduled_at, l.price_cents, u.id, p.display_name, p.category, p.avg_rating, u.avatar,
           EXISTS(SELECT 1 FROM live_access la WHERE la.live_id=l.id AND la.user_id=?) AS has_access
    FROM lives l JOIN users u ON u.id=l.model_id JOIN model_profiles p ON p.user_id=u.id
    WHERE l.status='scheduled' AND u.status='active' AND u.eligible=1
    ORDER BY l.scheduled_at ASC LIMIT 20`, req.user.id);
  const models = q.all(`
    SELECT u.id, p.display_name, p.bio, p.category, p.avg_rating, p.rating_count, p.sub_price_cents, p.is_live, u.avatar
    FROM users u JOIN model_profiles p ON p.user_id=u.id
    WHERE u.role='model' AND u.status='active' AND u.eligible=1 AND u.verified=1
    ORDER BY p.avg_rating DESC, p.total_earned_cents DESC LIMIT 60`);
  res.json({ live, upcoming, models });
});

router.get('/wallet', (req, res) => {
  const txs = q.all('SELECT kind,amount_cents,ref,created_at FROM transactions WHERE user_id=? ORDER BY id DESC LIMIT 50', req.user.id);
  res.json({ balance_cents: req.user.wallet_cents, transactions: txs });
});

// Demo top-up (swap with Stripe/PayPal/Crypto webhook in production)
router.post('/wallet/topup', (req, res) => {
  const cents = Math.round(Number(req.body.amount_cents));
  if (!Number.isFinite(cents) || cents < 500 || cents > 5000000) return res.status(400).json({ error: 'Top-up must be between $5 and $50,000' });
  q.run('UPDATE users SET wallet_cents = wallet_cents + ? WHERE id=?', cents, req.user.id);
  q.run('INSERT INTO transactions(user_id,kind,amount_cents,ref) VALUES(?,?,?,?)', req.user.id, 'topup', cents, 'demo');
  audit(req.user.id, 'wallet_topup', `user:${req.user.id}`, { cents });
  res.json({ ok: true, balance_cents: q.get('SELECT wallet_cents AS w FROM users WHERE id=?', req.user.id).w });
});

// Subscribe to a model (unlocks her free lives)
router.post('/subscribe/:modelId', (req, res) => {
  if (blocked(req, res)) return;
  const m = q.get(`SELECT u.id,u.name,p.sub_price_cents,p.display_name FROM users u JOIN model_profiles p ON p.user_id=u.id
                   WHERE u.id=? AND u.role='model' AND u.status='active' AND u.eligible=1`, req.params.modelId);
  if (!m) return res.status(404).json({ error: 'Model not found' });
  if (q.get("SELECT id FROM subscriptions WHERE model_id=? AND client_id=? AND status='active'", m.id, req.user.id))
    return res.status(409).json({ error: 'Already subscribed' });
  if (!debitWallet(req.user.id, m.sub_price_cents, 'subscribe', `model:${m.id}`))
    return res.status(402).json({ error: 'Insufficient balance — top up your wallet first' });
  q.run("INSERT OR IGNORE INTO subscriptions(model_id,client_id,price_cents) VALUES(?,?,?)", m.id, req.user.id, m.sub_price_cents);
  const { net } = creditModel(m.id, m.sub_price_cents, 'subscribe', `client:${req.user.id}`);
  notify(m.id, 'subscriber', `${req.user.name} subscribed to you (+$${(net / 100).toFixed(2)})`);
  audit(req.user.id, 'subscribe', `model:${m.id}`, { price: m.sub_price_cents });
  res.json({ ok: true, paid_cents: m.sub_price_cents });
});

// Pay to access a specific live
router.post('/lives/:id/access', (req, res) => {
  if (blocked(req, res)) return;
  const live = q.get("SELECT * FROM lives WHERE id=? AND status IN ('live','scheduled')", req.params.id);
  if (!live) return res.status(404).json({ error: 'Live not found' });
  if (live.price_cents === 0) {
    const sub = q.get("SELECT id FROM subscriptions WHERE model_id=? AND client_id=? AND status='active'", live.model_id, req.user.id);
    if (!sub) return res.status(402).json({ error: 'This live is for subscribers only — subscribe to the model first' });
    q.run('INSERT OR IGNORE INTO live_access(live_id,user_id,paid_cents) VALUES(?,?,0)', live.id, req.user.id);
    return res.json({ ok: true, via: 'subscription' });
  }
  if (q.get('SELECT id FROM live_access WHERE live_id=? AND user_id=?', live.id, req.user.id)) return res.json({ ok: true, already: true });
  if (!debitWallet(req.user.id, live.price_cents, 'live_ticket', `live:${live.id}`))
    return res.status(402).json({ error: 'Insufficient balance — top up your wallet first' });
  q.run('INSERT INTO live_access(live_id,user_id,paid_cents) VALUES(?,?,?)', live.id, req.user.id, live.price_cents);
  const { net } = creditModel(live.model_id, live.price_cents, 'live_ticket', `live:${live.id}`);
  notify(live.model_id, 'ticket', `${req.user.name} bought access to your live (+$${(net / 100).toFixed(2)})`);
  res.json({ ok: true, paid_cents: live.price_cents });
});

// Tip a model (optionally during a live)
router.post('/tip', (req, res) => {
  if (blocked(req, res)) return;
  const cents = Math.round(Number(req.body.amount_cents));
  const modelId = Number(req.body.model_id);
  if (!Number.isFinite(cents) || cents < 100) return res.status(400).json({ error: 'Minimum tip is $1' });
  const m = q.get("SELECT id FROM users WHERE id=? AND role='model' AND status='active'", modelId);
  if (!m) return res.status(404).json({ error: 'Model not found' });
  if (!debitWallet(req.user.id, cents, 'tip', `model:${modelId}`))
    return res.status(402).json({ error: 'Insufficient balance' });
  q.run('INSERT INTO tips(from_user,to_model,live_id,amount_cents,message) VALUES(?,?,?,?,?)',
    req.user.id, modelId, req.body.live_id || null, cents, String(req.body.message || '').slice(0, 200));
  const { net } = creditModel(modelId, cents, 'tip', `client:${req.user.id}`);
  notify(modelId, 'tip', `${req.user.name} tipped you $${(cents / 100).toFixed(2)}${req.body.message ? ': "' + String(req.body.message).slice(0, 60) + '"' : ''} (+$${(net / 100).toFixed(2)} net)`);
  const io = req.app.get('io');
  if (io && req.body.live_id) io.to(`live:${req.body.live_id}`).emit('tip', { from: req.user.name, amount_cents: cents, message: req.body.message || '' });
  res.json({ ok: true });
});

// Rate a model after a live
router.post('/rate', (req, res) => {
  if (blocked(req, res)) return;
  const stars = Math.round(Number(req.body.stars));
  const modelId = Number(req.body.model_id);
  if (!(stars >= 1 && stars <= 5)) return res.status(400).json({ error: 'Stars must be 1-5' });
  const liveId = req.body.live_id ? Number(req.body.live_id) : null;
  try {
    q.run('INSERT INTO ratings(model_id,client_id,live_id,stars,comment) VALUES(?,?,?,?,?)',
      modelId, req.user.id, liveId, stars, String(req.body.comment || '').slice(0, 300));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'You already rated this live' });
    throw e;
  }
  const agg = q.get('SELECT AVG(stars) a, COUNT(*) c FROM ratings WHERE model_id=?', modelId);
  q.run('UPDATE model_profiles SET avg_rating=?, rating_count=? WHERE user_id=?', Math.round(agg.a * 10) / 10, agg.c, modelId);
  res.json({ ok: true });
});

// Model's content store (locked items must be unlocked by payment)
router.get('/content/:modelId', (req, res) => {
  const rows = q.all(`SELECT c.id,c.title,c.kind,c.price_cents,c.created_at,
      CASE WHEN c.price_cents=0 THEN 1 WHEN cu.id IS NOT NULL THEN 1 ELSE 0 END AS unlocked
    FROM content c LEFT JOIN content_unlocks cu ON cu.content_id=c.id AND cu.user_id=?
    WHERE c.model_id=? AND c.status='approved' ORDER BY c.id DESC`, req.user.id, req.params.modelId);
  res.json({ content: rows.map(r => ({ ...r, file: r.unlocked ? `/api/stream/content/${r.id}` : null })) });
});

router.post('/content/:id/unlock', (req, res) => {
  if (blocked(req, res)) return;
  const c = q.get("SELECT * FROM content WHERE id=? AND status='approved'", req.params.id);
  if (!c) return res.status(404).json({ error: 'Content not found' });
  if (c.price_cents > 0) {
    if (!debitWallet(req.user.id, c.price_cents, 'content_unlock', `content:${c.id}`))
      return res.status(402).json({ error: 'Insufficient balance' });
    q.run('INSERT OR IGNORE INTO content_unlocks(content_id,user_id,paid_cents) VALUES(?,?,?)', c.id, req.user.id, c.price_cents);
    creditModel(c.model_id, c.price_cents, 'content_unlock', `content:${c.id}`);
    notify(c.model_id, 'unlock', `${req.user.name} unlocked your content "${c.title}"`);
  }
  res.json({ ok: true, file: `/api/stream/content/${c.id}` });
});

router.get('/notifications', (req, res) => {
  res.json({ notifications: q.all('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 50', req.user.id) });
});
router.post('/notifications/read', (req, res) => {
  q.run('UPDATE notifications SET read=1 WHERE user_id=?', req.user.id);
  res.json({ ok: true });
});

module.exports = router;
