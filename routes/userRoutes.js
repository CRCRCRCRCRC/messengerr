const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const User = require('../models/User');
const FriendRequest = require('../models/FriendRequest');
const Message = require('../models/Message');

// 驗證 middleware：所有 /api/user 路由都需登入
function ensureAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  return res.status(401).json({ message: 'Unauthorized' });
}
router.use(ensureAuth);

// 確保 avatars 資料夾存在
const avatarsDir = path.join(__dirname, '../public/avatars');
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

// POST /api/user/setup — 設置暱稱及頭像
router.post('/setup', upload.single('avatar'), async (req, res) => {
  const { nickname } = req.body;
  if (!nickname || nickname.trim().length < 2 || !req.file) {
    return res.status(400).send('暱稱需至少 2 字，且必須上傳頭像');
  }
  try {
    const user = await User.findById(req.user._id);
    user.nickname = nickname.trim();
    user.avatarUrl = '/avatars/' + req.file.filename;
    user.isNicknameSet = true;
    await user.save();
    res.sendStatus(200);
  } catch (err) {
    console.error('❗ /api/user/setup 錯誤：', err);
    res.status(500).send('設定失敗');
  }
});

// POST /api/user/update-profile — 更新暱稱或大頭貼
router.post('/update-profile', upload.single('avatar'), async (req, res) => {
  const { nickname } = req.body;
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: '使用者不存在' });
    if (nickname && nickname.trim().length >= 2) {
      user.nickname = nickname.trim();
    }
    if (req.file) {
      user.avatarUrl = '/avatars/' + req.file.filename;
    }
    await user.save();
    res.json({
      message: '更新成功',
      nickname: user.nickname,
      avatarUrl: user.avatarUrl
    });
  } catch (err) {
    console.error('❗ /api/user/update-profile 錯誤：', err);
    res.status(500).json({ message: '伺服器錯誤' });
  }
});

// GET /api/user/me — 取得個人資訊 & 好友列表
router.get('/me', async (req, res) => {
  try {
    const u = await User.findById(req.user._id)
      .populate('friends', 'nickname avatarUrl')
      .lean();
    const friendsMap = {};
    u.friends.forEach(f => {
      friendsMap[f._id] = {
        nickname:  f.nickname,
        avatarUrl: f.avatarUrl || '/default-avatar.png',
        isOnline:  false
      };
    });
    res.json({
      id: u._id.toString(),
      nickname: u.nickname,
      userCode: u.userCode,
      avatarUrl: u.avatarUrl || '/default-avatar.png',
      isNicknameSet: u.isNicknameSet,
      friendsMap
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: '伺服器錯誤' });
  }
});

// GET /api/user/chat-history/:withId — 聊天歷史 (私人 & 群組)
router.get('/chat-history/:withId', async (req, res) => {
  const me = req.user._id.toString();
  const other = req.params.withId;
  try {
    const msgs = await Message.find({
      $or: [
        { from: me, to: other },
        { from: other, to: me },
        { group: other }
      ]
    }).sort({ timestamp: 1 }).lean();
    for (let m of msgs) {
      const u = await User.findById(m.from).select('nickname avatarUrl').lean();
      m.nickname = u.nickname;
      m.avatarUrl = u.avatarUrl;
    }
    res.json(msgs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: '伺服器錯誤' });
  }
});

// POST /api/user/send-friend-request — 送出好友邀請
router.post('/send-friend-request', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ message: '請提供對方用戶ID' });
  if (code === req.user.userCode) return res.status(400).json({ message: '不能加自己' });
  try {
    const target = await User.findOne({ userCode: code });
    if (!target) return res.status(404).json({ message: '找不到此用戶' });
    const exists = await FriendRequest.findOne({
      from: req.user._id,
      to:   target._id,
      status: 'pending'
    });
    if (exists) return res.status(400).json({ message: '已送出邀請，請等待回應' });
    await FriendRequest.create({
      from: req.user._id,
      to:   target._id,
      status: 'pending',
      createdAt: new Date()
    });
    res.json({ message: '邀請已送出' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: '伺服器錯誤' });
  }
});

// GET /api/user/friend-requests — 取得收到的好友邀請
router.get('/friend-requests', async (req, res) => {
  try {
    const reqs = await FriendRequest.find({ to: req.user._id, status: 'pending' })
      .populate('from', 'nickname avatarUrl').lean();
    const result = reqs.map(r => ({
      _id:       r._id,
      fromId:    r.from._id,
      nickname:  r.from.nickname,
      avatarUrl: r.from.avatarUrl
    }));
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: '伺服器錯誤' });
  }
});

// POST /api/user/respond-friend-request — 接受/拒絕好友邀請
router.post('/respond-friend-request', async (req, res) => {
  const { requesterId, accept } = req.body;
  try {
    const fr = await FriendRequest.findOne({ from: requesterId, to: req.user._id, status: 'pending' });
    if (!fr) return res.status(404).json({ message: '邀請不存在' });
    if (accept) {
      await User.updateOne(
        { _id: req.user._id,    friends: { $ne: requesterId } },
        { $push: { friends: requesterId } }
      );
      await User.updateOne(
        { _id: requesterId, friends: { $ne: req.user._id } },
        { $push: { friends: req.user._id } }
      );
      fr.status = 'accepted';
      await fr.save();
    } else {
      fr.status = 'rejected';
      await fr.save();
    }
    res.json({ message: accept ? '已接受邀請' : '已拒絕邀請' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: '伺服器錯誤' });
  }
});

// GET /api/user/find-by-code/:userCode — 查詢用戶
router.get('/find-by-code/:userCode', async (req, res) => {
  const code = req.params.userCode?.trim().toUpperCase();
  if (!code) return res.status(400).json({ message: '請提供用戶ID' });
  try {
    const u = await User.findOne({ userCode: code, _id: { $ne: req.user._id } })
      .select('nickname userCode avatarUrl').lean();
    if (!u) return res.status(404).json({ message: '找不到此用戶' });
    res.json(u);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: '伺服器錯誤' });
  }
});

module.exports = router;
