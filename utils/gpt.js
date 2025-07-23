// 실제로는 OpenAI API 연동 필요
module.exports = async function gptClassify(title, thumbnailUrl) {
    // 예시: 제목에 따라 임시 분류
    if (title.includes('감정')) return '감정 과장';
    if (title.includes('리뷰')) return '리뷰';
    return '기타';
  };