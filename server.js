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
const Group = require('./models/Group');

mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Session middleware
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24
  }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/avatars', express.static(path.join(__dirname, 'public/avatars')));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));
app.use(sessionMiddleware);

app.use(passport.initialize());
app.use(passport.session());
require('./config/passport-setup');

// Routes
app.use('/auth', require('./routes/authRoutes'));
app.use('/api/user', require('./routes/userRoutes'));
app.use('/api/group', require('./routes/groupRoutes'));
app.use('/api/upload-image', require('./routes/uploadRoutes'));

// Authentication guards
const ensureAuthenticated = (req, res, next) => {
  if (req.isAuthenticated()) return next();
  res.redirect('/');
};
const ensureNicknameSet = (req, res, next) => {
  if (req.user && req.user.isNicknameSet) return next();
  res.redirect('/setup');
};

// Avatar upload for setup
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

// Routes for pages
app.get('/', async (req, res) => {
  if (req.isAuthenticated()) {
    const u = await User.findById(req.user._id);
    if (!u) return res.redirect('/');
    if (!u.isNicknameSet) return res.redirect('/setup');
    return res.redirect('/chat');
  }
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

app.get('/setup', ensureAuthenticated, (req, res) => {
  if (req.user.isNicknameSet) return res.redirect('/chat');
  res.sendFile(path.join(__dirname, 'public/setup.html'));
});

app.post('/api/user/setup', ensureAuthenticated, upload.single('avatar'), async (req, res) => {
  const { nickname } = req.body;
  if (!nickname || !req.file) return res.status(400).send('缺少暱稱或頭像檔');
  req.user.nickname = nickname.trim();
  req.user.avatarUrl = `/avatars/${req.file.filename}`;
  req.user.isNicknameSet = true;
  await req.user.save();
  res.sendStatus(200);
});

app.get('/chat', ensureAuthenticated, ensureNicknameSet, (req, res) => {
  res.sendFile(path.join(__dirname, 'public/chat.html'));
});

// Share session with Socket.IO
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

  // Join personal room
  socket.join(socket.userData.id);

  // Broadcast online
  socket.broadcast.emit('friend-online', { id: socket.userData.id });

  // Load chat history
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
    socket.emit('chat history', { messages: msgs });
  });

  // Private message
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
      avatarUrl: socket.userData.avatarUrl,
      nickname: socket.userData.nickname
    };
    io.to(toUserId).to(socket.userData.id).emit('private message', payload);
  });

  // Group message
  socket.on('group message', async ({ to, message }) => {
    const msg = await Message.create({
      from: socket.userData.id,
      group: to,
      message,
      timestamp: new Date(),
      read: false
    });
    const members = (await Group.findById(to)).members.map(m => m.toString());
    const payload = {
      ...msg.toObject(),
      avatarUrl: socket.userData.avatarUrl,
      nickname: socket.userData.nickname
    };
    members.forEach(mid => {
      io.to(mid).emit('group message', payload);
    });
  });

  // Recall message
  socket.on('message recall', async ({ messageId }) => {
    await Message.findByIdAndUpdate(messageId, { recalled: true });
    io.emit('message recalled', { messageId });
  });

  // WebRTC Signaling: call-user, make-answer, ice-candidate
  socket.on('call-user', ({ to, offer }) => {
    io.to(to).emit('call-made', { from: socket.id, offer });
  });
  socket.on('make-answer', ({ to, answer }) => {
    io.to(to).emit('answer-made', { from: socket.id, answer });
  });
  socket.on('ice-candidate', ({ to, candidate }) => {
    io.to(to).emit('ice-candidate', { from: socket.id, candidate });
  });

  // On disconnect
  socket.on('disconnect', () => {
    socket.broadcast.emit('friend-offline', { id: socket.userData.id });
  });
});

// 404 and error handlers
app.use((req, res) => res.status(404).send("404 Not Found"));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Something broke!');
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
