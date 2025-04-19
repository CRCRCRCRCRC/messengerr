// config/passport-setup.js
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const User = require('../models/User');

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const u = await User.findById(id);
    done(null, u);
  } catch (err) {
    done(err, null);
  }
});

passport.use(new GoogleStrategy({
    clientID:     process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL:  process.env.CALLBACK_URL,
  },
  async (accessToken, refreshToken, profile, done) => {
    try {
      let existing = await User.findOne({ googleId: profile.id });
      if (existing) {
        // 補上漏存的 Google 大頭貼
        if (!existing.avatarUrl && profile.photos && profile.photos[0]) {
          existing.avatarUrl = profile.photos[0].value;
          await existing.save();
        }
        return done(null, existing);
      }
      // 新用戶自動帶入 Google 大頭貼
      const newUser = new User({
        googleId:    profile.id,
        email:       profile.emails[0].value,
        displayName: profile.displayName,
        avatarUrl:   profile.photos && profile.photos[0] && profile.photos[0].value,
      });
      await newUser.save();
      done(null, newUser);
    } catch (err) {
      done(err, null);
    }
  }
));
