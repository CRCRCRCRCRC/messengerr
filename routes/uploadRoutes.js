// routes/uploadRoutes.js
const router = require('express').Router();
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const Message = require('../models/Message');
const Group = require('../models/Group');

// 确认已登录
function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ message: 'Unauthorized' });
}
router.use(ensureAuthenticated);

// 确保 public/uploads 目录存在
const uploadDir = path.join(__dirname, '..', 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer 存储配置
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    cb(null, Date.now() + '_' + file.originalname);
  }
});
const upload = multer({ storage });

// POST /api/upload-image
router.post('/', upload.single('image'), async (req, res) => {
  try {
    const { to, type } = req.body;           // type: 'friend' or 'group'
    const imageUrl = '/uploads/' + req.file.filename;
    const fromId = req.user._id.toString();
    const io = req.app.get('io');

    // 构建回传数据
    const payload = {
      from: fromId,
      timestamp: Date.now(),
      imageUrl,
      avatarUrl: req.user.avatarUrl,
      nickname: req.user.nickname
    };

    if (type === 'friend') {
      // 保存数据库
      await Message.create({ from: fromId, to, imageUrl });
      payload.to = to;
      io.to(to).to(fromId).emit('private message', payload);
    } else {
      await Message.create({ from: fromId, group: to, imageUrl });
      payload.groupId = to;
      const group = await Group.findById(to);
      group.members.forEach(mid => {
        io.to(mid.toString()).emit('group message', payload);
      });
    }

    // 回传给前端立即渲染
    res.json(payload);
  } catch (err) {
    console.error('❌ 图片上传错误：', err);
    res.status(500).json({ message: 'Upload error' });
  }
});

module.exports = router;
