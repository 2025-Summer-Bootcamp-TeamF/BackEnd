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
const { saveVideoSnapshot } = require('../utils/videoSnapshot');

const router = express.Router();

// 모든 요청에 대한 로그 추가
router.use((req, res, next) => {
  console.log(`[Channel Routes] ${req.method} ${req.path} - ${new Date().toISOString()}`);
  next();
});

/**
 * @swagger
 * /channel/my:
 *   get:
 *     summary: 현재 로그인한 사용자의 채널 정보 조회
 *     tags: [Channel]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: 채널 정보 반환
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 channel:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: number
 *                     channel_name:
 *                       type: string
 *                     profile_image_url:
 *                       type: string
 *                     channel_intro:
 *                       type: string
 *                     youtube_channel_id:
 *                       type: string
 *                     created_at:
 *                       type: string
 *                 snapshot:
 *                   type: object
 *                   properties:
 *                     subscriber:
 *                       type: number
 *                     total_videos:
 *                       type: number
 *                     total_view:
 *                       type: number
 *                     channel_created:
 *                       type: string
 *                     nation:
 *                       type: string
 *       401:
 *         description: 인증 실패 (토큰 없음)
 *       404:
 *         description: 채널 정보 없음
 *       500:
 *         description: 서버 오류
 */
// 현재 로그인한 사용자의 채널 정보 조회
router.get('/my', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'No user id in token' });
    }

    console.log('Fetching channel data for user ID:', userId);

    const { Pool } = require('pg');
    const pool = new Pool({
      user: process.env.POSTGRES_USER,
      host: process.env.POSTGRES_HOST,
      database: process.env.POSTGRES_DB,
      password: process.env.POSTGRES_PASSWORD,
      port: process.env.POSTGRES_PORT,
    });

    // 현재 로그인한 사용자의 채널 정보 조회
    const channelResult = await pool.query(
      'SELECT * FROM "Channel" WHERE user_id = $1 AND is_deleted = false',
      [userId]
    );

    if (channelResult.rows.length === 0) {
      console.log('No channel found for user ID:', userId);
      return res.status(404).json({ 
        success: false, 
        message: 'Channel not found for the current user' 
      });
    }

    const channel = channelResult.rows[0];
    console.log('Channel found:', channel);

    // 최신 스냅샷 정보 조회
    const snapshotResult = await pool.query(
      'SELECT * FROM "Channel_snapshot" WHERE channel_id = $1 AND is_deleted = false ORDER BY created_at DESC LIMIT 1',
      [channel.id]
    );

    const snapshot = snapshotResult.rows[0] || {};
    console.log('Snapshot found:', snapshot);

    res.json({
      channel: {
        id: channel.id,
        channel_name: channel.channel_name,
        profile_image_url: channel.profile_image_url,
        channel_intro: channel.channel_intro,
        youtube_channel_id: channel.youtube_channel_id,
        created_at: channel.created_at
      },
      snapshot: {
        subscriber: snapshot.subscriber,
        total_videos: snapshot.total_videos,
        total_view: snapshot.total_view,
        channel_created: snapshot.channel_created,
        nation: snapshot.nation
      }
    });

  } catch (error) {
    console.error('Error fetching channel data:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Internal server error',
      error: error.message 
    });
  }
});

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
 *                 daily_average_view:
 *                   type: number
 *                   example: 125000
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

    // 일일 평균 조회수 계산
    let daily_average_view = 0;
    if (snapshot.channel_created && snapshot.total_view) {
      const channelCreatedDate = new Date(snapshot.channel_created);
      const latestSnapshotDate = new Date(snapshot.created_at);
      const daysDiff = Math.ceil((latestSnapshotDate - channelCreatedDate) / (1000 * 60 * 60 * 24));
      
      if (daysDiff > 0) {
        daily_average_view = Math.round(snapshot.total_view / daysDiff);
      }
    }

    res.json({ 
      average_view: snapshot.average_view,
      daily_average_view: daily_average_view
    });
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
      

      //일단은 초단위는 무시 나중에 수정 가능
      const snapshot = await prisma.channel_snapshot.findFirst({
        where: {
          channel_id: channel.id,
          created_at: {
            gte: startOfDay,
            lt: new Date(startOfDay.getTime() + 60000) 
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
// 영상 목록 조회 (DB 기반, 최신순 정렬)
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
      orderBy: { upload_date: 'desc' }
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
  console.log('[Channel] /categories/stats 라우트에 요청이 도달했습니다!');
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

/**
 * @swagger
 * /channel/videos/fetch:
 *   get:
 *     summary: 채널의 모든 영상 정보 및 스냅샷 저장
 *     tags: [Channel]
 *     parameters:
 *       - in: query
 *         name: channelId
 *         required: true
 *         schema:
 *           type: string
 *         description: 유튜브 채널 ID
 *     responses:
 *       200:
 *         description: 영상 정보 및 스냅샷 저장 성공
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 count:
 *                   type: integer
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       videoId:
 *                         type: string
 *                       title:
 *                         type: string
 *                       thumbnail:
 *                         type: string
 *                       publishedAt:
 *                         type: string
 *       400:
 *         description: 채널 ID 누락
 *       404:
 *         description: DB에 해당 유튜브 채널 없음
 *       500:
 *         description: 유튜브 영상 정보 수집 중 오류
 */
// 채널의 모든 영상 정보 저장(스냅샷까지)하는 엔드포인트 (playlistItems API 사용, GET+쿼리파라미터)
router.get('/videos/fetch', async (req, res) => {
  const channelId = req.query.channelId;
  if (!channelId) {
    return res.status(400).json({ success: false, message: '채널 ID가 필요합니다.' });
  }

  const YOUTUBE_API_KEY = process.env.GOOGLE_API_KEY;
  if (!YOUTUBE_API_KEY) {
    return res.status(500).json({ success: false, message: '서버에 GOOGLE_API_KEY가 설정되어 있지 않습니다.' });
  }

  try {
    // 1. uploads playlistId 얻기
    const channelInfoUrl = `https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id=${channelId}&key=${YOUTUBE_API_KEY}`;
    const channelInfoResp = await fetch(channelInfoUrl);
    const channelInfoData = await channelInfoResp.json();
    const uploadsPlaylistId = channelInfoData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsPlaylistId) {
      return res.status(404).json({ success: false, message: '업로드 재생목록(playlistId)을 찾을 수 없습니다.' });
    }

    // 2. playlistItems API로 모든 영상 가져오기
    let nextPageToken = '';
    let totalResults = [];
    const dbChannel = await prisma.channel.findFirst({ where: { youtube_channel_id: channelId } });
    if (!dbChannel) {
      return res.status(404).json({ success: false, message: 'DB에 해당 유튜브 채널이 없습니다.' });
    }
    do {
      const playlistUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploadsPlaylistId}&maxResults=50&key=${YOUTUBE_API_KEY}${nextPageToken ? `&pageToken=${nextPageToken}` : ''}`;
      const playlistResp = await fetch(playlistUrl);
      const playlistData = await playlistResp.json();
      if (!playlistData.items) {
        break;
      }
      for (const item of playlistData.items) {
        const snippet = item.snippet;
        const videoId = snippet.resourceId?.videoId;
        if (!videoId) continue;
        // 비디오 테이블에 upsert (정적 정보)
        const video = await prisma.video.upsert({
          where: { id: videoId },
          update: {
            video_name: snippet.title,
            video_thumbnail_url: snippet.thumbnails?.high?.url || null,
            upload_date: snippet.publishedAt ? new Date(snippet.publishedAt) : null,
            video_link: `https://www.youtube.com/watch?v=${videoId}`,
          },
          create: {
            id: videoId,
            channel_id: dbChannel.id,
            video_name: snippet.title,
            video_thumbnail_url: snippet.thumbnails?.high?.url || null,
            upload_date: snippet.publishedAt ? new Date(snippet.publishedAt) : null,
            video_type: null,
            video_link: `https://www.youtube.com/watch?v=${videoId}`,
          },
        });
        // DB의 채널 pk와 유튜브 채널 ID 매핑 (최초 1회만 필요)
        if (!video.channel_id) {
          if (dbChannel) {
            await prisma.video.update({ where: { id: videoId }, data: { channel_id: dbChannel.id } });
          }
        }
        totalResults.push({
          videoId,
          title: snippet.title,
          thumbnail: snippet.thumbnails?.high?.url || null,
          publishedAt: snippet.publishedAt,
        });
        // 비디오 스냅샷 저장
        await saveVideoSnapshot(videoId, YOUTUBE_API_KEY);
      }
      nextPageToken = playlistData.nextPageToken;
    } while (nextPageToken);

    res.json({ success: true, count: totalResults.length, data: totalResults });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: '유튜브 영상 정보 수집 중 오류 발생', error: error.message });
  }
});

/**
 * @swagger
 * /channel/snapshot:
 *   post:
 *     summary: 채널 스냅샷 저장 (모든 영상 스냅샷 최신화 후 채널 통계 저장)
 *     tags: [Channel]
 *     parameters:
 *       - in: query
 *         name: channelId
 *         required: true
 *         schema:
 *           type: string
 *         description: 유튜브 채널 ID
 *     responses:
 *       200:
 *         description: 채널 스냅샷 저장 성공
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *       400:
 *         description: 채널 ID 누락
 *       404:
 *         description: DB에 해당 유튜브 채널 없음
 *       500:
 *         description: 채널 스냅샷 저장 중 오류
 */
router.post('/snapshot', async (req, res) => {
  const channelId = req.query.channelId;
  if (!channelId) {
    return res.status(400).json({ success: false, message: '채널 ID가 필요합니다.' });
  }
  const YOUTUBE_API_KEY = process.env.GOOGLE_API_KEY;
  if (!YOUTUBE_API_KEY) {
    return res.status(500).json({ success: false, message: '서버에 GOOGLE_API_KEY가 설정되어 있지 않습니다.' });
  }
  try {
    // 1. 영상/스냅샷을 항상 fetch API로 최신화
    const baseUrl = process.env.BACKEND_URL || 'http://localhost:8000';
    const fetchUrl = `${baseUrl}/api/channel/videos/fetch?channelId=${channelId}`;
    const fetchRes = await fetch(fetchUrl, { method: 'GET' });
    const fetchData = await fetchRes.json();
    if (!fetchData.success) {
      return res.status(500).json({ success: false, message: '영상 정보 수집 실패', error: fetchData.message });
    }

    // 2. DB 채널 PK 찾기
    const dbChannel = await prisma.channel.findFirst({ where: { youtube_channel_id: channelId } });
    if (!dbChannel) {
      return res.status(404).json({ success: false, message: 'DB에 해당 유튜브 채널이 없습니다.' });
    }

    // 3. 유튜브 API로 채널 정보 가져오기
    const channelInfoUrl = `https://www.googleapis.com/youtube/v3/channels?key=${YOUTUBE_API_KEY}&id=${channelId}&part=snippet,statistics`;
    const channelInfoResp = await fetch(channelInfoUrl);
    const channelInfoData = await channelInfoResp.json();
    const channelItem = channelInfoData.items?.[0];
    if (!channelItem) {
      return res.status(404).json({ success: false, message: '유튜브 API에서 채널 정보를 찾을 수 없습니다.' });
    }
    const stats = channelItem.statistics || {};
    const snippet = channelItem.snippet || {};
    // 4. 각 영상마다 스냅샷 최신화
    // 5. video/video_snapshot 테이블에서 통계 계산
    const total_videos = fetchData.count; // fetch API에서 반환된 총 영상 수
    let total_view = 0;
    let average_view = 0;
    if (total_videos > 0) {
      // 모든 영상의 최신 스냅샷 조회수 합산
      let viewSum = 0;
      for (const v of fetchData.data) { // fetch API에서 반환된 영상 목록
        const snap = await prisma.video_snapshot.findFirst({
          where: { video_id: v.videoId },
          orderBy: { created_at: 'desc' }
        });
        if (snap && snap.view_count) viewSum += snap.view_count;
      }
      total_view = viewSum;
      average_view = Math.round(viewSum / total_videos);
    }
    const today = new Date();
    const created = snippet.publishedAt ? new Date(snippet.publishedAt) : null;
    let daily_view = null;
    if (created && total_view > 0) {
      const days = Math.max(1, Math.ceil((today - created) / (1000 * 60 * 60 * 24)));
      daily_view = Math.round(total_view / days);
    }
    // 6. channel_snapshot 테이블에 저장
    const snapshot = await prisma.channel_snapshot.create({
      data: {
        channel_id: dbChannel.id,
        subscriber: stats.subscriberCount ? parseInt(stats.subscriberCount) : null,
        total_videos,
        total_view,
        channel_created: snippet.publishedAt ? new Date(snippet.publishedAt) : null,
        average_view,
        daily_view,
        nation: snippet.country || null,
      }
    });
    res.json({ success: true, data: snapshot });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: '채널 스냅샷 저장 중 오류', error: error.message });
  }
});

module.exports = router; 