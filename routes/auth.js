/*
  [Auth 관련 엔드포인트]
  GET    /auth/google            - 구글 로그인 시작
  GET    /auth/google/callback   - 구글 콜백 처리
  GET    /auth/failure           - 인증 실패 처리
  POST   /auth/logout            - 로그아웃
*/

/**
 * @swagger
 * tags:
 *   name: Auth
 *   description: 사용자 인증 관련 API
 */

const express = require('express');
const passport = require('passport');
const { verifyToken, generateToken } = require('../utils/jwtUtils');
const { authenticateToken } = require('../middleware/auth');
const router = express.Router();

/**
 * @swagger
 * /auth/google:
 *   get:
 *     summary: 구글 로그인 시작
 *     tags: [Auth]
 *     responses:
 *       302:
 *         description: Google OAuth 로그인 페이지로 리디렉션
 */
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

/**
 * @swagger
 * /auth/google/callback:
 *   get:
 *     summary: 구글 로그인 콜백 처리
 *     tags: [Auth]
 *     responses:
 *       302:
 *         description: 로그인 성공/실패 시 프론트엔드로 리디렉션
 */
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

/**
 * @swagger
 * /auth/failure:
 *   get:
 *     summary: 로그인 실패 처리
 *     tags: [Auth]
 *     responses:
 *       302:
 *         description: 인증 실패 시 프론트엔드로 리디렉션
 */
// OAuth 실패 처리
router.get('/failure', (req, res) => {
  res.redirect(`${process.env.FRONTEND_URL}/auth/error`);
});

/**
 * @swagger
 * /auth/logout:
 *   post:
 *     summary: 로그아웃
 *     tags: [Auth]
 *     responses:
 *       200:
 *         description: 로그아웃 성공 응답
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 */
// 로그아웃 (클라이언트에서 토큰 삭제)
router.post('/logout', (req, res) => {
  res.json({
    success: true,
    message: 'Logged out successfully'
  });
});

module.exports = router; 