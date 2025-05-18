require('dotenv').config();
const multer = require('multer');
const fs = require('fs');
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
const FriendRequest = require('./models/FriendRequest');

const app = express();
app.set('trust proxy', 1);

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

const server = http.createServer(app);
const io = new Server(server);

const MongoStore = require('connect-mongo');

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: process.env.MONGODB_URI,
    collectionName: 'sessions',
    ttl: 60 * 60 * 24
  }),
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge: 1000 * 60 * 60 * 24
  }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/avatars', express.static(path.join(__dirname, 'public/avatars')));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));
app.use(sessionMiddleware);

const avatarsDir = path.join(__dirname, 'public/avatars');
if (!fs.existsSync(avatarsDir)) fs.mkdirSync(avatarsDir, { recursive: true });

// multer 設定：上傳使用者大頭貼
const avatarStorage = multer.diskStorage({
  destination: (_, file, cb) => cb(null, avatarsDir),
  filename:   (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, req.user._id + ext);
  }
});
const upload = multer({ storage: avatarStorage });

app.use(passport.initialize());
app.use(passport.session());
require('./config/passport-setup');

// 登入檢查
const ensureAuth = (req, res, next) => {
  if (req.isAuthenticated()) return next();
  res.redirect('/');
};
const ensureNickname = (req, res, next) => {
  if (req.user && req.user.isNicknameSet) return next();
  res.redirect('/setup');
};

// 頁面路由
app.get('/', (req, res) => {
  if (req.isAuthenticated()) {
    if (!req.user.isNicknameSet) return res.redirect('/setup');
    return res.redirect('/chat');
  }
  res.sendFile(path.join(__dirname, 'public/index.html'));
});
app.get('/setup', ensureAuth, (req, res) => {
  if (req.user.isNicknameSet) return res.redirect('/chat');
  res.sendFile(path.join(__dirname, 'public/setup.html'));
});
app.get('/chat', ensureAuth, ensureNickname, (req, res) => {
  res.sendFile(path.join(__dirname, 'public/chat.html'));
});
app.get('/call/:roomId', ensureAuth, ensureNickname, (req, res) => {
  res.sendFile(path.join(__dirname, 'public/call.html'));
});

// 路由
app.use('/auth', require('./routes/authRoutes'));
app.use('/api/user', require('./routes/userRoutes')(io)); // 給 io 讓推播好友
app.use('/api/group', require('./routes/groupRoutes'));
app.use('/api/upload-image', require('./routes/uploadRoutes')(io));

// Socket.IO session
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
    friends: user.friends.map(f => f.toString())
  };

  socket.join(socket.userData.id);
  socket.broadcast.emit('friend-online', { id: socket.userData.id });

  // 歷史訊息
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
    for (let m of msgs) {
      const u = await User.findById(m.from).select('nickname avatarUrl').lean();
      m.nickname = u?.nickname || '未知';
      m.avatarUrl = u?.avatarUrl || '/default-avatar.png';
    }
    socket.emit('chat history', { messages: msgs });
  });

  // 私訊
  socket.on('private message', async ({ toUserId, message }) => {
    if (!socket.userData.friends.includes(toUserId)) return;
    const msg = await Message.create({
      from: socket.userData.id,
      to: toUserId,
      message,
      timestamp: new Date(),
      read: false
    });
    const payload = {
      ...msg.toObject(),
      from: msg.from.toString(),
      to: msg.to.toString(),
      nickname: socket.userData.nickname,
      avatarUrl: socket.userData.avatarUrl
    };
    io.to(toUserId).to(socket.userData.id).emit('private message', payload);
  });

  // 群聊
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
      from: msg.from.toString(),
      group: msg.group.toString(),
      nickname: socket.userData.nickname,
      avatarUrl: socket.userData.avatarUrl
    };
    const grp = await Group.findById(to).select('members');
    grp.members.forEach(mid => {
      io.to(mid.toString()).emit('group message', payload);
    });
  });

  // 收回訊息
  socket.on('message recall', async ({ messageId }) => {
    await Message.findByIdAndUpdate(messageId, { recalled: true });
    io.emit('message recalled', { messageId });
  });

  // 通話請求與信令
  socket.on('call-request', ({ toUserId, roomId }) => {
    io.to(toUserId).emit('incoming-call', {
      from: socket.userData.id,
      nickname: socket.userData.nickname,
      roomId
    });
  });
  socket.on('call-response', ({ toUserId, accept, roomId }) => {
    io.to(toUserId).emit('call-response', {
      from: socket.userData.id,
      accept,
      roomId
    });
  });
  socket.on('join-call', ({ roomId }) => {
    socket.join(roomId);
  });
  socket.on('offer', ({ roomId, offer }) => {
    socket.to(roomId).emit('offer', { from: socket.id, offer });
  });
  socket.on('answer', ({ roomId, answer }) => {
    socket.to(roomId).emit('answer', { from: socket.id, answer });
  });
  socket.on('ice-candidate', ({ roomId, candidate }) => {
    socket.to(roomId).emit('ice-candidate', { from: socket.id, candidate });
  });

  // 離線
  socket.on('disconnect', () => {
    socket.broadcast.emit('friend-offline', { id: socket.userData.id });
  });
});

// 404 + error
app.use((req, res) => res.status(404).send("404 Not Found"));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Something broke!');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
