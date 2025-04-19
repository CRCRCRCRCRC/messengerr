require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const mongoose = require('mongoose');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const User          = require('./models/User');
const Message       = require('./models/Message');
const Group         = require('./models/Group');
const FriendRequest = require('./models/FriendRequest'); // 確保 models/FriendRequest.js 已存在

// 1. 連線到 MongoDB
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);
app.set('io', io);

// 2. Express 中間件設定
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 3. 靜態資源路徑
app.use(express.static(path.join(__dirname, 'public')));
app.use('/avatars', express.static(path.join(__dirname, 'public/avatars')));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

// 4. 確保 avatars 與 uploads 資料夾存在
const avatarsDir = path.join(__dirname, 'public/avatars');
const uploadsDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(avatarsDir)) fs.mkdirSync(avatarsDir, { recursive: true });
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// 5. Session 設定
const sessionMiddleware = session({
  secret:            process.env.SESSION_SECRET,
  resave:            false,
  saveUninitialized: false,
  cookie: { secure: false, httpOnly: true, sameSite: 'lax', maxAge: 24*3600*1000 }
});
app.use(sessionMiddleware);

// 6. Passport 初始化
app.use(passport.initialize());
app.use(passport.session());
require('./config/passport-setup');

// 7. 路由掛載
app.use('/auth', require('./routes/authRoutes'));
app.use('/api/user', require('./routes/userRoutes'));
app.use('/api/group', require('./routes/groupRoutes'));
app.use('/api/upload-image', require('./routes/uploadRoutes'));
app.use('/api/message', require('./routes/messageRoutes'));

// 8. Helper: 驗證中間件
const ensureAuth = (req, res, next) =>
  req.isAuthenticated() ? next() : res.redirect('/');
const ensureNick = (req, res, next) =>
  req.user.isNicknameSet ? next() : res.redirect('/setup');

// 9. HTML 介面路由
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

// 10. Socket.IO & Session 共用
io.use((socket, next) => sessionMiddleware(socket.request, {}, next));

io.on('connection', async socket => {
  const sid = socket.request.session.passport?.user;
  if (!sid) return socket.disconnect(true);
  const user = await User.findById(sid);
  if (!user || !user.isNicknameSet) return socket.disconnect(true);

  // 加入自己的房間
  socket.join(user._id.toString());
  // 通知朋友上線
  user.friends.forEach(fid => {
    io.to(fid.toString()).emit('friend-online', { id: user._id.toString() });
  });

  socket.on('disconnect', () => {
    user.friends.forEach(fid => {
      io.to(fid.toString()).emit('friend-offline', { id: user._id.toString() });
    });
  });

  // 載入歷史訊息
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
      id:        m._id.toString(),
      from:      m.from._id.toString(),
      to:        m.to?.toString(),
      groupId:   m.group?.toString(),
      message:   m.message,
      imageUrl:  m.imageUrl || null,
      timestamp: m.timestamp,
      read:      m.read,
      recalled:  m.recalled,
      avatarUrl: m.from.avatarUrl,
      nickname:  m.from.nickname
    }));
    socket.emit('chat history', { messages: msgs });
  });

  // 私聊文字／圖片
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
      id:        msg._id.toString(),
      from:      msg.from.toString(),
      to:        msg.to.toString(),
      message:   msg.message,
      imageUrl:  msg.imageUrl,
      timestamp: msg.timestamp,
      read:      msg.read,
      recalled:  msg.recalled,
      avatarUrl: user.avatarUrl,
      nickname:  user.nickname
    };
    io.to(toUserId).to(user._id.toString()).emit('private message', payload);
  });

  // 群組文字／圖片
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
      id:        msg._id.toString(),
      from:      msg.from.toString(),
      groupId:   msg.group.toString(),
      message:   msg.message,
      imageUrl:  msg.imageUrl,
      timestamp: msg.timestamp,
      read:      msg.read,
      recalled:  msg.recalled,
      avatarUrl: user.avatarUrl,
      nickname:  user.nickname
    };
    const grp = await Group.findById(to);
    grp.members.forEach(mid => {
      io.to(mid.toString()).emit('group message', payload);
    });
  });
});

// 11. **錯誤處理**：將錯誤堆疊輸出到瀏覽器，方便調試
app.use((err, req, res, next) => {
  console.error('💥 ERROR STACK:', err.stack);
  res.status(500).send(`
    <h1>500 – 伺服器錯誤</h1>
    <pre style="white-space:pre-wrap;color:red;">${err.stack}</pre>
  `);
});

// 12. 404 處理
app.use((req, res) => {
  res.status(404).send('404 Not Found');
});

// 13. 啟動伺服器
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
