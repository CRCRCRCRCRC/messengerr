const router = require('express').Router();
const multer = require('multer');
const path  = require('path');
const fs    = require('fs');
const Message = require('../models/Message');
const Group   = require('../models/Group');

// 驗證
function ensureAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ message: 'Unauthorized' });
}
router.use(ensureAuth);

// 確保 uploads 資料夾
const UPLOAD_DIR = path.join(__dirname, '../public/uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// multer 設定
const storage = multer.diskStorage({
  destination: (_, file, cb) => cb(null, UPLOAD_DIR),
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + ext);
  }
});
const upload = multer({ storage });

// POST /api/upload-image
router.post('/', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

  const { to, type } = req.body;
  const imageUrl = '/uploads/' + req.file.filename;

  const data = {
    from:      req.user._id,
    message:   null,
    imageUrl,
    timestamp: new Date(),
    read:      false,
    recalled:  false
  };
  if (type === 'friend') data.to = to;
  else data.group = to;

  const msg = await Message.create(data);

  const payload = {
    id:        msg._id.toString(),
    from:      msg.from.toString(),
    to:        msg.to?.toString(),
    groupId:   msg.group?.toString(),
    message:   null,
    imageUrl:  msg.imageUrl,
    timestamp: msg.timestamp,
    read:      msg.read,
    recalled:  msg.recalled,
    avatarUrl: req.user.avatarUrl,
    nickname:  req.user.nickname
  };

  // 推送
  const io = req.app.get('io');
  if (type === 'friend') {
    io.to(to).to(req.user._id.toString()).emit('private message', payload);
  } else {
    const grp = await Group.findById(to);
    grp.members.forEach(mid => {
      io.to(mid.toString()).emit('group message', payload);
    });
  }

  res.json(payload);
});

module.exports = router;
