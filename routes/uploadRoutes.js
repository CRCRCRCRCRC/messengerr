// routes/uploadRoutes.js
const router = require('express').Router();
const multer = require('multer');
const Message = require('../models/Message');
const Group = require('../models/Group');

// 確認已登入
function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ message: 'Unauthorized' });
}

router.use(ensureAuthenticated);

// 設定上傳目錄： public/uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'public/uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '_' + file.originalname);
  }
});
const upload = multer({ storage });

// 圖片上傳 API
router.post('/', upload.single('image'), async (req, res) => {
  try {
    const { to, type } = req.body;           // type: 'friend' or 'group'
    const imageUrl = '/uploads/' + req.file.filename;  // 前端存取路徑
    const fromId = req.user._id.toString();
    const io = req.app.get('io');

    let msg;
    let payload;

    if (type === 'friend') {
      // 存入資料庫
      msg = await Message.create({ from: fromId, to, imageUrl });
      // 構造回傳 payload，帶上頭像與暱稱
      payload = {
        from: fromId,
        to,
        imageUrl,
        timestamp: msg.timestamp,
        avatarUrl: req.user.avatarUrl,
        nickname: req.user.nickname
      };
      // 廣播給雙方
      io.to(to).to(fromId).emit('private message', payload);
    } else {
      // 群組圖片訊息
      msg = await Message.create({ from: fromId, group: to, imageUrl });
      payload = {
        from: fromId,
        groupId: to,
        imageUrl,
        timestamp: msg.timestamp,
        avatarUrl: req.user.avatarUrl,
        nickname: req.user.nickname
      };
      const group = await Group.findById(to);
      group.members.forEach(memberId => {
        io.to(memberId.toString()).emit('group message', payload);
      });
    }

    // 回傳給前端 appendMessage 使用
    res.json(payload);
  } catch (err) {
    console.error('❌ 圖片上傳錯誤：', err);
    res.status(500).json({ message: 'Upload error' });
  }
});

module.exports = router;
