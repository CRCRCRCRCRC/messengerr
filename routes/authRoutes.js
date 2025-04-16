const express = require('express');
const passport = require('passport');
const User = require('../models/User');

const router = express.Router();

// Google 登入
router.get('/google', passport.authenticate('google', {
  scope: ['profile', 'email']
}));

// Google callback
router.get('/google/callback',
  passport.authenticate('google', { failureRedirect: '/' }),
  async (req, res) => {
    const user = await User.findById(req.user._id);
    if (!user || !user.isNicknameSet) {
      return res.redirect('/setup');
    }
    res.redirect('/chat');
  }
);

// 登出
router.get('/logout', (req, res, next) => {
  req.logout(err => {
    if (err) return next(err);
    req.session.destroy(() => {
      res.clearCookie('connect.sid');
      res.redirect('/');
    });
  });
});

module.exports = router;
