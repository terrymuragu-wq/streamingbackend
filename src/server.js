require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const { db, DATA_DIR } = require('./db');
const { seedIfEmpty } = require('./seed');
const { socketAuth } = require('./middleware/auth');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.set('io', io);

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '1mb' }));

// Static: admin panel + uploads
app.use('/admin', express.static(path.join(__dirname, '..', 'admin')));
app.get('/admin', (req, res) => res.redirect('/admin/'));
app.use('/uploads', express.static(path.join(DATA_DIR, 'uploads')));

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'fitstream', time: new Date().toISOString() }));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/coaches', require('./routes/coaches'));
app.use('/api/lives', require('./routes/lives'));
app.use('/api/content', require('./routes/content'));
app.use('/api/wallet', require('./routes/wallet'));
app.use('/api/manager', require('./routes/manager'));
app.use('/api/admin', require('./routes/admin'));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Never leak stack traces to the client
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'File too large' });
  console.error('[error]', err && err.message);
  res.status(500).json({ error: 'Something went wrong on our end. Please try again.' });
});

// ---- Realtime: chat, viewers, tips, live alerts ----
const viewers = {}; // liveId -> Set of socket ids

io.use(socketAuth);
io.on('connection', (socket) => {
  if (socket.user) socket.join(`user-${socket.user.id}`);

  socket.on('join-live', (liveId) => {
    liveId = parseInt(liveId, 10);
    if (!liveId) return;
    socket.join(`live-${liveId}`);
    (viewers[liveId] = viewers[liveId] || new Set()).add(socket.id);
    db.prepare('UPDATE live_sessions SET viewers = ? WHERE id = ?').run(viewers[liveId].size, liveId);
    io.to(`live-${liveId}`).emit('viewers', viewers[liveId].size);
  });

  socket.on('leave-live', (liveId) => {
    liveId = parseInt(liveId, 10);
    if (!liveId || !viewers[liveId]) return;
    socket.leave(`live-${liveId}`);
    viewers[liveId].delete(socket.id);
    db.prepare('UPDATE live_sessions SET viewers = ? WHERE id = ?').run(viewers[liveId].size, liveId);
    io.to(`live-${liveId}`).emit('viewers', viewers[liveId].size);
  });

  socket.on('chat', ({ liveId, text }) => {
    if (!socket.user) return socket.emit('chat-error', 'Log in to join the chat');
    liveId = parseInt(liveId, 10);
    text = String(text || '').trim().slice(0, 300);
    if (!liveId || !text) return;
    const info = db.prepare('INSERT INTO messages (live_id, user_id, text) VALUES (?,?,?)')
      .run(liveId, socket.user.id, text);
    io.to(`live-${liveId}`).emit('chat', {
      id: info.lastInsertRowid, text, name: socket.user.name,
      avatar_color: socket.user.avatar_color, role: socket.user.role,
      created_at: new Date().toISOString(),
    });
  });

  socket.on('disconnect', () => {
    for (const [liveId, set] of Object.entries(viewers)) {
      if (set.delete(socket.id)) {
        db.prepare('UPDATE live_sessions SET viewers = ? WHERE id = ?').run(set.size, liveId);
        io.to(`live-${liveId}`).emit('viewers', set.size);
      }
    }
  });
});

const PORT = process.env.PORT || 10000;
seedIfEmpty();
server.listen(PORT, () => {
  console.log(`FitStream backend listening on :${PORT}`);
  console.log(`Admin panel: http://localhost:${PORT}/admin`);
});
