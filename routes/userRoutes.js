// routes/userRoutes.js
const router = require('express').Router();
const User = require('../models/User');
const FriendRequest = require('../models/FriendRequest');

// 驗證
function ensureAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ message: 'Unauthorized' });
}
router.use(ensureAuth);

// 設定暱稱（只要暱稱，不再強制上傳頭像）
router.post('/set-nickname', async (req, res) => {
  const { nickname } = req.body;
  if (!nickname || nickname.trim().length < 2) {
    return res.status(400).json({ message: '暱稱需至少 2 字' });
  }
  try {
    const user = await User.findById(req.user._id);
    if (!user || user.isNicknameSet) {
      return res.status(400).json({ message: '無法設定暱稱' });
    }
    user.nickname = nickname.trim();
    user.isNicknameSet = true;
    await user.save();
    res.json({ message: '暱稱設定完成' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: '伺服器錯誤' });
  }
});

// 回傳自身資料與好友列表（含 avatarUrl）
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
      id:        u._id.toString(),
      nickname:  u.nickname,
      userCode:  u.userCode,
      avatarUrl: u.avatarUrl || '/default-avatar.png',
      friendsMap
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: '伺服器錯誤' });
  }
});

// 其餘 send-friend-request / respond-friend-request / find-by-code 不變
module.exports = router;
