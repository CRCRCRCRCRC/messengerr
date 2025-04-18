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

const User    = require('./models/User');
const Message = require('./models/Message');
const Group   = require('./models/Group');

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);
app.set('io', io);

const sessionMiddleware = session({
  secret:            process.env.SESSION_SECRET,
  resave:            false,
  saveUninitialized: false,
  cookie: { secure:false, httpOnly:true, sameSite:'lax', maxAge:86400000 }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname,'public')));
app.use('/avatars', express.static(path.join(__dirname,'public/avatars')));
app.use('/uploads', express.static(path.join(__dirname,'public/uploads')));
app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());
require('./config/passport-setup');

// 確保資料夾存在
if (!fs.existsSync('public/avatars')) fs.mkdirSync('public/avatars',{recursive:true});
if (!fs.existsSync('public/uploads')) fs.mkdirSync('public/uploads',{recursive:true});

// 路由
app.use('/auth', require('./routes/authRoutes'));
app.use('/api/user', require('./routes/userRoutes'));
app.use('/api/group', require('./routes/groupRoutes'));
app.use('/api/upload-image', require('./routes/uploadRoutes'));
app.use('/api/message', require('./routes/messageRoutes'));  // <-- 新增

const ensureAuthenticated = (req, res, next) =>
  req.isAuthenticated() ? next() : res.redirect('/');
const ensureNicknameSet = (req, res, next) =>
  (req.user && req.user.isNicknameSet) ? next() : res.redirect('/setup');

app.get('/', (req, res) => {
  if (req.isAuthenticated()) {
    return req.user.isNicknameSet ? res.redirect('/chat') : res.redirect('/setup');
  }
  res.sendFile(path.join(__dirname,'public/index.html'));
});

app.get('/setup', ensureAuthenticated, (req,res) => {
  if (req.user.isNicknameSet) return res.redirect('/chat');
  res.sendFile(path.join(__dirname,'public/setup.html'));
});

const avatarStorage = multer.diskStorage({
  destination: (req,file,cb) => cb(null,'public/avatars'),
  filename: (req,file,cb) => cb(null,req.user._id + path.extname(file.originalname))
});
app.post('/api/user/setup',
  ensureAuthenticated,
  multer({storage:avatarStorage}).single('avatar'),
  async (req,res) => {
    const { nickname } = req.body;
    if (!nickname || !req.file) return res.status(400).send('缺少暱稱或頭像');
    req.user.nickname  = nickname;
    req.user.avatarUrl = '/avatars/' + req.file.filename;
    req.user.isNicknameSet = true;
    await req.user.save();
    return res.sendStatus(200);
  }
);

app.get('/chat', ensureAuthenticated, ensureNicknameSet, (req,res) => {
  res.sendFile(path.join(__dirname,'public/chat.html'));
});

// Socket.IO 共用 session
io.use((socket,next) => sessionMiddleware(socket.request,{},next));

io.on('connection', async socket => {
  const sid = socket.request.session.passport?.user;
  if (!sid) return socket.disconnect(true);
  const user = await User.findById(sid);
  if (!user || !user.isNicknameSet) return socket.disconnect(true);

  socket.join(user._id.toString());

  // 上線通知
  user.friends.forEach(fid => {
    io.to(fid.toString()).emit('friend-online',{ id:user._id.toString() });
  });

  socket.userData = {
    id:       user._id.toString(),
    nickname: user.nickname,
    avatarUrl:user.avatarUrl,
    friends:  user.friends.map(f=>f.toString())
  };

  socket.on('disconnect', () => {
    socket.userData.friends.forEach(fid => {
      io.to(fid).emit('friend-offline',{ id:socket.userData.id });
    });
  });

  // 載入歷史記錄
  socket.on('load history', async ({id,type}) => {
    let raw;
    if (type==='friend') {
      raw = await Message.find({
        $or:[
          { from: socket.userData.id, to: id },
          { from: id, to: socket.userData.id }
        ]
      })
      .sort({ timestamp:1 })
      .populate('from','avatarUrl nickname')
      .lean();
    } else {
      raw = await Message.find({ group: id })
        .sort({ timestamp:1 })
        .populate('from','avatarUrl nickname')
        .lean();
    }
    const msgs = raw.map(m => ({
      id:       m._id.toString(),
      from:     m.from._id.toString(),
      to:       m.to?.toString(),
      groupId:  m.group?.toString(),
      message:  m.message,
      imageUrl: m.imageUrl,
      timestamp:m.timestamp,
      read:     m.read,
      recalled: m.recalled,
      avatarUrl:m.from.avatarUrl,
      nickname: m.from.nickname
    }));
    socket.emit('chat history',{ messages:msgs });
  });

  // 私聊
  socket.on('private message', async ({toUserId,message}) => {
    if (!socket.userData.friends.includes(toUserId)) return;
    const msg = await Message.create({
      from:socket.userData.id,
      to:toUserId,
      message:message,
      timestamp:new Date(),
      read:false
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
      avatarUrl:socket.userData.avatarUrl,
      nickname: socket.userData.nickname
    };
    io.to(toUserId).to(socket.userData.id).emit('private message',payload);
  });

  // 群聊
  socket.on('group message', async ({to,message}) => {
    const msg = await Message.create({
      from:socket.userData.id,
      group:to,
      message:message,
      timestamp:new Date(),
      read:false
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
      avatarUrl:socket.userData.avatarUrl,
      nickname: socket.userData.nickname
    };
    const group = await Group.findById(to);
    group.members.forEach(mid => {
      io.to(mid.toString()).emit('group message',payload);
    });
  });
});

// 404 & 錯誤處理
app.use((req,res)=>res.status(404).send("404 Not Found"));
app.use((err,req,res,next)=>{ console.error(err); res.status(500).send('Something broke!'); });

const PORT = process.env.PORT||3000;
server.listen(PORT,()=>console.log(`🚀 Server on port ${PORT}`));
