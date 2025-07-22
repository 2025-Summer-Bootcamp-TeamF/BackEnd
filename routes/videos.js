/*
  [Videos 관련 엔드포인트]
  POST   /api/videos/:video_id/comments/analysis   - 유튜브 댓글 분석 요청 (n8n 연동)
*/

const express = require('express');
const axios = require('axios');
const pool = require('../db');
const router = express.Router();

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

module.exports = router; 