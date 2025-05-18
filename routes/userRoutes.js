// routes/userRoutes.js
const express = require('express');
const User = require('../models/User');
const FriendRequest = require('../models/FriendRequest');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

module.exports = function(io) {
  const router = express.Router();

  // middleware
  function ensureAuth(req, res, next) {
    if (req.isAuthenticated()) return next();
    return res.status(401).json({ message: 'Unauthorized' });
  }
  router.use(ensureAuth);

  // ----------- 使用者頭像設定 -----------
  const avatarsDir = path.join(__dirname, '../public/avatars');
  if (!fs.existsSync(avatarsDir)) fs.mkdirSync(avatarsDir, { recursive: true });

  const avatarStorage = multer.diskStorage({
    destination: (_, file, cb) => cb(null, avatarsDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, req.user._id + ext);
    }
  });
  const upload = multer({ storage: avatarStorage });

  // 新增：處理首次設定暱稱與頭像
  router.post('/setup', upload.single('avatar'), async (req, res) => {
    const { nickname } = req.body;
    if (!nickname || nickname.trim().length < 2 || nickname.trim().length > 20) {
      return res.status(400).json({ message: '暱稱長度必須介於 2 到 20 個字元之間。' });
    }
    if (!req.file) {
      return res.status(400).json({ message: '請上傳頭像。' });
    }

    try {
      const user = await User.findById(req.user._id);
      if (!user) {
        return res.status(404).json({ message: '使用者不存在。' });
      }
      if (user.isNicknameSet) {
        return res.status(400).json({ message: '已經完成過初始設定。' });
      }

      user.nickname = nickname.trim();
      user.avatarUrl = '/avatars/' + req.file.filename; // multer 儲存的檔案路徑
      user.isNicknameSet = true;
      await user.save();

      res.json({ 
        message: '設定成功！',
        nickname: user.nickname,
        avatarUrl: user.avatarUrl
      });
    } catch (err) {
      console.error('[/api/user/setup] Error:', err);
      res.status(500).json({ message: '伺服器錯誤，設定失敗。' });
    }
  });

  // 設定暱稱 (首次註冊)
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

  // 更新個人資料（暱稱/大頭貼）
  router.post('/update-profile', upload.single('avatar'), async (req, res) => {
    const { nickname } = req.body;
    try {
      const u = await User.findById(req.user._id);
      if (!u) return res.status(404).json({ message: '使用者不存在' });
      if (nickname && nickname.trim().length >= 2) u.nickname = nickname.trim();
      if (req.file) u.avatarUrl = '/avatars/' + req.file.filename;
      await u.save();
      return res.json({
        message: '更新成功',
        nickname: u.nickname,
        avatarUrl: u.avatarUrl || '/avatars/default-avatar.png'
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: '伺服器錯誤' });
    }
  });

  // 取得自己的個資
  router.get('/me', async (req, res) => {
    try {
      const u = await User.findById(req.user._id)
        .populate('friends', 'nickname avatarUrl')
        .lean();
      const friendsMap = {};
      if (u.friends && u.friends.length) {
        u.friends.forEach(f => {
          friendsMap[f._id] = {
            nickname: f.nickname,
            avatarUrl: f.avatarUrl || '/default-avatar.png',
            isOnline: false // 若要顯示在線需在 socket 中額外實作
          };
        });
      }
      return res.json({
        id: u._id.toString(),
        nickname: u.nickname,
        userCode: u.userCode,
        avatarUrl: u.avatarUrl || '/avatars/default-avatar.png',
        friendsMap
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: '伺服器錯誤' });
    }
  });

  // 發送好友邀請（互斥雙方皆不能重複發送）
  router.post('/send-friend-request', async (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ message: '請輸入用戶ID' });
    const target = await User.findOne({ userCode: code });
    if (!target) return res.status(404).json({ message: '用戶不存在' });
    if (target._id.equals(req.user._id)) return res.status(400).json({ message: '不能加自己' });
    if (req.user.friends.includes(target._id)) return res.status(400).json({ message: '已是好友' });
    const exist = await FriendRequest.findOne({
      $or: [
        { from: req.user._id, to: target._id, status: 'pending' },
        { from: target._id, to: req.user._id, status: 'pending' }
      ]
    });
    if (exist) return res.status(400).json({ message: '已發送邀請' });

    await FriendRequest.create({
      from: req.user._id,
      to: target._id,
      status: 'pending'
    });

    // ------ 即時通知被邀請者刷新鈴鐺 (socket) ------
    io.to(target._id.toString()).emit('new-friend-request', {
      from: req.user._id,
      nickname: req.user.nickname,
      avatarUrl: req.user.avatarUrl || '/avatars/default-avatar.png'
    });

    return res.json({ message: '邀請已送出' });
  });

  // 查詢自己的好友邀請
  router.get('/friend-requests', async (req, res) => {
    const reqs = await FriendRequest.find({ to: req.user._id, status: 'pending' })
      .populate('from', 'nickname avatarUrl')
      .lean();
    res.json(
      reqs.map(r => ({
        _id: r._id,
        fromId: r.from._id,
        nickname: r.from.nickname,
        avatarUrl: r.from.avatarUrl || '/avatars/default-avatar.png'
      }))
    );
  });

  // 回應好友邀請（接受/拒絕）
  router.post('/respond-friend-request', async (req, res) => {
    const { requesterId, accept } = req.body;
    const fr = await FriendRequest.findOne({ from: requesterId, to: req.user._id, status: 'pending' });
    if (!fr) return res.status(404).json({ message: '邀請不存在' });
    if (accept) {
      // 雙方加好友
      await User.updateOne({ _id: req.user._id }, { $addToSet: { friends: requesterId } });
      await User.updateOne({ _id: requesterId }, { $addToSet: { friends: req.user._id } });
      fr.status = 'accepted';
      await fr.save();

      // ------- 雙方即時更新好友列表 -------
      const me = await User.findById(req.user._id);
      const you = await User.findById(requesterId);
      io.to(me._id.toString()).emit('new-friend', {
        id: you._id.toString(),
        nickname: you.nickname,
        avatarUrl: you.avatarUrl || '/avatars/default-avatar.png',
        isOnline: false
      });
      io.to(you._id.toString()).emit('new-friend', {
        id: me._id.toString(),
        nickname: me.nickname,
        avatarUrl: me.avatarUrl || '/avatars/default-avatar.png',
        isOnline: false
      });

      return res.json({ message: '已成為好友' });
    } else {
      fr.status = 'declined';
      await fr.save();
      return res.json({ message: '已拒絕' });
    }
  });

  // 查詢用戶ID (userCode)
  router.get('/find-by-code/:userCode', async (req, res) => {
    const searchCode = req.params.userCode?.trim();
    if (!searchCode) return res.status(400).json({ message: 'User code required' });
    const foundUser = await User.findOne({
      userCode: searchCode,
      _id: { $ne: req.user._id }
    }).select('nickname userCode avatarUrl');
    if (!foundUser) return res.status(404).json({ message: '無此用戶' });
    res.json(foundUser);
  });

  // 好友歷史紀錄 (for chat)
  router.get('/chat-history/:userId', async (req, res) => {
    const { userId } = req.params;
    const Message = require('../models/Message');
    const msgs = await Message.find({
      $or: [
        { from: req.user._id, to: userId },
        { from: userId, to: req.user._id }
      ]
    }).sort({ timestamp: 1 }).lean();
    // 附加對方的暱稱/頭像
    const user = await User.findById(userId).select('nickname avatarUrl');
    res.json(msgs.map(msg => ({
      ...msg,
      nickname: msg.from.equals(req.user._id) ? req.user.nickname : (user.nickname),
      avatarUrl: msg.from.equals(req.user._id) ? req.user.avatarUrl : (user.avatarUrl || '/avatars/default-avatar.png')
    })));
  });

  return router;
};
