const express = require("express");
const router = express.Router();
const extractUser = require("../middleware/extractUser");
const {
  getTodayDashboard,
  completeChecklistItem,
  submitLearningProof,
  submitDailyReflection,
  confirmTimeRule, getDayByDate, getDayHistory
} = require("../controllers/dailyexecution.controller");

router.use(extractUser);

router.get("/today", getTodayDashboard);
router.post("/complete-item", completeChecklistItem);
router.post("/learning-proof", submitLearningProof);
router.post("/reflection", submitDailyReflection);
router.post("/confirm-time-rule", confirmTimeRule);
router.get("/day/:date", getDayByDate);
router.get("/history", getDayHistory);

module.exports = router;
