const { QueryTypes } = require("sequelize");
const sequelize = require("../config/database");
const eventPublisher = require("../utils/eventPublisher");
const { EVENT_TYPES, EVENT_CATEGORIES } = require("../config/eventTypes");

const getTodayDashboard = async (req, res) => {
  try {
    const userId = req.userId;

    //=================================================
    // EXECUTE STORED PROCEDURE
    //=================================================
    const result = await sequelize.query(
      `EXEC USP_GET_TODAY_DASHBOARD 
          @USERID = :userId,
          @DATE = :date`,
      {
        replacements: {
          userId,
          date: null, // Use today
        },
        type: QueryTypes.RAW,
      },
    );
    // console.log(JSON.stringify(result, null, 2));

    const rows = result[0] || [];

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        error: {
          code: "NO_DAY_TODAY",
          message: "No active day found for today",
        },
      });
    }

    // Day row (has DAYNUMBER but no CHECKLISTITEMID / PROOFTYPEID)
    const userDayData = rows.filter(
      (r) =>
        r.DAYNUMBER !== undefined &&
        r.CHECKLISTITEMID === undefined &&
        r.PROOFTYPEID === undefined,
    );

    // Checklist rows (have CHECKLISTITEMID)
    const checklistData = rows.filter((r) => r.CHECKLISTITEMID !== undefined);

    // Proof type master rows (have PROOFTYPEID)
    const proofTypeMaster = rows.filter((r) => r.PROOFTYPEID !== undefined);

    // These are not returned anymore
    const proofsData = [];
    const reflectionsData = [];
    const weekSummaryData = [];

    //=================================================
    // CHECK FOR ERRORS
    //=================================================
    if (userDayData.length > 0 && userDayData[0].ErrorCode) {
      const errorInfo = userDayData[0];
      return res.status(200).json({
        success: false,
        error: {
          code: errorInfo.ErrorType || "NO_DAY_TODAY",
          message: errorInfo.ErrorMessage,
        },
      });
    }

    if (!userDayData.length) {
      return res.status(200).json({
        success: false,
        error: {
          code: "NO_DAY_TODAY",
          message: "No active day found for today",
        },
      });
    }

    const dayRow = userDayData[0];

    //=================================================
    // BUILD PROOF TYPE MAP
    //=================================================
    const proofTypeMap = {};
    proofTypeMaster.forEach((pt) => {
      proofTypeMap[pt.PROOFTYPEID] = pt.PROOFTYPECODE;
    });

    //=================================================
    // MAP CHECKLIST WITH PROOFS AND REFLECTIONS
    //=================================================
    const checklist = checklistData.map((item) => {
      const checklistItem = {
        checklistItemId: item.CHECKLISTITEMID,
        ruleId: item.RULEID,
        domainType: item.DOMAINTYPE,
        emoji: item.EMOJI || getEmojiForDomain(item.DOMAINTYPE),
        description: item.DESCRIPTION,
        isCompleted: Boolean(item.ISCOMPLETED),
      };

      // Add completion details if completed
      if (item.ISCOMPLETED) {
        checklistItem.completedAt = item.COMPLETEDAT;
        checklistItem.completionSource = item.COMPLETIONSOURCE;
      }

      // Add required value for time-based rules (SLEEP, FUEL)
      if (item.REQUIREDVALUE && item.DOMAINTYPE === "SLEEP") {
        checklistItem.requiresProof = false;
        checklistItem.evaluatesAt = item.REQUIREDVALUE;
      }

      // Add LEARNING-specific fields
      if (item.DOMAINTYPE === "LEARNING") {
        checklistItem.requiresProof = true;

        const tv = item.TARGETVALUE ?? item.targetValue;
        const unit = item.UNIT ?? item.unit;
        if (tv != null && tv !== "") {
          checklistItem.targetValue = tv;
          if (unit != null && unit !== "") {
            checklistItem.unit = unit;
          }
        }

        // Parse allowed proof types
        if (item.ALLOWEDPROOFTYPES) {
          const allowedIds = item.ALLOWEDPROOFTYPES.split(",").map((id) =>
            parseInt(id.trim()),
          );
          checklistItem.proofTypes = allowedIds
            .map((id) => proofTypeMap[id])
            .filter(Boolean);
        }

        // Attach proof if exists
        if (item.PROOFID) {
          const proof = proofsData.find((p) => p.PROOFID === item.PROOFID);
          if (proof) {
            checklistItem.proof = {
              proofId: proof.PROOFID,
              descriptionText: proof.DESCRIPTIONTEXT,
              proofType: proof.PROOFTYPES,
              durationMinutes: proof.DURATIONMINUTES,
              submittedAt: proof.SUBMITTEDAT,
            };
          }
        }
      } else {
        checklistItem.requiresProof = false;
      }

      // Add REFLECTION-specific fields
      if (item.DOMAINTYPE === "REFLECTION") {
        if (item.REFLECTIONID) {
          const reflection = reflectionsData.find(
            (r) => r.REFLECTIONID === item.REFLECTIONID,
          );
          if (reflection) {
            checklistItem.reflection = {
              reflectionId: reflection.REFLECTIONID,
              whatHappened: reflection.WHATHAPPENED,
              whatBlocked: reflection.WHATBLOCKED,
              planForTomorrow: reflection.PLANFORTOMORROW,
              createdAt: reflection.CREATEDAT,
            };
          }
        }
      }

      return checklistItem;
    });

    //=================================================
    // BUILD BASE RESPONSE
    //=================================================
    const baseResponse = {
      dayId: dayRow.DAYID,
      userId: dayRow.USERID,
      date: dayRow.DAYDATE,
      dayNumber: dayRow.DAYNUMBER,
      mode: dayRow.MODE,
      status: dayRow.STATUS,
      result: dayRow.RESULT || "PENDING",
      checklist,
      progress: {
        totalRules: dayRow.TOTALRULES,
        completedRules: dayRow.COMPLETEDRULES,
        remainingRules: dayRow.TOTALRULES - dayRow.COMPLETEDRULES,
        percentComplete:
          dayRow.TOTALRULES > 0
            ? Math.round((dayRow.COMPLETEDRULES / dayRow.TOTALRULES) * 100)
            : 0,
      },
    };

    //=================================================
    // HANDLE OPEN DAY RESPONSE
    //=================================================
    if (dayRow.STATUS === "OPEN") {
      return res.status(200).json({
        success: true,
        data: {
          ...baseResponse,
          timing: {
            startedAt: dayRow.STARTEDAT,
            closesAt: dayRow.CLOSEDAT,
            hoursRemaining: dayRow.HOURSREMAINING
              ? parseFloat(dayRow.HOURSREMAINING.toFixed(1))
              : null,
          },
          lockInfo: {
            rulesLocked: dayRow.DAYSREMAININGINLOCK > 0,
            daysRemaining: Math.max(0, dayRow.DAYSREMAININGINLOCK || 0),
          },
        },
      });
    }

    //=================================================
    // HANDLE CLOSED DAY RESPONSE
    //=================================================
    if (dayRow.STATUS === "CLOSED") {
      // Build verdict message
      const missedItems = checklist
        .filter((item) => !item.isCompleted)
        .map((item) => item.description);

      let verdictMessage = "";
      if (dayRow.RESULT === "PASS") {
        verdictMessage = `Day ${dayRow.DAYNUMBER}: Pass\n\nYou completed all ${dayRow.TOTALRULES} non-negotiables.\nTomorrow: Same rules. Show up again.`;
      } else if (dayRow.RESULT === "FAIL") {
        verdictMessage = `Day ${dayRow.DAYNUMBER}: Incomplete\n\nYou completed ${dayRow.COMPLETEDRULES}/${dayRow.TOTALRULES} non-negotiables.\n\nMissing:\n${missedItems.map((item) => `- ${item}`).join("\n")}\n\nTomorrow: Same rules. Show up again.`;
      }

      // Build week summary
      let weekSummary = null;
      if (weekSummaryData.length > 0) {
        const passedDays = weekSummaryData.filter(
          (d) => d.RESULT === "PASS",
        ).length;
        const totalDays = weekSummaryData.length;
        const pattern = weekSummaryData
          .map((d) => (d.RESULT === "PASS" ? "✓" : "✗"))
          .join(" ");

        // Get date range for week label
        const firstDay = weekSummaryData[0]?.DAYDATE;
        const lastDay = weekSummaryData[weekSummaryData.length - 1]?.DAYDATE;
        const weekLabel = formatWeekLabel(firstDay, lastDay);

        weekSummary = {
          week: weekLabel,
          passedDays,
          totalDays,
          passRate: Math.round((passedDays / totalDays) * 100),
          pattern,
        };
      }

      // Calculate consecutive failures
      let consecutiveFailures = 0;
      if (dayRow.RESULT === "FAIL") {
        // Count consecutive failures working backwards
        for (let i = weekSummaryData.length - 1; i >= 0; i--) {
          if (weekSummaryData[i].RESULT === "FAIL") {
            consecutiveFailures++;
          } else {
            break;
          }
        }
      }

      return res.status(200).json({
        success: true,
        data: {
          ...baseResponse,
          closedAt: dayRow.CLOSEDAT,
          evaluatedAt: dayRow.EVALUATEDAT,
          verdict: {
            result: dayRow.RESULT,
            message: verdictMessage,
            completedRules: dayRow.COMPLETEDRULES,
            totalRules: dayRow.TOTALRULES,
            missedItems: dayRow.RESULT === "FAIL" ? missedItems : undefined,
            evaluatedAt: dayRow.EVALUATEDAT,
          },
          weekSummary,
          nextDay: {
            dayNumber: dayRow.DAYNUMBER + 1,
            mode: dayRow.MODE,
            sameRules: true,
          },
          ...(consecutiveFailures > 0 && { consecutiveFailures }),
        },
      });
    }

    // Fallback for unexpected status
    return res.status(200).json({
      success: true,
      data: baseResponse,
    });
  } catch (error) {
    console.error("Error fetching today's dashboard:", error);

    return res.status(500).json({
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to fetch today's dashboard",
        details:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      },
    });
  }
};

//=================================================
// HELPER FUNCTIONS
//=================================================

function getEmojiForDomain(domainType) {
  const emojiMap = {
    SLEEP: "💤",
    BODY: "🏃",
    LEARNING: "📚",
    FUEL: "🥗",
    REFLECTION: "📝",
  };
  return emojiMap[domainType] || "⭐";
}

function formatWeekLabel(firstDate, lastDate) {
  if (!firstDate || !lastDate) return "This week";

  const first = new Date(firstDate);
  const last = new Date(lastDate);

  const monthNames = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];

  const firstMonth = monthNames[first.getMonth()];
  const lastMonth = monthNames[last.getMonth()];
  const firstDay = first.getDate();
  const lastDay = last.getDate();

  if (firstMonth === lastMonth) {
    return `${firstMonth} ${firstDay}-${lastDay}`;
  } else {
    return `${firstMonth} ${firstDay}-${lastMonth} ${lastDay}`;
  }
}
//-------------------------
const completeChecklistItem = async (req, res) => {
  try {
    const userId = req.userId;
    const { checklistItemId, completionSource, completedAt } = req.body;

    if (!checklistItemId) {
      return res.status(400).json({
        success: false,
        error: {
          code: "MISSING_CHECKLIST_ITEM_ID",
          message: "checklistItemId is required",
        },
      });
    }

    if (!completionSource) {
      return res.status(400).json({
        success: false,
        error: {
          code: "MISSING_COMPLETION_SOURCE",
          message: "completionSource is required",
        },
      });
    }

    const completionTime = completedAt || new Date().toISOString();

    //=================================================
    // EXECUTE STORED PROCEDURE
    //=================================================
    const result = await sequelize.query(
      `EXEC USP_COMPLETE_CHECKLIST_ITEM
          @USERID = :userId,
          @CHECKLISTITEMID = :checklistItemId,
          @COMPLETIONSOURCE = :completionSource,
          @COMPLETEDAT = :completedAt`,
      {
        replacements: {
          userId,
          checklistItemId: parseInt(checklistItemId),
          completionSource,
          completedAt: completionTime,
        },
        type: QueryTypes.RAW,
      },
    );

    // console.log(JSON.stringify(result, null, 2));

    //=================================================
    // FIX: PARSE FLATTENED RESULT SET
    //=================================================
    const rows = result[0] || [];

    if (!rows.length) {
      return res.status(500).json({
        success: false,
        error: {
          code: "NO_RESULT",
          message: "No result returned from stored procedure",
        },
      });
    }

    // Extract rows by column presence
    const statusResult = rows.find((r) => r.ErrorCode !== undefined);
    const itemRow = rows.find((r) => r.CHECKLISTITEMID !== undefined);
    const progressRow = rows.find((r) => r.TotalRules !== undefined);

    if (!statusResult) {
      return res.status(500).json({
        success: false,
        error: {
          code: "NO_STATUS",
          message: "No status returned from stored procedure",
        },
      });
    }

    //=================================================
    // HANDLE ERRORS FROM STORED PROCEDURE
    //=================================================
    if (statusResult.ErrorCode !== 0) {
      const errorMap = {
        1: { status: 404, code: "ITEM_NOT_FOUND" },
        2: { status: 403, code: "UNAUTHORIZED" },
        3: { status: 400, code: "DAY_CLOSED" },
        4: { status: 409, code: "ALREADY_COMPLETED" },
        5: { status: 400, code: "PROOF_REQUIRED" },
        6: { status: 400, code: "REFLECTION_REQUIRED" },
        99: { status: 500, code: "INTERNAL_ERROR" },
      };

      const errorInfo = errorMap[statusResult.ErrorCode] || {
        status: 500,
        code: "UNKNOWN_ERROR",
      };

      const errorResponse = {
        success: false,
        error: {
          code: statusResult.ErrorType || errorInfo.code,
          message: statusResult.ErrorMessage,
          details: {},
        },
      };

      const checklistId =
        statusResult.ChecklistItemId ||
        statusResult.CHECKLISTITEMID ||
        checklistItemId;

      if (checklistId) {
        errorResponse.error.details.checklistItemId = checklistId;
      }

      if (statusResult.ErrorCode === 3) {
        errorResponse.error.details.dayClosedAt = statusResult.DayClosedAt;
      } else if (statusResult.ErrorCode === 5) {
        errorResponse.error.details.ruleId = statusResult.RuleId;
        errorResponse.error.details.proofTypes = statusResult.ProofTypes
          ? statusResult.ProofTypes.split(",")
          : [];
      } else if (statusResult.ErrorCode === 6) {
        errorResponse.error.details.ruleId = statusResult.RuleId;
      } else if (statusResult.ErrorCode === 99) {
        errorResponse.error.details.sqlErrorNumber =
          statusResult.SqlErrorNumber;
        errorResponse.error.details.sqlErrorLine = statusResult.SqlErrorLine;
      }

      return res.status(errorInfo.status).json(errorResponse);
    }

    //=================================================
    // BUILD SUCCESS RESPONSE
    //=================================================
    if (!itemRow || !progressRow) {
      return res.status(500).json({
        success: false,
        error: {
          code: "INCOMPLETE_DATA",
          message: "Item completion succeeded but response data is incomplete",
        },
      });
    }

    if (itemRow) {
      await eventPublisher.publish(
        EVENT_TYPES.RULE_COMPLETED,
        EVENT_CATEGORIES.RULE,
        {
          dayId: itemRow.DAYID,
          userId,
          ruleId: itemRow.RULEID,
          ruleName: itemRow.DESCRIPTION,
          domainType: itemRow.DOMAINTYPE,
          completedAt: itemRow.COMPLETEDAT,
        },
        {
          entityType: "CHECKLIST_ITEM",
          entityId: itemRow.CHECKLISTITEMID,
        }
      );
    }

    return res.status(200).json({
      success: true,
      data: {
        checklistItemId: itemRow.CHECKLISTITEMID,
        ruleId: itemRow.RULEID,
        description: itemRow.DESCRIPTION,
        domainType: itemRow.DOMAINTYPE,
        isCompleted: Boolean(itemRow.ISCOMPLETED),
        completedAt: itemRow.COMPLETEDAT,
        completionSource: itemRow.COMPLETIONSOURCE,
        updatedProgress: {
          totalRules: progressRow.TotalRules,
          completedRules: progressRow.CompletedRules,
          remainingRules: progressRow.RemainingRules,
        },
      },
    });
  } catch (error) {
    console.error("Error completing checklist item:", error);

    return res.status(500).json({
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to complete checklist item",
        details:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      },
    });
  }
};

const submitLearningProof = async (req, res) => {
  try {
    const userId = req.userId;
    const { dayId, ruleId, proof } = req.body;

    if (!dayId) {
      return res.status(400).json({
        success: false,
        error: {
          code: "MISSING_DAY_ID",
          message: "dayId is required",
        },
      });
    }

    if (!ruleId) {
      return res.status(400).json({
        success: false,
        error: {
          code: "MISSING_RULE_ID",
          message: "ruleId is required",
        },
      });
    }

    if (!proof || typeof proof !== "object") {
      return res.status(400).json({
        success: false,
        error: {
          code: "MISSING_PROOF",
          message: "proof object is required",
        },
      });
    }

    if (!proof.descriptionText) {
      return res.status(400).json({
        success: false,
        error: {
          code: "MISSING_DESCRIPTION",
          message: "proof.descriptionText is required",
        },
      });
    }

    const proofTypesList = (() => {
      if (Array.isArray(proof.proofTypes) && proof.proofTypes.length) {
        return proof.proofTypes
          .map((t) => String(t).trim())
          .filter(Boolean);
      }
      if (typeof proof.proofType === "string" && proof.proofType.trim()) {
        if (proof.proofType.includes(",")) {
          return proof.proofType
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean);
        }
        return [proof.proofType.trim()];
      }
      return [];
    })();

    if (!proofTypesList.length) {
      return res.status(400).json({
        success: false,
        error: {
          code: "MISSING_PROOF_TYPE",
          message:
            "proof.proofTypes (non-empty array) or proof.proofType is required",
        },
      });
    }

    const seen = new Set();
    const orderedProofTypes = [];
    for (const t of proofTypesList) {
      const key = t.toUpperCase();
      if (!seen.has(key)) {
        seen.add(key);
        orderedProofTypes.push(t);
      }
    }

    const primaryProofType = orderedProofTypes[0];
    let descriptionText = String(proof.descriptionText).trim();
    if (orderedProofTypes.length > 1) {
      descriptionText = `${descriptionText}\n\n[Outputs: ${orderedProofTypes.join(", ")}]`;
    }

    if (!proof.durationMinutes || proof.durationMinutes < 1) {
      return res.status(400).json({
        success: false,
        error: {
          code: "MISSING_DURATION",
          message: "proof.durationMinutes is required and must be at least 1",
        },
      });
    }

    //=================================================
    // EXECUTE STORED PROCEDURE
    //=================================================
    const result = await sequelize.query(
      `EXEC USP_SUBMIT_LEARNING_PROOF
          @USERID = :userId,
          @DAYID = :dayId,
          @RULEID = :ruleId,
          @DESCRIPTIONTEXT = :descriptionText,
          @PROOFTYPECODE = :proofType,
          @DURATIONMINUTES = :durationMinutes,
          @ATTACHMENTURL = :attachmentURL`,
      {
        replacements: {
          userId,
          dayId: parseInt(dayId),
          ruleId: parseInt(ruleId),
          descriptionText,
          proofType: primaryProofType,
          durationMinutes: parseInt(proof.durationMinutes),
          attachmentURL: proof.attachmentURL || null,
        },
        type: QueryTypes.RAW,
      },
    );

    // console.log(JSON.stringify(result, null, 2));

    //=================================================
    // PARSE RESULT
    // [0] - Status (ErrorCode, Status)
    // [1] - Proof details
    // [2] - Updated checklist item
    // [3] - Updated progress
    //=================================================
    const rows = result[0] || [];

    if (!rows.length) {
      return res.status(500).json({
        success: false,
        error: {
          code: "NO_RESULT",
          message: "No result returned from stored procedure",
        },
      });
    }

    // Extract rows by column presence
    const statusResult = rows.find((r) => r.ErrorCode !== undefined);
    const proofRow = rows.find((r) => r.PROOFID !== undefined);
    const itemRow = rows.find((r) => r.CHECKLISTITEMID !== undefined);
    const progressRow = rows.find((r) => r.TotalRules !== undefined);

    if (!statusResult) {
      return res.status(500).json({
        success: false,
        error: {
          code: "NO_RESULT",
          message: "No result returned from stored procedure",
        },
      });
    }

    //=================================================
    // HANDLE ERRORS FROM STORED PROCEDURE
    //=================================================
    if (statusResult.ErrorCode !== 0) {
      const errorMap = {
        1: { status: 400, code: "INVALID_PROOF_TYPE_CODE" },
        2: { status: 404, code: "DAY_NOT_FOUND" },
        3: { status: 400, code: "DAY_CLOSED" },
        4: { status: 404, code: "CHECKLIST_ITEM_NOT_FOUND" },
        5: { status: 409, code: "ALREADY_COMPLETED" },
        6: { status: 400, code: "INVALID_PROOF_TYPE" },
        7: { status: 400, code: "PROOF_TOO_SHORT" },
        8: { status: 400, code: "INVALID_DURATION" },
        99: { status: 500, code: "INTERNAL_ERROR" },
      };

      const errorInfo = errorMap[statusResult.ErrorCode] || {
        status: 500,
        code: "UNKNOWN_ERROR",
      };

      const errorResponse = {
        success: false,
        error: {
          code: statusResult.ErrorType || errorInfo.code,
          message: statusResult.ErrorMessage,
          details: {},
        },
      };

      const checklistId =
        statusResult.ChecklistItemId || statusResult.CHECKLISTITEMID;

      if (checklistId !== undefined) {
        errorResponse.error.details.checklistItemId = checklistId;
      }
      // Add specific error details
      if (statusResult.ErrorCode === 6) {
        // INVALID_PROOF_TYPE
        errorResponse.error.details.allowedTypes = statusResult.AllowedTypes
          ? statusResult.AllowedTypes.split(", ")
          : [];
      } else if (statusResult.ErrorCode === 7) {
        // PROOF_TOO_SHORT
        errorResponse.error.details.minLength = statusResult.MinLength;
        errorResponse.error.details.provided = statusResult.ProvidedLength;
      } else if (statusResult.ErrorCode === 8) {
        // INVALID_DURATION
        errorResponse.error.details.providedDuration =
          statusResult.ProvidedDuration;
      } else if (statusResult.ErrorCode === 99) {
        // INTERNAL_ERROR
        errorResponse.error.details.sqlErrorNumber =
          statusResult.SqlErrorNumber;
        errorResponse.error.details.sqlErrorLine = statusResult.SqlErrorLine;
      }

      return res.status(errorInfo.status).json(errorResponse);
    }

    //=================================================
    // BUILD SUCCESS RESPONSE
    //=================================================

    if (!proofRow || !itemRow || !progressRow) {
      return res.status(500).json({
        success: false,
        error: {
          code: "INCOMPLETE_DATA",
          message: "Proof submission succeeded but response data is incomplete",
        },
      });
    }

    if (proofRow) {
      await eventPublisher.publish(
        EVENT_TYPES.RULE_PROOF_SUBMITTED,
        EVENT_CATEGORIES.RULE,
        {
          dayId: proofRow.DAYID,
          userId,
          ruleId: proofRow.RULEID,
          proofId: proofRow.PROOFID,
          proofType: proofRow.PROOFTYPECODE || proofRow.PROOFTYPES,
          submittedAt: proofRow.SUBMITTEDAT,
        },
        {
          entityType: "LEARNING_PROOF",
          entityId: proofRow.PROOFID,
        }
      );
    }

    return res.status(200).json({
      success: true,
      data: {
        proofId: proofRow.PROOFID,
        checklistItemId: itemRow.CHECKLISTITEMID,
        ruleId: itemRow.RULEID,
        description: itemRow.DESCRIPTION,
        isCompleted: Boolean(itemRow.ISCOMPLETED),
        completedAt: itemRow.COMPLETEDAT,
        proof: {
          proofId: proofRow.PROOFID,
          descriptionText: proofRow.DESCRIPTIONTEXT,
          proofType: proofRow.PROOFTYPECODE, // Return code, not ID
          durationMinutes: proofRow.DURATIONMINUTES,
          attachmentURL: proofRow.ATTACHMENTURL,
          submittedAt: proofRow.SUBMITTEDAT,
        },
        updatedProgress: {
          totalRules: progressRow.TotalRules,
          completedRules: progressRow.CompletedRules,
          remainingRules: progressRow.RemainingRules,
        },
      },
    });
  } catch (error) {
    console.error("Error submitting learning proof:", error);

    return res.status(500).json({
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to submit learning proof",
        details:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      },
    });
  }
};

const submitDailyReflection = async (req, res) => {
  try {
    const userId = req.userId;
    const { dayId, ruleId, reflection } = req.body;

    if (!dayId) {
      return res.status(400).json({
        success: false,
        error: {
          code: "MISSING_DAY_ID",
          message: "dayId is required",
        },
      });
    }

    if (!ruleId) {
      return res.status(400).json({
        success: false,
        error: {
          code: "MISSING_RULE_ID",
          message: "ruleId is required",
        },
      });
    }

    if (!reflection || typeof reflection !== "object") {
      return res.status(400).json({
        success: false,
        error: {
          code: "MISSING_REFLECTION",
          message: "reflection object is required",
        },
      });
    }

    // Check for missing fields at API level too
    const requiredFields = ["whatHappened", "whatBlocked", "planForTomorrow"];
    const missingFields = requiredFields.filter(
      (field) => !reflection[field] || reflection[field].trim() === "",
    );

    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: "INCOMPLETE_REFLECTION",
          message: "All three reflection questions must be answered",
          details: {
            required: requiredFields,
            missing: missingFields,
          },
        },
      });
    }

    //=================================================
    // EXECUTE STORED PROCEDURE
    //=================================================
    const result = await sequelize.query(
      `EXEC USP_SUBMIT_DAILY_REFLECTION
          @USERID = :userId,
          @DAYID = :dayId,
          @RULEID = :ruleId,
          @WHATHAPPENED = :whatHappened,
          @WHATBLOCKED = :whatBlocked,
          @PLANFORTOMORROW = :planForTomorrow`,
      {
        replacements: {
          userId,
          dayId: parseInt(dayId),
          ruleId: parseInt(ruleId),
          whatHappened: reflection.whatHappened.trim(),
          whatBlocked: reflection.whatBlocked.trim(),
          planForTomorrow: reflection.planForTomorrow.trim(),
        },
        type: QueryTypes.RAW,
      },
    );

    // console.log(JSON.stringify(result, null, 2));

    //=================================================
    // PARSE RESULT
    // [0] - Status (ErrorCode, Status)
    // [1] - Reflection details
    // [2] - Updated checklist item
    // [3] - Updated progress
    // [4] - Remaining items
    //=================================================
    const rows = result[0] || [];

    if (!rows.length) {
      return res.status(500).json({
        success: false,
        error: {
          code: "NO_RESULT",
          message: "No result returned from stored procedure",
        },
      });
    }

    // Extract rows by unique column presence
    const statusResult = rows.find((r) => r.ErrorCode !== undefined);
    const reflectionRow = rows.find((r) => r.REFLECTIONID !== undefined);
    const itemRow = rows.find((r) => r.CHECKLISTITEMID !== undefined);
    const progressRow = rows.find((r) => r.TotalRules !== undefined);

    // Remaining items = rows that only contain DESCRIPTION
    const remainingItems = rows.filter(
      (r) =>
        r.DESCRIPTION !== undefined &&
        r.CHECKLISTITEMID === undefined &&
        r.TotalRules === undefined &&
        r.REFLECTIONID === undefined &&
        r.ErrorCode === undefined,
    );

    if (!statusResult) {
      return res.status(500).json({
        success: false,
        error: {
          code: "NO_RESULT",
          message: "No result returned from stored procedure",
        },
      });
    }

    //=================================================
    // HANDLE ERRORS FROM STORED PROCEDURE
    //=================================================
    if (statusResult.ErrorCode !== 0) {
      const errorMap = {
        1: { status: 404, code: "DAY_NOT_FOUND" },
        2: { status: 400, code: "DAY_CLOSED" },
        3: { status: 404, code: "CHECKLIST_ITEM_NOT_FOUND" },
        4: { status: 400, code: "NOT_REFLECTION_ITEM" },
        5: { status: 409, code: "ALREADY_COMPLETED" },
        6: { status: 400, code: "INCOMPLETE_REFLECTION" },
        7: { status: 400, code: "FIELD_TOO_SHORT" },
        99: { status: 500, code: "INTERNAL_ERROR" },
      };

      const errorInfo = errorMap[statusResult.ErrorCode] || {
        status: 500,
        code: "UNKNOWN_ERROR",
      };

      const errorResponse = {
        success: false,
        error: {
          code: statusResult.ErrorType || errorInfo.code,
          message: statusResult.ErrorMessage,
          details: {},
        },
      };

      const checklistId =
        statusResult.ChecklistItemId || statusResult.CHECKLISTITEMID;

      if (checklistId !== undefined) {
        errorResponse.error.details.checklistItemId = checklistId;
      }

      // Add specific error details
      if (statusResult.ErrorCode === 6) {
        // INCOMPLETE_REFLECTION
        const required = ["whatHappened", "whatBlocked", "planForTomorrow"];
        const missing = statusResult.MissingFields
          ? statusResult.MissingFields.split(",")
          : [];
        errorResponse.error.details = { required, missing };
      } else if (statusResult.ErrorCode === 7) {
        // FIELD_TOO_SHORT
        errorResponse.error.details = {
          fieldName: statusResult.FieldName,
          minLength: statusResult.MinLength,
          provided: statusResult.ProvidedLength,
        };
      } else if (statusResult.ErrorCode === 99) {
        // INTERNAL_ERROR
        errorResponse.error.details.sqlErrorNumber =
          statusResult.SqlErrorNumber;
        errorResponse.error.details.sqlErrorLine = statusResult.SqlErrorLine;
      }

      return res.status(errorInfo.status).json(errorResponse);
    }

    //=================================================
    // BUILD SUCCESS RESPONSE
    //=================================================

    if (!reflectionRow || !itemRow || !progressRow) {
      return res.status(500).json({
        success: false,
        error: {
          code: "INCOMPLETE_DATA",
          message:
            "Reflection submission succeeded but response data is incomplete",
        },
      });
    }

    // Build helpful message
    let message = "Journal submitted.";
    if (remainingItems.length > 0) {
      const itemsList = remainingItems
        .map((item) => item.DESCRIPTION)
        .join(", ");
      message += ` ${remainingItems.length} item${remainingItems.length > 1 ? "s" : ""} left: ${itemsList}`;
    } else {
      message += " All items complete!";
    }
    if (reflectionRow) {
      await eventPublisher.publish(
        EVENT_TYPES.REFLECTION_SUBMITTED,
        EVENT_CATEGORIES.RULE,
        {
          dayId: reflectionRow.DAYID,
          userId,
          ruleId: reflectionRow.RULEID,
          reflectionId: reflectionRow.REFLECTIONID,
          createdAt: reflectionRow.CREATEDAT,
        },
        {
          entityType: "DAILY_REFLECTION",
          entityId: reflectionRow.REFLECTIONID,
        }
      );
    }
    return res.status(200).json({
      success: true,
      data: {
        reflectionId: reflectionRow.REFLECTIONID,
        checklistItemId: itemRow.CHECKLISTITEMID,
        ruleId: itemRow.RULEID,
        description: itemRow.DESCRIPTION,
        isCompleted: Boolean(itemRow.ISCOMPLETED),
        completedAt: itemRow.COMPLETEDAT,
        reflection: {
          reflectionId: reflectionRow.REFLECTIONID,
          whatHappened: reflectionRow.WHATHAPPENED,
          whatBlocked: reflectionRow.WHATBLOCKED,
          planForTomorrow: reflectionRow.PLANFORTOMORROW,
          createdAt: reflectionRow.CREATEDAT,
        },
        updatedProgress: {
          totalRules: progressRow.TotalRules,
          completedRules: progressRow.CompletedRules,
          remainingRules: progressRow.RemainingRules,
        },
        message,
      },
    });
  } catch (error) {
    console.error("Error submitting daily reflection:", error);

    return res.status(500).json({
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to submit daily reflection",
        details:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      },
    });
  }
};

const confirmTimeRule = async (req, res) => {
  try {
    const userId = req.userId;
    const { checklistItemId, confirmed, actualTime } = req.body;

    if (!checklistItemId) {
      return res.status(400).json({
        success: false,
        error: {
          code: "MISSING_CHECKLIST_ITEM_ID",
          message: "checklistItemId is required",
        },
      });
    }

    if (confirmed === undefined || confirmed === null) {
      return res.status(400).json({
        success: false,
        error: {
          code: "MISSING_CONFIRMATION",
          message: "confirmed field is required",
        },
      });
    }

    if (!actualTime) {
      return res.status(400).json({
        success: false,
        error: {
          code: "MISSING_ACTUAL_TIME",
          message: "actualTime is required",
        },
      });
    }

    //=================================================
    // EXECUTE STORED PROCEDURE
    //=================================================
    const result = await sequelize.query(
      `EXEC USP_CONFIRM_TIME_RULE
          @USERID = :userId,
          @CHECKLISTITEMID = :checklistItemId,
          @CONFIRMED = :confirmed,
          @ACTUALTIME = :actualTime`,
      {
        replacements: {
          userId,
          checklistItemId: parseInt(checklistItemId),
          confirmed: confirmed ? 1 : 0,
          actualTime: actualTime,
        },
        type: QueryTypes.RAW,
      },
    );
    console.log(JSON.stringify(result, null, 2));

    //=================================================
    // PARSE RESULT
    // [0] - Status (ErrorCode, Status)
    // [1] - Updated checklist item
    // [2] - Updated progress
    //=================================================
    const rows = result[0] || [];

    if (!rows.length) {
      return res.status(500).json({
        success: false,
        error: {
          code: "NO_RESULT",
          message: "No result returned from stored procedure",
        },
      });
    }

    // Extract rows by unique column presence
    const statusResult = rows.find((r) => r.ErrorCode !== undefined);
    const itemRow = rows.find((r) => r.CHECKLISTITEMID !== undefined);
    const progressRow = rows.find((r) => r.TotalRules !== undefined);

    if (!statusResult) {
      return res.status(500).json({
        success: false,
        error: {
          code: "NO_RESULT",
          message: "No result returned from stored procedure",
        },
      });
    }

    //=================================================
    // HANDLE ERRORS FROM STORED PROCEDURE
    //=================================================
    if (statusResult.ErrorCode !== 0) {
      const errorMap = {
        1: { status: 404, code: "ITEM_NOT_FOUND" },
        2: { status: 403, code: "UNAUTHORIZED" },
        3: { status: 400, code: "DAY_CLOSED" },
        4: { status: 409, code: "ALREADY_COMPLETED" },
        5: { status: 400, code: "NOT_TIME_RULE" },
        6: { status: 400, code: "USER_DENIED" },
        7: { status: 400, code: "PAST_DEADLINE" },
        99: { status: 500, code: "INTERNAL_ERROR" },
      };

      const errorInfo = errorMap[statusResult.ErrorCode] || {
        status: 500,
        code: "UNKNOWN_ERROR",
      };

      const errorResponse = {
        success: false,
        error: {
          code: statusResult.ErrorType || errorInfo.code,
          message: statusResult.ErrorMessage,
          details: {},
        },
      };

      // Add specific error details
      if (statusResult.ErrorCode === 7) {
        // PAST_DEADLINE
        errorResponse.error.details = {
          deadlineTime: statusResult.DeadlineTime,
          actualTime: statusResult.ActualTime,
          minutesLate: statusResult.MinutesLate,
          deadlineAt: statusResult.DeadlineAt || undefined,
          actualAt: statusResult.ActualAt || undefined,
        };
      } else if (statusResult.ErrorCode === 99) {
        // INTERNAL_ERROR
        errorResponse.error.details.sqlErrorNumber =
          statusResult.SqlErrorNumber;
        errorResponse.error.details.sqlErrorLine = statusResult.SqlErrorLine;
      }

      return res.status(errorInfo.status).json(errorResponse);
    }

    //=================================================
    // BUILD SUCCESS RESPONSE
    //=================================================

    if (!itemRow || !progressRow) {
      return res.status(500).json({
        success: false,
        error: {
          code: "INCOMPLETE_DATA",
          message:
            "Time confirmation succeeded but response data is incomplete",
        },
      });
    }

    // Build encouraging message
    let message = "";
    if (itemRow.ONTIME) {
      const minutes = itemRow.MINUTESDIFF;
      if (minutes > 30) {
        message = `Excellent! You made it with ${minutes} minutes to spare.`;
      } else if (minutes > 10) {
        message = `Good job! You made it with ${minutes} minutes to spare.`;
      } else if (minutes > 0) {
        message = `Nice! You made it with ${minutes} minute${minutes === 1 ? "" : "s"} to spare.`;
      } else {
        message = `Perfect timing! You made it right on time.`;
      }
    }

    return res.status(200).json({
      success: true,
      data: {
        checklistItemId: itemRow.CHECKLISTITEMID,
        ruleId: itemRow.RULEID,
        description: itemRow.DESCRIPTION,
        isCompleted: Boolean(itemRow.ISCOMPLETED),
        completedAt: itemRow.COMPLETEDAT,
        targetTime: itemRow.TARGETTIME,
        actualTime: itemRow.ACTUALTIME,
        onTime: Boolean(itemRow.ONTIME),
        message,
        updatedProgress: {
          totalRules: progressRow.TotalRules,
          completedRules: progressRow.CompletedRules,
          remainingRules: progressRow.RemainingRules,
        },
      },
    });
  } catch (error) {
    console.error("Error confirming time rule:", error);

    return res.status(500).json({
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to confirm time rule",
        details:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      },
    });
  }
};

const getDayByDate = async (req, res) => {
  try {
    const { date } = req.params;
    const userId = req.userId;

    if (!date) {
      return res.status(400).json({
        success: false,
        error: {
          code: "MISSING_DATE",
          message: "date is required",
        },
      });
    }

    // Validate date format (YYYY-MM-DD)
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) {
      return res.status(400).json({
        success: false,
        error: {
          code: "INVALID_DATE_FORMAT",
          message: "date must be in YYYY-MM-DD format",
        },
      });
    }

    //=================================================
    // EXECUTE STORED PROCEDURE
    //=================================================
    const result = await sequelize.query(
      `EXEC USP_GET_DAY_BY_DATE
          @USERID = :userId,
          @DAYDATE = :dayDate`,
      {
        replacements: {
          userId,
          dayDate: date,
        },
        type: QueryTypes.RAW,
      },
    );

    //=================================================
    // PARSE RESULT
    // [0] - Day details
    // [1] - Checklist items
    // [2] - Learning proofs
    // [3] - Daily reflections
    //=================================================

    console.log(JSON.stringify(result, null, 2));

    const rows = result[0] || [];

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        error: {
          code: "DAY_NOT_FOUND",
          message: `No day found for date ${date}`,
          details: { date },
        },
      });
    }

    // 1️⃣ Day row (has DAYID + USERID)
    const dayRow = rows.find(
      (r) => r.DAYID !== undefined && r.USERID !== undefined,
    );

    // 2️⃣ Checklist items (have CHECKLISTITEMID)
    const checklistData = rows.filter((r) => r.CHECKLISTITEMID !== undefined);

    // 3️⃣ Learning proofs (if returned later)
    const proofsData = rows.filter(
      (r) => r.PROOFID !== undefined && r.DESCRIPTIONTEXT !== undefined,
    );

    // 4️⃣ Reflections (if returned later)
    const reflectionsData = rows.filter(
      (r) => r.REFLECTIONID !== undefined && r.WHATHAPPENED !== undefined,
    );

    if (!dayRow) {
      return res.status(404).json({
        success: false,
        error: {
          code: "DAY_NOT_FOUND",
          message: `No day found for date ${date}`,
          details: { date },
        },
      });
    }
    
    //=================================================
    // MAP CHECKLIST WITH PROOFS AND REFLECTIONS
    //=================================================
    const checklist = checklistData.map((item) => {
      const checklistItem = {
        checklistItemId: item.CHECKLISTITEMID,
        ruleId: item.RULEID,
        domainType: item.DOMAINTYPE,
        emoji: item.EMOJI || getEmojiForDomain(item.DOMAINTYPE),
        description: item.DESCRIPTION,
        isCompleted: Boolean(item.ISCOMPLETED),
      };

      // Add completion details if completed
      if (item.ISCOMPLETED) {
        checklistItem.completedAt = item.COMPLETEDAT;
        if (item.COMPLETIONSOURCE) {
          checklistItem.completionSource = item.COMPLETIONSOURCE;
        }
        if (item.COMPLETEDVALUE) {
          checklistItem.completedValue = item.COMPLETEDVALUE;
        }
      }

      // Add required value for time-based rules
      if (item.REQUIREDVALUE) {
        checklistItem.requiredValue = item.REQUIREDVALUE;
      }

      // Attach learning proof if exists
      if (item.PROOFID) {
        const proof = proofsData.find((p) => p.PROOFID === item.PROOFID);
        if (proof) {
          checklistItem.proof = {
            proofId: proof.PROOFID,
            descriptionText: proof.DESCRIPTIONTEXT,
            proofType: proof.PROOFTYPECODE || proof.PROOFTYPES,
            durationMinutes: proof.DURATIONMINUTES,
            attachmentUrl: proof.ATTACHMENTURL,
            submittedAt: proof.SUBMITTEDAT,
          };
        }
      }

      // Attach reflection if exists
      if (item.REFLECTIONID) {
        const reflection = reflectionsData.find(
          (r) => r.REFLECTIONID === item.REFLECTIONID,
        );
        if (reflection) {
          checklistItem.reflection = {
            reflectionId: reflection.REFLECTIONID,
            whatHappened: reflection.WHATHAPPENED,
            whatBlocked: reflection.WHATBLOCKED,
            planForTomorrow: reflection.PLANFORTOMORROW,
            createdAt: reflection.CREATEDAT,
          };
        }
      }

      return checklistItem;
    });

    //=================================================
    // BUILD VERDICT MESSAGE (for closed days)
    //=================================================
    let verdict = null;
    if (dayRow.STATUS === "CLOSED") {
      const missedItems = checklist
        .filter((item) => !item.isCompleted)
        .map((item) => item.description);

      let verdictMessage = "";
      if (dayRow.RESULT === "PASS") {
        verdictMessage = `Day ${dayRow.DAYNUMBER}: Pass\n\nYou completed all ${dayRow.TOTALRULES} non-negotiables.`;
      } else if (dayRow.RESULT === "FAIL") {
        verdictMessage = `Day ${dayRow.DAYNUMBER}: Incomplete\n\nYou completed ${dayRow.COMPLETEDRULES}/${dayRow.TOTALRULES} non-negotiables.\n\nMissed:\n${missedItems.map((item) => `- ${item}`).join("\n")}`;
      }

      verdict = {
        result: dayRow.RESULT,
        message: verdictMessage,
        completedRules: dayRow.COMPLETEDRULES,
        totalRules: dayRow.TOTALRULES,
        missedItems: dayRow.RESULT === "FAIL" ? missedItems : undefined,
      };
    }

    //=================================================
    // BUILD COMPLETE RESPONSE
    //=================================================
    const responseData = {
      dayId: dayRow.DAYID,
      userId: dayRow.USERID,
      date: dayRow.DAYDATE,
      dayNumber: dayRow.DAYNUMBER,
      mode: dayRow.MODE,
      status: dayRow.STATUS,
      result: dayRow.RESULT,
      checklist,
    };

    // Add timing for closed days
    if (dayRow.STATUS === "CLOSED") {
      responseData.closedAt = dayRow.CLOSEDAT;
      responseData.evaluatedAt = dayRow.EVALUATEDAT;
      responseData.verdict = verdict;
    } else {
      // For open days, add timing info
      responseData.startedAt = dayRow.STARTEDAT;
      responseData.closesAt = dayRow.CLOSEDAT;
    }

    // Add minimum mode reason if applicable
    if (dayRow.MODE === "MINIMUM" && dayRow.MINIMUMMODEREASON) {
      responseData.minimumModeReason = dayRow.MINIMUMMODEREASON;
    }

    return res.status(200).json({
      success: true,
      data: responseData,
    });
  } catch (error) {
    console.error("Error fetching day by date:", error);

    return res.status(500).json({
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to fetch day",
        details:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      },
    });
  }
};

const getDayHistory = async (req, res) => {
  try {
    const userId = req.userId;
    const { page = 1, limit = 7 } = req.query;

    // =============================================
    // VALIDATION
    // =============================================
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);

    if (isNaN(pageNum) || pageNum < 1) {
      return res.status(400).json({
        success: false,
        error: {
          code: "INVALID_PAGE",
          message: "page must be a positive integer",
        },
      });
    }

    if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
      return res.status(400).json({
        success: false,
        error: {
          code: "INVALID_LIMIT",
          message: "limit must be between 1 and 100",
        },
      });
    }

    // =============================================
    // EXECUTE STORED PROCEDURE
    // =============================================
    const result = await sequelize.query(
      `EXEC USP_GET_DAY_HISTORY
        @USERID = :userId,
        @PAGE = :page,
        @LIMIT = :limit`,
      {
        replacements: {
          userId,
          page: pageNum,
          limit: limitNum,
        },
        type: QueryTypes.RAW,
      }
    );

    // console.log(JSON.stringify(result, null, 2));

    const rawData = result[0] || [];

    // =============================================
    // DYNAMIC PARSING (KEY-BASED ✅)
    // =============================================
    const pagination = rawData.find((r) => r.UserId);
    const daysList = rawData.filter((r) => r.DAYID);
    const summaryStats = rawData.find((r) => r.PassedDays !== undefined);
    const patternData = rawData.find((r) => r.Pattern);
    const domainStats = rawData.filter((r) => r.DOMAINTYPE);

    // =============================================
    // ERROR HANDLING
    // =============================================
    if (pagination && pagination.ErrorCode) {
      return res.status(200).json({
        success: false,
        error: {
          code: pagination.ErrorType || "NO_HISTORY",
          message: pagination.ErrorMessage,
          details: {
            userId: pagination.UserId,
          },
        },
      });
    }

    if (!pagination) {
      return res.status(200).json({
        success: false,
        error: {
          code: "NO_HISTORY",
          message: "No day history found for this user",
          details: { userId },
        },
      });
    }

    // =============================================
    // BUILD DAYS ARRAY
    // =============================================
    const days = daysList.map((day) => ({
      dayId: day.DAYID,
      date: day.DAYDATE,
      dayNumber: day.DAYNUMBER,
      mode: day.MODE,
      result: day.RESULT,
      completedRules: day.COMPLETEDRULES,
      totalRules: day.TOTALRULES,
      closedAt: day.CLOSEDAT,
      evaluatedAt: day.EVALUATEDAT,
    }));

    // =============================================
    // BUILD SUMMARY
    // =============================================
    const summary = {
      passedDays: 0,
      failedDays: 0,
      passRate: 0,
      pattern: "",
      mostMissed: {},
      alwaysCompleted: {},
    };

    // Basic stats
    if (summaryStats) {
      summary.passedDays = summaryStats.PassedDays || 0;
      summary.failedDays = summaryStats.FailedDays || 0;
      summary.passRate = Math.round(summaryStats.PassRate || 0);
    }

    // Pattern
    if (patternData) {
      summary.pattern = patternData.Pattern;
    }

    // Domain stats (dynamic)
    domainStats.forEach((stat) => {
      if (stat.TimesMissed !== undefined) {
        summary.mostMissed = {
          domainType: stat.DOMAINTYPE,
          description: stat.DESCRIPTION,
          timesMissed: stat.TimesMissed,
        };
      }

      if (stat.CompletionRate !== undefined) {
        summary.alwaysCompleted = {
          domainType: stat.DOMAINTYPE,
          description: stat.DESCRIPTION,
          completionRate: Math.round(stat.CompletionRate || 0),
        };
      }
    });

    // =============================================
    // FINAL RESPONSE
    // =============================================
    return res.status(200).json({
      success: true,
      data: {
        userId: pagination.UserId,
        page: pagination.CurrentPage,
        limit: pagination.PageLimit,
        totalDays: pagination.TotalDays,
        totalPages: pagination.TotalPages,
        days,
        summary,
      },
    });
  } catch (error) {
    console.error("Error fetching day history:", error);

    return res.status(500).json({
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to fetch day history",
        details:
          process.env.NODE_ENV === "development"
            ? error.message
            : undefined,
      },
    });
  }
};

module.exports = {
  getTodayDashboard,
  completeChecklistItem,
  submitLearningProof,
  submitDailyReflection,
  confirmTimeRule,
  getDayByDate,
  getDayHistory,
};
