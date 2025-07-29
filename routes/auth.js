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

const express = require("express");
const passport = require("passport");
const { verifyToken, generateToken } = require("../utils/jwtUtils");
const { authenticateToken } = require("../middleware/auth");
const { PrismaClient } = require("@prisma/client");
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
router.get(
  "/google",
  passport.authenticate("google", {
  scope: [
      "profile",
      "email",
      "https://www.googleapis.com/auth/youtube",
      "https://www.googleapis.com/auth/youtube.force-ssl",
  ],
    prompt: "consent",
  })
);

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
router.get(
  "/google/callback",
  passport.authenticate("google", {
    failureRedirect: "/auth/failure",
    session: false,
  }),
  (req, res) => {
    try {
      const { user, token, youtubeAccessToken } = req.user;
      
      // 프론트엔드로 리디렉션 (토큰들을 URL 파라미터로 전달)
      const redirectUrl = `${process.env.FRONTEND_URL}/auth/callback?token=${token}&youtube_token=${youtubeAccessToken}`;
      res.redirect(redirectUrl);
    } catch (error) {
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
router.get("/failure", (req, res) => {
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
router.post("/logout", async (req, res) => {
  try {
    // 사용자 ID 추출 (토큰에서)
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.substring(7);

      const decoded = verifyToken(token);

      if (decoded && decoded.id) {
        // 해당 사용자의 채널 ID 찾기
        const userChannel = await prisma.channel.findFirst({
          where: { user_id: decoded.id },
        });

        if (userChannel) {
          // 해당 채널의 영상들 찾기
          const channelVideos = await prisma.video.findMany({
            where: { channel_id: userChannel.id },
            select: { id: true },
          });

          const videoIds = channelVideos.map((v) => v.id);

          // 카테고리 분류 데이터 삭제
          if (videoIds.length > 0) {
            // 1. Video_category 테이블에서 해당 영상들의 분류 데이터 삭제
            const deletedVideoCategories =
              await prisma.video_category.deleteMany({
                where: {
                  video_id: {
                    in: videoIds,
                  },
                },
              });

            // 2. 모든 Category 삭제 (사용자가 로그아웃하면 모든 카테고리 초기화)
            const deletedCategories = await prisma.category.deleteMany({});
          }
        }
      }
    }

    res.json({
      success: true,
      message: "Logged out successfully",
    });
  } catch (error) {
  res.json({
    success: true,
      message: "Logged out successfully",
  });
  }
});

module.exports = router; 
