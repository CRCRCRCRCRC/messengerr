// ✅ 完整 server.js，支援即時好友在線狀態、已讀訊息、自動加入好友後刷新聊天清單
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const mongoose = require('mongoose');
const http = require('http');
const { Server } = require("socket.io");
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const User = require('./models/User');
const Message = require('./models/Message');

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ MongoDB Error:', err));

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24
  }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/avatars', express.static(path.join(__dirname, 'public/avatars')));
app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());
require('./config/passport-setup');

app.use('/auth', require('./routes/authRoutes'));
app.use('/api/user', require('./routes/userRoutes'));

const ensureAuthenticated = (req, res, next) => {
  if (req.isAuthenticated()) return next();
  res.redirect('/');
};

const ensureNicknameSet = (req, res, next) => {
  if (req.user && req.user.isNicknameSet) return next();
  res.redirect('/setup');
};

const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'public/avatars');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, req.user._id + ext);
  }
});
const upload = multer({ storage: avatarStorage });

app.get('/', async (req, res) => {
  if (req.isAuthenticated()) {
    const freshUser = await User.findById(req.user._id);
    if (!freshUser) return res.redirect('/');
    if (!freshUser.isNicknameSet) return res.redirect('/setup');
    return res.redirect('/chat');
  } else {
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

app.get('/setup', ensureAuthenticated, (req, res) => {
  if (req.user.isNicknameSet) res.redirect('/chat');
  else res.sendFile(path.join(__dirname, 'public', 'setup.html'));
});

app.post('/api/user/setup', ensureAuthenticated, upload.single('avatar'), async (req, res) => {
  const { nickname } = req.body;
  if (!nickname || !req.file) return res.status(400).send('缺少暱稱或頭像檔');

  req.user.nickname = nickname;
  req.user.avatarUrl = `/avatars/${req.file.filename}`;
  req.user.isNicknameSet = true;
  await req.user.save();
  res.sendStatus(200);
});

app.get('/chat', ensureAuthenticated, ensureNicknameSet, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});

// --- Socket.IO ---
io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

const onlineUsers = new Map();

io.on('connection', async (socket) => {
  const session = socket.request.session;
  if (!session?.passport?.user) return socket.disconnect(true);

  const user = await User.findById(session.passport.user);
  if (!user || !user.isNicknameSet) return socket.disconnect(true);

  user.isOnline = true;
  await user.save();
  onlineUsers.set(user._id.toString(), socket);

  socket.userData = {
    id: user._id.toString(),
    nickname: user.nickname,
    avatarUrl: user.avatarUrl,
    friends: user.friends.map(f => f.toString())
  };

  socket.join(socket.userData.id);

  user.friends.forEach(fid => {
    io.to(fid.toString()).emit('friend-online', { id: user._id.toString() });
  });

  socket.on('private message', async ({ toUserId, message }) => {
    const isOnline = onlineUsers.has(toUserId);
    const msg = await Message.create({
      from: socket.userData.id,
      to: toUserId,
      message,
      isRead: isOnline
    });

    const data = {
      from: socket.userData.id,
      to: toUserId,
      message,
      isRead: isOnline,
      timestamp: msg.timestamp,
      avatarUrl: socket.userData.avatarUrl,
      nickname: socket.userData.nickname
    };
    io.to(toUserId).to(socket.userData.id).emit('private message', data);
  });

  socket.on('disconnect', async () => {
    user.isOnline = false;
    await user.save();
    onlineUsers.delete(user._id.toString());
    user.friends.forEach(fid => {
      io.to(fid.toString()).emit('friend-offline', { id: user._id.toString() });
    });
  });
});

app.use((req, res) => {
  res.status(404).send("Sorry, can't find that!");
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Something broke!');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server ready at http://localhost:${PORT}`));
