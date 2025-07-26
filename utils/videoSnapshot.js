const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function saveVideoSnapshot(videoId, YOUTUBE_API_KEY) {
  // 1. 유튜브 API로 동적 정보(조회수, 좋아요, 댓글수 등) 가져오기
  const videoDetailUrl = `https://www.googleapis.com/youtube/v3/videos?key=${YOUTUBE_API_KEY}&id=${videoId}&part=statistics`;
  const videoDetailResp = await fetch(videoDetailUrl);
  const videoDetailData = await videoDetailResp.json();
  const stats = videoDetailData.items?.[0]?.statistics || {};

  // 2. Return YouTube Dislike API로 싫어요 수 가져오기
  let dislikeCount = null;
  try {
    const dislikeResp = await fetch(`https://returnyoutubedislikeapi.com/votes?videoId=${videoId}`);
    const dislikeData = await dislikeResp.json();
    dislikeCount = dislikeData.dislikes ?? null;
  } catch (e) {
    dislikeCount = null;
  }

  // 3. 비디오 스냅샷 테이블에 insert
  const snapshot = await prisma.video_snapshot.create({
    data: {
      video_id: videoId,
      view_count: stats.viewCount ? parseInt(stats.viewCount) : null,
      like_count: stats.likeCount ? parseInt(stats.likeCount) : null,
      comment_count: stats.commentCount ? parseInt(stats.commentCount) : null,
      dislike_count: dislikeCount,
    },
  });
  return snapshot;
}

module.exports = { saveVideoSnapshot }; 