// routes/userRoutes.js
const express = require('express');
const User = require('../models/User');
const FriendRequest = require('../models/FriendRequest');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Group = require('../models/Group');
const Message = require('../models/Message');

module.exports = function(io) {
  const router = express.Router();

  // middleware
  function ensureAuth(req, res, next) {
    if (req.isAuthenticated()) return next();
    return res.status(401).json({ message: 'Unauthorized' });
  }
  router.use(ensureAuth);

  // ++ 修改：統一獲取初始資料 ++ 
  router.get('/initial-data', async (req, res) => {
    try {
      const userId = req.user._id;
      const RECENT_MESSAGES_LIMIT = 10; // ++ 定義預載入訊息數量 ++

      const userPromise = User.findById(userId)
        .select('nickname userCode avatarUrl friends isNicknameSet')
        .populate('friends', 'nickname avatarUrl isOnline')
        .lean();
      
      const groupsPromise = Group.find({ members: userId })
        .select('name avatarUrl members owner')
        .lean();

      let [userData, groupsData] = await Promise.all([userPromise, groupsPromise]);

      if (!userData) {
        return res.status(404).json({ message: '使用者不存在' });
      }
      if (!userData.isNicknameSet) {
        // 理論上 ensureNickname 中介軟體會處理，但多一層防護
        return res.status(403).json({ message: '需要先設定暱稱', redirectTo: '/setup' });
      }

      // 處理好友，並為每個好友預載入訊息
      const friendsMap = {};
      if (userData.friends && userData.friends.length) {
        for (let friend of userData.friends) {
          const recentMessages = await Message.find({
            $or: [
              { from: userId, to: friend._id },
              { from: friend._id, to: userId }
            ]
          })
          .sort({ timestamp: -1 })
          .limit(RECENT_MESSAGES_LIMIT)
          .lean();
          
          // 訊息是降序的，前端可能需要反轉成升序顯示
          // 附加發送者資訊到訊息中
          for (let msg of recentMessages) {
            const sender = msg.from.equals(userId) ? userData : friend;
            msg.nickname = sender.nickname;
            msg.avatarUrl = sender.avatarUrl || '/default-avatar.png';
            msg.isSelf = msg.from.equals(userId);
            msg.from = msg.from.toString();
            msg.to = msg.to.toString();
          }

          friendsMap[friend._id.toString()] = {
            nickname: friend.nickname,
            avatarUrl: friend.avatarUrl || '/default-avatar.png',
            isOnline: friend.isOnline || false,
            recentMessages: recentMessages.reverse() // 反轉為時間升序
          };
        }
      }

      // 處理群組，並為每個群組預載入訊息
      if (groupsData && groupsData.length) {
        for (let group of groupsData) {
          const recentMessages = await Message.find({ group: group._id })
            .sort({ timestamp: -1 })
            .limit(RECENT_MESSAGES_LIMIT)
            .lean();

          // 附加發送者資訊到訊息中
          for (let msg of recentMessages) {
            // 需要查詢 User 表來獲取發送者暱稱和頭像
            const senderData = await User.findById(msg.from).select('nickname avatarUrl').lean();
            msg.nickname = senderData ? senderData.nickname : '未知用戶';
            msg.avatarUrl = senderData ? (senderData.avatarUrl || '/default-avatar.png') : '/default-avatar.png';
            msg.isSelf = msg.from.equals(userId);
            msg.from = msg.from.toString();
            if (msg.group) msg.group = msg.group.toString();
          }
          group.recentMessages = recentMessages.reverse(); // 反轉為時間升序
        }
      }

      const { friends, ...userBasicInfo } = userData;

      res.json({
        user: {
          id: userBasicInfo._id.toString(),
          nickname: userBasicInfo.nickname,
          userCode: userBasicInfo.userCode,
          avatarUrl: userBasicInfo.avatarUrl || '/default-avatar.png'
        },
        friendsMap: friendsMap,
        groups: groupsData.map(g => ({
          id: g._id.toString(),
          name: g.name,
          avatarUrl: g.avatarUrl || '/default-avatar.png',
          recentMessages: g.recentMessages || [] // 確保有 recentMessages 陣列
        }))
      });

    } catch (err) {
      console.error('[/api/initial-data] Error:', err);
      res.status(500).json({ message: '獲取初始資料失敗' });
    }
  });
  // ++ 結束：統一獲取初始資料 ++ 

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
            isOnline: false
          };
        });
      }
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
      avatarUrl: req.user.avatarUrl || '/default-avatar.png'
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
        avatarUrl: r.from.avatarUrl || '/default-avatar.png'
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

      // ------- 更新雙方活躍 Socket Session 中的好友列表 -------
      const currentUserMongoId = req.user._id;
      const newFriendMongoId = fr.from; // requesterId 是字串，fr.from 是 ObjectId

      for (const connectedSocket of io.sockets.sockets.values()) {
        if (connectedSocket.userData && connectedSocket.userData.id === currentUserMongoId.toString()) {
          if (!connectedSocket.userData.friends.includes(newFriendMongoId.toString())) {
            connectedSocket.userData.friends.push(newFriendMongoId.toString());
            console.log(`Updated socket session for user ${currentUserMongoId}: added friend ${newFriendMongoId}`)
          }
        }
        if (connectedSocket.userData && connectedSocket.userData.id === newFriendMongoId.toString()) {
          if (!connectedSocket.userData.friends.includes(currentUserMongoId.toString())) {
            connectedSocket.userData.friends.push(currentUserMongoId.toString());
            console.log(`Updated socket session for user ${newFriendMongoId}: added friend ${currentUserMongoId}`)
          }
        }
      }
      // ------- 結束更新活躍 Socket Session -------

      // ------- 雙方即時更新客戶端好友列表 -------
      const me = await User.findById(req.user._id);
      const you = await User.findById(requesterId);
      io.to(me._id.toString()).emit('new-friend', {
        id: you._id.toString(),
        nickname: you.nickname,
        avatarUrl: you.avatarUrl || '/default-avatar.png',
        isOnline: false
      });
      io.to(you._id.toString()).emit('new-friend', {
        id: me._id.toString(),
        nickname: me.nickname,
        avatarUrl: me.avatarUrl || '/default-avatar.png',
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
    const { beforeMessageId, limit = 20 } = req.query; // ++ 新增分頁參數 ++
    const Message = require('../models/Message');

    const query = {
      $or: [
        { from: req.user._id, to: userId },
        { from: userId, to: req.user._id }
      ]
    };

    // ++ 如果有 beforeMessageId，則查詢此 ID 之前的訊息 ++
    if (beforeMessageId) {
      try {
        const beforeMessage = await Message.findById(beforeMessageId).lean();
        if (beforeMessage) {
          query.timestamp = { $lt: beforeMessage.timestamp };
        }
      } catch (err) {
        console.error('Error finding beforeMessage:', err);
        // 可以選擇回傳錯誤，或忽略此參數繼續
      }
    }

    const msgs = await Message.find(query)
      .sort({ timestamp: -1 }) // 改為降序，方便 limit 和後續反轉
      .limit(parseInt(limit))
      .lean();

    // 附加對方的暱稱/頭像，並確保 ID 是字串
    const user = await User.findById(userId).select('nickname avatarUrl');
    const processedMsgs = msgs.map(msg => ({
      ...msg,
      _id: msg._id.toString(), // ++ ID 轉字串 ++
      from: msg.from.toString(), // ++ ID 轉字串 ++
      to: msg.to.toString(), // ++ ID 轉字串 ++
      isSelf: msg.from.equals(req.user._id.toString()), // ++ 新增 isSelf ++
      nickname: msg.from.equals(req.user._id.toString()) ? req.user.nickname : (user.nickname),
      avatarUrl: msg.from.equals(req.user._id.toString()) ? (req.user.avatarUrl || '/default-avatar.png') : (user.avatarUrl || '/default-avatar.png')
    }));

    res.json(processedMsgs.reverse()); // 反轉回時間升序給前端
  });

  return router;
};
