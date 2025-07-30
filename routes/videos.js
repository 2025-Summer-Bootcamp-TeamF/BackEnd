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
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { saveVideoSnapshot } = require('../utils/videoSnapshot');
const { n8nQueue } = require('../utils/queue');
const { Job } = require('bullmq');

// 댓글 긍정 비율 계산 함수
async function calculatePositiveRatio(video_id, pool) {
  // comment_type: 1(긍정), 2(부정), 0(중립, 계산 제외)
  const result = await pool.query(
    'SELECT comment_type FROM "Comment" WHERE video_id = $1 AND (comment_type = 1 OR comment_type = 2)',
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

    // 2. Video_category 테이블에 연결 (ON CONFLICT 제거)
    await pool.query(
      `INSERT INTO "Video_category" (category_id, video_id, description)
       VALUES ($1, $2, $3)`,
      [categoryId, video_id, cat.desc || null]
    );
  }

  res.status(200).json({ success: true, categories });
});

// AI 썸네일 분류 API (프론트엔드용)
router.get('/videos/thumbnail-categories', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  
  console.log('[DEBUG] AI 분류 API 호출됨, userId:', userId);
  
  try {
    // 사용자의 채널 정보 가져오기
    const userChannel = await pool.query(
      'SELECT * FROM "Channel" WHERE user_id = $1',
      [userId]
    );

    console.log('[DEBUG] 채널 조회 결과:', userChannel.rows.length, '개');

    if (userChannel.rows.length === 0) {
      console.log('[DEBUG] 채널 정보 없음');
      return res.status(404).json({ 
        success: false, 
        message: '채널 정보를 찾을 수 없습니다.' 
      });
    }

    const channel = userChannel.rows[0];
    console.log('[DEBUG] 채널 ID:', channel.id);

    // 기존 카테고리 분류 결과가 있는지 확인 (해당 채널의 영상들만)
    const existingCategories = await prisma.video_category.findMany({
      where: {
        Video: {
          channel_id: channel.id
        }
      },
      include: {
        Category: true,
        Video: true
      }
    });

    console.log('[DEBUG] 기존 분류 결과 확인:', existingCategories.length, '개');
    console.log('[DEBUG] 채널 ID:', channel.id);
    if (existingCategories.length > 0) {
      console.log('[DEBUG] 기존 카테고리 샘플:', existingCategories.slice(0, 3).map(ec => ({
        categoryName: ec.Category.category,
        videoId: ec.Video.id,
        videoTitle: ec.Video.video_name,
        channelId: ec.Video.channel_id
      })));
    }

    // 기존 분류 결과가 있으면 DB에서 가져오기
    if (existingCategories.length > 0) {
      console.log('[DEBUG] 기존 분류 결과 사용 - AI 분류 건너뛰기');
      console.log('[DEBUG] 기존 카테고리 분류 결과 사용');
      
      // 카테고리별로 그룹화 (중복 제거)
      const categoryGroups = {};
      const processedVideos = new Set(); // 중복 방지를 위한 Set
      
      existingCategories.forEach(vc => {
        const categoryName = vc.Category.category;
        const videoId = vc.Video.id;
        
        // 이미 처리된 영상인지 확인
        if (processedVideos.has(videoId)) {
          return; // 중복 영상은 건너뛰기
        }
        
        if (!categoryGroups[categoryName]) {
          // DB에 저장된 AI 설명글 사용
          categoryGroups[categoryName] = {
            name: categoryName,
            description: vc.Category.description || `이 카테고리는 ${categoryName} 특성을 가진 영상들을 모아놓은 공간입니다.`,
            videos: [],
            videoCount: 0,
            averageViews: 0,
            averageLikes: 0
          };
        }
        
        categoryGroups[categoryName].videos.push({
          id: vc.Video.id,
          title: vc.Video.video_name,
          thumbnail_url: vc.Video.video_thumbnail_url,
          upload_date: vc.Video.upload_date,
          views: 0, // DB에서 가져와야 함
          likes: 0,
          dislikes: 0,
          comments: 0
        });
        
        processedVideos.add(videoId); // 처리된 영상 기록
      });

      // 통계 계산
      const categories = Object.values(categoryGroups);
      for (const category of categories) {
        category.videoCount = category.videos.length;
        
        // 영상들의 조회수, 좋아요 수 가져오기
        const videoIds = category.videos.map(v => v.id);
        const videoStats = await pool.query(`
          SELECT v.id, 
                 COALESCE(vs.view_count, 0) as view_count,
                 COALESCE(vs.like_count, 0) as like_count,
                 COALESCE(vs.comment_count, 0) as comment_count
          FROM "Video" v
          LEFT JOIN (
            SELECT DISTINCT ON (video_id) video_id, view_count, like_count, comment_count, created_at
            FROM "Video_snapshot"
            ORDER BY video_id, created_at DESC
          ) vs ON v.id = vs.video_id
          WHERE v.id = ANY($1)
        `, [videoIds]);

        // 통계 업데이트
        category.videos.forEach(video => {
          const stats = videoStats.rows.find(row => row.id === video.id);
          if (stats) {
            video.views = stats.view_count || 0;
            video.likes = stats.like_count || 0;
            video.comments = stats.comment_count || 0;
          }
        });

        // 평균 계산
        const totalViews = category.videos.reduce((sum, video) => sum + video.views, 0);
        const totalLikes = category.videos.reduce((sum, video) => sum + video.likes, 0);
        category.averageViews = category.videos.length > 0 ? Math.round(totalViews / category.videos.length) : 0;
        category.averageLikes = category.videos.length > 0 ? Math.round(totalLikes / category.videos.length) : 0;
      }

      // 평균 조회수 순으로 정렬
      categories.sort((a, b) => b.averageViews - a.averageViews);

      return res.json({
        success: true,
        data: categories
      });
    }

    // 기존 분류 결과가 없으면 AI 분류 실행
    console.log('[DEBUG] 새로운 카테고리 분류 실행 - 기존 결과 없음');

    // 사용자 채널의 모든 영상 가져오기
    const videos = await pool.query(`
      SELECT v.*, 
             COALESCE(vs.view_count, 0) as view_count,
             COALESCE(vs.like_count, 0) as like_count,
             COALESCE(vs.comment_count, 0) as comment_count
      FROM "Video" v
      LEFT JOIN (
        SELECT DISTINCT ON (video_id) video_id, view_count, like_count, comment_count, created_at
        FROM "Video_snapshot"
        ORDER BY video_id, created_at DESC
      ) vs ON v.id = vs.video_id
      WHERE v.channel_id = $1
      ORDER BY v.upload_date DESC
    `, [channel.id]);

    console.log('[DEBUG] 영상 조회 결과:', videos.rows.length, '개');

    if (videos.rows.length === 0) {
      console.log('[DEBUG] 분류할 영상 없음');
      return res.status(404).json({ 
        success: false, 
        message: '분류할 영상이 없습니다.' 
      });
    }

    // AI 분류를 위한 영상 데이터 준비 (id, title, thumbnail_url만, 모든 영상)
    const videoData = videos.rows.map(video => ({
      id: video.id,
      title: video.video_name,
      thumbnail_url: video.video_thumbnail_url
    }));

    // 프롬프트: 모든 영상을 한 번에 분류 요청 (한 영상은 반드시 하나의 카테고리에만 속해야 함)
    const prompt = `
다음 YouTube 영상들의 썸네일과 제목을 분석하여 카테고리로 분류해주세요.
**중요: 모든 영상은 반드시 하나의 카테고리에만 속해야 합니다.**

영상 데이터 (${videoData.length}개):
${JSON.stringify(videoData, null, 2)}

**분류 및 설명 요구사항:**
1. 실제 영상들의 썸네일과 제목을 자세히 분석하세요
2. 유사한 특징을 가진 영상들을 그룹으로 묶어서 카테고리를 만드세요
3. 각 카테고리의 이름은 해당 영상들의 실제 특징을 반영하여 적절하게 지어주세요
4. 각 카테고리의 설명글은 해당 카테고리에 속한 영상들의 실제 썸네일과 제목을 분석하여 작성하세요
5. 설명글은 60-100자 정도로 구체적이고 상세해야 합니다
6. 모든 ${videoData.length}개 영상을 반드시 카테고리에 할당하세요
7. 각 영상은 하나의 카테고리에만 속할 수 있습니다
8. 영상이 없는 카테고리는 응답에 포함하지 마세요

**카테고리 이름 작성 가이드:**
- 실제 영상들의 썸네일에서 관찰되는 시각적 특징을 바탕으로 이름을 지으세요
- 색상, 주제, 스타일, 분위기, 콘텐츠 유형 등을 반영한 구체적인 이름을 사용하세요
- 예시: "밝은 색상 게임", "자연 풍경 음악", "클로즈업 촬영", "어두운 테마 음악" 등

**설명글 작성 가이드:**
- 각 카테고리의 실제 영상들을 분석하여 고유한 특징을 발견하고, 이를 바탕으로 자연스럽고 구체적인 설명을 작성하세요
- 설명글은 다음과 같은 다양한 스타일로 작성하세요:
  * "이 영상들은 ~한 시각적 특징을 공유하며, ~한 주제나 분위기가 두드러집니다"
  * "주로 ~한 색상 팔레트와 ~한 구도를 사용하는 영상들로 구성되어 있습니다"
  * "~한 스타일의 썸네일이 특징이며, ~한 콘텐츠 유형이 주를 이룹니다"
  * "~한 배경과 ~한 요소들이 자주 등장하며, ~한 분위기를 연출합니다"
  * "~한 시각적 요소와 ~한 주제가 결합된 형태로, ~한 매력이 돋보입니다"
- 실제 영상들의 썸네일에서 관찰되는 구체적인 특징(색상, 구도, 배경, 주제, 스타일 등)을 분석하여 각 카테고리의 고유한 매력을 부각시키세요
- 각 카테고리마다 다른 관점에서 분석하여 다양성 있는 설명을 작성하세요
- 형식적인 문구나 반복적인 표현을 피하고, 각 카테고리의 실제 특징을 정확히 반영한 자연스러운 설명을 작성하세요
- 설명글은 60-100자 정도로 구체적이고 상세해야 합니다
- 실제 영상 제목들을 참고하여 해당 카테고리의 콘텐츠 특성을 정확히 파악하고 반영하세요

다음 JSON 형식으로 응답해주세요:
{
  "categories": [
    {
      "name": "실제 영상 특징을 반영한 카테고리 이름",
      "description": "해당 카테고리 영상들의 실제 특징을 분석한 구체적인 설명",
      "videos": [
        { "id": "video_id", "title": "video_title", "thumbnail_url": "url" }
      ]
    }
  ]
}

**중요: 유효한 JSON만 응답하고, 추가 텍스트는 포함하지 마세요.**
`;

    try {
      const gptResponse = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt }
            ]
          }
        ],
        max_tokens: 2000
      });

      let content = gptResponse.choices[0].message.content;
      console.log('[DEBUG] Vision API 원본 응답:', content);
      
      if (content.startsWith("```json")) {
        content = content.replace(/^```json/, '').replace(/```$/, '').trim();
      } else if (content.startsWith("```")) {
        content = content.replace(/^```/, '').replace(/```$/, '').trim();
      }
      console.log('[DEBUG] 정리된 응답:', content);
      
      let categories = [];
      try {
        const parsed = JSON.parse(content);
        categories = parsed.categories || [];
        console.log('[DEBUG] 파싱된 카테고리 개수:', categories.length);
      } catch (e) {
        console.log('[DEBUG] JSON 파싱 실패:', e.message);
        // fallback: 모든 영상을 하나의 카테고리로 묶어서 반환
        categories = [{
          name: "기본",
          description: "AI 분류 실패, 전체 영상",
          videos: videoData
        }];
        console.log('[DEBUG] fallback 카테고리 생성됨');
      }

      // 한 영상이 여러 카테고리에 중복 포함되지 않도록 필터링
      const assigned = new Set();
      categories.forEach(group => {
        group.videos = group.videos.filter(v => {
          if (assigned.has(v.id)) return false;
          assigned.add(v.id);
          return true;
        });
      });

      // 빈 카테고리 제거 및 통계 계산
      categories = categories.filter(group => group.videos.length > 0);
      
      // 모든 영상이 할당되었는지 검증 및 중복 제거
      const assignedVideos = new Set();
      const duplicateVideos = new Set();
      
      categories.forEach(group => {
        const categoryVideos = [];
        group.videos.forEach(video => {
          if (assignedVideos.has(video.id)) {
            duplicateVideos.add(video.id);
            console.log('[DEBUG] 중복 영상 발견:', video.id, video.title);
          } else {
            assignedVideos.add(video.id);
            categoryVideos.push(video);
          }
        });
        group.videos = categoryVideos; // 중복 제거된 영상 목록으로 교체
      });
      
      console.log('[DEBUG] 총 영상 개수:', videoData.length);
      console.log('[DEBUG] 할당된 영상 개수:', assignedVideos.size);
      console.log('[DEBUG] 중복 영상 개수:', duplicateVideos.size);
      console.log('[DEBUG] 할당되지 않은 영상:', videoData.filter(v => !assignedVideos.has(v.id)).map(v => v.id));
      
      // DB 데이터 확인
      console.log('[DEBUG] DB 영상 데이터 샘플:', videos.rows.slice(0, 3).map(v => ({
        id: v.id,
        title: v.video_name,
        view_count: v.view_count,
        like_count: v.like_count
      })));
      
      // DB 데이터와 AI 분류 결과 연결
      const dbVideosMap = new Map();
      videos.rows.forEach(video => {
        dbVideosMap.set(video.id, video);
      });
      
      categories.forEach(group => {
        // AI 분류된 영상들을 DB 데이터로 교체
        group.videos = group.videos.map(aiVideo => {
          const dbVideo = dbVideosMap.get(aiVideo.id);
          if (dbVideo) {
            return {
              id: dbVideo.id,
              title: dbVideo.video_name,
              thumbnail_url: dbVideo.video_thumbnail_url,
              upload_date: dbVideo.upload_date,
              views: dbVideo.view_count || 0,
              likes: dbVideo.like_count || 0,
              dislikes: dbVideo.dislikes || 0,
              comments: dbVideo.comment_count || 0
            };
          }
          return aiVideo; // DB에 없는 경우 AI 결과 사용
        });
        
        // AI가 생성한 원본 설명글 그대로 사용
        console.log('[DEBUG] AI 생성 설명글:', group.description);
        
        group.videoCount = group.videos.length;
        
        // 평균 조회수 계산
        const totalViews = group.videos.reduce((sum, video) => sum + (video.views || 0), 0);
        group.averageViews = group.videos.length > 0 ? Math.round(totalViews / group.videos.length) : 0;
        
        // 평균 좋아요 계산
        const totalLikes = group.videos.reduce((sum, video) => sum + (video.likes || 0), 0);
        group.averageLikes = group.videos.length > 0 ? Math.round(totalLikes / group.videos.length) : 0;
      });
      
      // 평균 조회수가 높은 순으로 카테고리 정렬
      categories.sort((a, b) => b.averageViews - a.averageViews);
      
      console.log('[DEBUG] 정렬된 카테고리:', categories.map(cat => ({
        name: cat.name,
        averageViews: cat.averageViews,
        videoCount: cat.videoCount
      })));

      // AI 분류 결과를 DB에 저장
      try {
        console.log('[DEBUG] 카테고리 분류 결과를 DB에 저장 중...');
        console.log('[DEBUG] 저장할 카테고리 개수:', categories.length);
        
        // 기존 분류 결과 삭제 (중복 방지)
        const videoIds = videos.rows.map(v => v.id);
        console.log('[DEBUG] 삭제할 영상 ID들:', videoIds);
        
        const deletedVideoCategories = await prisma.video_category.deleteMany({
          where: {
            video_id: {
              in: videoIds
            }
          }
        });
        console.log('[DEBUG] 삭제된 Video_category 개수:', deletedVideoCategories.count);
        
        for (const category of categories) {
          console.log('[DEBUG] 카테고리 저장 중:', category.name);
          
          // 카테고리 생성 또는 찾기
          let dbCategory = await prisma.category.findFirst({
            where: { category: category.name }
          });
          
          if (!dbCategory) {
            console.log('[DEBUG] 새 카테고리 생성:', category.name);
            dbCategory = await prisma.category.create({
              data: { 
                category: category.name,
                description: category.description
              }
            });
            console.log('[DEBUG] 생성된 카테고리 ID:', dbCategory.id);
          } else {
            console.log('[DEBUG] 기존 카테고리 업데이트:', category.name);
            // 기존 카테고리의 설명글 업데이트
            await prisma.category.update({
              where: { id: dbCategory.id },
              data: { description: category.description }
            });
          }
          
          // 영상들을 해당 카테고리에 연결 (중복 방지)
          console.log('[DEBUG] 영상 연결 중, 영상 개수:', category.videos.length);
          for (const video of category.videos) {
            // 이미 존재하는지 확인
            const existing = await prisma.video_category.findFirst({
              where: {
                video_id: video.id,
                category_id: dbCategory.id
              }
            });
            
            if (!existing) {
              console.log('[DEBUG] Video_category 생성:', video.id, '->', dbCategory.id);
              await prisma.video_category.create({
                data: {
                  category_id: dbCategory.id,
                  video_id: video.id
                }
              });
            } else {
              console.log('[DEBUG] Video_category 이미 존재:', video.id, '->', dbCategory.id);
            }
          }
        }
        
        console.log('[DEBUG] 카테고리 분류 결과 DB 저장 완료');
      } catch (dbError) {
        console.error('[DEBUG] DB 저장 실패:', dbError);
        console.error('[DEBUG] DB 저장 실패 상세:', dbError.message);
        // DB 저장 실패해도 결과는 반환
      }

      res.json({
        success: true,
        data: categories
      });
    } catch (error) {
      console.error('[DEBUG] 썸네일 분류 실패:', error);
      res.status(500).json({ 
        success: false, 
        message: '썸네일 분류 중 오류가 발생했습니다.',
        error: error.message 
      });
    }
    return;

  } catch (error) {
    console.error('[DEBUG] 썸네일 분류 실패:', error);
    res.status(500).json({ 
      success: false, 
      message: '썸네일 분류 중 오류가 발생했습니다.',
      error: error.message 
    });
  }
});

// 카테고리 분류 결과 초기화 API
router.post('/videos/clear-categories', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // 사용자의 채널 정보 가져오기
    const userChannel = await pool.query(
      'SELECT * FROM "Channel" WHERE user_id = $1',
      [userId]
    );

    if (userChannel.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: '채널 정보를 찾을 수 없습니다.' 
      });
    }

    const channel = userChannel.rows[0];
    
    // 해당 채널의 모든 영상에 대한 카테고리 분류 결과 삭제
    const videos = await pool.query(
      'SELECT id FROM "Video" WHERE channel_id = $1',
      [channel.id]
    );
    
    const videoIds = videos.rows.map(v => v.id);
    
    if (videoIds.length > 0) {
      // Video_category 테이블에서 해당 영상들의 분류 결과 삭제
      const deletedVideoCategories = await prisma.video_category.deleteMany({
        where: {
          video_id: {
            in: videoIds
          }
        }
      });
      
      // 모든 Category 삭제
      const deletedCategories = await prisma.category.deleteMany({});
      
      console.log(`[DEBUG] 카테고리 분류 결과 초기화 완료: ${videoIds.length}개 영상, ${deletedVideoCategories.count}개 Video_category, ${deletedCategories.count}개 Category`);
    }

    res.json({
      success: true,
      message: '카테고리 분류 결과가 초기화되었습니다.'
    });
  } catch (error) {
    console.error('[DEBUG] 카테고리 초기화 실패:', error);
    res.status(500).json({ 
      success: false, 
      message: '카테고리 초기화 중 오류가 발생했습니다.',
      error: error.message 
    });
  }
});

/**
 * @swagger
 * /api/videos/debug-categories:
 *   get:
 *     summary: 카테고리 및 비디오 카테고리 테이블 상태 확인 (디버깅용)
 *     tags: [Videos]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: 카테고리 및 비디오 카테고리 테이블 상태 반환
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 categories:
 *                   type: integer
 *                   description: 카테고리 테이블 항목 수
 *                 videoCategories:
 *                   type: integer
 *                   description: 비디오 카테고리 테이블 항목 수
 *                 categoryDetails:
 *                   type: array
 *                   items:
 *                     type: object
 *                 videoCategoryDetails:
 *                   type: array
 *                   items:
 *                     type: object
 *       500:
 *         description: 디버깅 실패
 */
// DB 상태 확인용 API (디버깅용)
router.get('/videos/debug-categories', authenticateToken, async (req, res) => {
  try {
    const categories = await prisma.category.findMany();
    const videoCategories = await prisma.video_category.findMany();
    
    res.json({
      categories: categories.length,
      videoCategories: videoCategories.length,
      categoryDetails: categories,
      videoCategoryDetails: videoCategories
    });
  } catch (error) {
    console.error('Debug categories error:', error);
    res.status(500).json({ success: false, message: 'Failed to debug categories' });
  }
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
      WHERE video_id = $1 AND comment_type = 1
      ORDER BY comment_date DESC;
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
      WHERE video_id = $1 AND comment_type = 2
      ORDER BY comment_date DESC;
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
 * /api/videos/{video_id}/comments/summary/{summary_id}:
 *   delete:
 *     summary: 댓글 분석 요약 삭제
 *     tags: [Videos]
 *     parameters:
 *       - in: path
 *         name: video_id
 *         required: true
 *         schema:
 *           type: string
 *         description: 영상 ID
 *       - in: path
 *         name: summary_id
 *         required: true
 *         schema:
 *           type: integer
 *         description: 분석 요약 ID
 *     responses:
 *       200:
 *         description: 삭제 성공
 *       404:
 *         description: 분석 요약을 찾을 수 없음
 *       500:
 *         description: 삭제 실패
 */
// 댓글 분석 요약 삭제 API
router.delete('/videos/:video_id/comments/summary/:summary_id', authenticateToken, async (req, res) => {
  const { video_id, summary_id } = req.params;

  try {
    // 해당 분석 요약이 존재하는지 확인
    const checkResult = await pool.query(
      'SELECT id FROM "Comment_summary" WHERE id = $1 AND video_id = $2',
      [summary_id, video_id]
    );

    if (checkResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: '분석 요약을 찾을 수 없습니다.'
      });
    }

    // 분석 요약 삭제
    const deleteResult = await pool.query(
      'DELETE FROM "Comment_summary" WHERE id = $1 AND video_id = $2',
      [summary_id, video_id]
    );

    if (deleteResult.rowCount > 0) {
      res.status(200).json({
        success: true,
        message: '분석 요약이 삭제되었습니다.'
      });
    } else {
      res.status(404).json({
        success: false,
        message: '분석 요약을 찾을 수 없습니다.'
      });
    }
  } catch (error) {
    console.error('분석 요약 삭제 실패:', error.message);
    res.status(500).json({
      success: false,
      message: '분석 요약 삭제 중 오류가 발생했습니다.'
    });
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
    errors
  });
});

/**
 * @swagger
 * /api/videos/{video_id}/comments/filter:
 *   post:
 *     summary: 댓글 필터링 요청 (n8n 연동)
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
 *               filtering_keyword:
 *                 type: string
 *                 example: "노래가 좋다는 댓글"
 *                 description: 필터링할 키워드
 *     responses:
 *       200:
 *         description: 필터링 작업 요청 성공
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 job_id:
 *                   type: string
 *                   example: "12345"
 *                 message:
 *                   type: string
 *                   example: "필터링 작업이 큐에 추가되었습니다."
 *       400:
 *         description: 잘못된 요청
 *       500:
 *         description: 필터링 작업 추가 실패
 */
// 댓글 필터링 요청 API
router.post('/videos/:video_id/comments/filter', async (req, res) => {
  const { video_id } = req.params;
  const { filtering_keyword } = req.body;

  if (!filtering_keyword) {
    return res.status(400).json({ 
      success: false, 
      message: '필터링 키워드가 필요합니다.' 
    });
  }

  try {
    // 큐에 필터링 작업 추가
    const job = await n8nQueue.add('filter', {
      videoId: video_id,
      jobType: 'filter',
      data: { 
        video_id, 
        filtering_keyword 
      }
    });

    res.status(200).json({
      success: true,
      job_id: job.id,
      message: '필터링 작업이 큐에 추가되었습니다.'
    });
  } catch (error) {
    console.error('필터링 작업 추가 실패:', error.message);
    res.status(500).json({ 
      success: false, 
      message: '필터링 작업 추가 실패',
      error: error.message 
    });
  }
});

/**
 * @swagger
 * /api/videos/{video_id}/comments:
 *   get:
 *     summary: 모든 댓글 조회
 *     description: 특정 비디오의 모든 댓글을 조회합니다.
 *     tags: [Comments]
 *     parameters:
 *       - in: path
 *         name: video_id
 *         required: true
 *         schema:
 *           type: string
 *         description: 비디오 ID
 *     responses:
 *       200:
 *         description: 댓글 조회 성공
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
 *                       youtube_comment_id:
 *                         type: string
 *                       author_name:
 *                         type: string
 *                       comment:
 *                         type: string
 *                       comment_type:
 *                         type: integer
 *                       comment_date:
 *                         type: string
 *                         format: date-time
 *                       is_filtered:
 *                         type: boolean
 *       500:
 *         description: 서버 오류
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
 *                 error:
 *                   type: string
 */
// 모든 댓글 조회 API 입니다.
router.get('/videos/:video_id/comments', async (req, res) => {
  const { video_id } = req.params;

  try {
    const result = await pool.query(
      'SELECT * FROM "Comment" WHERE video_id = $1 ORDER BY comment_date DESC',
      [video_id]
    );

    res.status(200).json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    console.error('댓글 조회 실패:', error.message);
    res.status(500).json({ 
      success: false, 
      message: '댓글 조회 실패',
      error: error.message 
    });
  }
});


/**
 * @swagger

 * /api/videos/{video_id}/comments/filter/status/{job_id}:
 *   get:
 *     summary: 댓글 필터링 작업 상태 확인!
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
 *                   example: true
 *                 status:
 *                   type: string
 *                   enum: [waiting, active, completed, failed]
 *                   example: "completed"
 *                 job_id:
 *                   type: string
 *                   example: "12345"
 *                 video_id:
 *                   type: string
 *                   example: "tpUxKppsShg"
 *       404:
 *         description: 작업을 찾을 수 없음
 *       500:
 *         description: 상태 확인 실패
 */
// 댓글 필터링 작업 상태 확인 API
router.get('/videos/:video_id/comments/filter/status/:job_id', async (req, res) => {
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
    console.error('필터링 작업 상태 확인 실패:', error.message);
    res.status(500).json({ 
      success: false, 
      error: '필터링 작업 상태 확인 실패' 
    });
  }
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

// 내 채널의 조회수 순위 1,2,3등 영상 조회 API
router.get('/videos/top-views', authenticateToken, async (req, res) => {
  console.log('[DEBUG] /api/videos/top-views 요청 받음');
  try {
    const userId = req.user.id;
    
    // 사용자의 채널 찾기
    const userChannel = await pool.query(
      'SELECT * FROM "Channel" WHERE user_id = $1',
      [userId]
    );

    if (userChannel.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: '채널 정보를 찾을 수 없습니다.' 
      });
    }

    const channel = userChannel.rows[0];
    
    // 해당 채널의 영상들을 조회수 순으로 정렬하여 상위 3개 조회
    const topVideos = await pool.query(`
      SELECT v.*, 
             COALESCE(vs.view_count, 0) as view_count,
             COALESCE(vs.like_count, 0) as like_count,
             COALESCE(vs.comment_count, 0) as comment_count
      FROM "Video" v
      LEFT JOIN (
        SELECT DISTINCT ON (video_id) video_id, view_count, like_count, comment_count, created_at
        FROM "Video_snapshot"
        ORDER BY video_id, created_at DESC
      ) vs ON v.id = vs.video_id
      WHERE v.channel_id = $1
      ORDER BY COALESCE(vs.view_count, 0) DESC
      LIMIT 3
    `, [channel.id]);

    // 결과 포맷팅
    const formattedVideos = topVideos.rows.map((video, index) => ({
      rank: index + 1,
      id: video.id,
      title: video.video_name,
      thumbnail_url: video.video_thumbnail_url,
      upload_date: video.upload_date,
      views: video.view_count || 0,
      likes: video.like_count || 0,
      comments: video.comment_count || 0
    }));

    res.json({
      success: true,
      data: formattedVideos
    });
  } catch (error) {
    console.error('[DEBUG] 상위 조회수 영상 조회 실패:', error);
    res.status(500).json({ 
      success: false, 
      message: '상위 조회수 영상 조회 중 오류가 발생했습니다.',
      error: error.message 
    });
  }
});

/**
 * @swagger
 * /api/videos/{video_id}:
 *   get:
 *     summary: 특정 비디오 상세 정보 조회
 *     description: 비디오 ID로 특정 비디오의 상세 정보를 조회합니다. filtering_keyword를 포함합니다.
 *     tags: [Videos]
 *     parameters:
 *       - in: path
 *         name: video_id
 *         required: true
 *         schema:
 *           type: string
 *         description: 비디오 ID
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: 비디오 정보 조회 성공
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
 *                     id:
 *                       type: string
 *                       example: "tpUxKppsShg"
 *                     video_name:
 *                       type: string
 *                       example: "샘플 비디오 제목"
 *                     video_thumbnail_url:
 *                       type: string
 *                       example: "https://i.ytimg.com/vi/tpUxKppsShg/default.jpg"
 *                     upload_date:
 *                       type: string
 *                       format: date-time
 *                       example: "2024-01-01T00:00:00.000Z"
 *                     channel_id:
 *                       type: string
 *                       example: "UC123456789"
 *                     filtering_keyword:
 *                       type: string
 *                       nullable: true
 *                       example: "노래가 좋다는 댓글"
 *                     comment_classified_at:
 *                       type: string
 *                       format: date-time
 *                       nullable: true
 *                       example: "2024-01-01T00:00:00.000Z"
 *                     created_at:
 *                       type: string
 *                       format: date-time
 *                       example: "2024-01-01T00:00:00.000Z"
 *                     updated_at:
 *                       type: string
 *                       format: date-time
 *                       example: "2024-01-01T00:00:00.000Z"
 *       404:
 *         description: 비디오를 찾을 수 없음
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
 *                   example: "비디오를 찾을 수 없습니다."
 *       500:
 *         description: 서버 오류
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
 *                 error:
 *                   type: string
 */
// 특정 비디오 상세 정보 조회 API
router.get('/videos/:video_id', authenticateToken, async (req, res) => {
  const { video_id } = req.params;
  const userId = req.user.id;

  try {
    // 비디오 정보 조회 (채널 소유자 확인 포함)
    const videoQuery = `
      SELECT v.*, c.user_id
      FROM "Video" v
      JOIN "Channel" c ON v.channel_id = c.id
      WHERE v.id = $1 AND c.user_id = $2 AND v.is_deleted = false
    `;
    
    const result = await pool.query(videoQuery, [video_id, userId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: '비디오를 찾을 수 없습니다.'
      });
    }

    const video = result.rows[0];
    
    // 응답 데이터 구성 (민감한 정보 제외)
    const videoData = {
      id: video.id,
      video_name: video.video_name,
      video_thumbnail_url: video.video_thumbnail_url,
      upload_date: video.upload_date,
      channel_id: video.channel_id,
      filtering_keyword: video.filtering_keyword,
      comment_classified_at: video.comment_classified_at,
      created_at: video.created_at,
      updated_at: video.updated_at
    };

    res.status(200).json({
      success: true,
      data: videoData
    });
  } catch (error) {
    console.error('비디오 정보 조회 실패:', error.message);
    res.status(500).json({
      success: false,
      message: '비디오 정보 조회 중 오류가 발생했습니다.',
      error: error.message
    });
  }
});

module.exports = router;