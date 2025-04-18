// routes/uploadRoutes.js

const router = require('express').Router();
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const Message = require('../models/Message');
const Group = require('../models/Group');

// Middleware：確認已登入
function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next();
  return res.status(401).json({ message: 'Unauthorized' });
}
router.use(ensureAuthenticated);

// 確保 public/uploads 目錄存在
const uploadDir = path.join(__dirname, '..', 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer 存储設定
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename:    (req, file, cb) => cb(null, Date.now() + '_' + file.originalname)
});
const upload = multer({ storage });

// POST /api/upload-image
router.post('/', upload.single('image'), async (req, res) => {
  try {
    const { to, type } = req.body;             // type: 'friend' or 'group'
    const imageUrl    = '/uploads/' + req.file.filename;
    const fromId      = req.user._id.toString();
    const io          = req.app.get('io');

    // 構造要回傳給前端的資料
    const payload = {
      from:      fromId,
      timestamp: new Date(),
      imageUrl:  imageUrl,
      avatarUrl: req.user.avatarUrl,
      nickname:  req.user.nickname
    };

    if (type === 'friend') {
      await Message.create({ from: fromId, to, imageUrl });
      payload.to = to;
      io.to(to).to(fromId).emit('private message', payload);
    } else {
      await Message.create({ from: fromId, group: to, imageUrl });
      payload.groupId = to;
      const group = await Group.findById(to);
      group.members.forEach(memberId => {
        io.to(memberId.toString()).emit('group message', payload);
      });
    }

    return res.json(payload);
  } catch (err) {
    console.error('❌ 圖片上傳錯誤：', err);
    return res.status(500).json({ message: 'Upload error' });
  }
});

module.exports = router;
