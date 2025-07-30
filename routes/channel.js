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
        nation: snapshot.nation,
        daily_view: snapshot.daily_view,
        average_view: snapshot.average_view
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
// 구독자 변화 추이 반환 (최근 스냅샷들 조회)
router.get('/subscriber-change', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'No user id in token' });
    }
    
    // 계정 하나당 채널 한개 가정
    const channel = await prisma.channel.findFirst({ where: { user_id: userId } });
    if (!channel) {
      return res.status(404).json({ success: false, message: 'Channel not found' });
    }
    
    // 최근 6개의 스냅샷 조회 (구독자 데이터가 있는 것만)
    const snapshots = await prisma.channel_snapshot.findMany({
      where: {
        channel_id: channel.id,
        subscriber: {
          not: null
        }
      },
      orderBy: { created_at: 'desc' },
      take: 6
    });
    
    // 결과 데이터 생성
    const result = snapshots.map(snapshot => ({
      date: snapshot.created_at.toISOString().slice(0, 10),
      subscriber: snapshot.subscriber
    }));
    
    // 날짜순으로 정렬 (오래된 것부터)
    result.sort((a, b) => new Date(a.date) - new Date(b.date));
    
    console.log(`[DEBUG] 구독자 변화 데이터 조회: ${result.length}개 스냅샷`);
    
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
        videoId: video.id, // 이 값이 실제 YouTube video ID
        video_id: video.id, // YouTube video ID (video.id와 동일)
        title: video.video_name,
        thumbnail: video.video_thumbnail_url,
        upload_date: video.upload_date ? video.upload_date.toISOString().slice(0, 10) : null, // ← 반드시 포함
        video_link: video.video_link, // 유튜브 링크 추가
        viewCount: snapshot?.view_count ?? 0,
        commentRate: snapshot && snapshot.comment_count && snapshot.view_count ? (snapshot.comment_count / snapshot.view_count * 100).toFixed(3) + '%' : '0.000%',
        likeRate: snapshot && snapshot.like_count && snapshot.view_count ? (snapshot.like_count / snapshot.view_count * 100).toFixed(1) + '%' : '0.0%',
        commentCount: snapshot?.comment_count ?? 0,
        likeCount: snapshot?.like_count ?? 0,
        dislikeCount: snapshot?.dislike_count ?? 0,
        dislikeRate: snapshot && snapshot.dislike_count && snapshot.view_count ? (snapshot.dislike_count / snapshot.view_count * 100).toFixed(1) + '%' : '0.0%',
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
    
         // 탑5 카테고리별 통계 조회 (최신 스냅샷 기준)
     const categoryStats = await prisma.$queryRaw`
       WITH latest_snapshots AS (
         SELECT DISTINCT ON (video_id) 
           video_id, 
           view_count, 
           like_count
         FROM "Video_snapshot" 
         WHERE is_deleted = false
         ORDER BY video_id, created_at DESC
       ),
       category_video_counts AS (
         SELECT 
           c.id as category_id,
           c.category as category_name,
           COUNT(DISTINCT vc.video_id) as video_count
         FROM "Category" c
         JOIN "Video_category" vc ON c.id = vc.category_id
         JOIN "Video" v ON vc.video_id = v.id 
         WHERE v.channel_id = ${channel.id} AND v.is_deleted = false
         GROUP BY c.id, c.category
         ORDER BY video_count DESC
         LIMIT 5
       ),
       top_videos_per_category AS (
         SELECT DISTINCT ON (cvc.category_id)
           cvc.category_id,
           v.video_thumbnail_url as top_video_thumbnail
         FROM category_video_counts cvc
         JOIN "Video_category" vc ON cvc.category_id = vc.category_id
         JOIN "Video" v ON vc.video_id = v.id AND v.channel_id = ${channel.id} AND v.is_deleted = false
         LEFT JOIN latest_snapshots ls ON v.id = ls.video_id
         ORDER BY cvc.category_id, COALESCE(ls.view_count, 0) DESC
       )
       SELECT 
         cvc.category_id,
         cvc.category_name,
         cvc.video_count,
         COALESCE(SUM(ls.view_count), 0) as total_views,
         COALESCE(SUM(ls.like_count), 0) as total_likes,
         CASE 
           WHEN cvc.video_count > 0 
           THEN COALESCE(SUM(ls.view_count), 0)::float / cvc.video_count::float
           ELSE 0 
         END as average_views,
         tvpc.top_video_thumbnail
       FROM category_video_counts cvc
       JOIN "Video_category" vc ON cvc.category_id = vc.category_id
       JOIN "Video" v ON vc.video_id = v.id AND v.channel_id = ${channel.id} AND v.is_deleted = false
       LEFT JOIN latest_snapshots ls ON v.id = ls.video_id
       LEFT JOIN top_videos_per_category tvpc ON cvc.category_id = tvpc.category_id
       GROUP BY cvc.category_id, cvc.category_name, cvc.video_count, tvpc.top_video_thumbnail
       ORDER BY cvc.video_count DESC, total_views DESC
     `;
    
         // BigInt를 Number로 변환
     const processedStats = categoryStats.map(stat => ({
       category_id: Number(stat.category_id),
       category_name: stat.category_name,
       video_count: Number(stat.video_count),
       total_views: Number(stat.total_views),
       total_likes: Number(stat.total_likes),
       average_views: Number(stat.average_views),
       top_video_thumbnail: stat.top_video_thumbnail
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
    // 1. uploads playlistId 얻기 (롱폼)
    const channelInfoUrl = `https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id=${channelId}&key=${YOUTUBE_API_KEY}`;
    const channelInfoResp = await fetch(channelInfoUrl);
    const channelInfoData = await channelInfoResp.json();
    const uploadsPlaylistId = channelInfoData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsPlaylistId) {
      return res.status(404).json({ success: false, message: '업로드 재생목록(playlistId)을 찾을 수 없습니다.' });
    }

    // 1-2. 숏츠 재생목록Id(UUSH...) 생성
    const shortsPlaylistId = 'UUSH' + channelId.slice(2);

    // 1-3. 숏츠 videoId 목록 수집
    let shortsVideoIds = new Set();
    let shortsNextPageToken = '';
    do {
      const shortsUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${shortsPlaylistId}&maxResults=50&key=${YOUTUBE_API_KEY}${shortsNextPageToken ? `&pageToken=${shortsNextPageToken}` : ''}`;
      const shortsResp = await fetch(shortsUrl);
      const shortsData = await shortsResp.json();
      if (shortsData.items) {
        for (const item of shortsData.items) {
          const sId = item.snippet?.resourceId?.videoId;
          if (sId) shortsVideoIds.add(sId);
        }
      }
      shortsNextPageToken = shortsData.nextPageToken;
    } while (shortsNextPageToken);

    // 2. playlistItems API로 모든 영상 가져오기 (롱폼+숏츠)
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
        // 숏츠 videoId는 제외
        if (shortsVideoIds.has(videoId)) {
          console.log(`숏츠 영상 제외: ${videoId}`);
          continue;
        }
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


/**
 * @swagger
 * /api/channel/categories/{category_id}/videos:
 *   get:
 *     summary: 카테고리별 최신 동영상 5개 조회 (썸네일, 업로드 날짜, 제목, 조회수, 참여율 포함)
 *     tags: [Channel]
 *     parameters:
 *       - in: path
 *         name: category_id
 *         required: true
 *         schema:
 *           type: integer
 *         description: 카테고리 ID
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: 카테고리별 최신 동영상 목록 반환
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
 *                       id:
 *                         type: string
 *                       title:
 *                         type: string
 *                       thumbnail:
 *                         type: string
 *                       upload_date:
 *                         type: string
 *                       view_count:
 *                         type: integer
 *                       comment_participation_rate:
 *                         type: number
 *                       like_participation_rate:
 *                         type: number
 *       400:
 *         description: 잘못된 요청
 *       401:
 *         description: 인증 실패
 *       404:
 *         description: 카테고리 또는 채널 없음
 *       500:
 *         description: 서버 오류
 */
// 카테고리별 최신 동영상 5개 조회 API
router.get('/categories/:category_id/videos', authenticateToken, async (req, res) => {
  try {
    const { category_id } = req.params;
    const userId = req.user.id;
    
    if (!userId) {
      return res.status(401).json({ success: false, message: 'No user id in token' });
    }

    if (!category_id || isNaN(parseInt(category_id))) {
      return res.status(400).json({ success: false, message: 'Invalid category_id' });
    }

    // 유저의 채널 확인
    const channel = await prisma.channel.findFirst({ 
      where: { 
        user_id: userId,
        is_deleted: false 
      } 
    });
    
    if (!channel) {
      return res.status(404).json({ success: false, message: 'Channel not found' });
    }

    // 카테고리별 최신 동영상 5개 조회 (최신 스냅샷 기준)
    const videos = await prisma.$queryRaw`
      WITH latest_snapshots AS (
        SELECT DISTINCT ON (video_id) 
          video_id, 
          view_count, 
          like_count,
          comment_count
        FROM "Video_snapshot" 
        WHERE is_deleted = false
        ORDER BY video_id, created_at DESC
      )
      SELECT 
        v.id,
        v.video_name as title,
        v.video_thumbnail_url as thumbnail,
        v.upload_date,
        COALESCE(ls.view_count, 0) as view_count,
        COALESCE(ls.like_count, 0) as like_count,
        COALESCE(ls.comment_count, 0) as comment_count,
        CASE 
          WHEN COALESCE(ls.view_count, 0) > 0 
          THEN ROUND(((COALESCE(ls.comment_count, 0)::numeric / ls.view_count::numeric) * 100)::numeric, 3)
          ELSE 0 
        END as comment_participation_rate,
        CASE 
          WHEN COALESCE(ls.view_count, 0) > 0 
          THEN ROUND(((COALESCE(ls.like_count, 0)::numeric / ls.view_count::numeric) * 100)::numeric, 3)
          ELSE 0 
        END as like_participation_rate
      FROM "Video" v
      JOIN "Video_category" vc ON v.id = vc.video_id
      LEFT JOIN latest_snapshots ls ON v.id = ls.video_id
      WHERE vc.category_id = ${parseInt(category_id)} 
        AND v.channel_id = ${channel.id} 
        AND v.is_deleted = false
      ORDER BY v.upload_date DESC
      LIMIT 5
    `;

    // BigInt를 Number로 변환
    const processedVideos = videos.map(video => ({
      id: video.id,
      title: video.title,
      thumbnail: video.thumbnail,
      upload_date: video.upload_date ? 
        new Date(video.upload_date).toISOString().split('T')[0].replace(/-/g, '. ') : null,
      view_count: Number(video.view_count),
      comment_participation_rate: Number(video.comment_participation_rate),
      like_participation_rate: Number(video.like_participation_rate)
    }));

    res.json({ 
      success: true, 
      data: processedVideos 
    });

  } catch (error) {
    console.error('카테고리별 동영상 조회 실패:', error.message);
    res.status(500).json({ 
      success: false, 
      error: '카테고리별 동영상 조회 실패' 
    });
  }
});

module.exports = router; 