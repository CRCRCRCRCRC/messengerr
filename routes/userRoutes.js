// routes/userRoutes.js

const router = require('express').Router();
const User = require('../models/User');
const Message = require('../models/Message');
const FriendRequest = require('../models/FriendRequest'); // 你需要在 models/FriendRequest.js 定義 schema

// Middleware：確認已登入
function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next();
  return res.status(401).json({ message: 'Unauthorized' });
}
// Middleware：確認已設定暱稱
function ensureNicknameSet(req, res, next) {
  if (req.user && req.user.isNicknameSet) return next();
  return res.status(403).json({ message: 'Forbidden: 請先設定暱稱' });
}

// GET /api/user/me
// 回傳當前使用者資訊及好友列表
router.get('/me', ensureAuthenticated, async (req, res) => {
  const user = await User.findById(req.user._id).populate('friends', 'nickname avatarUrl');
  const friendsMap = {};
  user.friends.forEach(f => {
    friendsMap[f._id] = {
      nickname: f.nickname,
      avatarUrl: f.avatarUrl,
      isOnline: false // 由前端 socket 'friend-online' 事件更新
    };
  });
  res.json({
    id:        user._id.toString(),
    nickname:  user.nickname,
    userCode:  user.userCode,
    avatarUrl: user.avatarUrl,
    friendsMap
  });
});

// GET /api/user/find-by-code/:userCode
router.get('/find-by-code/:userCode', ensureAuthenticated, ensureNicknameSet, async (req, res) => {
  const code = req.params.userCode.trim().toUpperCase();
  if (!code) return res.status(400).json({ message: '請提供用戶ID' });
  if (code === req.user.userCode) return res.status(400).json({ message: '不可加入自己' });

  const found = await User.findOne({ userCode: code, _id: { $ne: req.user._id } })
    .select('nickname avatarUrl');
  if (!found) return res.status(404).json({ message: '找不到此用戶' });
  res.json(found);
});

// POST /api/user/send-friend-request
router.post('/send-friend-request', ensureAuthenticated, ensureNicknameSet, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ message: '請提供用戶ID' });
  if (code === req.user.userCode) return res.status(400).json({ message: '不可邀請自己' });

  const other = await User.findOne({ userCode: code });
  if (!other) return res.status(404).json({ message: '找不到此用戶' });

  // 檢查是否已為好友
  if (req.user.friends.includes(other._id)) {
    return res.status(400).json({ message: '已經是好友' });
  }
  // 檢查是否已送出過邀請
  const exist = await FriendRequest.findOne({ from: req.user._id, to: other._id });
  if (exist) return res.status(400).json({ message: '已送出過邀請' });

  // 建立邀請紀錄
  await FriendRequest.create({ from: req.user._id, to: other._id });
  res.sendStatus(200);
});

// GET /api/user/friend-requests
// 取得「收到的」好友邀請
router.get('/friend-requests', ensureAuthenticated, ensureNicknameSet, async (req, res) => {
  const list = await FriendRequest.find({ to: req.user._id })
    .populate('from', 'nickname avatarUrl')
    .lean();
  // 回傳簡化結構
  const result = list.map(rq => ({
    _id:       rq.from._id.toString(),
    nickname:  rq.from.nickname,
    avatarUrl: rq.from.avatarUrl
  }));
  res.json(result);
});

// POST /api/user/respond-friend-request
// body: { requesterId, accept: true|false }
router.post('/respond-friend-request', ensureAuthenticated, ensureNicknameSet, async (req, res) => {
  const { requesterId, accept } = req.body;
  const me = req.user;
  const other = await User.findById(requesterId);
  if (!other) return res.status(404).json({ message: '找不到請求者' });

  // 刪除邀請
  await FriendRequest.deleteOne({ from: requesterId, to: me._id });

  const io = req.app.get('io');
  if (accept) {
    // 加入好友（雙向）
    if (!me.friends.includes(other._id)) {
      me.friends.push(other._id);
      await me.save();
    }
    if (!other.friends.includes(me._id)) {
      other.friends.push(me._id);
      await other.save();
    }

    // 立刻推送 new-friend 給雙方
    const payloadForMe = {
      id:        other._id.toString(),
      nickname:  other.nickname,
      avatarUrl: other.avatarUrl,
      isOnline:  false
    };
    const payloadForOther = {
      id:        me._id.toString(),
      nickname:  me.nickname,
      avatarUrl: me.avatarUrl,
      isOnline:  false
    };
    io.to(me._id.toString()).emit('new-friend', payloadForMe);
    io.to(other._id.toString()).emit('new-friend', payloadForOther);
  }

  res.sendStatus(200);
});

// POST /api/user/mark-read
// 將與某好友的未讀訊息標記為已讀
router.post('/mark-read', ensureAuthenticated, ensureNicknameSet, async (req, res) => {
  const { withUserId } = req.body;
  await Message.updateMany(
    { from: withUserId, to: req.user._id, read: false },
    { $set: { read: true } }
  );
  res.sendStatus(200);
});

// GET /api/user/chat-history/:friendId
// 回傳與某好友的歷史對話
router.get('/chat-history/:friendId', ensureAuthenticated, ensureNicknameSet, async (req, res) => {
  const friendId = req.params.friendId;
  const raw = await Message.find({
    $or: [
      { from: req.user._id, to: friendId },
      { from: friendId, to: req.user._id }
    ]
  })
  .sort({ timestamp: 1 })
  .populate('from', 'avatarUrl nickname')
  .lean();

  const history = raw.map(m => ({
    from:      m.from._id.toString(),
    to:        m.to?.toString(),
    message:   m.message,
    imageUrl:  m.imageUrl,
    timestamp: m.timestamp,
    read:      m.read,
    avatarUrl: m.from.avatarUrl,
    nickname:  m.from.nickname
  }));
  res.json(history);
});

module.exports = router;
