// routes/uploadRoutes.js
const express = require('express');
const multer = require('multer');
const path = require('path');
const Message = require('../models/Message');
const Group = require('../models/Group');

module.exports = function(io) {
  const router = express.Router();

  // 把上傳的圖片放 public/uploads
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(__dirname, '../public/uploads');
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      // 用 timestamp+原名 保證不衝突
      const name = `${Date.now()}_${file.originalname}`;
      cb(null, name);
    }
  });
  const upload = multer({ storage });

  router.post('/', upload.single('image'), async (req, res) => {
    try {
      // body: { to, type }
      const to = req.body.to;
      const type = req.body.type; // 'friend' 或 'group'
      const imageUrl = `/uploads/${req.file.filename}`;

      let msg;
      if (type === 'friend') {
        // 私訊圖片
        msg = await Message.create({
          from: req.user._id,
          to: to,
          imageUrl: imageUrl,
          timestamp: new Date(),
          read: false
        });
        // 撈出 sender 資訊
        const sender = await req.user.populate('nickname avatarUrl').execPopulate();
        // 推播給對方 & 自己
        const payload = {
          ...msg.toObject(),
          nickname: sender.nickname,
          avatarUrl: sender.avatarUrl
        };
        io.to(to).to(req.user._id.toString()).emit('private message', payload);
      } else {
        // 群組圖片
        msg = await Message.create({
          from: req.user._id,
          group: to,
          imageUrl: imageUrl,
          timestamp: new Date(),
          read: false
        });
        const sender = await req.user.populate('nickname avatarUrl').execPopulate();
        const payload = {
          ...msg.toObject(),
          nickname: sender.nickname,
          avatarUrl: sender.avatarUrl
        };
        const group = await Group.findById(to).select('members');
        group.members.forEach(memberId => {
          io.to(memberId.toString()).emit('group message', payload);
        });
      }

      // 回給前端 appendMessage() 用
      res.json({
        ...msg.toObject(),
        nickname: req.user.nickname,
        avatarUrl: req.user.avatarUrl
      });
    } catch (err) {
      console.error('❌ 圖片上傳或存 DB 發生錯誤：', err);
      res.status(500).json({ message: '圖片上傳失敗' });
    }
  });

  return router;
};
