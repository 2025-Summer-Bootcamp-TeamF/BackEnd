/*
  [Videos 관련 엔드포인트]
  POST   /api/videos/:video_id/comments/analysis   - 유튜브 댓글 분석 요청 (n8n 연동)
*/

const express = require('express');
const axios = require('axios');
const router = express.Router();

// 댓글 분석 API
router.post('/videos/:video_id/comments/analysis', async (req, res) => {
  const { video_id } = req.params;

  
  try {
    // n8n Webhook URL로 POST 요청
    const n8nRes = await axios.post('http://n8n:5678/webhook/comments-analysis', {
      video_id
    });

    // n8n에서 받은 결과를 그대로 반환
    res.status(200).json(n8nRes.data);
  } catch (error) {
    console.error('n8n 분석 요청 실패:', error.message);
    res.status(500).json({ error: '댓글 분석 실패' });
  }
});

module.exports = router; 