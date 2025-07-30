const express = require("express");
const router = express.Router();
const {classifyVideo} = require("../controllers/videoController");

router.post("/:video_id/classify_category", classifyCategory);

module.exports = router;