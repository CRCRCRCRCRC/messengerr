const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const userSchema = new mongoose.Schema({
  googleId: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  displayName: String,
  nickname: { type: String, trim: true },
  userCode: {
    type: String,
    required: true,
    unique: true,
    default: () => `U${uuidv4().substring(0, 8).toUpperCase()}`
  },
  isNicknameSet: { type: Boolean, default: false },
  avatarUrl: String,
  isOnline: { type: Boolean, default: false },

  friends: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  friendRequests: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }] // ✅ 新增
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
