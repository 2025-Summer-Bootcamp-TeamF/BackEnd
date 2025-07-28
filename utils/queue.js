const { Queue, Worker } = require('bullmq');
const axios = require('axios');
const pool = require('../db');

// Redis 연결 설정
const connection = {
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379
};

// 병렬 처리 설정
const CONCURRENCY = 3; // 동시에 처리할 작업 수

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

// 작업 큐 생성
const videoQueue = new Queue('video-processing', { connection });

// 경쟁 채널 추가 작업 큐
const competitorQueue = new Queue('competitor-processing', { connection });

// n8n 워크플로우 작업 큐
const n8nQueue = new Queue('n8n-processing', { connection });

// n8n 작업을 병렬 처리할 Worker 생성 (동시에 3개 작업 처리)
const n8nWorker = new Worker('n8n-processing', async (job) => {
  console.log(`n8n 작업 처리 중: ${job.id}`);
  
  // 작업 데이터 가져오기
  const { videoId, jobType, data } = job.data;
  
  try {
    if (jobType === 'analysis') {
      // n8n Webhook URL로 POST 요청
      const n8nRes = await axios.post('http://n8n:5678/webhook/comments-analysis', {
        video_id: videoId
      });

      // n8n 응답 파싱
      let output = n8nRes.data.output;
      if (output === undefined) {
        output = n8nRes.data;
      }
      
      // output이 문자열인 경우 JSON으로 파싱
      let parsedOutput;
      if (typeof output === 'string') {
        try {
          parsedOutput = JSON.parse(output);
        } catch (e) {
          parsedOutput = { summary_title: "분석 결과", summary: JSON.stringify(output) };
        }
      } else {
        parsedOutput = output;
      }

      // summary_title 추출
      const summary_title = parsedOutput.summary_title || "분석 결과";
      
      // 전체 결과를 JSON 문자열로 저장 (기존 summary 필드)
      const summary = JSON.stringify(parsedOutput);

      // 긍정 비율 계산
      const positive_ratio = await calculatePositiveRatio(videoId, pool);

      // DB에 저장 (summary_title 추가)
      const insertQuery = `
        INSERT INTO "Comment_summary" (video_id, summary, summary_title, positive_ratio, created_at)
        VALUES ($1, $2, $3, $4, NOW())
        RETURNING *;
      `;
      const result = await pool.query(insertQuery, [videoId, summary, summary_title, positive_ratio]);

      console.log(`분석 완료: ${job.id}, video_id: ${videoId}, summary_title: ${summary_title}`);
      return { status: 'completed', videoId, jobType, data: result.rows[0] };
    }
    
    if (jobType === 'classify') {
      const { video_id, comment_classified_at, apiKey } = data;
      
      // 1. n8n에 classify 요청
      const n8nRes = await axios.post('http://n8n:5678/webhook/comments-classify', {
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
      
      // 5. 댓글 저장 후 Video 테이블의 comment_classified_at 업데이트 (저장된 댓글이 있을 때만)
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
      
      console.log(`분류 완료: ${job.id}, video_id: ${videoId}`);
      return { status: 'completed', videoId, jobType, data: results };
    }
    
    if (jobType === 'filter') {
      const { video_id, filtering_keyword } = data;
      
      // 1. Comment 테이블의 is_filtered를 모두 false로 초기화
      await pool.query(
        'UPDATE "Comment" SET is_filtered = false WHERE video_id = $1',
        [video_id]
      );
      console.log(`[DB] Comment.is_filtered 초기화 완료: video_id=${video_id}`);
      
      // 2. n8n에 필터링 요청
      const n8nRes = await axios.post('http://n8n:5678/webhook/comments-filtering', {
        video_id,
        filtering_keyword
      });
      console.log('[n8n filter response]', n8nRes.data);
      
      // 3. n8n 응답 파싱
      let output = n8nRes.data.output;
      if (output === undefined) {
        output = n8nRes.data;
      }
      
      const filteredComments = output.comments || output;
      const results = [];
      
      for (const c of filteredComments) {
        // c: { id, text, is_filtered }
        
        // 4. 기존 댓글인지 확인
        const existingComment = await pool.query(
          'SELECT youtube_comment_id FROM "Comment" WHERE youtube_comment_id = $1 AND video_id = $2',
          [c.id, video_id]
        );
        
        if (existingComment.rows.length > 0) {
          // 기존 댓글: is_filtered만 업데이트
          const isFiltered = c.is_filtered === 1;
          await pool.query(
            'UPDATE "Comment" SET is_filtered = $1 WHERE youtube_comment_id = $2 AND video_id = $3',
            [isFiltered, c.id, video_id]
          );
          console.log(`[DB] 기존 댓글 is_filtered 업데이트: id=${c.id}, is_filtered=${isFiltered}`);
        } else {
          // 새 댓글: YouTube API로 메타데이터 조회 후 insert
          const url = `https://www.googleapis.com/youtube/v3/comments?id=${c.id}&part=snippet&key=${process.env.GOOGLE_API_KEY}`;
          try {
            const ytRes = await axios.get(url);
            const item = ytRes.data.items[0]?.snippet;
            if (!item) {
              console.warn(`[YouTube API] 댓글 메타데이터 없음: id=${c.id}`);
              continue;
            }
            
            const insertQuery = `
              INSERT INTO "Comment" (
                youtube_comment_id, author_name, author_id, comment, comment_type, comment_date, is_parent, video_id, is_filtered, created_at, updated_at
              ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW())
              RETURNING *;
            `;
            const values = [
              c.id,
              item.authorDisplayName,
              item.authorChannelId?.value || null,
              c.text,
              0, // comment_type = 0 (무조건)
              item.publishedAt,
              !item.parentId,
              video_id,
              c.is_filtered === 1 // is_filtered
            ];
            
            const result = await pool.query(insertQuery, values);
            if (result.rows[0]) {
              console.log(`[DB] 새 댓글 저장 성공: id=${c.id}`);
              results.push(result.rows[0]);
            }
          } catch (err) {
            console.error(`[YouTube API] 댓글 메타데이터 조회 실패: id=${c.id}, error=${err.message}`);
          }
        }
      }
      
      console.log(`필터링 완료: ${job.id}, video_id: ${videoId}`);
      return { status: 'completed', videoId, jobType, data: results };
    }
    
    return { status: 'completed', videoId, jobType };
  } catch (error) {
    console.error(`작업 실패: ${job.id}`, error.message);
    throw error;
  }
}, { 
  connection,
  concurrency: CONCURRENCY  // 동시에 3개 작업 처리
});

module.exports = { 
  videoQueue, 
  competitorQueue, 
  n8nQueue,
  n8nWorker,
  connection 
}; 