require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const mongoose = require('mongoose');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const User         = require('./models/User');
const Message      = require('./models/Message');
const Group        = require('./models/Group');
const FriendRequest= require('./models/FriendRequest'); // 若有此模型

// 連線 MongoDB
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);
app.set('io', io);

// Middleware：解析 JSON, URL-encoded
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 靜態資源：public、avatars、uploads
app.use(express.static(path.join(__dirname, 'public')));
app.use('/avatars', express.static(path.join(__dirname, 'public/avatars')));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

// 初使化 uploads 及 avatars 資料夾
if (!fs.existsSync(path.join(__dirname, 'public/avatars'))) {
  fs.mkdirSync(path.join(__dirname, 'public/avatars'), { recursive: true });
}
if (!fs.existsSync(path.join(__dirname, 'public/uploads'))) {
  fs.mkdirSync(path.join(__dirname, 'public/uploads'), { recursive: true });
}

// Session 設定
const sessionMiddleware = session({
  secret:            process.env.SESSION_SECRET,
  resave:            false,
  saveUninitialized: false,
  cookie: { secure:false, httpOnly:true, sameSite:'lax', maxAge: 24*3600*1000 }
});
app.use(sessionMiddleware);

// Passport 初始化
app.use(passport.initialize());
app.use(passport.session());
require('./config/passport-setup');

// 路由掛載
app.use('/auth', require('./routes/authRoutes'));
app.use('/api/user', require('./routes/userRoutes'));
app.use('/api/group', require('./routes/groupRoutes'));         // 若有群組路由
app.use('/api/upload-image', require('./routes/uploadRoutes'));
app.use('/api/message', require('./routes/messageRoutes'));

// Helper Middleware
const ensureAuth = (req, res, next) => req.isAuthenticated() ? next() : res.redirect('/');
const ensureNick = (req, res, next) => req.user.isNicknameSet ? next() : res.redirect('/setup');

// HTML Routes
app.get('/', (req, res) => {
  if (!req.isAuthenticated()) return res.sendFile(path.join(__dirname, 'public/index.html'));
  return req.user.isNicknameSet ? res.redirect('/chat') : res.redirect('/setup');
});
app.get('/setup', ensureAuth, (req, res) => {
  if (req.user.isNicknameSet) return res.redirect('/chat');
  res.sendFile(path.join(__dirname, 'public/setup.html'));
});
app.get('/chat', ensureAuth, ensureNick, (req, res) => {
  res.sendFile(path.join(__dirname, 'public/chat.html'));
});

// Socket.IO & Session 共用
io.use((socket, next) => sessionMiddleware(socket.request, {}, next));

io.on('connection', async socket => {
  const sid = socket.request.session.passport?.user;
  if (!sid) return socket.disconnect(true);
  const user = await User.findById(sid);
  if (!user || !user.isNicknameSet) return socket.disconnect(true);

  // 加入自己的房間
  socket.join(user._id.toString());
  // 通知朋友自己上線
  user.friends.forEach(fid => {
    io.to(fid.toString()).emit('friend-online', { id: user._id.toString() });
  });

  socket.on('disconnect', () => {
    user.friends.forEach(fid => {
      io.to(fid.toString()).emit('friend-offline', { id: user._id.toString() });
    });
  });

  // 載入歷史訊息（含圖片 URL）
  socket.on('load history', async ({ id, type }) => {
    let raw;
    if (type === 'friend') {
      raw = await Message.find({
        $or: [
          { from: user._id, to: id },
          { from: id, to: user._id }
        ]
      }).sort('timestamp').populate('from', 'avatarUrl nickname').lean();
    } else {
      raw = await Message.find({ group: id }).sort('timestamp').populate('from', 'avatarUrl nickname').lean();
    }
    const msgs = raw.map(m => ({
      id:       m._id.toString(),
      from:     m.from._id.toString(),
      to:       m.to?.toString(),
      groupId:  m.group?.toString(),
      message:  m.message,
      imageUrl: m.imageUrl || null,
      timestamp:m.timestamp,
      read:     m.read,
      recalled: m.recalled,
      avatarUrl:m.from.avatarUrl,
      nickname: m.from.nickname
    }));
    socket.emit('chat history', { messages: msgs });
  });

  // 私聊文字或圖片
  socket.on('private message', async ({ toUserId, message, imageUrl }) => {
    if (!user.friends.map(f => f.toString()).includes(toUserId)) return;
    const msg = await Message.create({
      from:      user._id,
      to:        toUserId,
      message:   message || null,
      imageUrl:  imageUrl || null,
      timestamp: new Date(),
      read:      false,
      recalled:  false
    });
    const payload = {
      id:       msg._id.toString(),
      from:     msg.from.toString(),
      to:       msg.to.toString(),
      message:  msg.message,
      imageUrl: msg.imageUrl,
      timestamp:msg.timestamp,
      read:     msg.read,
      recalled: msg.recalled,
      avatarUrl:user.avatarUrl,
      nickname: user.nickname
    };
    io.to(toUserId).to(user._id.toString()).emit('private message', payload);
  });

  // 群組文字或圖片
  socket.on('group message', async ({ to, message, imageUrl }) => {
    const msg = await Message.create({
      from:      user._id,
      group:     to,
      message:   message || null,
      imageUrl:  imageUrl || null,
      timestamp: new Date(),
      read:      false,
      recalled:  false
    });
    const payload = {
      id:       msg._id.toString(),
      from:     msg.from.toString(),
      groupId:  msg.group.toString(),
      message:  msg.message,
      imageUrl: msg.imageUrl,
      timestamp:msg.timestamp,
      read:     msg.read,
      recalled: msg.recalled,
      avatarUrl:user.avatarUrl,
      nickname: user.nickname
    };
    const grp = await Group.findById(to);
    grp.members.forEach(mid => {
      io.to(mid.toString()).emit('group message', payload);
    });
  });
});

// 404 & Error
app.use((req, res) => res.status(404).send('404 Not Found'));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Something broke!');
});

// 啟動
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
