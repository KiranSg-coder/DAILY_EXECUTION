const express = require("express");
const router = express.Router();
const { createUserDay, closeDay, getDaySummary, updateDayResult, getNudgeCandidates, getPreviousDayResult } = require("../controllers/day.controller");

router.post("/day/create", createUserDay);
router.post("/day/close", closeDay);
router.get("/day/nudge-candidates", getNudgeCandidates);
router.get("/day/previous-result", getPreviousDayResult);
router.post("/day/previous-result", getPreviousDayResult);
router.get("/day/:dayId/summary", getDaySummary);
router.post("/day/:dayId/result", updateDayResult);

module.exports = router;