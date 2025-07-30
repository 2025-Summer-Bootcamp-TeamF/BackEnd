const { classifyCategoryService } = require('../services/videoService');

async function classifyCategory(req, res) {
  const { video_id } = req.params;
  try {
    const result = await classifyCategoryService(Number(video_id));
    res.json({ success: true, category: result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

module.exports = { classifyCategory };