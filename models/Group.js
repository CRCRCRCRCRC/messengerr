const mongoose = require('mongoose');

const groupSchema = new mongoose.Schema({
  name: { type: String, required: true },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  members: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  avatarUrl: { type: String, default: '/default-group.png' }
}, { timestamps: true });

module.exports = mongoose.model('Group', groupSchema);
