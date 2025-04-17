require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const mongoose = require('mongoose');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const User = require('./models/User');
const Message = require('./models/Message');
const Group = require('./models/Group');

// 1. 连接 MongoDB
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.set('io', io);

// 2. Session 配置
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, httpOnly: true, sameSite: 'lax', maxAge: 1000*60*60*24 }
});

// 3. 静态资源
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/avatars', express.static(path.join(__dirname, 'public/avatars')));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

// 4. Passport + Session
app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());
require('./config/passport-setup');

// 5. 路由挂载
app.use('/auth', require('./routes/authRoutes'));
app.use('/api/user', require('./routes/userRoutes'));
app.use('/api/group', require('./routes/groupRoutes'));
app.use('/api/upload-image', require('./routes/uploadRoutes'));

// 6. 确保目录存在（avatars, uploads）
const avatarDir = path.join(__dirname, 'public/avatars');
const uploadDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(avatarDir)) fs.mkdirSync(avatarDir, { recursive: true });
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// 7. 页面路由
const ensureAuthenticated = (req, res, next) => {
  if (req.isAuthenticated()) return next();
  res.redirect('/');
};
const ensureNicknameSet = (req, res, next) => {
  if (req.user && req.user.isNicknameSet) return next();
  res.redirect('/setup');
};

app.get('/', (req, res) => {
  if (req.isAuthenticated()) {
    const u = req.user.isNicknameSet ? '/chat' : '/setup';
    return res.redirect(u);
  }
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

app.get('/setup', ensureAuthenticated, (req, res) => {
  if (req.user.isNicknameSet) return res.redirect('/chat');
  res.sendFile(path.join(__dirname, 'public/setup.html'));
});

const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, avatarDir),
  filename: (req, file, cb) => cb(null, req.user._id + path.extname(file.originalname))
});
const upload = multer({ storage: avatarStorage });

app.post('/api/user/setup', ensureAuthenticated, upload.single('avatar'), async (req, res) => {
  const { nickname } = req.body;
  if (!nickname || !req.file) return res.status(400).send('缺少暱稱或頭像檔');
  req.user.nickname   = nickname;
  req.user.avatarUrl  = `/avatars/${req.file.filename}`;
  req.user.isNicknameSet = true;
  await req.user.save();
  res.sendStatus(200);
});

app.get('/chat', ensureAuthenticated, ensureNicknameSet, (req, res) => {
  res.sendFile(path.join(__dirname, 'public/chat.html'));
});

// 8. Socket.IO
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

  // 加载历史消息（带头像 & 昵称）
  socket.on('load history', async ({ id, type }) => {
    let raw;
    if (type === 'friend') {
      raw = await Message.find({
        $or: [
          { from: socket.userData.id, to: id },
          { from: id, to: socket.userData.id }
        ]
      })
      .sort({ timestamp: 1 })
      .populate('from', 'avatarUrl nickname')
      .lean();
    } else {
      raw = await Message.find({ group: id })
        .sort({ timestamp: 1 })
        .populate('from', 'avatarUrl nickname')
        .lean();
    }
    const msgs = raw.map(m => ({
      from:      m.from._id.toString(),
      to:        m.to    ? m.to.toString()    : undefined,
      groupId:   m.group ? m.group.toString() : undefined,
      message:   m.message,
      imageUrl:  m.imageUrl,
      timestamp: m.timestamp,
      read:      m.read,
      avatarUrl: m.from.avatarUrl,
      nickname:  m.from.nickname
    }));
    socket.emit('chat history', { messages: msgs });
  });

  // 私聊
  socket.on('private message', async ({ toUserId, message }) => {
    if (!socket.userData.friends.includes(toUserId)) return;
    const msg = await Message.create({
      from:      socket.userData.id,
      to:        toUserId,
      message,
      timestamp: new Date(),
      read:      false
    });
    const payload = {
      from:      msg.from,
      to:        msg.to,
      message:   msg.message,
      timestamp: msg.timestamp,
      avatarUrl: socket.userData.avatarUrl,
      nickname:  socket.userData.nickname,
      read:      false
    };
    io.to(toUserId).to(socket.userData.id).emit('private message', payload);
  });

  // 群聊
  socket.on('group message', async ({ to, message }) => {
    const msg = await Message.create({
      from:      socket.userData.id,
      group:     to,
      message,
      timestamp: new Date(),
      read:      false
    });
    const members = (await Group.findById(to)).members;
    const payload = {
      from:      msg.from,
      groupId:   to,
      message:   msg.message,
      timestamp: msg.timestamp,
      avatarUrl: socket.userData.avatarUrl,
      nickname:  socket.userData.nickname,
      read:      false
    };
    members.forEach(mid => io.to(mid.toString()).emit('group message', payload));
  });
});

// 9. 错误处理
app.use((req, res) => res.status(404).send("404 Not Found"));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Something broke!');
});

// 10. 启动
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
