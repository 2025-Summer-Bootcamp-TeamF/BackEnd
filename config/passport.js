const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { generateToken } = require('../utils/jwtUtils');
const { findOrCreateUser } = require('../utils/userService');
const axios = require('axios');
const { Pool } = require('pg');
const pool = new Pool({
  user: process.env.POSTGRES_USER,
  host: process.env.POSTGRES_HOST,
  database: process.env.POSTGRES_DB,
  password: process.env.POSTGRES_PASSWORD,
  port: process.env.POSTGRES_PORT,
});

// Google OAuth 전략 설정
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: "/auth/google/callback"
  },
  async (accessToken, refreshToken, profile, done) => {
    try {
      // [임시] Google access_token 콘솔에 출력 (보안상 실제 서비스에서는 제거해야 함)
      console.log('Google access_token:', accessToken);
      // 1. 유저 생성/조회
      const youtube_user_id = profile.id;
      const email = profile.emails[0].value;
      const user = await findOrCreateUser({ youtube_user_id, email });

      // 2. 유튜브 채널 정보 가져오기
      const ytRes = await axios.get(
        'https://www.googleapis.com/youtube/v3/channels',
        {
          params: {
            part: 'snippet',
            mine: true
          },
          headers: {
            Authorization: `Bearer ${accessToken}`
          }
        }
      );
      const channels = ytRes.data.items;

      // 3. 채널 정보 DB에 저장 (중복 체크)
      for (const ch of channels) {
        const youtube_channel_id = ch.id; // YouTube 채널 고유 id
        const channel_name = ch.snippet.title;
        const profile_image_url = ch.snippet.thumbnails.default.url;
        const channel_intro = ch.snippet.description;

        // 중복 체크 (user_id + youtube_channel_id 기준)
        const exists = await pool.query(
          'SELECT 1 FROM "Channel" WHERE user_id = $1 AND youtube_channel_id = $2',
          [user.id, youtube_channel_id]
        );
        if (exists.rows.length === 0) {
          await pool.query(
            `INSERT INTO "Channel" (user_id, youtube_channel_id, channel_name, profile_image_url, channel_intro, is_deleted, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, false, NOW(), NOW())`,
            [user.id, youtube_channel_id, channel_name, profile_image_url, channel_intro]
          );
          
          // 새로 추가된 채널이면 영상 정보와 스냅샷도 함께 저장
          try {
            const baseUrl = process.env.BACKEND_URL || 'http://localhost:8000';
            const snapshotUrl = `${baseUrl}/api/channel/snapshot?channelId=${youtube_channel_id}`;
            await axios.post(snapshotUrl);
            console.log(`채널 스냅샷 저장 완료: ${youtube_channel_id}`);
          } catch (error) {
            console.error(`채널 스냅샷 저장 실패: ${youtube_channel_id}`, error.message);
            // 스냅샷 저장 실패해도 로그인은 계속 진행
          }
        }
      }

      // 4. JWT 발급
      const token = generateToken({
        id: user.id,
        youtube_user_id: user.youtube_user_id,
        email: user.email
      });

      return done(null, { user, token });
    } catch (error) {
      console.error('YouTube API error:', error.response?.data || error.message);
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