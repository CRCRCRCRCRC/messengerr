// server.js
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const mongoose = require('mongoose');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const User = require('./models/User');
const Message = require('./models/Message');
const Group = require('./models/Group');

const app = express();

// 1️⃣ trust proxy（讓 secure cookie 在 proxy 後面也生效）
app.set('trust proxy', 1);

// MongoDB 連線
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('✅ MongoDB Connected'))
.catch(err => console.error('❌ MongoDB connection error:', err));

const server = http.createServer(app);
const io = new Server(server);

// session 設定
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge: 1000 * 60 * 60 * 24
  }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 靜態檔
app.use(express.static(path.join(__dirname, 'public')));
app.use('/avatars', express.static(path.join(__dirname, 'public/avatars')));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());
require('./config/passport-setup');

// 頁面路由
app.get('/', async (req, res) => {
  if (req.isAuthenticated()) {
    const u = await User.findById(req.user._id);
    if (!u || !u.isNicknameSet) {
      return u ? res.redirect('/setup') : res.redirect('/');
    }
    return res.redirect('/chat');
  }
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

// Setup 頁面
app.get('/setup', (req, res, next) => {
  if (!req.isAuthenticated()) return res.redirect('/');
  if (req.user.isNicknameSet) return res.redirect('/chat');
  res.sendFile(path.join(__dirname, 'public/setup.html'));
});

// 加上 passport 流程、用戶 API、好友 API、群組 API︰
app.use('/auth', require('./routes/authRoutes'));
app.use('/api/user', require('./routes/userRoutes'));
app.use('/api/group', require('./routes/groupRoutes'));

// 圖片上傳 API（把 io 傳進去）
app.use('/api/upload-image', require('./routes/uploadRoutes')(io));

// Chat 頁面
app.get('/chat', (req, res, next) => {
  if (!req.isAuthenticated() || !req.user.isNicknameSet) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public/chat.html'));
});

// Socket.IO 共用 session
io.use((socket, next) => sessionMiddleware(socket.request, {}, next));

io.on('connection', async socket => {
  const session = socket.request.session;
  if (!session?.passport?.user) return socket.disconnect(true);

  const user = await User.findById(session.passport.user);
  if (!user || !user.isNicknameSet) return socket.disconnect(true);

  socket.userData = {
    id: user._id.toString(),
    nickname: user.nickname,
    avatarUrl: user.avatarUrl,
    friends: user.friends.map(x => x.toString())
  };

  socket.join(socket.userData.id);
  socket.broadcast.emit('friend-online', { id: socket.userData.id });

  // 載入歷史訊息
  socket.on('load history', async ({ id, type }) => {
    let msgs;
    if (type === 'friend') {
      msgs = await Message.find({
        $or: [
          { from: socket.userData.id, to: id },
          { from: id, to: socket.userData.id }
        ]
      }).sort({ timestamp: 1 }).lean();
    } else {
      msgs = await Message.find({ group: id }).sort({ timestamp: 1 }).lean();
    }
    // 補上 nickname + avatarUrl
    for (let m of msgs) {
      const u = await User.findById(m.from).select('nickname avatarUrl').lean();
      m.nickname = u.nickname;
      m.avatarUrl = u.avatarUrl;
    }
    socket.emit('chat history', { messages: msgs });
  });

  // 私訊
  socket.on('private message', async ({ toUserId, message }) => {
    if (!socket.userData.friends.includes(toUserId)) return;
    const msg = await Message.create({
      from: socket.userData.id,
      to: toUserId,
      message: message,
      timestamp: new Date(),
      read: false
    });
    const payload = {
      ...msg.toObject(),
      nickname: socket.userData.nickname,
      avatarUrl: socket.userData.avatarUrl
    };
    io.to(toUserId).to(socket.userData.id).emit('private message', payload);
  });

  // 群組訊息
  socket.on('group message', async ({ to, message }) => {
    const msg = await Message.create({
      from: socket.userData.id,
      group: to,
      message,
      timestamp: new Date(),
      read: false
    });
    const payload = {
      ...msg.toObject(),
      nickname: socket.userData.nickname,
      avatarUrl: socket.userData.avatarUrl
    };
    const group = await Group.findById(to).select('members');
    group.members.forEach(mid => {
      io.to(mid.toString()).emit('group message', payload);
    });
  });

  // 收回
  socket.on('message recall', async ({ messageId }) => {
    await Message.findByIdAndUpdate(messageId, { recalled: true });
    io.emit('message recalled', { messageId });
  });

  // WebRTC Signaling
  socket.on('call-user', ({ to, offer }) => {
    io.to(to).emit('call-made', { from: socket.id, offer });
  });
  socket.on('make-answer', ({ to, answer }) => {
    io.to(to).emit('answer-made', { from: socket.id, answer });
  });
  socket.on('ice-candidate', ({ to, candidate }) => {
    io.to(to).emit('ice-candidate', { from: socket.id, candidate });
  });

  socket.on('disconnect', () => {
    socket.broadcast.emit('friend-offline', { id: socket.userData.id });
  });
});

// 404 & Error
app.use((req, res) => res.status(404).send("404 Not Found"));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Something broke!');
});

// 啟動
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
