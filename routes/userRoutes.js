// routes/userRoutes.js
const router = require('express').Router();
const User = require('../models/User');
const FriendRequest = require('../models/FriendRequest');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// 驗證 middleware
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

// POST /api/user/set-nickname
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

// POST /api/user/update-profile
// 允許同時更新暱稱和大頭貼
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

// GET /api/user/me
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
      friendsMap
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: '伺服器錯誤' });
  }
});

// 其餘 send-friend-request / respond-friend-request / find-by-code 等路由保持不變
module.exports = router;
