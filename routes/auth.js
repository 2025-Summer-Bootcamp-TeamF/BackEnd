const express = require('express');
const passport = require('passport');
const { verifyToken, generateToken } = require('../utils/jwtUtils');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Google OAuth 로그인 시작
router.get('/google', passport.authenticate('google', {
  scope: ['profile', 'email']
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

// JWT 토큰 검증
router.post('/verify', (req, res) => {
  const { token } = req.body;
  
  if (!token) {
    return res.status(400).json({
      success: false,
      message: 'Token is required'
    });
  }

  const user = verifyToken(token);
  if (!user) {
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired token'
    });
  }

  res.json({
    success: true,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      picture: user.picture,
      provider: user.provider
    }
  });
});

// 토큰 갱신
router.post('/refresh', (req, res) => {
  const { token } = req.body;
  
  if (!token) {
    return res.status(400).json({
      success: false,
      message: 'Token is required'
    });
  }

  const user = verifyToken(token);
  if (!user) {
    return res.status(401).json({
      success: false,
      message: 'Invalid token'
    });
  }

  // 새로운 토큰 생성
  const newToken = generateToken({
    id: user.id,
    email: user.email,
    name: user.name,
    picture: user.picture,
    provider: user.provider
  });

  res.json({
    success: true,
    token: newToken,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      picture: user.picture,
      provider: user.provider
    }
  });
});

// 보호된 라우트 예시
router.get('/profile', authenticateToken, (req, res) => {
  res.json({
    success: true,
    user: req.user
  });
});

// 로그아웃 (클라이언트에서 토큰 삭제)
router.post('/logout', (req, res) => {
  res.json({
    success: true,
    message: 'Logged out successfully'
  });
});

module.exports = router; 