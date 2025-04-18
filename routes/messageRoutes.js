// routes/messageRoutes.js

const router = require('express').Router();
const Message = require('../models/Message');
const Group   = require('../models/Group');

// Middleware：確認已登入
function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next();
  return res.status(401).json({ message: 'Unauthorized' });
}
router.use(ensureAuthenticated);

// POST /api/message/recall
router.post('/recall', async (req, res) => {
  try {
    const { messageId } = req.body;
    const msg = await Message.findById(messageId);
    if (!msg) return res.status(404).json({ message: '訊息不存在' });
    if (msg.from.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: '無權收回此訊息' });
    }
    msg.recalled = true;
    await msg.save();

    const io = req.app.get('io');
    // 廣播給相關房間（好友聊天室或群組）
    if (msg.to) {
      io.to(msg.to.toString()).to(msg.from.toString())
        .emit('message recalled', { messageId });
    } else if (msg.group) {
      const group = await Group.findById(msg.group);
      group.members.forEach(mid => {
        io.to(mid.toString()).emit('message recalled', { messageId });
      });
    }
    return res.sendStatus(200);
  } catch (err) {
    console.error('Recall error:', err);
    return res.status(500).json({ message: '伺服器錯誤' });
  }
});

module.exports = router;
