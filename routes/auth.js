/*
  [Auth 관련 엔드포인트]
  GET    /auth/google            - 구글 로그인 시작
  GET    /auth/google/callback   - 구글 콜백 처리
  GET    /auth/failure           - 인증 실패 처리
  POST   /auth/logout            - 로그아웃
*/

const express = require('express');
const passport = require('passport');
const { verifyToken, generateToken } = require('../utils/jwtUtils');
const { authenticateToken } = require('../middleware/auth');
const router = express.Router();


// Google OAuth 로그인 시작
router.get('/google', passport.authenticate('google', {
  scope: [
    'profile',
    'email',
    'https://www.googleapis.com/auth/youtube',
    'https://www.googleapis.com/auth/youtube.force-ssl' 
  ],
  prompt: 'consent' 
}));

// Google OAuth 콜백 처리
router.get('/google/callback', 
  passport.authenticate('google', { 
    failureRedirect: '/auth/failure',
    session: false 
  }),
  (req, res) => {
    try {
      const { user, token } = req.user;
      
      // 프론트엔드로 리디렉션 (토큰을 URL 파라미터로 전달)
      const redirectUrl = `${process.env.FRONTEND_URL}/auth/callback?token=${token}`;
      res.redirect(redirectUrl);
    } catch (error) {
      console.error('OAuth callback error:', error);
      res.redirect(`${process.env.FRONTEND_URL}/auth/error`);
    }
  }
);

// OAuth 실패 처리
router.get('/failure', (req, res) => {
  res.redirect(`${process.env.FRONTEND_URL}/auth/error`);
});

// 로그아웃 (클라이언트에서 토큰 삭제)
router.post('/logout', (req, res) => {
  res.json({
    success: true,
    message: 'Logged out successfully'
  });
});

module.exports = router; 