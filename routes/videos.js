/*
  [Videos 관련 엔드포인트]
  POST   /api/videos/:video_id/comments/analysis   - 유튜브 댓글 분석 요청 (n8n 연동)
  GET    /api/videos/:video_id/comments/summary    - 감정 요약 이력 전체 조회
  POST   /api/videos/:video_id/comments/classify   - 유튜브 댓글 분류 및 저장 (n8n 연동)
  GET    /api/videos/:video_id/comments/ratio      - 긍/부정 비율 그래프 데이터 조회
*/

const express = require('express');
const axios = require('axios');
const pool = require('../db');
const router = express.Router();

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

    // 긍정 비율 계산
    const positive_ratio = await calculatePositiveRatio(video_id, pool);

    // DB에 저장
    const insertQuery = `
      INSERT INTO "Comment_summary" (video_id, summary, positive_ratio, created_at)
      VALUES ($1, $2, $3, NOW())
      RETURNING *;
    `;
    const result = await pool.query(insertQuery, [video_id, summary, positive_ratio]);

    // 저장된 결과를 클라이언트에 반환
    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('n8n 분석 요청/DB 저장 실패:', error.message);
    res.status(500).json({ error: '댓글 분석 저장 실패' });
  }
});

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

// 댓글 분류 및 저장 API
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

    // 2. n8n에 전달
    const n8nRes = await axios.post('http://n8n:5678/webhook-test/comments-classify', {
      video_id,
      comment_classified_at
    });
    console.log('[n8n raw response]', n8nRes.data);

    // 2. n8n 응답 파싱
    let output = n8nRes.data.output;
    if (output === undefined) {
      output = n8nRes.data;
    }
    console.log('[n8n output]', output);

    const comments = output.comments || output; // output이 배열이면 그대로 사용
    const results = [];
    for (const c of comments) {
      // c: { id, text, comment_type }
      // 3. YouTube API로 댓글 메타데이터 조회
      const url = `https://www.googleapis.com/youtube/v3/comments?id=${c.id}&part=snippet&key=${apiKey}`;
      let meta;
      try {
        const ytRes = await axios.get(url);
        const item = ytRes.data.items[0]?.snippet;
        if (!item) {
          console.warn(`[YouTube API] 댓글 메타데이터 없음: id=${c.id}`);
          continue;
        }
        meta = {
          author_name: item.authorDisplayName,
          author_id: item.authorChannelId?.value || null,
          comment: c.text, // n8n에서 받은 text 사용
          comment_date: item.publishedAt,
          is_parent: !item.parentId, // parentId 없으면 최상위
        };
        console.log(`[YouTube API] 댓글 메타데이터 조회 성공: id=${c.id}`);
      } catch (err) {
        console.error(`[YouTube API] 댓글 메타데이터 조회 실패: id=${c.id}, error=${err.message}`);
        continue; // 해당 댓글 정보 못 가져오면 skip
      }
      // 4. DB 저장
      try {
        const insertQuery = `
          INSERT INTO "Comment" (
            youtube_comment_id, author_name, author_id, comment, comment_type, comment_date, is_parent, video_id, created_at, updated_at, is_filtered
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW(),false)
          ON CONFLICT (youtube_comment_id) DO UPDATE SET
            author_name = EXCLUDED.author_name,
            author_id = EXCLUDED.author_id,
            comment = EXCLUDED.comment,
            comment_type = EXCLUDED.comment_type,
            comment_date = EXCLUDED.comment_date,
            is_parent = EXCLUDED.is_parent,
            video_id = EXCLUDED.video_id,
            updated_at = NOW(),
            is_filtered = EXCLUDED.is_filtered
          RETURNING *;
        `;
        const values = [
          c.id,               // youtube_comment_id (문자열)
          meta.author_name,
          meta.author_id,
          meta.comment,
          c.comment_type, // 정수형 그대로 저장
          meta.comment_date,
          meta.is_parent,
          video_id
        ];
        const result = await pool.query(insertQuery, values);
        if (result.rows[0]) {
          console.log(`[DB] 댓글 저장 성공: id=${c.id}`);
          results.push(result.rows[0]);
        } else {
          console.warn(`[DB] 댓글 저장: 중복 또는 저장 안됨 (id=${c.id})`);
        }
      } catch (dbErr) {
        console.error(`[DB] 댓글 저장 실패: id=${c.id}, error=${dbErr.message}`);
      }
    }
    // 댓글 저장 후 Video 테이블의 comment_classified_at 업데이트 (저장된 댓글이 있을 때만)
    if (results.length > 0) {
      try {
        await pool.query(
          'UPDATE "Video" SET comment_classified_at = NOW() WHERE id = $1',
          [video_id]
        );
        console.log(`[DB] Video.comment_classified_at 업데이트 완료: video_id=${video_id}`);
      } catch (err) {
        console.error(`[DB] Video.comment_classified_at 업데이트 실패: video_id=${video_id}, error=${err.message}`);
      }
    } else {
      console.log(`[DB] 저장된 댓글이 없어 comment_classified_at을 업데이트하지 않음: video_id=${video_id}`);
    }
    res.status(200).json({ success: true, data: results });
  } catch (error) {
    console.error('[전체] 댓글 분류/저장 실패:', error.message, error);
    res.status(500).json({ error: '댓글 분류 저장 실패' });
  }
});

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

module.exports = router; 