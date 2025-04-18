// models/Message.js

const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema({
  from:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  to:        { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  group:     { type: mongoose.Schema.Types.ObjectId, ref: 'Group' },
  message:   { type: String },
  imageUrl:  { type: String },
  timestamp: { type: Date, default: Date.now },
  read:      { type: Boolean, default: false },
  recalled:  { type: Boolean, default: false }
});

module.exports = mongoose.model('Message', MessageSchema);
