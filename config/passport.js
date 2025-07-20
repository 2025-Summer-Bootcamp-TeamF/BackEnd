const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { generateToken } = require('../utils/jwtUtils');

// Google OAuth 전략 설정
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: "/auth/google/callback"
  },
  async (accessToken, refreshToken, profile, done) => {
    try {
      // Google에서 받은 사용자 정보
      const user = {
        id: profile.id,
        email: profile.emails[0].value,
        name: profile.displayName,
        picture: profile.photos[0].value,
        provider: 'google'
      };

      // JWT 토큰 생성
      const token = generateToken(user);
      
      // 토큰과 함께 사용자 정보 반환
      return done(null, { user, token });
    } catch (error) {
      return done(error, null);
    }
  }
));

// 세션 직렬화 (OAuth 과정에서만 사용)
passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((user, done) => {
  done(null, user);
});

module.exports = passport; 