/**
 * @swagger
 * tags:
 *   name: Others
 *   description: 경쟁 채널 관리 API
 */

const express = require('express');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');

// 유튜브 채널 URL에서 채널ID 추출 함수
function extractChannelId(url) {
  // /channel/UCxxxx
  const channelMatch = url.match(/youtube\.com\/channel\/([\w-]+)/);
  if (channelMatch) return channelMatch[1];
  // /@닉네임 → 유튜브 API로 변환 필요
  const handleMatch = url.match(/youtube\.com\/@([\w-]+)/);
  if (handleMatch) return handleMatch[1]; // 이 경우 API로 변환 필요
  return null;
}

// 공통 함수: 최근 3개 영상 조회수 및 변화율 계산
async function getIndividualViews(channelId) {
  // 1. Video 테이블에서 해당 채널의 영상 3개를 최신순으로 가져온다 (upload_date 기준)
  const videos = await prisma.video.findMany({
    where: { channel_id: channelId },
    orderBy: { upload_date: 'desc' },
    take: 3
  });

  // 2. 각 영상의 id로 video_snapshot에서 최신 view_count를 가져온다
  const individualViews = await Promise.all(
    videos.map(async (video) => {
      const snapshot = await prisma.video_snapshot.findFirst({
        where: { video_id: video.id },
        orderBy: { created_at: 'desc' }
      });
      return { views: snapshot?.view_count || 0 };
    })
  );

  // 3. 변화율 계산 (최신은 0, 최신-1은 최신 대비, 최신-2는 최신-1 대비)
  const result = individualViews.map((item, idx, arr) => {
    let rate = 0;
    if (idx < arr.length - 1) {
      const nextViews = arr[idx + 1].views;
      rate = nextViews > 0 ? ((item.views - nextViews) / nextViews) * 100 : 0;
    }
    return { views: item.views, rate };
  });

  // 디버깅 로그
  console.log(`Channel ${channelId} individual views:`, result);
  return result;
}

// 공통 함수: 최근 3개 영상 정보 조회
async function getLatestVideos(channelDbId) {
  const videos = await prisma.video.findMany({
    where: { channel_id: channelDbId },
    orderBy: { upload_date: 'desc' },
    take: 3
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
      uploadDate: video.upload_date,
      views: snapshot?.view_count ?? null,
      likes: snapshot?.like_count ?? null,
      dislikes: snapshot?.dislike_count ?? null
    });
  }
  return result;
}

// 공통 함수: 최근 5주간 주차별 업로드 개수
async function getWeeklyUploads(channelDbId) {
  const now = new Date();
  const weeks = [];
  for (let i = 0; i < 5; i++) {
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - now.getDay() - 7 * i); // 이번주 일요일 기준
    weekStart.setHours(0,0,0,0);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 7);
    const count = await prisma.video.count({
      where: {
        channel_id: channelDbId,
        upload_date: {
          gte: weekStart,
          lt: weekEnd
        }
      }
    });
    weeks.unshift({ week: weekStart.toISOString().slice(0,10), count });
  }
  return weeks;
}

/**
 * @swagger
 * /api/others:
 *   post:
 *     summary: 경쟁 채널 등록
 *     description: 유튜브 채널 URL을 입력받아 경쟁 채널로 등록합니다. 새 채널인 경우 자동으로 채널 정보와 영상 데이터를 저장합니다.
 *     tags: [Others]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - channelUrl
 *             properties:
 *               channelUrl:
 *                 type: string
 *                 description: "유튜브 채널 URL (예: https://www.youtube.com/channel/UCxxxx 또는 https://www.youtube.com/@닉네임)"
 *                 example: "https://www.youtube.com/channel/UC123456789"
 *     responses:
 *       200:
 *         description: 경쟁 채널 등록 성공
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     channel_id:
 *                       type: integer
 *                       description: DB 채널 ID
 *                       example: 1
 *                     youtube_channel_id:
 *                       type: string
 *                       description: 유튜브 채널 ID
 *                       example: "UC123456789"
 *       400:
 *         description: 잘못된 요청
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
 *                   example: "채널 링크가 필요합니다."
 *       401:
 *         description: 인증 실패
 *       404:
 *         description: 채널을 찾을 수 없음
 *       500:
 *         description: 서버 오류
 */
// POST /api/others
router.post('/', authenticateToken, async (req, res) => {
  const { channelUrl } = req.body;
  const userId = req.user.id;
  if (!channelUrl) {
    return res.status(400).json({ success: false, message: '채널 링크가 필요합니다.' });
  }

  // 현재 등록된 경쟁 채널 개수 확인
  const currentCompetitorsCount = await prisma.other_channel.count({
    where: { user_id: userId }
  });

  if (currentCompetitorsCount >= 2) {
    return res.status(400).json({ 
      success: false, 
      message: '더이상 경쟁 채널을 등록할 수 없습니다. (최대 2개)' 
    });
  }

  let channelId = extractChannelId(channelUrl);
  if (!channelId) {
    return res.status(400).json({ success: false, message: '유효한 유튜브 채널 링크가 아닙니다.' });
  }

  // @닉네임 형태면 유튜브 API로 채널ID 변환
  if (!channelId.startsWith('UC')) {
    // 유튜브 API로 handle → channelId 변환
    const YOUTUBE_API_KEY = process.env.GOOGLE_API_KEY;
    const url = `https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${channelId}&key=${YOUTUBE_API_KEY}`;
    const resp = await fetch(url);
    const data = await resp.json();
    channelId = data.items?.[0]?.id;
    if (!channelId) {
      return res.status(404).json({ success: false, message: '유튜브 API에서 채널 ID를 찾을 수 없습니다.' });
    }
  }

  // Channel 테이블에 있는지 확인
  let channel = await prisma.channel.findFirst({ where: { youtube_channel_id: channelId } });
  let isNewChannel = false;
  if (!channel) {
    // 유튜브 API로 채널 정보 가져와서 insert
    const YOUTUBE_API_KEY = process.env.GOOGLE_API_KEY;
    const infoUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet&id=${channelId}&key=${YOUTUBE_API_KEY}`;
    const resp = await fetch(infoUrl);
    const data = await resp.json();
    const snippet = data.items?.[0]?.snippet;
    if (!snippet) {
      return res.status(404).json({ success: false, message: '유튜브 API에서 채널 정보를 찾을 수 없습니다.' });
    }
    channel = await prisma.channel.create({
      data: {
        user_id: null,
        channel_name: snippet.title,
        profile_image_url: snippet.thumbnails?.high?.url || null,
        channel_intro: snippet.description,
        youtube_channel_id: channelId,
      }
    });
    isNewChannel = true;
  }

  // 자기 자신의 채널인지 확인
  const myChannel = await prisma.channel.findFirst({
    where: {
      user_id: userId,
      youtube_channel_id: channelId
    }
  });
  if (myChannel) {
    return res.status(400).json({ success: false, message: '자기 자신의 채널은 경쟁 채널로 등록할 수 없습니다.' });
  }

  // 처음 등록된 채널이면 영상/스냅샷도 저장 (내부적으로 fetch 호출)
  if (isNewChannel) {
    try {
      const baseUrl = process.env.BACKEND_URL || 'http://localhost:8000';
      const fetchUrl = `${baseUrl}/api/channel/videos/fetch?channelId=${channelId}`;
      await fetch(fetchUrl, { method: 'GET' });
    } catch (e) {
      // 실패해도 경쟁채널 등록은 계속 진행
      console.error('경쟁채널 영상 fetch 실패:', e.message);
    }
  }

  // Other_channel 테이블에 등록 (중복 방지)
  try {
    await prisma.other_channel.create({
      data: {
        user_id: userId,
        channel_id: channel.id,
      }
    });
  } catch (e) {
    // 이미 등록된 경우 unique 에러 무시
    return res.status(200).json({ success: true, message: '이미 등록된 경쟁 채널입니다.' });
  }

  res.json({ success: true, data: { channel_id: channel.id, youtube_channel_id: channelId } });
});

/**
 * @swagger
 * /api/others/{channel_id}:
 *   delete:
 *     summary: 경쟁 채널 등록 해제
 *     tags: [Others]
 *     parameters:
 *       - in: path
 *         name: channel_id
 *         required: true
 *         schema:
 *           type: integer
 *         description: 경쟁 채널의 DB PK (Channel 테이블의 id)
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: 경쟁 채널 등록 해제 성공
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *       404:
 *         description: 해당 경쟁 채널 등록 없음
 *       500:
 *         description: 서버 오류
 */
router.delete('/:other_channel_id', authenticateToken, async (req, res) => {
  const { other_channel_id } = req.params;
  const userId = req.user.id;
  try {
    const deleted = await prisma.other_channel.deleteMany({
      where: {
        id: parseInt(other_channel_id, 10),
        user_id: userId
      }
    });
    if (deleted.count === 0) {
      return res.status(404).json({ success: false, message: '해당 경쟁 채널 등록이 없습니다.' });
    }
    res.json({ success: true });
  } catch (error) {
    console.error('경쟁 채널 등록 해제 실패:', error.message);
    res.status(500).json({ success: false, message: '경쟁 채널 등록 해제 실패', error: error.message });
  }
});

/**
 * @swagger
 * /api/others:
 *   get:
 *     summary: 등록된 경쟁 채널 목록 조회
 *     description: 현재 사용자가 등록한 경쟁 채널들의 목록을 조회합니다.
 *     tags: [Others]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: 경쟁 채널 목록 조회 성공
 *       401:
 *         description: 인증 실패
 *       500:
 *         description: 서버 오류
 */
router.get('/', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  
  try {
    const competitors = await prisma.other_channel.findMany({
      where: { user_id: userId },
      include: {
        Channel: {
          select: {
            id: true,
            channel_name: true,
            youtube_channel_id: true
          }
        }
      }
    });

    const formattedData = competitors.map(comp => ({
      id: comp.id,
      channel_id: comp.channel_id,
      channel_name: comp.Channel.channel_name,
      youtube_channel_id: comp.Channel.youtube_channel_id
    }));

    res.json({ success: true, data: formattedData });
  } catch (error) {
    console.error('경쟁 채널 목록 조회 실패:', error.message);
    res.status(500).json({ success: false, message: '경쟁 채널 목록 조회 실패', error: error.message });
  }
});

/**
 * @swagger
 * /api/others/videos/views:
 *   get:
 *     summary: 경쟁 채널들의 최근 3개 영상 조회수 합계 조회
 *     description: 내 채널과 등록된 경쟁 채널들의 최근 3개 영상 조회수 합계를 조회합니다.
 *     tags: [Others]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: 조회수 합계 조회 성공
 *       404:
 *         description: 내 채널 정보 없음
 *       500:
 *         description: 서버 오류
 */
router.get('/videos/views', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  
  try {
    // 내 채널 정보
    const myChannel = await prisma.channel.findFirst({ 
      where: { user_id: userId },
      select: { id: true, channel_name: true }
    });
    
    if (!myChannel) {
      return res.status(404).json({ success: false, message: '내 채널 정보가 없습니다.' });
    }

    // 내 채널의 최근 3개 영상 개별 조회수 (created_at 기준)
    const myIndividualViews = await getIndividualViews(myChannel.id);

    const myTotalViews = myIndividualViews.reduce((sum, item) => sum + item.views, 0);

    // 등록된 경쟁 채널들 조회
    const competitors = await prisma.other_channel.findMany({
      where: { user_id: userId },
      include: {
        Channel: {
          select: { id: true, channel_name: true }
        }
      }
    });

    // 각 경쟁 채널의 최근 3개 영상 개별 조회수 (created_at 기준)
    const competitorViews = await Promise.all(
      competitors.map(async (comp) => {
        const individualViews = await getIndividualViews(comp.Channel.id);
        const totalViews = individualViews.reduce((sum, item) => sum + item.views, 0);

        return {
          channel_id: comp.Channel.id,
          channel_name: comp.Channel.channel_name,
          totalViews: totalViews,
          individualViews: individualViews
        };
      })
    );

    res.json({
      success: true,
      data: {
        myChannel: {
          channel_id: myChannel.id,
          channel_name: myChannel.channel_name,
          totalViews: myTotalViews,
          individualViews: myIndividualViews
        },
        competitors: competitorViews
      }
    });
  } catch (error) {
    console.error('조회수 합계 조회 실패:', error.message);
    res.status(500).json({ success: false, message: '조회수 합계 조회 실패', error: error.message });
  }
});

/**
 * @swagger
 * /api/others/videos/compare:
 *   get:
 *     summary: 내 채널과 등록된 경쟁 채널들의 최근 3개 영상 및 5주간 업로드 비교
 *     tags: [Others]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: 비교 데이터 반환 (경쟁 채널이 없으면 내 채널만 반환)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *       404:
 *         description: 내 채널 정보 없음
 *       500:
 *         description: 서버 오류
 */
router.get('/videos/compare', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    // 내 채널 정보
    const myChannel = await prisma.channel.findFirst({ where: { user_id: userId } });
    if (!myChannel) {
      return res.status(404).json({ success: false, message: '내 채널 정보가 없습니다.' });
    }
    
    // 내가 등록한 경쟁 채널들 조회
    const myCompetitors = await prisma.other_channel.findMany({
      where: { user_id: userId },
      include: {
        Channel: true
      }
    });
    
    // 최근 3개 영상 + 동적 데이터 (조회수, 좋아요, 싫어요)
    const myChannelData = {
      channelId: myChannel.id,
      channelName: myChannel.channel_name,
      latestVideos: await getLatestVideos(myChannel.id),
      weeklyUploads: await getWeeklyUploads(myChannel.id)
    };
    
    // 경쟁 채널이 없으면 내 채널만 반환
    if (myCompetitors.length === 0) {
      return res.json({
        success: true,
        data: {
          myChannel: myChannelData,
          competitors: []
        }
      });
    }
    
    // 경쟁 채널들 데이터 가져오기
    const competitorPromises = myCompetitors.map(async (competitor) => {
      return {
        channelId: competitor.Channel.id,
        channelName: competitor.Channel.channel_name,
        latestVideos: await getLatestVideos(competitor.Channel.id),
        weeklyUploads: await getWeeklyUploads(competitor.Channel.id)
      };
    });
    
    const competitors = await Promise.all(competitorPromises);
    
    res.json({
      success: true,
      data: {
        myChannel: myChannelData,
        competitors: competitors
      }
    });
  } catch (error) {
    console.error('채널 비교 분석 실패:', error.message);
    res.status(500).json({ success: false, message: '채널 비교 분석 실패', error: error.message });
  }
});

module.exports = router;
