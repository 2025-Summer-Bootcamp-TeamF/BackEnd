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

// POST /api/others
router.post('/', authenticateToken, async (req, res) => {
  const { channelUrl } = req.body;
  const userId = req.user.id;
  if (!channelUrl) {
    return res.status(400).json({ success: false, message: '채널 링크가 필요합니다.' });
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
router.delete('/:channel_id', authenticateToken, async (req, res) => {
  const { channel_id } = req.params;
  const userId = req.user.id;
  try {
    const deleted = await prisma.other_channel.deleteMany({
      where: {
        user_id: userId,
        channel_id: parseInt(channel_id, 10)
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

module.exports = router;
