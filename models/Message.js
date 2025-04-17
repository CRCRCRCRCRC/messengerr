const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  from: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  to: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },        // 私聊對象
  group: { type: mongoose.Schema.Types.ObjectId, ref: 'Group' },    // 群組對象
  message: { type: String },                                        // 文字內容
  imageUrl: { type: String },                                       // 圖片 URL
  timestamp: { type: Date, default: Date.now },
  read: { type: Boolean, default: false }
});

module.exports = mongoose.model('Message', messageSchema);
