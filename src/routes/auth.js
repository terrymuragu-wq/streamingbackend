const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { q, notify, audit, getSetting } = require('../db');
const { sign, requireAuth, ageFromDob, isAdult } = require('../auth');

const router = express.Router();

const UP = process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads');
fs.mkdirSync(UP, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: UP,
    filename: (req, file, cb) => cb(null, `v_${Date.now()}_${Math.random().toString(36).slice(2)}${path.extname(file.originalname || '.bin').slice(0, 8)}`)
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(jpe?g|png|webp|pdf)$/i.test(file.originalname || '');
    cb(ok ? null : new Error('Only JPG/PNG/WEBP/PDF files allowed'), ok);
  }
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- REGISTER (client | model | manager) ----------
router.post('/register', (req, res) => {
  try {
    const { email, password, name, role, dob, agencyCode } = req.body || {};
    if (!email || !password || !name || !role) return res.status(400).json({ error: 'email, password, name and role are required' });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Invalid email address' });
    if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (!['client', 'model', 'manager'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    if (!dob) return res.status(400).json({ error: 'Date of birth is required (18+ only)' });

    const minAge = parseInt(getSetting('min_age', '18'), 10);
    if (!isAdult(dob, minAge)) {
      return res.status(403).json({ error: `You must be at least ${minAge} years old to use this platform.` });
    }

    let agencyId = null;
    if (role === 'model') {
      if (!agencyCode) return res.status(400).json({ error: 'Models must register with an agency code' });
      const ag = q.get("SELECT * FROM agencies WHERE code=? AND status='active'", String(agencyCode).trim().toUpperCase());
      if (!ag) return res.status(400).json({ error: 'Invalid or inactive agency code' });
      agencyId = ag.id;
    }

    const hash = bcrypt.hashSync(String(password), 10);
    let id;
    try {
      id = q.run('INSERT INTO users(email,pass_hash,name,role,status,dob,agency_id) VALUES(?,?,?,?,?,?,?)',
        email.toLowerCase().trim(), hash, String(name).trim(), role, 'pending', dob, agencyId).lastInsertRowid;
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'An account with this email already exists' });
      throw e;
    }

    if (role === 'model') {
      q.run('INSERT INTO model_profiles(user_id,display_name) VALUES(?,?)', id, String(name).trim());
      const ag = q.get('SELECT manager_id,name FROM agencies WHERE id=?', agencyId);
      if (ag) notify(ag.manager_id, 'model_pending', `New model "${name}" applied to your agency "${ag.name}". Review and approve.`);
    }
    if (role === 'manager') {
      const code = 'AG' + Math.random().toString(36).slice(2, 8).toUpperCase();
      const agName = String(req.body.agencyName || `${name}'s Agency`).trim();
      q.run('INSERT INTO agencies(code,name,manager_id) VALUES(?,?,?)', code, agName, id);
      const admins = q.all("SELECT id FROM users WHERE role='admin'");
      admins.forEach(a => notify(a.id, 'agency_new', `New agency "${agName}" (${code}) registered by ${name}.`));
      return res.json({ ok: true, message: 'Agency registered. Share your agency code with your models.', agencyCode: code, needsVerification: true });
    }
    audit(id, 'register', `user:${id}`, { role });
    res.json({ ok: true, message: 'Account created. Next step: verify your identity (ID + selfie) to activate.', needsVerification: true, userId: id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// ---------- ID VERIFICATION: ID/passport scan + selfie, auto age check ----------
router.post('/verify', upload.fields([{ name: 'idDoc', maxCount: 1 }, { name: 'selfie', maxCount: 1 }]), (req, res) => {
  try {
    const { email, idType, idNumber, dobDeclared } = req.body || {};
    if (!email || !idType || !idNumber || !dobDeclared) return res.status(400).json({ error: 'email, idType, idNumber and dobDeclared are required' });
    if (!req.files || !req.files.idDoc || !req.files.selfie) return res.status(400).json({ error: 'Both the ID document and a selfie are required' });

    const user = q.get('SELECT * FROM users WHERE email=?', String(email).toLowerCase().trim());
    if (!user) return res.status(404).json({ error: 'Account not found' });
    if (user.verified) return res.status(409).json({ error: 'Account already verified' });

    const minAge = parseInt(getSetting('min_age', '18'), 10);
    const checks = {
      dobOnIdAdult: isAdult(dobDeclared, minAge),
      dobMatchesAccount: dobDeclared === user.dob,
      accountDobAdult: isAdult(user.dob, minAge),
      idType: ['passport', 'national_id', 'drivers_license'].includes(idType),
    };
    const autoPass = Object.values(checks).every(Boolean);

    q.run(`INSERT INTO verifications(user_id,id_type,id_number,dob_declared,id_file,selfie_file,status,auto_checks)
           VALUES(?,?,?,?,?,?,?,?)`,
      user.id, idType, String(idNumber).trim(), dobDeclared,
      req.files.idDoc[0].filename, req.files.selfie[0].filename,
      autoPass ? 'approved' : 'pending', JSON.stringify(checks));

    if (autoPass) {
      q.run('UPDATE users SET verified=1 WHERE id=?', user.id);
      if (user.role === 'client') {
        q.run("UPDATE users SET status='active' WHERE id=?", user.id);
        notify(user.id, 'verified', 'Identity verified — welcome! Your account is now active.');
      } else {
        notify(user.id, 'verified', 'Identity verified. Waiting for agency/admin approval before you go live.');
      }
      const admins = q.all("SELECT id FROM users WHERE role='admin'");
      admins.forEach(a => notify(a.id, 'verification', `${user.name} (${user.role}) auto-verified: ID ${idType}, DOB ${dobDeclared}.`));
      audit(user.id, 'verification_auto_approved', `user:${user.id}`, checks);
      return res.json({ ok: true, verified: true, message: 'Identity verified automatically. You are 18+ confirmed.' });
    }

    const admins = q.all("SELECT id FROM users WHERE role='admin'");
    admins.forEach(a => notify(a.id, 'verification_review', `${user.name} (${user.role}) verification needs manual review.`));
    audit(user.id, 'verification_manual_review', `user:${user.id}`, checks);
    res.json({ ok: true, verified: false, message: 'Documents received. Some checks need manual review by our team (usually < 24h).', checks });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Verification upload failed. Please try again.' });
  }
});

// ---------- LOGIN ----------
router.post('/login', (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
    const user = q.get('SELECT * FROM users WHERE email=?', String(email).toLowerCase().trim());
    if (!user || !bcrypt.compareSync(String(password), user.pass_hash)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    if (user.status === 'suspended') return res.status(403).json({ error: 'Account suspended. Contact support.' });
    if (user.status === 'rejected') return res.status(403).json({ error: 'Account application was rejected.' });
    audit(user.id, 'login', `user:${user.id}`);
    const { pass_hash, ...safe } = user;
    res.json({ token: sign(user), user: safe });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Login failed' });
  }
});

router.get('/me', requireAuth, (req, res) => {
  const extra = req.user.role === 'model'
    ? q.get('SELECT display_name,bio,category,sub_price_cents,is_live,total_earned_cents,avg_rating,rating_count FROM model_profiles WHERE user_id=?', req.user.id)
    : req.user.role === 'manager'
      ? q.get('SELECT code,name FROM agencies WHERE manager_id=?', req.user.id)
      : {};
  res.json({ user: { ...req.user, profile: extra || {} } });
});

module.exports = router;
