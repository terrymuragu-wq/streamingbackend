const jwt = require('jsonwebtoken');
const { q } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me';
if (process.env.NODE_ENV === 'production' && JWT_SECRET === 'dev-only-secret-change-me') {
  console.warn('[warn] JWT_SECRET not set - set it in Render environment variables!');
}

const sign = (user) =>
  jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });

function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : (req.query.token || null);
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = q.get('SELECT id,email,name,role,status,verified,eligible,wallet_cents,agency_id,agency_approved,restricted,avatar,dob FROM users WHERE id=?', payload.id);
    if (!user) return res.status(401).json({ error: 'Account not found' });
    if (user.status === 'suspended') return res.status(403).json({ error: 'Account suspended. Contact support.' });
    req.user = user;
    q.run("UPDATE users SET last_seen=datetime('now') WHERE id=?", user.id);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  next();
};

/** Age gate: must be at least `minAge` (default 18) based on an ISO date string. */
function ageFromDob(dobIso) {
  if (!dobIso) return -1;
  const dob = new Date(dobIso);
  if (isNaN(dob.getTime())) return -1;
  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const m = now.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < dob.getUTCDate())) age--;
  return age;
}

const isAdult = (dobIso, minAge = 18) => ageFromDob(dobIso) >= minAge;

module.exports = { sign, requireAuth, requireRole, ageFromDob, isAdult, JWT_SECRET };
