// routes/userRoutes.js
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const User = require('../models/User');
const FriendRequest = require('../models/FriendRequest');
const Message = require('../models/Message');
const Group = require('../models/Group');

// 驗證 middleware：所有 /api/user 都要登入
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
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, req.user._id + ext);
  }
});
const upload = multer({ storage: avatarStorage });


// 1. 設定暱稱（第一登入後用）
router.post('/set-nickname', async (req, res) => {
  const { nickname } = req.body;
  if (!nickname || nickname.trim().length < 2) {
    return res.status(400).json({ message: '暱稱需至少 2 字' });
  }
  try {
    const u = await User.findById(req.user._id);
    if (!u || u.isNicknameSet) {
      return res.status(400).json({ message: '無法設定暱稱' });
    }
    u.nickname = nickname.trim();
    u.isNicknameSet = true;
    await u.save();
    return res.json({ message: '暱稱設定完成' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: '伺服器錯誤' });
  }
});

// 2. 更新個人檔案（暱稱＋大頭貼）
router.post('/update-profile', upload.single('avatar'), async (req, res) => {
  const { nickname } = req.body;
  try {
    const u = await User.findById(req.user._id);
    if (!u) return res.status(404).json({ message: '使用者不存在' });
    if (nickname && nickname.trim().length >= 2) {
      u.nickname = nickname.trim();
    }
    if (req.file) {
      u.avatarUrl = '/avatars/' + req.file.filename;
    }
    await u.save();
    return res.json({
      message: '更新成功',
      nickname: u.nickname,
      avatarUrl: u.avatarUrl || '/default-avatar.png'
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: '伺服器錯誤' });
  }
});

// 3. 取得自己資訊（含好友列表 map）
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
    return res.json({
      id: u._id.toString(),
      nickname: u.nickname,
      userCode: u.userCode,
      avatarUrl: u.avatarUrl || '/default-avatar.png',
      isNicknameSet: u.isNicknameSet,
      friendsMap
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: '伺服器錯誤' });
  }
});

// 4. 抓好友聊天歷史／群組歷史（文字＋圖片＋nickname/avatarUrl）
router.get('/chat-history/:withId', async (req, res) => {
  const me = req.user._id.toString();
  const other = req.params.withId;
  try {
    // 私聊或群組都撈出 Message
    const msgs = await Message.find({
      $or: [
        { from: me, to: other },
        { from: other, to: me },
        { group: other }
      ]
    }).sort({ timestamp: 1 }).lean();

    // 補充每筆 message 的發送者暱稱＆頭像
    for (let m of msgs) {
      const u = await User.findById(m.from).select('nickname avatarUrl').lean();
      m.nickname = u.nickname;
      m.avatarUrl = u.avatarUrl;
    }
    return res.json(msgs);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: '伺服器錯誤' });
  }
});

// 5. 發送好友邀請
router.post('/send-friend-request', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ message: '請提供對方用戶ID' });
  if (code === req.user.userCode) return res.status(400).json({ message: '不能加自己' });
  try {
    const target = await User.findOne({ userCode: code });
    if (!target) return res.status(404).json({ message: '找不到此用戶' });

    const exists = await FriendRequest.findOne({
      from: req.user._id,
      to: target._id,
      status: 'pending'
    });
    if (exists) return res.status(400).json({ message: '已送出邀請，請等待回應' });

    await FriendRequest.create({
      from: req.user._id,
      to:   target._id,
      status: 'pending',
      createdAt: new Date()
    });
    // 你可以在這裡 io.to(target._id).emit('new-friend-request', {...})
    return res.json({ message: '邀請已送出' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: '伺服器錯誤' });
  }
});

// 6. 列出所有收到的好友邀請
router.get('/friend-requests', async (req, res) => {
  try {
    const reqs = await FriendRequest.find({
      to: req.user._id,
      status: 'pending'
    }).populate('from', 'nickname avatarUrl').lean();
    // 回傳 from 的暱稱、頭像、_id
    const result = reqs.map(r => ({
      _id: r._id,
      fromId: r.from._id,
      nickname: r.from.nickname,
      avatarUrl: r.from.avatarUrl
    }));
    return res.json(result);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: '伺服器錯誤' });
  }
});

// 7. 回應好友邀請（接受／拒絕）
router.post('/respond-friend-request', async (req, res) => {
  const { requesterId, accept } = req.body;
  try {
    const fr = await FriendRequest.findOne({
      from: requesterId,
      to:   req.user._id,
      status: 'pending'
    });
    if (!fr) return res.status(404).json({ message: '邀請不存在' });

    if (accept) {
      // 雙向加入好友清單
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
      // io.emit('new-friend', {...}) 也可以在這推播給雙方
    } else {
      fr.status = 'rejected';
      await fr.save();
    }
    return res.json({ message: accept ? '已接受邀請' : '已拒絕邀請' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: '伺服器錯誤' });
  }
});

// 8. 按 userCode 查找用戶（加好友前預覽）
router.get('/find-by-code/:userCode', async (req, res) => {
  const code = req.params.userCode?.trim().toUpperCase();
  if (!code) return res.status(400).json({ message: '請提供用戶ID' });
  try {
    const u = await User.findOne({ userCode: code, _id: { $ne: req.user._id } })
      .select('nickname userCode avatarUrl')
      .lean();
    if (!u) return res.status(404).json({ message: '找不到此用戶' });
    return res.json(u);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: '伺服器錯誤' });
  }
});

module.exports = router;
