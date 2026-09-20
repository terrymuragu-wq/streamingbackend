// Seed demo data on first boot (skipped if users exist or SEED_DEMO=false)
const bcrypt = require('bcryptjs');
const { db, getWallet, credit, notify } = require('./db');

function seedIfEmpty() {
  if (process.env.SEED_DEMO === 'false') return;
  const count = db.prepare('SELECT COUNT(*) n FROM users').get().n;
  if (count > 0) return;

  console.log('[seed] Creating demo data...');
  const hash = bcrypt.hashSync('password123', 10);
  const adminHash = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin123', 10);

  const insUser = db.prepare(
    'INSERT INTO users (email, password_hash, name, role, status, avatar_color) VALUES (?,?,?,?,?,?)'
  );

  const adminId = insUser.run('admin@fitstream.io', adminHash, 'Platform Admin', 'admin', 'active', '#d63031').lastInsertRowid;
  const managerId = insUser.run('manager@fitstream.io', hash, 'Dana Reed', 'manager', 'active', '#0984e3').lastInsertRowid;
  const agencyId = db.prepare('INSERT INTO agencies (name, manager_id) VALUES (?,?)')
    .run('PeakForm Agency', managerId).lastInsertRowid;

  const coachSeeds = [
    ['ava@fitstream.io', 'Ava Martinez', 'HIIT & Cardio', 'Former track athlete. High-energy HIIT sessions that torch calories in 30 minutes.', '#e17055', 499],
    ['marcus@fitstream.io', 'Marcus Cole', 'Strength Training', 'Certified strength coach, 10 years powerlifting. Progressive programs for all levels.', '#00b894', 599],
    ['yuki@fitstream.io', 'Yuki Tanaka', 'Yoga & Mobility', 'RYT-500 yoga instructor. Flow, breathe, recover. All levels welcome.', '#6c5ce7', 399],
  ];
  const coachIds = [];
  for (const [email, name, specialty, bio, color, price] of coachSeeds) {
    const id = insUser.run(email, hash, name, 'coach', 'active', color).lastInsertRowid;
    db.prepare('INSERT INTO coaches (user_id, agency_id, bio, specialty, price_cents, approved) VALUES (?,?,?,?,?,1)')
      .run(id, agencyId, bio, specialty, price);
    db.prepare('INSERT INTO coach_applications (coach_id, agency_id, status) VALUES (?,?,?)').run(id, agencyId, 'approved');
    coachIds.push(id);
    getWallet(id);
  }

  const clientId = insUser.run('client@fitstream.io', hash, 'Sam Carter', 'client', 'active', '#00cec9').lastInsertRowid;
  getWallet(clientId);
  credit(clientId, 5000, 'topup', 'Welcome credits');

  // One coach live now, one scheduled
  db.prepare(`INSERT INTO live_sessions (coach_id, title, description, price_cents, status, stream_url, started_at, viewers)
    VALUES (?,?,?,?, 'live', ?, datetime('now'), 12)`)
    .run(coachIds[0], 'Morning HIIT Blast 🔥', '30-min full body burner. No equipment needed.', 0,
      'https://www.youtube.com/embed/jfKfPfyJRdk');
  db.prepare('UPDATE coaches SET live_now = 1 WHERE user_id = ?').run(coachIds[0]);

  db.prepare(`INSERT INTO live_sessions (coach_id, title, description, price_cents, status, scheduled_at)
    VALUES (?,?,?,?, 'scheduled', datetime('now', '+1 day'))`)
    .run(coachIds[1], 'Heavy Compound Strength', 'Squat, bench, deadlift technique deep-dive.', 499);

  // Approved paid content
  db.prepare(`INSERT INTO content (coach_id, title, description, type, price_cents, url, status)
    VALUES (?,?,?,?,?,?, 'approved')`)
    .run(coachIds[2], '7-Day Flexibility Program', 'A guided week of daily 20-min mobility flows.', 'program', 999,
      'https://www.youtube.com/embed/v7AYKMP6rOE');
  db.prepare(`INSERT INTO content (coach_id, title, description, type, price_cents, url, status)
    VALUES (?,?,?,?,?,?, 'approved')`)
    .run(coachIds[1], 'Perfect Your Deadlift', 'Masterclass: setup, bracing, and the pull.', 'video', 499,
      'https://www.youtube.com/embed/op9kVnSso6Q');

  // Sample ratings
  const insRating = db.prepare('INSERT INTO ratings (client_id, coach_id, stars, review) VALUES (?,?,?,?)');
  insRating.run(clientId, coachIds[0], 5, 'Ava\'s classes are insanely motivating!');
  insRating.run(clientId, coachIds[2], 5, 'My back pain is gone after two weeks.');

  notify(clientId, 'Welcome to FitStream! You have 50.00 credits to spend on live classes and programs.');
  notify(adminId, 'Demo data seeded. Admin panel is at /admin');

  console.log('[seed] Done. Logins (password: password123, admin: admin123):');
  console.log('  admin@fitstream.io / manager@fitstream.io / ava@fitstream.io / client@fitstream.io');
}

module.exports = { seedIfEmpty };
