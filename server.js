// server.js
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
  cookie: { secure: false, httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 }
});

// 3. 静态资源
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/avatars', express.static(path.join(__dirname, 'public/avatars')));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));
app.use(sessionMiddleware);

// 4. Passport 初始化
app.use(passport.initialize());
app.use(passport.session());
require('./config/passport-setup');

// 5. 确保目录存在
const avatarDir = path.join(__dirname, 'public/avatars');
const uploadDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(avatarDir)) fs.mkdirSync(avatarDir, { recursive: true });
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// 6. 路由挂载
app.use('/auth', require('./routes/authRoutes'));
app.use('/api/user', require('./routes/userRoutes'));
app.use('/api/group', require('./routes/groupRoutes'));
app.use('/api/upload-image', require('./routes/uploadRoutes'));

// 7. 页面路由中介
const ensureAuthenticated = (req, res, next) => req.isAuthenticated() ? next() : res.redirect('/');
const ensureNicknameSet = (req, res, next) =>
  req.user && req.user.isNicknameSet ? next() : res.redirect('/setup');

// 8. 页面路由
app.get('/', (req, res) => {
  if (req.isAuthenticated()) {
    return req.user.isNicknameSet ? res.redirect('/chat') : res.redirect('/setup');
  }
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

app.get('/setup', ensureAuthenticated, (req, res) => {
  if (req.user.isNicknameSet) return res.redirect('/chat');
  res.sendFile(path.join(__dirname, 'public/setup.html'));
});

// 用户首次设置昵称与头像
const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, avatarDir),
  filename: (req, file, cb) => cb(null, req.user._id + path.extname(file.originalname))
});
const setupUpload = multer({ storage: avatarStorage });
app.post('/api/user/setup', ensureAuthenticated, setupUpload.single('avatar'), async (req, res) => {
  const { nickname } = req.body;
  if (!nickname || !req.file) return res.status(400).send('缺少暱稱或頭像檔');
  req.user.nickname = nickname;
  req.user.avatarUrl = '/avatars/' + req.file.filename;
  req.user.isNicknameSet = true;
  await req.user.save();
  res.sendStatus(200);
});

app.get('/chat', ensureAuthenticated, ensureNicknameSet, (req, res) => {
  res.sendFile(path.join(__dirname, 'public/chat.html'));
});

// 9. Socket.IO 共享 Session
io.use((socket, next) => sessionMiddleware(socket.request, {}, next));

io.on('connection', async socket => {
  const sid = socket.request.session.passport?.user;
  if (!sid) return socket.disconnect(true);
  const user = await User.findById(sid);
  if (!user || !user.isNicknameSet) return socket.disconnect(true);

  // 保存 userData
  socket.userData = {
    id:      user._id.toString(),
    nickname:user.nickname,
    avatarUrl:user.avatarUrl,
    friends: user.friends.map(f => f.toString())
  };

  // 加入私人房間
  socket.join(socket.userData.id);

  // 上線通知好友
  user.friends.forEach(fid => {
    io.to(fid.toString()).emit('friend-online', { id: socket.userData.id });
  });

  // 斷線時通知
  socket.on('disconnect', () => {
    socket.userData.friends.forEach(fid => {
      io.to(fid).emit('friend-offline', { id: socket.userData.id });
    });
  });

  // 載入歷史訊息（包含头像与昵称）
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

  // 私聊訊息
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

  // 群組訊息
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
    members.forEach(mid => {
      io.to(mid.toString()).emit('group message', payload);
    });
  });
});

// 10. 全局错误处理
app.use((req, res) => res.status(404).send("404 Not Found"));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Something broke!');
});

// 11. 启动服务器
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
