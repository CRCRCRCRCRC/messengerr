const router = require('express').Router();
const User = require('../models/User');

function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ message: '請先登入' });
}

function ensureNicknameSet(req, res, next) {
  if (req.user && req.user.isNicknameSet) return next();
  res.status(403).json({ message: '尚未設定暱稱' });
}

router.use(ensureAuthenticated);

// ✅ 查詢目前使用者
router.get('/me', async (req, res) => {
  const user = await User.findById(req.user._id).populate('friends', 'nickname avatarUrl isOnline');
  const friendsMap = {};
  user.friends.forEach(f => {
    friendsMap[f._id] = {
      nickname: f.nickname,
      avatarUrl: f.avatarUrl,
      isOnline: f.isOnline
    };
  });
  res.json({ id: user._id, nickname: user.nickname, userCode: user.userCode, avatarUrl: user.avatarUrl, friendsMap });
});

// ✅ 查詢聊天紀錄（由後端提供）
const Message = require('../models/Message');
router.get('/chat-history/:friendId', async (req, res) => {
  const messages = await Message.find({
    $or: [
      { from: req.user._id, to: req.params.friendId },
      { from: req.params.friendId, to: req.user._id }
    ]
  }).sort({ timestamp: 1 });

  res.json(messages);
});

// ✅ 已讀標記
router.post('/mark-read', async (req, res) => {
  await Message.updateMany({
    from: req.body.withUserId,
    to: req.user._id,
    isRead: false
  }, { isRead: true });

  res.sendStatus(200);
});

// ✅ 發送好友邀請
router.post('/send-friend-request', ensureNicknameSet, async (req, res) => {
  try {
    const code = req.body.code?.trim().toUpperCase();
    if (!code) return res.status(400).json({ message: '請輸入用戶ID' });

    if (code === req.user.userCode) return res.status(400).json({ message: '不能加自己' });

    const receiver = await User.findOne({ userCode: code });
    if (!receiver) return res.status(404).json({ message: '找不到該用戶' });

    // 避免重複邀請
    if (!receiver.friendRequests) receiver.friendRequests = [];
    if (receiver.friendRequests.includes(req.user._id)) {
      return res.status(400).json({ message: '已送出邀請' });
    }

    receiver.friendRequests.push(req.user._id);
    await receiver.save();

    res.sendStatus(200);
  } catch (err) {
    console.error('🔥 發送好友邀請錯誤：', err);
    res.status(500).json({ message: '伺服器錯誤' });
  }
});

// ✅ 查看好友邀請
router.get('/friend-requests', async (req, res) => {
  const user = await User.findById(req.user._id).populate('friendRequests', 'nickname avatarUrl');
  res.json(user.friendRequests);
});

// ✅ 接受或拒絕邀請
router.post('/respond-friend-request', async (req, res) => {
  const { requesterId, accept } = req.body;
  const user = await User.findById(req.user._id);

  if (!user.friendRequests.includes(requesterId)) {
    return res.status(400).json({ message: '邀請不存在' });
  }

  // 移除邀請
  user.friendRequests = user.friendRequests.filter(id => id.toString() !== requesterId);
  if (accept) {
    if (!user.friends.includes(requesterId)) user.friends.push(requesterId);
    const requester = await User.findById(requesterId);
    if (!requester.friends.includes(req.user._id)) {
      requester.friends.push(req.user._id);
      await requester.save();
    }
  }

  await user.save();
  res.sendStatus(200);
});

module.exports = router;
