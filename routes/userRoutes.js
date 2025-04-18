const router = require('express').Router();
const User   = require('../models/User');
const FriendRequest = require('../models/FriendRequest'); // 若定義了好友邀請模型

// 驗證
function ensureAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  return res.status(401).json({ message: 'Unauthorized' });
}
router.use(ensureAuth);

// POST /api/user/set-nickname
router.post('/set-nickname', async (req, res) => {
  const { nickname } = req.body;
  if (!nickname || nickname.trim().length < 2) {
    return res.status(400).json({ message: '暱稱需至少 2 字' });
  }
  const user = await User.findById(req.user._id);
  if (!user || user.isNicknameSet) {
    return res.status(400).json({ message: '無法設定暱稱' });
  }
  user.nickname = nickname.trim();
  user.isNicknameSet = true;
  await user.save();
  res.json({ message: 'OK' });
});

// GET /api/user/me
router.get('/me', async (req, res) => {
  const user = await User.findById(req.user._id)
    .populate('friends', 'nickname avatarUrl')
    .lean();
  const friendsMap = {};
  user.friends.forEach(f => {
    friendsMap[f._id] = {
      nickname: f.nickname,
      avatarUrl: f.avatarUrl,
      isOnline: false
    };
  });
  res.json({
    id:       user._id.toString(),
    nickname: user.nickname,
    userCode: user.userCode,
    avatarUrl:user.avatarUrl,
    friendsMap
  });
});

// POST /api/user/send-friend-request
router.post('/send-friend-request', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ message: '需要 userCode' });
  if (code === req.user.userCode) {
    return res.status(400).json({ message: '無法加自己' });
  }
  const target = await User.findOne({ userCode: code });
  if (!target) return res.status(404).json({ message: '找不到該用戶' });

  // 防重複邀請
  const exists = await FriendRequest.findOne({
    from: req.user._id, to: target._id
  });
  if (exists) return res.status(400).json({ message: '已送出邀請' });

  await FriendRequest.create({
    from: req.user._id,
    to:   target._id,
    createdAt: new Date()
  });

  // 推通知
  const io = req.app.get('io');
  io.to(target._id.toString()).emit('new-friend-request', {
    _id: req.user._id.toString(),
    nickname: req.user.nickname,
    avatarUrl: req.user.avatarUrl
  });

  res.json({ message: '邀請已送出' });
});

// GET /api/user/friend-requests
router.get('/friend-requests', async (req, res) => {
  const reqs = await FriendRequest.find({ to: req.user._id })
    .populate('from', 'nickname avatarUrl')
    .lean();
  res.json(reqs.map(r => ({
    _id:       r.from._id.toString(),
    nickname:  r.from.nickname,
    avatarUrl: r.from.avatarUrl
  })));
});

// POST /api/user/respond-friend-request
router.post('/respond-friend-request', async (req, res) => {
  const { requesterId, accept } = req.body;
  const fr = await FriendRequest.findOne({
    from: requesterId, to: req.user._id
  });
  if (!fr) return res.status(404).json({ message: '邀請不存在' });
  if (accept) {
    const me = await User.findById(req.user._id);
    const other = await User.findById(requesterId);
    if (!me.friends.includes(other._id)) {
      me.friends.push(other._id);
      await me.save();
    }
    if (!other.friends.includes(me._id)) {
      other.friends.push(me._id);
      await other.save();
    }
    // 即時通知雙方
    const io = req.app.get('io');
    io.to(requesterId).emit('new-friend', {
      id: me._id.toString(),
      nickname: me.nickname,
      avatarUrl: me.avatarUrl,
      isOnline: true
    });
    io.to(req.user._id.toString()).emit('new-friend', {
      id: other._id.toString(),
      nickname: other.nickname,
      avatarUrl: other.avatarUrl,
      isOnline: false
    });
  }
  await fr.deleteOne();
  res.json({ message: accept ? '已成為好友' : '已拒絕' });
});

// GET /api/user/find-by-code/:userCode
router.get('/find-by-code/:userCode', async (req, res) => {
  const code = req.params.userCode.trim().toUpperCase();
  if (!code) return res.status(400).json({ message: '需要 code' });
  const u = await User.findOne({ userCode: code, _id: { $ne: req.user._id } })
    .select('nickname userCode avatarUrl');
  if (!u) return res.status(404).json({ message: '找不到使用者' });
  res.json(u);
});

module.exports = router;
