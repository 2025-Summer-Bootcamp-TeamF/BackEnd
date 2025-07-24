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
 * /channel/subscriber-change:
 *   get:
 *     summary: 최근 5일 구독자 변화 추이 반환
 *     tags: [Channel]
 *     security:
 *       - bearerAuth: []
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
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       date:
 *                         type: string
 *                         example: "2025-07-21"
 *                       subscriber:
 *                         type: integer
 *                         example: 34912
 *       401:
 *         description: 인증 실패 (토큰 없음)
 *       404:
 *         description: 유저 또는 채널 없음
 *       500:
 *         description: DB 오류
 */
// 구독자 변화 추이 반환 (최근 5일)
router.get('/subscriber-change', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'No user id in token' });
    }
    const channel = await prisma.channel.findFirst({ where: { user_id: userId } });
    if (!channel) {
      return res.status(404).json({ success: false, message: 'Channel not found' });
    }
    const snapshots = await prisma.channel_snapshot.findMany({
      where: { channel_id: channel.id },
      orderBy: { created_at: 'desc' },
      take: 5
    });
    snapshots.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const result = snapshots.map(s => ({
      date: s.created_at.toISOString().slice(0, 10),
      subscriber: s.subscriber
    }));
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


module.exports = router; 