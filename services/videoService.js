const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const gptClassify = require('../utils/gpt');

async function classifyCategoryService(video_id) {
  // 1. 영상 조회
  const video = await prisma.video.findUnique({ where: { video_id } });
  if (!video) throw new Error('Video not found');

  // 2. GPT로 카테고리 분류
  const categoryName = await gptClassify(video.video_name, video.video_thumbnail_url);

  // 3. 카테고리 찾기/생성
  let category = await prisma.category.findUnique({ where: { category_name: categoryName } });
  if (!category) {
    category = await prisma.category.create({ data: { category_name: categoryName } });
  }

  // 4. video_category 매핑 추가 (중복 방지)
  await prisma.video_category.upsert({
    where: {
      video_id_category_id: {
        video_id: video.video_id,
        category_id: category.category_id
      }
    },
    update: {},
    create: {
      video_id: video.video_id,
      category_id: category.category_id
    }
  });

  return category.category_name;
}

module.exports = { classifyCategoryService };