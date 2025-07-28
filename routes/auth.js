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
const { PrismaClient } = require('@prisma/client');
const router = express.Router();

const prisma = new PrismaClient();

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
router.post('/logout', async (req, res) => {
  console.log('[DEBUG] 로그아웃 API 호출됨');
  try {
    // 사용자 ID 추출 (토큰에서)
    const authHeader = req.headers.authorization;
    console.log('[DEBUG] Authorization 헤더:', authHeader);
    
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      console.log('[DEBUG] 토큰 추출됨');
      
      const decoded = verifyToken(token);
      console.log('[DEBUG] 토큰 디코딩 결과:', decoded);
      
      if (decoded && decoded.id) {
        console.log('[DEBUG] 사용자 ID:', decoded.id);
        
        // 해당 사용자의 채널 ID 찾기
        const userChannel = await prisma.channel.findFirst({
          where: { user_id: decoded.id }
        });
        
        console.log('[DEBUG] 사용자 채널:', userChannel);
        
        if (userChannel) {
          // 해당 채널의 영상들 찾기
          const channelVideos = await prisma.video.findMany({
            where: { channel_id: userChannel.id },
            select: { id: true }
          });
          
          const videoIds = channelVideos.map(v => v.id);
          console.log('[DEBUG] 채널 영상 ID들:', videoIds);
          
          // 카테고리 분류 데이터 삭제
          if (videoIds.length > 0) {
            // 1. Video_category 테이블에서 해당 영상들의 분류 데이터 삭제
            const deletedVideoCategories = await prisma.video_category.deleteMany({
              where: {
                video_id: {
                  in: videoIds
                }
              }
            });
            
            // 2. 모든 Category 삭제 (사용자가 로그아웃하면 모든 카테고리 초기화)
            const deletedCategories = await prisma.category.deleteMany({});
            
            console.log(`[DEBUG] 로그아웃 시 카테고리 분류 데이터 삭제 완료: ${videoIds.length}개 영상, ${deletedVideoCategories.count}개 Video_category, ${deletedCategories.count}개 Category`);
          } else {
            console.log('[DEBUG] 삭제할 영상이 없음');
          }
        } else {
          console.log('[DEBUG] 사용자 채널을 찾을 수 없음');
        }
      } else {
        console.log('[DEBUG] 토큰에서 사용자 ID를 추출할 수 없음');
      }
    } else {
      console.log('[DEBUG] Authorization 헤더가 없거나 Bearer 형식이 아님');
    }
    
    res.json({
      success: true,
      message: 'Logged out successfully'
    });
  } catch (error) {
    console.error('[DEBUG] 로그아웃 시 카테고리 데이터 삭제 실패:', error);
    res.json({
      success: true,
      message: 'Logged out successfully'
    });
  }
});

module.exports = router; 