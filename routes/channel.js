/**
 * @swagger
 * tags:
 *   name: Channel
 *   description: 채널 관련 API
 */

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { google } = require('googleapis');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const router = express.Router();

/**
 * @swagger
 * /channel/avg-views:
 *   get:
 *     summary: 채널 평균 조회수 반환
 *     tags: [Channel]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: 평균 조회수 반환
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 average_view:
 *                   type: number
 *                   example: 15403
 *       401:
 *         description: 인증 실패 (토큰 없음)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       404:
 *         description: 유저 또는 채널, 스냅샷 없음
 *       500:
 *         description: DB 오류
 */
// 평균 조회수 반환
router.get('/avg-views', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'No user id in token' });
    }
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    const channel = await prisma.channel.findFirst({ where: { user_id: userId } });
    if (!channel) {
      return res.status(404).json({ success: false, message: 'Channel not found' });
    }
    const snapshot = await prisma.channel_snapshot.findFirst({
      where: { channel_id: channel.id },
      orderBy: { created_at: 'desc' }
    });
    if (!snapshot) {
      return res.status(404).json({ success: false, message: 'Channel snapshot not found' });
    }
    res.json({ average_view: snapshot.average_view });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'DB error', error: error.message });
  }
});

/**
 * @swagger
 * /api/channel/subscriber-change:
 *   get:
 *     summary: 주기별 구독자 변화 추이 반환
 *     tags: [Channel]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: period
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 365
 *           default: 1
 *           example: 7
 *         description: 주기 (일 단위, 1-365일, 기본값 1)
 *         required: false
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 30
 *           default: 5
 *           example: 10
 *         description: 반환할 데이터 개수 (1-30개, 기본값 5)
 *         required: false
 *     responses:
 *       200:
 *         description: 구독자 변화 추이 반환
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       date:
 *                         type: string
 *                         format: date
 *                         example: "2025-07-21"
 *                       subscriber:
 *                         type: integer
 *                         example: 34912
 *       400:
 *         description: 잘못된 파라미터
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *                   example: "Invalid period value. Must be between 1 and 365"
 *       401:
 *         description: 인증 실패 (토큰 없음)
 *       404:
 *         description: 유저 또는 채널 없음
 *       500:
 *         description: DB 오류
 */
// 구독자 변화 추이 반환 (어제 기준으로 주기별 5개의 스냅샷 조회)
router.get('/subscriber-change', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'No user id in token' });
    }
    
    // 주기 파라미터 받기 (기본값 1일)
    const period = parseInt(req.query.period) || 1;
    
    // 계정 하나당 채널 한개 가정
    const channel = await prisma.channel.findFirst({ where: { user_id: userId } });
    if (!channel) {
      return res.status(404).json({ success: false, message: 'Channel not found' });
    }
    
    // 어제 날짜 계산
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);
    
    // 5개의 날짜 계산 (어제부터 주기별로 역순)
    const targetDates = [];
    for (let i = 0; i < 5; i++) {
      const date = new Date(yesterday);
      date.setDate(date.getDate() - (i * period));
      targetDates.push(date);
    }
    
    // 각 날짜의 00시 스냅샷 조회
    const result = [];
    for (const targetDate of targetDates) {
      const startOfDay = new Date(targetDate);
      startOfDay.setHours(0, 0, 0, 0);
      
      const endOfDay = new Date(targetDate);
      endOfDay.setHours(23, 59, 59, 999);
      
      const snapshot = await prisma.channel_snapshot.findFirst({
        where: {
          channel_id: channel.id,
          created_at: {
            gte: startOfDay,
            lt: new Date(startOfDay.getTime() + 60000) // 00시부터 1분까지 (정확히 00시)
          }
        }
      });
      
      if (!snapshot) {
        return res.status(404).json({ 
          success: false, 
          message: `No snapshot found for ${targetDate.toISOString().slice(0, 10)} at 00:00` 
        });
      }
      
      result.push({
        date: targetDate.toISOString().slice(0, 10),
        subscriber: snapshot.subscriber
      });
    }
    
    // 날짜순으로 정렬
    result.sort((a, b) => new Date(a.date) - new Date(b.date));
    
    res.json({ success: true, data: result });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'DB error', error: error.message });
  }
});

/**
 * @swagger
 * /channel/videos:
 *   get:
 *     summary: 채널의 최근 5개 영상 목록 조회
 *     tags: [Channel]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: 영상 목록 반환
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       videoId:
 *                         type: string
 *                         example: "abc123"
 *                       title:
 *                         type: string
 *                         example: "유튜브 영상 제목"
 *                       thumbnail:
 *                         type: string
 *                         example: "https://example.com/thumbnail.jpg"
 *                       publishedAt:
 *                         type: string
 *                         example: "2025-07-22"
 *                       viewCount:
 *                         type: integer
 *                         example: 15203
 *                       commentRate:
 *                         type: string
 *                         example: "2.334%"
 *                       likeRate:
 *                         type: string
 *                         example: "4.7%"
 *       401:
 *         description: 인증 실패 (토큰 없음)
 *       404:
 *         description: 유저 또는 채널 없음
 *       500:
 *         description: DB 오류
 */
// 영상 목록 조회 (DB 기반, 최근 5개)
router.get('/videos', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'No user id in token' });
    }
    const channel = await prisma.channel.findFirst({ where: { user_id: userId } });
    if (!channel) {
      return res.status(404).json({ success: false, message: 'Channel not found' });
    }
    const videos = await prisma.video.findMany({
      where: { channel_id: channel.id },
      orderBy: { created_at: 'desc' },
      take: 5
    });
    const result = [];
    for (const video of videos) {
      const snapshot = await prisma.video_snapshot.findFirst({
        where: { video_id: video.id },
        orderBy: { created_at: 'desc' }
      });
      result.push({
        videoId: video.id,
        title: video.video_name,
        thumbnail: video.video_thumbnail_url,
        publishedAt: video.created_at ? video.created_at.toISOString().slice(0, 10) : null,
        viewCount: snapshot?.view_count ?? 0,
        commentRate: snapshot && snapshot.comment_count && snapshot.view_count ? (snapshot.comment_count / snapshot.view_count * 100).toFixed(3) + '%' : '0.000%',
        likeRate: snapshot && snapshot.like_count && snapshot.view_count ? (snapshot.like_count / snapshot.view_count * 100).toFixed(1) + '%' : '0.0%',
      });
    }
    res.json({ success: true, data: result });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'DB error', error: error.message });
  }
});

/**
 * @swagger
 * /api/channel/categories/stats:
 *   get:
 *     summary: 채널의 카테고리별 통계 반환 (많은 순)
 *     tags: [Channel]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: 카테고리별 통계 반환
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       category_id:
 *                         type: integer
 *                         example: 1
 *                       category_name:
 *                         type: string
 *                         example: "게임"
 *                       video_count:
 *                         type: integer
 *                         example: 25
 *                       total_views:
 *                         type: integer
 *                         example: 1250000
 *                       total_likes:
 *                         type: integer
 *                         example: 45000
 *                       total_comments:
 *                         type: integer
 *                         example: 3200
 *                       average_views:
 *                         type: number
 *                         example: 50000.0
 *       401:
 *         description: 인증 실패 (토큰 없음)
 *       404:
 *         description: 유저 또는 채널 없음
 *       500:
 *         description: DB 오류
 */
// 카테고리별 통계 반환 (많은 순)
router.get('/categories/stats', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'No user id in token' });
    }
    
    const channel = await prisma.channel.findFirst({ where: { user_id: userId } });
    if (!channel) {
      return res.status(404).json({ success: false, message: 'Channel not found' });
    }
    
    // 카테고리별 통계 조회 (JOIN을 사용하여 한 번에 조회)
    const categoryStats = await prisma.$queryRaw`
      SELECT 
        c.id as category_id,
        c.category as category_name,
        COUNT(vc.video_id)::int as video_count,
        COALESCE(SUM(vs.view_count), 0)::int as total_views,
        COALESCE(SUM(vs.like_count), 0)::int as total_likes,
        COALESCE(SUM(vs.comment_count), 0)::int as total_comments,
        CASE 
          WHEN COUNT(vc.video_id) > 0 
          THEN COALESCE(SUM(vs.view_count), 0)::float / COUNT(vc.video_id)::float
          ELSE 0 
        END as average_views
      FROM "Category" c
      LEFT JOIN "Video_category" vc ON c.id = vc.category_id
      LEFT JOIN "Video" v ON vc.video_id = v.id AND v.channel_id = ${channel.id} AND v.is_deleted = false
      LEFT JOIN "Video_snapshot" vs ON v.id = vs.video_id AND vs.is_deleted = false
      GROUP BY c.id, c.category
      HAVING COUNT(vc.video_id) > 0
      ORDER BY video_count DESC, total_views DESC
    `;
    
    // BigInt를 Number로 변환
    const processedStats = categoryStats.map(stat => ({
      category_id: Number(stat.category_id),
      category_name: stat.category_name,
      video_count: Number(stat.video_count),
      total_views: Number(stat.total_views),
      total_likes: Number(stat.total_likes),
      total_comments: Number(stat.total_comments),
      average_views: Number(stat.average_views)
    }));
    
    res.json({ success: true, data: processedStats });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'DB error', error: error.message });
  }
});

module.exports = router; 