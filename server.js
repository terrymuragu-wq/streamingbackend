require('./src/db'); // init schema + seed admin
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');

const { q, notify } = require('./src/db');
const { requireAuth, JWT_SECRET } = require('./src/auth');

const app = express();
const server = http.createServer(app);

const ALLOWED = (process.env.CORS_ORIGIN || '*').split(',').map(s => s.trim());
// CORS fix: never hard-block with an error (that was causing "Not allowed by CORS"
// on the admin login and frontend). Unknown origins are still allowed instead of rejected.
const corsOpts = {
  origin: (origin, cb) => {
    if (!origin || ALLOWED.includes('*') || ALLOWED.includes(origin)) return cb(null, true);
    return cb(null, true);
  },
  credentials: true,
};
app.use(cors(corsOpts));
app.options('*', cors(corsOpts)); // answer every preflight request
app.use(express.json({ limit: '2mb' }));

// tiny rate limiter (per IP, 300 req / 5 min)
const hits = new Map();
app.use((req, res, next) => {
  const k = req.ip;
  const now = Date.now();
  const rec = hits.get(k) || { n: 0, t: now };
  if (now - rec.t > 5 * 60 * 1000) { rec.n = 0; rec.t = now; }
  rec.n++; hits.set(k, rec);
  if (rec.n > 300) return res.status(429).json({ error: 'Too many requests — slow down.' });
  next();
});

// ---------- static: admin panel at /admin ----------
app.use('/admin', express.static(path.join(__dirname, 'admin')));

// ---------- routes ----------
app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/client', require('./src/routes/client'));
app.use('/api/model', require('./src/routes/model'));
app.use('/api/manager', require('./src/routes/manager'));
app.use('/api/admin', require('./src/routes/admin'));

// Protected content streaming (paid content)
const UP = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
app.get('/api/stream/content/:id', requireAuth, (req, res) => {
  const c = q.get("SELECT * FROM content WHERE id=? AND status='approved'", req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  const owns = c.model_id === req.user.id || req.user.role === 'admin';
  const unlocked = c.price_cents === 0 ||
    q.get('SELECT id FROM content_unlocks WHERE content_id=? AND user_id=?', c.id, req.user.id);
  if (!owns && !unlocked) return res.status(402).json({ error: 'Locked — pay to unlock' });
  const p = path.join(UP, path.basename(c.file_path));
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'File missing' });
  res.sendFile(p);
});

// Public avatar serving (only the file recorded on the user's profile — verification docs stay protected)
app.get('/api/avatar/:userId', (req, res) => {
  const u = q.get('SELECT avatar FROM users WHERE id=?', req.params.userId);
  if (!u || !u.avatar) return res.status(404).json({ error: 'No avatar' });
  const p = path.join(UP, path.basename(u.avatar));
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'File missing' });
  res.sendFile(p);
});

app.get('/api/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
app.get('/', (req, res) => res.json({ service: 'AdultBlog API', docs: '/api/health', admin: '/admin' }));

// ---------- Socket.IO: live chat, tips, WebRTC signaling ----------
const io = new Server(server, {
  cors: { origin: ALLOWED.includes('*') ? '*' : ALLOWED, credentials: true },
});
app.set('io', io);

const viewers = new Map(); // live_id -> Set(socketId)
const endTimers = new Map(); // live_id -> grace timeout (broadcaster reconnect window)

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    const payload = jwt.verify(token, JWT_SECRET);
    const u = q.get('SELECT id,name,role,status,restricted FROM users WHERE id=?', payload.id);
    if (!u || u.status !== 'active') return next(new Error('unauthorized'));
    socket.user = u;
    next();
  } catch (e) { next(new Error('unauthorized')); }
});

io.on('connection', (socket) => {
  // Join a live room: model = broadcaster, clients = viewers (must have paid access)
  socket.on('join_live', ({ live_id }) => {
    const live = q.get("SELECT * FROM lives WHERE id=? AND status='live'", live_id);
    if (!live) return socket.emit('error_msg', { error: 'Live not found or already ended' });
    const isModel = live.model_id === socket.user.id;
    const isStaff = ['admin'].includes(socket.user.role);
    if (!isModel && !isStaff) {
      const access = q.get('SELECT id FROM live_access WHERE live_id=? AND user_id=?', live_id, socket.user.id);
      if (!access) return socket.emit('error_msg', { error: 'Payment required to watch this live' });
    }
    // Broadcaster rejoined within the grace window — cancel the pending auto-end
    if (isModel && endTimers.has(live_id)) { clearTimeout(endTimers.get(live_id)); endTimers.delete(live_id); }
    socket.join(`live:${live_id}`);
    socket.data.live_id = live_id;
    socket.data.is_broadcaster = isModel;
    if (!viewers.has(live_id)) viewers.set(live_id, new Set());
    viewers.get(live_id).add(socket.id);
    const count = viewers.get(live_id).size - 1; // minus broadcaster
    q.run('UPDATE lives SET peak_viewers = MAX(peak_viewers, ?) WHERE id=?', Math.max(0, count), live_id);
    io.to(`live:${live_id}`).emit('viewer_count', { live_id, count: Math.max(0, count) });
    if (!isModel) socket.to(`live:${live_id}`).emit('viewer_joined', { socketId: socket.id });
    // recent chat history
    const history = q.all(`SELECT c.message, c.created_at, u.name, u.role FROM chat c JOIN users u ON u.id=c.user_id
                           WHERE c.live_id=? ORDER BY c.id DESC LIMIT 30`, live_id).reverse();
    socket.emit('chat_history', history);
  });

  // WebRTC signaling relay
  socket.on('webrtc_offer', ({ to, sdp }) => io.to(`live:${socket.data.live_id}`).emit('webrtc_offer', { from: socket.id, to, sdp }));
  socket.on('webrtc_answer', ({ to, sdp }) => io.to(`live:${socket.data.live_id}`).emit('webrtc_answer', { from: socket.id, to, sdp }));
  socket.on('webrtc_ice', ({ to, candidate }) => io.to(`live:${socket.data.live_id}`).emit('webrtc_ice', { from: socket.id, to, candidate }));

  socket.on('chat', ({ live_id, message }) => {
    if (socket.user.restricted) return socket.emit('error_msg', { error: 'Your account is restricted from chatting' });
    const msg = String(message || '').trim().slice(0, 300);
    if (!msg) return;
    const live = q.get("SELECT * FROM lives WHERE id=? AND status='live'", live_id);
    if (!live) return;
    q.run('INSERT INTO chat(live_id,user_id,message) VALUES(?,?,?)', live_id, socket.user.id, msg);
    io.to(`live:${live_id}`).emit('chat', { name: socket.user.name, role: socket.user.role, message: msg, at: new Date().toISOString() });
  });

  socket.on('disconnect', () => {
    const lid = socket.data.live_id;
    if (lid && viewers.has(lid)) {
      viewers.get(lid).delete(socket.id);
      io.to(`live:${lid}`).emit('viewer_count', { live_id: lid, count: Math.max(0, viewers.get(lid).size - 1) });
      if (socket.data.is_broadcaster) {
        // Grace window: a page refresh or brief network drop must NOT end the stream.
        // The live only ends if the broadcaster does not reconnect within 90 seconds,
        // or when the model/admin explicitly ends it.
        const uid = socket.user.id;
        if (endTimers.has(lid)) clearTimeout(endTimers.get(lid));
        endTimers.set(lid, setTimeout(() => {
          endTimers.delete(lid);
          const stillLive = q.get("SELECT id FROM lives WHERE id=? AND status='live'", lid);
          if (!stillLive) return;
          const back = [...(viewers.get(lid) || [])].some(sid => {
            const s = io.sockets.sockets.get(sid);
            return s && s.data.is_broadcaster;
          });
          if (back) return;
          q.run("UPDATE lives SET status='ended', ended_at=datetime('now') WHERE id=? AND status='live'", lid);
          q.run('UPDATE model_profiles SET is_live=0 WHERE user_id=?', uid);
          io.to(`live:${lid}`).emit('live_ended', { live_id: lid });
        }, 90000));
        io.to(`live:${lid}`).emit('broadcaster_reconnecting', { live_id: lid });
      }
    }
  });
});

// Scheduled-live reminder sweep (every minute) — auto-notify when it's time
setInterval(() => {
  const due = q.all(`SELECT * FROM lives WHERE status='scheduled' AND scheduled_at <= datetime('now') AND scheduled_at > datetime('now','-2 minutes')`);
  for (const l of due) {
    const m = q.get('SELECT name FROM users WHERE id=?', l.model_id);
    const subs = q.all("SELECT client_id FROM subscriptions WHERE model_id=? AND status='active'", l.model_id);
    subs.forEach(s => notify(s.client_id, 'live_starting', `${m.name}'s live "${l.title}" is starting now!`, `/watch.html?live=${l.id}`));
  }
}, 60000);

// Global error handler — never leak stack traces to clients
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message && err.message.length < 200 ? err.message : 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`AdultBlog API listening on :${PORT} — admin panel at /admin`));

// Neon PostgreSQL backup / restore + Render keep-alive.
// Active only when DATABASE_URL is set; harmless no-op otherwise.
require('./src/pgbackup').start();
