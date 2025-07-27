/*
  [Videos 관련 엔드포인트]
  POST   /api/videos/:video_id/comments/analysis   - 유튜브 댓글 분석 요청 (n8n 연동)
  GET    /api/videos/:video_id/comments/summary    - 감정 요약 이력 전체 조회
  POST   /api/videos/:video_id/comments/classify   - 유튜브 댓글 분류 및 저장 (n8n 연동)
  GET    /api/videos/:video_id/comments/ratio      - 긍/부정 비율 그래프 데이터 조회
  DELETE /api/videos/:video_id/comments            - 여러 댓글 삭제 (YouTube 숨김 + DB 삭제)
  PUT    /api/videos/:video_id/comments            - 여러 댓글 comment_type 수정 (0,1→2 / 2→1)
*/

/**
 * @swagger
 * tags:
 *   name: Videos
 *   description: 영상 및 댓글 관련 API
 */

const express = require('express');
const axios = require('axios');
const pool = require('../db');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { saveVideoSnapshot } = require('../utils/videoSnapshot');
const { n8nQueue } = require('../utils/queue');
const { Job } = require('bullmq');

// 댓글 긍정 비율 계산 함수
async function calculatePositiveRatio(video_id, pool) {
  // comment_type: 1(긍정), 2(부정), 0(중립, 계산 제외)
  const result = await pool.query(
    'SELECT comment_type FROM "Comment" WHERE video_id = $1 AND is_filtered = false AND (comment_type = 1 OR comment_type = 2)',
    [video_id]
  );
  const comments = result.rows;
  if (comments.length === 0) return null;
  const positive = comments.filter(c => c.comment_type === 1).length;
  // 소수점 첫째자리까지 (예: 62.5)
  return Math.round((positive / comments.length) * 1000) / 10;
}

// 영상 썸네일 카테고리 분류 API (라우트 순서 문제 해결을 위해 상단으로 이동)
const { OpenAI } = require("openai");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

router.post('/videos/:video_id/classify_category', async (req, res) => {
  const { video_id } = req.params;
  // 썸네일 URL을 DB에서 가져오는 예시
  const videoRes = await pool.query('SELECT video_thumbnail_url, video_name FROM "Video" WHERE id = $1', [video_id]);
  const video = videoRes.rows[0];
  if (!video || !video.video_thumbnail_url) {
    return res.status(404).json({ success: false, message: '썸네일 없음' });
  }
  const thumbnailUrl = video.video_thumbnail_url;
  const videoTitle = video.video_name;

  // 프롬프트 예시
  const prompt = `
아래 영상의 썸네일 이미지와 영상 제목을 보고, 썸네일의 특징을 키워드(짧게)와 설명(짧게)로 분류해줘.
- 영상 제목: "${videoTitle}"
- 영상의 주제, 출연 인물 등은 카테고리에서 제외
- 카테고리는 키워드 형식(짧게)
- 예시: 인물포커스, 큰자막, 화려한색상 등
- 결과는 JSON 배열로
[
  { "category": "인물포커스", "desc": "인물이 화면 중앙에 큼직하게 배치됨" }
]
`;

  // OpenAI Vision API 호출
  const visionResponse = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: thumbnailUrl } }
        ]
      }
    ],
    max_tokens: 500
  });

  // Vision API 응답 콘솔 출력
  console.log('Vision API 응답:', visionResponse.choices[0].message.content);

  // 백틱/```json 제거 후 파싱
  let categories = [];
  let content = visionResponse.choices[0].message.content;
  if (content.startsWith("```json")) {
    content = content.replace(/^```json/, '').replace(/```$/, '').trim();
  } else if (content.startsWith("```")) {
    content = content.replace(/^```/, '').replace(/```$/, '').trim();
  }
  try {
    categories = JSON.parse(content);
  } catch (e) {
    categories = [];
  }

  for (const cat of categories) {
    // 1. Category 테이블에 이미 있는지 확인
    let categoryId;
    const catRes = await pool.query(
      'SELECT id FROM "Category" WHERE category = $1',
      [cat.category]
    );
    if (catRes.rows.length > 0) {
      categoryId = catRes.rows[0].id;
    } else {
      // 없으면 새로 추가
      const insertCat = await pool.query(
        'INSERT INTO "Category" (category) VALUES ($1) RETURNING id',
        [cat.category]
      );
      categoryId = insertCat.rows[0].id;
    }

    // 2. Video_category 테이블에 연결 (중복 방지)
    await pool.query(
      `INSERT INTO "Video_category" (category_id, video_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [categoryId, video_id]
    );
  }

  res.status(200).json({ success: true, categories });
});

/**
 * @swagger
 * /api/videos/{video_id}/comments/analysis:
 *   post:
 *     summary: 유튜브 댓글 분석 요청 (n8n 연동)
 *     tags: [Videos]
 *     parameters:
 *       - in: path
 *         name: video_id
 *         required: true
 *         schema:
 *           type: string
 *         description: 분석할 영상 ID
 *     responses:
 *       200:
 *         description: 분석 결과 저장 및 반환
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *       500:
 *         description: 댓글 분석 저장 실패
 */
// 댓글 분석 API
router.post('/videos/:video_id/comments/analysis', async (req, res) => {
  const { video_id } = req.params;

  try {
    // 작업을 큐에 추가
    const job = await n8nQueue.add('analysis', {
      videoId: video_id,
      jobType: 'analysis',
      data: { video_id }
    });

    // 즉시 job_id 반환
    res.status(200).json({ 
      success: true, 
      job_id: job.id,
      message: '분석 작업이 큐에 추가되었습니다. 상태 확인을 위해 job_id를 사용하세요.'
    });
  } catch (error) {
    console.error('큐 작업 추가 실패:', error.message);
    res.status(500).json({ error: '분석 작업 추가 실패' });
  }
});

/**
 * @swagger
 * /api/videos/{video_id}/comments/analysis/status/{job_id}:
 *   get:
 *     summary: 댓글 분석 작업 상태 확인
 *     tags: [Videos]
 *     parameters:
 *       - in: path
 *         name: video_id
 *         required: true
 *         schema:
 *           type: string
 *         description: 비디오 ID
 *       - in: path
 *         name: job_id
 *         required: true
 *         schema:
 *           type: string
 *         description: 작업 ID
 *     responses:
 *       200:
 *         description: 작업 상태 반환
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 status:
 *                   type: string
 *                   enum: [waiting, active, completed, failed]
 *                 job_id:
 *                   type: string
 *                 video_id:
 *                   type: string
 *       404:
 *         description: 작업을 찾을 수 없음
 *       500:
 *         description: 상태 확인 실패
 */
// 댓글 분석 작업 상태 확인 API
router.get('/videos/:video_id/comments/analysis/status/:job_id', async (req, res) => {
  const { video_id, job_id } = req.params;

  try {
    // 작업 상태 확인
    const job = await Job.fromId(n8nQueue, job_id);
    
    if (!job) {
      return res.status(404).json({ 
        success: false, 
        error: '작업을 찾을 수 없습니다.' 
      });
    }

    const jobState = await job.getState();
    
    res.status(200).json({
      success: true,
      status: jobState,
      job_id: job_id,
      video_id: video_id
    });
  } catch (error) {
    console.error('작업 상태 확인 실패:', error.message);
    res.status(500).json({ error: '작업 상태 확인 실패' });
  }
});

/**
 * @swagger
 * /api/videos/{video_id}/comments/positive:
 *   get:
 *     summary: 긍정 댓글 조회
 *     tags: [Videos]
 *     parameters:
 *       - in: path
 *         name: video_id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: 긍정 댓글 목록 반환
 *       500:
 *         description: 조회 실패
 */
// 긍정적 댓글만 조회하는 API
router.get('/videos/:video_id/comments/positive', async (req, res) => {
  const { video_id } = req.params;
  try {
    const selectQuery = `
      SELECT * FROM "Comment"
      WHERE video_id = $1 AND comment_type = 1;
    `;
    const result = await pool.query(selectQuery, [video_id]);
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('긍정 댓글 조회 실패:', error.message);
    res.status(500).json({ error: '긍정 댓글 조회 실패' });
  }
});

/**
 * @swagger
 * /api/videos/{video_id}/comments/negative:
 *   get:
 *     summary: 부정 댓글 조회
 *     tags: [Videos]
 *     parameters:
 *       - in: path
 *         name: video_id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: 부정 댓글 목록 반환
 *       500:
 *         description: 조회 실패
 */
// 부정적 댓글만 조회하는 API
router.get('/videos/:video_id/comments/negative', async (req, res) => {
  const { video_id } = req.params;
  try {
    const selectQuery = `
      SELECT * FROM "Comment"
      WHERE video_id = $1 AND comment_type = 2;
    `;
    const result = await pool.query(selectQuery, [video_id]);
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('부정 댓글 조회 실패:', error.message);
    res.status(500).json({ error: '부정 댓글 조회 실패' });
  }
});

/**
 * @swagger
 * /api/videos/watches:
 *   get:
 *     summary: 최근 5개 영상의 최신 스냅샷 조회
 *     tags: [Videos]
 *     parameters:
 *       - in: query
 *         name: channel_id
 *         required: true
 *         schema:
 *           type: string
 *         description: 채널 ID
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: 스냅샷 목록 반환
 *       400:
 *         description: 필수 파라미터 누락
 *       404:
 *         description: 채널 없음
 *       500:
 *         description: 서버 오류
 */

// 로그인한 사용자의 채널의 최근 5개 영상의 최신 스냅샷 정보 조회 API
router.get('/videos/watches', authenticateToken, async (req, res) => {
  const { channel_id } = req.query;
  if (!channel_id) {
    return res.status(400).json({ success: false, message: 'channel_id is required' });
  }
  try {
    // 유저의 채널 id 조회
    const channelQuery = `
      SELECT id FROM "Channel" WHERE id = $1 AND user_id = $2 AND is_deleted = false
    `;
    const channelResult = await pool.query(channelQuery, [channel_id, req.user.id]);
    if (channelResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'No channel found for this user' });
    }
    const channelId = channelResult.rows[0].id;
    // 최근 5개 영상 조회
    const videoQuery = `
      SELECT v.id, v.video_name, v.upload_date
      FROM "Video" v
      WHERE v.channel_id = $1 AND v.is_deleted = false
      ORDER BY v.created_at DESC
      LIMIT 5
    `;
    const videoResult = await pool.query(videoQuery, [channelId]);
    const videos = videoResult.rows;
    if (videos.length === 0) {
      return res.status(200).json({ success: true, data: [] });
    }
    // 각 영상별 최신 스냅샷 조회
    const snapshots = [];
    for (const video of videos) {
      const snapshotQuery = `
        SELECT view_count
        FROM "Video_snapshot"
        WHERE video_id = $1 AND is_deleted = false
        ORDER BY created_at DESC
        LIMIT 1
      `;
      const snapshotResult = await pool.query(snapshotQuery, [video.id]);
      const snapshot = snapshotResult.rows[0] || {};
      snapshots.push({
        videoId: video.id,
        title: video.video_name,
        viewCount: snapshot.view_count ?? 0,
        uploadDate: video.upload_date
      });
    }
    res.status(200).json({ success: true, data: snapshots });
  } catch (error) {
    console.error('영상별 조회수/스냅샷 조회 실패:', error.message);
    res.status(500).json({ error: '영상별 조회수/스냅샷 조회 실패' });
  }
});

/**
 * @swagger
 * /api/videos/likes:
 *   get:
 *     summary: 최근 5개 영상의 좋아요 참여율 조회
 *     tags: [Videos]
 *     parameters:
 *       - in: query
 *         name: channel_id
 *         required: true
 *         schema:
 *           type: string
 *         description: 채널 ID
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: 좋아요 통계 반환
 *       400:
 *         description: 필수 파라미터 누락
 *       404:
 *         description: 채널 없음
 *       500:
 *         description: 서버 오류
 */

// 영상별 좋아요 참여율 가져오기 API
router.get('/videos/likes', authenticateToken, async (req, res) => {
  const { channel_id } = req.query;
  if (!channel_id) {
    return res.status(400).json({ success: false, message: 'channel_id is required' });
  }
  try {
    // 유저의 채널 id 검사
    const channelQuery = `
      SELECT id FROM "Channel" WHERE id = $1 AND user_id = $2 AND is_deleted = false
    `;
    const channelResult = await pool.query(channelQuery, [channel_id, req.user.id]);
    if (channelResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'No channel found for this user' });
    }
    // 최근 5개 영상 조회
    const videoQuery = `
      SELECT v.id, v.video_name, v.upload_date
      FROM "Video" v
      WHERE v.channel_id = $1 AND v.is_deleted = false
      ORDER BY v.created_at DESC
      LIMIT 5
    `;
    const videoResult = await pool.query(videoQuery, [channel_id]);
    const videos = videoResult.rows;
    if (videos.length === 0) {
      return res.status(200).json({ success: true, data: [] });
    }
    // 각 영상별 최신 스냅샷에서 좋아요, 조회수, 댓글수, 참여율 계산
    const results = [];
    for (const video of videos) {
      const snapshotQuery = `
        SELECT like_count, view_count, comment_count
        FROM "Video_snapshot"
        WHERE video_id = $1 AND is_deleted = false
        ORDER BY created_at DESC
        LIMIT 1
      `;
      const snapshotResult = await pool.query(snapshotQuery, [video.id]);
      const snapshot = snapshotResult.rows[0] || {};
      const likeCount = snapshot.like_count ?? 0;
      const viewCount = snapshot.view_count ?? 0;
      const commentCount = snapshot.comment_count ?? 0;
      // 좋아요 참여율 계산 (조회수 0이면 0%)
      const likeRate = viewCount > 0 ? ((likeCount / viewCount) * 100).toFixed(2) + '%' : '0.00%';
      results.push({
        videoId: video.id,
        title: video.video_name,
        likeCount,
        viewCount,
        commentCount,
        likeRate,
        uploadDate: video.upload_date
      });
    }
    res.status(200).json({ success: true, data: results });
  } catch (error) {
    console.error('영상별 좋아요 참여율 조회 실패:', error.message);
    res.status(500).json({ error: '영상별 좋아요 참여율 조회 실패' });
  }
});

/**
 * @swagger
 * /api/videos/comments:
 *   get:
 *     summary: 최근 5개 영상의 댓글 참여율 조회
 *     tags: [Videos]
 *     parameters:
 *       - in: query
 *         name: channel_id
 *         required: true
 *         schema:
 *           type: string
 *         description: 채널 ID
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: 댓글 참여율 반환
 *       400:
 *         description: 필수 파라미터 누락
 *       404:
 *         description: 채널 없음
 *       500:
 *         description: 서버 오류
 */
// 영상별 댓글 참여율 가져오기 API
router.get('/videos/comments', authenticateToken, async (req, res) => {
  const { channel_id } = req.query;
  if (!channel_id) {
    return res.status(400).json({ success: false, message: 'channel_id is required' });
  }
  try {
    // 유저의 채널 id 검사
    const channelQuery = `
      SELECT id FROM "Channel" WHERE id = $1 AND user_id = $2 AND is_deleted = false
    `;
    const channelResult = await pool.query(channelQuery, [channel_id, req.user.id]);
    if (channelResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'No channel found for this user' });
    }
    // 최근 5개 영상 조회
    const videoQuery = `
      SELECT v.id, v.video_name, v.upload_date
      FROM "Video" v
      WHERE v.channel_id = $1 AND v.is_deleted = false
      ORDER BY v.created_at DESC
      LIMIT 5
    `;
    const videoResult = await pool.query(videoQuery, [channel_id]);
    const videos = videoResult.rows;
    if (videos.length === 0) {
      return res.status(200).json({ success: true, data: [] });
    }
    // 각 영상별 최신 스냅샷에서 댓글수, 조회수, 참여율 계산
    const results = [];
    for (const video of videos) {
      const snapshotQuery = `
        SELECT comment_count, view_count
        FROM "Video_snapshot"
        WHERE video_id = $1 AND is_deleted = false
        ORDER BY created_at DESC
        LIMIT 1
      `;
      const snapshotResult = await pool.query(snapshotQuery, [video.id]);
      const snapshot = snapshotResult.rows[0] || {};
      const commentCount = snapshot.comment_count ?? 0;
      const viewCount = snapshot.view_count ?? 0;
      // 댓글 참여율 계산 (조회수 0이면 0%)
      const commentRate = viewCount > 0 ? ((commentCount / viewCount) * 100).toFixed(2) + '%' : '0.00%';
      results.push({
        videoId: video.id,
        title: video.video_name,
        commentCount,
        viewCount,
        commentRate,
        uploadDate: video.upload_date
      });
    }
    res.status(200).json({ success: true, data: results });
  } catch (error) {
    console.error('영상별 댓글 참여율 조회 실패:', error.message);
    res.status(500).json({ error: '영상별 댓글 참여율 조회 실패' });
  }
});

/**
 * @swagger
 * /api/videos/{video_id}/comments/summary:
 *   get:
 *     summary: 감정 요약 이력 전체 조회
 *     tags: [Videos]
 *     parameters:
 *       - in: path
 *         name: video_id
 *         required: true
 *         schema:
 *           type: string
 *         description: 영상 ID
 *     responses:
 *       200:
 *         description: 감정 요약 이력 반환
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
 *       500:
 *         description: 감정 요약 이력 조회 실패
 */
// 감정 요약 이력 전체 조회 API
router.get('/videos/:video_id/comments/summary', async (req, res) => {
  const { video_id } = req.params;
  try {
    const result = await pool.query(
      'SELECT * FROM "Comment_summary" WHERE video_id = $1 AND is_deleted = false ORDER BY created_at DESC',
      [video_id]
    );
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('감정 요약 이력 조회 실패:', error.message);
    res.status(500).json({ error: '감정 요약 이력 조회 실패' });
  }
});

/**
 * @swagger
 * /api/videos/{video_id}/comments/classify:
 *   post:
 *     summary: 유튜브 댓글 분류 및 저장 (n8n 연동)
 *     tags: [Videos]
 *     parameters:
 *       - in: path
 *         name: video_id
 *         required: true
 *         schema:
 *           type: string
 *         description: 영상 ID
 *     responses:
 *       200:
 *         description: 댓글 분류 및 저장 결과 반환
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
 *       500:
 *         description: 댓글 분류 저장 실패
 */
// 댓글 분류 및 저장 API (큐 방식)
router.post('/videos/:video_id/comments/classify', async (req, res) => {
  const { video_id } = req.params;
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'YouTube API KEY가 설정되어 있지 않습니다.' });
  }
  try {
    // 1. DB에서 기존 comment_classified_at 값 조회
    const videoResult = await pool.query(
      'SELECT comment_classified_at FROM "Video" WHERE id = $1',
      [video_id]
    );
    const comment_classified_at = videoResult.rows[0]?.comment_classified_at;

    // 2. 큐에 작업 추가
    const job = await n8nQueue.add('classify', {
      videoId: video_id,
      jobType: 'classify',
      data: { 
        video_id, 
        comment_classified_at,
        apiKey 
      }
    });

    res.status(200).json({
      success: true,
      job_id: job.id,
      message: '분류 작업이 큐에 추가되었습니다. 상태 확인을 위해 job_id를 사용하세요.'
    });
  } catch (error) {
    console.error('큐 작업 추가 실패:', error.message);
    res.status(500).json({ error: '분류 작업 추가 실패' });
  }
});

/**
 * @swagger
 * /api/videos/{video_id}/comments/classify/status/{job_id}:
 *   get:
 *     summary: 댓글 분류 작업 상태 확인
 *     tags: [Videos]
 *     parameters:
 *       - in: path
 *         name: video_id
 *         required: true
 *         schema:
 *           type: string
 *         description: 비디오 ID
 *       - in: path
 *         name: job_id
 *         required: true
 *         schema:
 *           type: string
 *         description: 작업 ID
 *     responses:
 *       200:
 *         description: 작업 상태 반환
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 status:
 *                   type: string
 *                   enum: [waiting, active, completed, failed]
 *                 job_id:
 *                   type: string
 *                 video_id:
 *                   type: string
 *       404:
 *         description: 작업을 찾을 수 없음
 *       500:
 *         description: 상태 확인 실패
 */
router.get('/videos/:video_id/comments/classify/status/:job_id', async (req, res) => {
  const { video_id, job_id } = req.params;
  try {
    const job = await Job.fromId(n8nQueue, job_id);
    if (!job) {
      return res.status(404).json({
        success: false,
        error: '작업을 찾을 수 없습니다.'
      });
    }
    const jobState = await job.getState();
    res.status(200).json({
      success: true,
      status: jobState,
      job_id: job_id,
      video_id: video_id
    });
  } catch (error) {
    console.error('작업 상태 확인 실패:', error.message);
    res.status(500).json({ error: '작업 상태 확인 실패' });
  }
});

/**
 * @swagger
 * /api/videos/{video_id}/comments/ratio:
 *   get:
 *     summary: 긍/부정 비율 그래프 데이터 조회
 *     tags: [Videos]
 *     parameters:
 *       - in: path
 *         name: video_id
 *         required: true
 *         schema:
 *           type: string
 *         description: 영상 ID
 *     responses:
 *       200:
 *         description: 긍/부정 비율 반환
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 positive_ratio:
 *                   type: number
 *       500:
 *         description: 긍/부정 비율 계산 실패
 */
// 긍/부정 비율 그래프 데이터 API
router.get('/videos/:video_id/comments/ratio', async (req, res) => {
  const { video_id } = req.params;
  try {
    const positive_ratio = await calculatePositiveRatio(video_id, pool);
    res.status(200).json({ success: true, positive_ratio });
  } catch (error) {
    res.status(500).json({ error: '긍/부정 비율 계산 실패' });
  }
});

/**
 * @swagger
 * /api/videos/{video_id}/snapshot:
 *   post:
 *     summary: 특정 영상의 스냅샷 저장
 *     tags: [Videos]
 *     parameters:
 *       - in: path
 *         name: video_id
 *         required: true
 *         schema:
 *           type: string
 *         description: 스냅샷을 저장할 영상 ID
 *     responses:
 *       200:
 *         description: 스냅샷 저장 성공
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *       500:
 *         description: 스냅샷 저장 실패
 */
router.post('/videos/:video_id/snapshot', async (req, res) => {
  const { video_id } = req.params;
  const YOUTUBE_API_KEY = process.env.GOOGLE_API_KEY || process.env.YOUTUBE_API_KEY;
  if (!YOUTUBE_API_KEY) {
    return res.status(500).json({ success: false, message: '서버에 YouTube API KEY가 설정되어 있지 않습니다.' });
  }
  try {
    const snapshot = await saveVideoSnapshot(video_id, YOUTUBE_API_KEY);
    res.status(200).json({ success: true, data: snapshot });
  } catch (error) {
    console.error('비디오 스냅샷 저장 실패:', error.message);
    res.status(500).json({ success: false, message: '비디오 스냅샷 저장 실패', error: error.message });
  }
});

/**
 * @swagger
 * /api/videos/{video_id}/comments:
 *   delete:
 *     summary: 여러 댓글 삭제 (YouTube 숨김 + DB 삭제)
 *     tags: [Videos]
 *     parameters:
 *       - in: path
 *         name: video_id
 *         required: true
 *         schema:
 *           type: string
 *         description: 영상 ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               comment_ids:
 *                 type: array
 *                 items:
 *                   type: string
 *               youtube_access_token:
 *                 type: string
 *     responses:
 *       200:
 *         description: 삭제 결과 반환
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 youtubeDeleted:
 *                   type: integer
 *                 dbDeleted:
 *                   type: integer
 *                 errors:
 *                   type: array
 *                   items:
 *                     type: object
 *       400:
 *         description: 잘못된 요청
 */
// 여러 댓글 삭제 (DB + YouTube)
router.delete('/videos/:video_id/comments', async (req, res) => {
  const { video_id } = req.params;
  const { comment_ids, youtube_access_token } = req.body;

  if (!Array.isArray(comment_ids) || comment_ids.length === 0) {
    return res.status(400).json({ error: '삭제할 댓글 ID가 필요합니다.' });
  }
  if (!youtube_access_token) {
    return res.status(400).json({ error: 'YouTube access token이 필요합니다.' });
  }

  let dbDeleted = 0;
  let youtubeDeleted = 0;
  let errors = [];

  for (const commentId of comment_ids) {
    // 1. YouTube API로 숨김(거부) 처리
    try {
      await axios.post(
        `https://www.googleapis.com/youtube/v3/comments/setModerationStatus`,
        null, // POST body 없음
        {
          params: {
            id: commentId,
            moderationStatus: 'rejected',
          },
          headers: {
            Authorization: `Bearer ${youtube_access_token}`,
          },
        }
      );
      youtubeDeleted++;
    } catch (err) {
      errors.push({ commentId, error: 'YouTube 숨김(거부) 실패', detail: err.response?.data || err.message });
      continue; // 유튜브 숨김 실패 시 DB도 삭제하지 않음
    }

    // 2. DB에서 hard delete
    try {
      await pool.query(
        `DELETE FROM "Comment" WHERE video_id = $1 AND youtube_comment_id = $2`,
        [video_id, commentId]
      );
      dbDeleted++;
    } catch (err) {
      errors.push({ commentId, error: 'DB 삭제 실패', detail: err.message });
    }
  }

  res.status(200).json({
    success: true,
    youtubeDeleted,
    dbDeleted,
    errors,
  });
});

/**
 * @swagger
 * /api/videos/{video_id}/comments:
 *   put:
 *     summary: 여러 댓글 comment_type 수정 (0,1→2 / 2→1)
 *     tags: [Videos]
 *     parameters:
 *       - in: path
 *         name: video_id
 *         required: true
 *         schema:
 *           type: string
 *         description: 영상 ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               comment_ids:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: 수정 결과 반환
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 updated:
 *                   type: integer
 *                 errors:
 *                   type: array
 *                   items:
 *                     type: object
 *       400:
 *         description: 잘못된 요청
 */
// 여러 댓글 comment_type 수정
router.put('/videos/:video_id/comments', async (req, res) => {
  const { video_id } = req.params;
  const { comment_ids } = req.body;

  if (!Array.isArray(comment_ids) || comment_ids.length === 0) {
    return res.status(400).json({ error: '수정할 댓글 ID가 필요합니다.' });
  }

  let updated = 0;
  let errors = [];

  for (const commentId of comment_ids) {
    try {
      // 1. 댓글 유효성 검사 (해당 영상에 존재하는지)
      const check = await pool.query(
        'SELECT comment_type FROM "Comment" WHERE video_id = $1 AND youtube_comment_id = $2',
        [video_id, commentId]
      );
      if (check.rows.length === 0) {
        errors.push({ commentId, error: '댓글이 존재하지 않음' });
        continue;
      }
      const currentType = check.rows[0].comment_type;
      let newType;
      if (currentType === 0 || currentType === 1) {
        newType = 2;
      } else if (currentType === 2) {
        newType = 1;
      } else {
        errors.push({ commentId, error: '알 수 없는 comment_type' });
        continue;
      }
      // 2. comment_type 업데이트
      await pool.query(
        'UPDATE "Comment" SET comment_type = $1 WHERE video_id = $2 AND youtube_comment_id = $3',
        [newType, video_id, commentId]
      );
      updated++;
    } catch (err) {
      errors.push({ commentId, error: 'DB 수정 실패', detail: err.message });
    }
  }

  res.status(200).json({
    success: true,
    updated,
    errors,
  });
});


module.exports = router; 