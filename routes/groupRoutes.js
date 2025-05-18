const router = require('express').Router();
const Group = require('../models/Group');
const Message = require('../models/Message');

// 確認已登入
function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ message: 'Unauthorized' });
}

router.use(ensureAuthenticated);

// 建立群組
// body: { name: String, members: [userId,...] }
router.post('/create', async (req, res) => {
  const { name, members } = req.body;
  const group = await Group.create({
    name,
    owner: req.user._id,
    members: Array.isArray(members) ? members : [],
    avatarUrl: '/default-group.png'
  });
  res.json(group);
});

// 列出我的群組
router.get('/list', async (req, res) => {
  const groups = await Group.find({ members: req.user._id });
  res.json(groups);
});

// 取得群組聊天歷史
router.get('/chat-history/:groupId', async (req, res) => {
  const { groupId } = req.params;
  const { beforeMessageId, limit = 20 } = req.query;
  const currentUserId = req.user._id;

  const query = { group: groupId };

  if (beforeMessageId) {
    try {
      const beforeMessage = await Message.findById(beforeMessageId).lean();
      if (beforeMessage) {
        query.timestamp = { $lt: beforeMessage.timestamp };
      }
    } catch (err) {
      console.error('Error finding beforeMessage for group chat:', err);
    }
  }

  const msgs = await Message.find(query)
    .sort({ timestamp: -1 })
    .limit(parseInt(limit))
    .populate('from', 'nickname avatarUrl')
    .lean();

  const processedMsgs = msgs.map(msg => ({
    ...msg,
    _id: msg._id.toString(),
    group: msg.group.toString(),
    from: {
        id: msg.from._id.toString(),
        nickname: msg.from.nickname,
        avatarUrl: msg.from.avatarUrl || '/default-avatar.png'
    },
    isSelf: msg.from._id.equals(currentUserId)
  }));

  res.json(processedMsgs.reverse());
});

// 刪除群組（只有建立者）
router.delete('/delete/:groupId', async (req, res) => {
  const group = await Group.findById(req.params.groupId);
  if (!group) return res.status(404).json({ message: 'Not found' });
  if (group.owner.toString() !== req.user._id.toString()) {
    return res.status(403).json({ message: 'Forbidden' });
  }
  await Group.deleteOne({ _id: group._id });
  // 同步刪除該群組訊息
  await Message.deleteMany({ group: group._id });
  res.sendStatus(200);
});

module.exports = router;
