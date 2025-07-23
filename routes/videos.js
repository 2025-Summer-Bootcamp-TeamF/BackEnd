/*
  [Videos 관련 엔드포인트]
  POST   /api/videos/:video_id/comments/analysis   - 유튜브 댓글 분석 요청 (n8n 연동)
*/

const express = require('express');
const axios = require('axios');
const pool = require('../db');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');

// 댓글 분석 API
router.post('/videos/:video_id/comments/analysis', async (req, res) => {
  const { video_id } = req.params;

  try {
    // n8n Webhook URL로 POST 요청
    const n8nRes = await axios.post('http://n8n:5678/webhook/comments-analysis', {
      video_id
    });

    // n8n에서 받은 결과의 summary 필드 또는 전체 결과를 JSON 문자열로 저장
    const summary = n8nRes.data.summary || JSON.stringify(n8nRes.data);

    // DB에 저장
    const insertQuery = `
      INSERT INTO "Comment_summary" (video_id, summary, created_at)
      VALUES ($1, $2, NOW())
      RETURNING *;
    `;
    const result = await pool.query(insertQuery, [video_id, summary]);

    // 저장된 결과를 클라이언트에 반환
    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('n8n 분석 요청/DB 저장 실패:', error.message);
    res.status(500).json({ error: '댓글 분석 저장 실패' });
  }
});

// 긍정적 댓글만 조회하는 API
router.get('/videos/:video_id/comments/positive', async (req, res) => {
  const { video_id } = req.params;
  try {
    const selectQuery = `
      SELECT * FROM "Comment"
      WHERE video_id = $1 AND sentiment = 'positive';
    `;
    const result = await pool.query(selectQuery, [video_id]);
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('긍정 댓글 조회 실패:', error.message);
    res.status(500).json({ error: '긍정 댓글 조회 실패' });
  }
});

// 부정적 댓글만 조회하는 API
router.get('/videos/:video_id/comments/negative', async (req, res) => {
  const { video_id } = req.params;
  try {
    const selectQuery = `
      SELECT * FROM "Comment"
      WHERE video_id = $1 AND sentiment = 'negative';
    `;
    const result = await pool.query(selectQuery, [video_id]);
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('부정 댓글 조회 실패:', error.message);
    res.status(500).json({ error: '부정 댓글 조회 실패' });
  }
});

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


module.exports = router; 