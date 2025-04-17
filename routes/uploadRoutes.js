const router = require('express').Router();
const multer = require('multer');
const Message = require('../models/Message');
const Group = require('../models/Group');

// 確認已登入
function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ message: 'Unauthorized' });
}

// 圖片存放目錄
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'public/uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + '_' + file.originalname)
});
const upload = multer({ storage });

// 圖片上傳 API
router.post('/', ensureAuthenticated, upload.single('image'), async (req, res) => {
  const { to, type } = req.body;           // type = 'friend' or 'group'
  const imageUrl = `/uploads/${req.file.filename}`;
  const fromId = req.user._id.toString();
  const io = req.app.get('io');

  let msg;
  if (type === 'friend') {
    // 私聊圖片訊息
    msg = await Message.create({ from: fromId, to, imageUrl });
    io.to(to).to(fromId).emit('private message', {
      from: fromId,
      to,
      imageUrl,
      timestamp: msg.timestamp,
      avatarUrl: req.user.avatarUrl,
      nickname: req.user.nickname
    });
  } else if (type === 'group') {
    // 群組圖片訊息
    msg = await Message.create({ from: fromId, group: to, imageUrl });
    const group = await Group.findById(to);
    group.members.forEach(memberId => {
      io.to(memberId.toString()).emit('group message', {
        from: fromId,
        groupId: to,
        imageUrl,
        timestamp: msg.timestamp,
        avatarUrl: req.user.avatarUrl,
        nickname: req.user.nickname
      });
    });
  }

  res.json(msg);
});

module.exports = router;
