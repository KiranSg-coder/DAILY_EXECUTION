const { QueryTypes } = require("sequelize");
const sequelize = require("../config/database");
const eventPublisher = require("../utils/eventPublisher");
const { EVENT_TYPES, EVENT_CATEGORIES } = require("../config/eventTypes");

/** Flatten recordsets from mssql EXEC (RAW) into one array of row objects. */
function flattenExecRecordsets(rawResult) {
  const out = [];
  if (!Array.isArray(rawResult)) return out;
  for (const chunk of rawResult) {
    if (!chunk) continue;
    if (Array.isArray(chunk)) {
      for (const row of chunk) {
        if (row != null && typeof row === "object" && !Array.isArray(row)) out.push(row);
      }
    } else if (typeof chunk === "object") {
      out.push(chunk);
    }
  }
  return out;
}

function pickPreviousDayDataRow(rows) {
  const dataRow = rows.find(
    (r) =>
      r &&
      (r.DAYID != null || r.DayId != null) &&
      (r.RESULT != null ||
        r.Result != null ||
        r.TOTALRULES != null ||
        r.TotalRules != null ||
        r.COMPLETEDRULES != null ||
        r.CompletedRules != null),
  );
  if (dataRow) return dataRow;
  return (
    rows.find((r) => r && r.DAYNUMBER != null && (r.RESULT != null || r.Result != null)) ||
    rows[rows.length - 1] ||
    null
  );
}


const createUserDay = async (req, res) => {
  try {
    const {
      userId,
      ruleSetId,
      versionNumber,
      dayDate,
      dayNumber,
      mode,
      startedAt,
      rules,
      minimumModeReason,
    } = req.body;

    //=================================================
    // VALIDATION: Required Fields
    //=================================================
    if (!userId || !ruleSetId || !versionNumber) {
      return res.status(400).json({
        success: false,
        error: {
          code: "MISSING_REQUIRED_FIELDS",
          message: "userId, ruleSetId, and versionNumber are required",
        },
      });
    }

    if (!dayDate || !dayNumber) {
      return res.status(400).json({
        success: false,
        error: {
          code: "MISSING_DAY_INFO",
          message: "dayDate and dayNumber are required",
        },
      });
    }

    if (!mode || !["STANDARD", "MINIMUM"].includes(mode)) {
      return res.status(400).json({
        success: false,
        error: {
          code: "INVALID_MODE",
          message: "mode must be either STANDARD or MINIMUM",
          providedMode: mode,
        },
      });
    }

    if (!startedAt) {
      return res.status(400).json({
        success: false,
        error: {
          code: "MISSING_START_TIME",
          message: "startedAt is required",
        },
      });
    }

    if (!rules || !Array.isArray(rules) || rules.length === 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: "MISSING_RULES",
          message: "rules array is required and must contain at least one rule",
        },
      });
    }

    //=================================================
    // VALIDATION: Mode-specific rule count
    //=================================================
    if (mode === "MINIMUM" && rules.length !== 2) {
      return res.status(400).json({
        success: false,
        error: {
          code: "INVALID_MINIMUM_RULE_COUNT",
          message: "Minimum mode must have exactly 2 rules",
          providedRuleCount: rules.length,
        },
      });
    }

    if (mode === "STANDARD" && (rules.length < 3 || rules.length > 5)) {
      return res.status(400).json({
        success: false,
        error: {
          code: "INVALID_STANDARD_RULE_COUNT",
          message: "Standard mode must have 3-5 rules",
          providedRuleCount: rules.length,
        },
      });
    }

    //=================================================
    // VALIDATION: Minimum mode reason required
    //=================================================
    if (mode === "MINIMUM" && !minimumModeReason) {
      return res.status(400).json({
        success: false,
        error: {
          code: "MISSING_MINIMUM_MODE_REASON",
          message: "minimumModeReason is required when mode is MINIMUM",
        },
      });
    }

    console.log(
      `[Daily Execution] Creating day ${dayNumber} for user ${userId} in ${mode} mode`
    );

    //=================================================
    // EXECUTE STORED PROCEDURE
    //=================================================
    const result = await sequelize.query(
      `EXEC USP_CREATE_USER_DAY
          @USERID = :userId,
          @RULESETID = :ruleSetId,
          @VERSIONNUMBER = :versionNumber,
          @DAYDATE = :dayDate,
          @DAYNUMBER = :dayNumber,
          @MODE = :mode,
          @STARTEDAT = :startedAt,
          @RULES = :rules,
          @MINIMUMMODEREASON = :minimumModeReason`,
      {
        replacements: {
          userId: parseInt(userId),
          ruleSetId: parseInt(ruleSetId),
          versionNumber: parseInt(versionNumber),
          dayDate,
          dayNumber: parseInt(dayNumber),
          mode,
          startedAt,
          rules: JSON.stringify(rules),
          minimumModeReason: minimumModeReason || null,
        },
        type: QueryTypes.RAW,
      }
    );

    //=================================================
    // PARSE RESULT
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

    // Parse flattened result set
    const statusResult = rows.find((r) => r.ErrorCode !== undefined);
    const dayRow = rows.find((r) => r.DAYNUMBER !== undefined);
    const checklistData = rows.filter((r) => r.CHECKLISTITEMID !== undefined);

    //=================================================
    // HANDLE ERRORS
    //=================================================
    if (statusResult && statusResult.ErrorCode !== 0) {
      const errorMap = {
        1: { status: 409, code: "DAY_ALREADY_EXISTS" },
        2: { status: 400, code: "INVALID_MODE" },
        3: { status: 400, code: "NO_RULES_PROVIDED" },
        4: { status: 400, code: "INVALID_MINIMUM_RULE_COUNT" },
        5: { status: 400, code: "INVALID_STANDARD_RULE_COUNT" },
        99: { status: 500, code: "INTERNAL_ERROR" },
      };

      const errorInfo = errorMap[statusResult.ErrorCode] || {
        status: 500,
        code: "UNKNOWN_ERROR",
      };

      
      return res.status(errorInfo.status).json({
        success: false,
        error: {
          code: statusResult.ErrorType || errorInfo.code,
          message: statusResult.ErrorMessage,
          details: {
            dayDate: statusResult.DayDate,
            providedMode: statusResult.ProvidedMode,
            providedRuleCount: statusResult.ProvidedRuleCount,
            sqlErrorNumber: statusResult.SqlErrorNumber,
            sqlErrorLine: statusResult.SqlErrorLine,
          },
        },
      });
    }

    if (!dayRow) {
      return res.status(500).json({
        success: false,
        error: {
          code: "DAY_NOT_CREATED",
          message: "Day creation failed - no data returned",
        },
      });
    }

    //=================================================
    // MAP CHECKLIST WITH DOMAIN-SPECIFIC FIELDS
    //=================================================
    const checklistItems = checklistData.map((item) => {
      const baseItem = {
        checklistItemId: item.CHECKLISTITEMID,
        ruleId: item.RULEID,
        domainType: item.DOMAINTYPE,
        description: item.DESCRIPTION,
        requiredValue: item.REQUIREDVALUE,
        completedValue: item.COMPLETEDVALUE,
        isCompleted: Boolean(item.ISCOMPLETED),
        completedAt: item.COMPLETEDAT,
        completionSource: item.COMPLETIONSOURCE,
        proofId: item.PROOFID,
        reflectionId: item.REFLECTIONID,
        createdDate: item.CREATEDDATE,
      };

      // Add LEARNING-specific fields
      if (item.DOMAINTYPE === "LEARNING") {
        baseItem.allowedProofTypes = item.ALLOWEDPROOFTYPES
          ? item.ALLOWEDPROOFTYPES.split(",").map((id) => parseInt(id.trim()))
          : [];
        baseItem.requiresProof = true;
      }

      // Add REFLECTION-specific fields
      if (item.DOMAINTYPE === "REFLECTION") {
        baseItem.reflectionTiming = item.REFLECTIONTIMING;
      }

      return baseItem;
    });

    const completedCount = checklistItems.filter((item) => item.isCompleted).length;
    const totalCount = checklistItems.length;
    const progressPercentage =
      totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

    //=================================================
    // BUILD MODE-SPECIFIC MESSAGE
    //=================================================
    let modeMessage = "";
    let modeAlert = null;

    if (dayRow.MODE === "MINIMUM") {
      modeMessage = `Day ${dayNumber} created in Minimum Mode with ${totalCount} core rules`;
      modeAlert = {
        type: "MINIMUM_MODE_ACTIVE",
        severity: "INFO",
        message: minimumModeReason || "Currently in Minimum Mode",
        details: "Focus on completing these 2 core rules to recover",
      };
    } else {
      modeMessage = `Day ${dayNumber} created successfully in Standard Mode with ${totalCount} rules`;
    }

    //=================================================
    // SUCCESS RESPONSE
    //=================================================
    const responseData = {
      dayId: dayRow.DAYID,
      userId: dayRow.USERID,
      ruleSetId: dayRow.RULESETID,
      versionNumber: dayRow.VERSIONNUMBER,
      dayDate: dayRow.DAYDATE,
      dayNumber: dayRow.DAYNUMBER,
      mode: dayRow.MODE,
      status: dayRow.STATUS,
      result: dayRow.RESULT,
      progress: {
        totalRules: dayRow.TOTALRULES,
        completedRules: dayRow.COMPLETEDRULES,
        percentage: progressPercentage,
      },
      minimumModeReason: dayRow.MINIMUMMODEREASON,
      startedAt: dayRow.STARTEDAT,
      closedAt: dayRow.CLOSEDAT,
      evaluatedAt: dayRow.EVALUATEDAT,
      checklist: checklistItems,
      createdDate: dayRow.CREATEDDATE,
      updatedDate: dayRow.UPDATEDDATE,
      message: modeMessage,
    };

    // Add mode alert if in minimum mode
    if (modeAlert) {
      responseData.alert = modeAlert;
    }

    console.log(
      `[Daily Execution] ✓ Created day ${dayNumber} for user ${userId} - ${dayRow.MODE} mode (${totalCount} rules)`
    );

    await eventPublisher.publish(
      EVENT_TYPES.DAY_CREATED,
      EVENT_CATEGORIES.DAY_LIFECYCLE,
      {
        dayId: dayRow.DAYID,
        userId: dayRow.USERID,
        dayNumber: dayRow.DAYNUMBER,
        dayDate: dayRow.DAYDATE,
        mode: dayRow.MODE,
        totalRules: dayRow.TOTALRULES,
        startedAt: dayRow.STARTEDAT,
        minimumModeReason: dayRow.MINIMUMMODEREASON,
      },
      {
        entityType: "DAY",
        entityId: dayRow.DAYID,
        ruleSetId: dayRow.RULESETID,
      }
    );

    return res.status(201).json({
      success: true,
      data: responseData,
    });
  } catch (error) {
    console.error("[Daily Execution] Error creating user day:", error);

    return res.status(500).json({
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to create user day",
        details: process.env.NODE_ENV === "development" ? error.message : undefined,
      },
    });
  }
};

const closeDay = async (req, res) => {
  try {
    const { dayId, closedAt } = req.body;

    //=================================================
    // VALIDATION: Required Fields
    //=================================================
    if (!dayId) {
      return res.status(400).json({
        success: false,
        error: {
          code: "MISSING_DAY_ID",
          message: "dayId is required",
        },
      });
    }

    if (!closedAt) {
      return res.status(400).json({
        success: false,
        error: {
          code: "MISSING_CLOSED_AT",
          message: "closedAt is required",
        },
      });
    }

    //=================================================
    // EXECUTE STORED PROCEDURE
    //=================================================
    const result = await sequelize.query(
      `EXEC USP_CLOSE_DAY
          @DAYID = :dayId,
          @CLOSEDAT = :closedAt`,
      {
        replacements: {
          dayId: parseInt(dayId),
          closedAt: closedAt,
        },
        type: QueryTypes.RAW,
      }
    );
console.log(JSON.stringify(result, null, 2));

    //=================================================
    // PARSE RESULT
    // [0] - Status (ErrorCode, Status)
    // [1] - Day details
    // [2] - Incomplete items (if any)
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
const statusResult = rows.find(r => r.ErrorCode !== undefined);
const dayRow = rows.find(r => r.DAYID !== undefined);

// Incomplete items (if any) → rows that have CHECKLISTITEMID
const incompleteItems = rows.filter(
  r => r.CHECKLISTITEMID !== undefined
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
        2: { status: 409, code: "ALREADY_CLOSED" },
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
      if (statusResult.ErrorCode === 1 || statusResult.ErrorCode === 2) {
        errorResponse.error.details.dayId = statusResult.DayId;
      } else if (statusResult.ErrorCode === 99) {
        errorResponse.error.details.sqlErrorNumber = statusResult.SqlErrorNumber;
        errorResponse.error.details.sqlErrorLine = statusResult.SqlErrorLine;
      }

      return res.status(errorInfo.status).json(errorResponse);
    }

    //=================================================
    // BUILD SUCCESS RESPONSE
    //=================================================
    

    if (!dayRow) {
      return res.status(500).json({
        success: false,
        error: {
          code: "INCOMPLETE_DATA",
          message: "Day closure succeeded but response data is incomplete",
        },
      });
    }

    const responseData = {
      dayId: dayRow.DAYID,
      userId: dayRow.USERID,
      dayDate: dayRow.DAYDATE,
      dayNumber: dayRow.DAYNUMBER,
      mode: dayRow.MODE,
      status: dayRow.STATUS,
      result: dayRow.RESULT,
      totalRules: dayRow.TOTALRULES,
      completedRules: dayRow.COMPLETEDRULES,
      closedAt: dayRow.CLOSEDAT,
      evaluatedAt: dayRow.EVALUATEDAT,
      readyForEvaluation: Boolean(dayRow.READYFOREVALUATION),
    };

    // Add incomplete items if day failed
    if (dayRow.RESULT === "FAIL" && incompleteItems.length > 0) {
      responseData.incompleteItems = incompleteItems.map((item) => ({
        checklistItemId: item.CHECKLISTITEMID,
        ruleId: item.RULEID,
        description: item.DESCRIPTION,
        domainType: item.DOMAINTYPE,
      }));
    }

    await eventPublisher.publish(
      EVENT_TYPES.DAY_CLOSED,
      EVENT_CATEGORIES.DAY_LIFECYCLE,
      {
        dayId: responseData.dayId,
        userId: responseData.userId,
        dayDate: responseData.dayDate,
        dayNumber: responseData.dayNumber,
        totalRules: responseData.totalRules,
        completedRules: responseData.completedRules,
        closedAt: responseData.closedAt,
        result: responseData.result,
      },
      {
        entityType: "DAY",
        entityId: responseData.dayId,
      }
    );

    return res.status(200).json({
      success: true,
      data: responseData,
    });
  } catch (error) {
    console.error("Error closing day:", error);

    return res.status(500).json({
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to close day",
        details: process.env.NODE_ENV === "development" ? error.message : undefined,
      },
    });
  }
};

const getDaySummary = async (req, res) => {
  try {
    const { dayId } = req.params;

    //=================================================
    // VALIDATION: Required Fields
    //=================================================
    if (!dayId) {
      return res.status(400).json({
        success: false,
        error: {
          code: "MISSING_DAY_ID",
          message: "dayId is required",
        },
      });
    }

    //=================================================
    // EXECUTE STORED PROCEDURE
    //=================================================
    const result = await sequelize.query(
      `EXEC USP_GET_DAY_SUMMARY @DAYID = :dayId`,
      {
        replacements: {
          dayId: parseInt(dayId),
        },
        type: QueryTypes.RAW,
      }
    );
// console.log(JSON.stringify(result, null, 2));
    //=================================================
    // PARSE RESULT
    // [0] - Day details
    // [1] - Checklist items
    // [2] - Completed rule IDs
    // [3] - Missed rules
    // [4] - Learning proofs
    // [5] - Daily reflections
    //=================================================
   const rows = result[0] || [];

if (!rows.length) {
  return res.status(404).json({
    success: false,
    error: {
      code: "DAY_NOT_FOUND",
      message: "Day not found",
      details: { dayId: parseInt(dayId) },
    },
  });
}

// 1️⃣ Day row (has DAYID + USERID + TOTALRULES)
const dayRow = rows.find(
  r => r.DAYID !== undefined && r.USERID !== undefined
);

// 2️⃣ Checklist items (have CHECKLISTITEMID)
const checklistData = rows.filter(
  r => r.CHECKLISTITEMID !== undefined
);

// 3️⃣ Completed rule IDs (rows that ONLY have RULEID)
const completedRuleIds = rows.filter(
  r =>
    r.RULEID !== undefined &&
    r.CHECKLISTITEMID === undefined &&
    r.PROOFID === undefined &&
    r.REFLECTIONID === undefined &&
    r.DAYID === undefined
);

// 4️⃣ Learning proofs (have PROOFID + DESCRIPTIONTEXT)
const learningProofs = rows.filter(
  r => r.PROOFID !== undefined && r.DESCRIPTIONTEXT !== undefined
);

// 5️⃣ Reflections (have REFLECTIONID + WHATHAPPENED)
const reflections = rows.filter(
  r => r.REFLECTIONID !== undefined && r.WHATHAPPENED !== undefined
);

    

   if (!dayRow) {
  return res.status(404).json({
    success: false,
    error: {
      code: "DAY_NOT_FOUND",
      message: "Day not found",
      details: { dayId: parseInt(dayId) },
    },
  });
}

 

    //=================================================
    // BUILD REQUIRED RULES ARRAY (ALL RULES)
    //=================================================
    const requiredRules = checklistData.map((item) => item.RULEID);

    //=================================================
    // BUILD COMPLETED RULES ARRAY
    //=================================================
    const completedRules = completedRuleIds.map((item) => item.RULEID);

    //=================================================
    // BUILD MISSED RULES ARRAY WITH DETAILS
    //=================================================
    const missedRulesDetails = checklistData
  .filter(item => !item.ISCOMPLETED)
  .map(item => ({
    ruleId: item.RULEID,
    domainType: item.DOMAINTYPE,
    description: item.DESCRIPTION,
  }));

    //=================================================
    // BUILD CHECKLIST WITH ENRICHED DATA
    //=================================================
    const checklist = checklistData.map((item) => {
      const checklistItem = {
        checklistItemId: item.CHECKLISTITEMID,
        ruleId: item.RULEID,
        domainType: item.DOMAINTYPE,
        description: item.DESCRIPTION,
        requiredValue: item.REQUIREDVALUE,
        completedValue: item.COMPLETEDVALUE,
        isCompleted: Boolean(item.ISCOMPLETED),
        completedAt: item.COMPLETEDAT,
        completionSource: item.COMPLETIONSOURCE,
      };

      // Add proof flag and details if exists
      if (item.HASPROOF) {
        checklistItem.hasProof = true;
        const proof = learningProofs.find((p) => p.PROOFID === item.PROOFID);
        if (proof) {
          checklistItem.proofDetails = {
            proofId: proof.PROOFID,
            descriptionLength: proof.DESCRIPTIONTEXT
              ? proof.DESCRIPTIONTEXT.length
              : 0,
            proofType: proof.PROOFTYPES,
            durationMinutes: proof.DURATIONMINUTES,
            submittedAt: proof.SUBMITTEDAT,
          };
        }
      }

      // Add reflection flag and summary if exists
      if (item.HASREFLECTION) {
        checklistItem.hasReflection = true;
        const reflection = reflections.find(
          (r) => r.REFLECTIONID === item.REFLECTIONID
        );
        if (reflection) {
          checklistItem.reflectionDetails = {
            reflectionId: reflection.REFLECTIONID,
            hasContent: Boolean(
              reflection.WHATHAPPENED ||
                reflection.WHATBLOCKED ||
                reflection.PLANFORTOMORROW
            ),
            createdAt: reflection.CREATEDAT,
          };
        }
      }

      return checklistItem;
    });

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
      ruleSetId: dayRow.RULESETID,
      ruleSetVersion: dayRow.RULESETVERSION,
      requiredRules,
      completedRules,
      missedRules: missedRulesDetails,
      totalRules: dayRow.TOTALRULES,
      completedRulesCount: dayRow.COMPLETEDRULES,
      completionPercentage: dayRow.TOTALRULES > 0
        ? Math.round((dayRow.COMPLETEDRULES / dayRow.TOTALRULES) * 100)
        : 0,
      checklist,
      timing: {
        startedAt: dayRow.STARTEDAT,
        closedAt: dayRow.CLOSEDAT,
        evaluatedAt: dayRow.EVALUATEDAT,
      },
    };

    // Add minimum mode reason if applicable
    if (dayRow.MODE === "MINIMUM" && dayRow.MINIMUMMODEREASON) {
      responseData.minimumModeReason = dayRow.MINIMUMMODEREASON;
    }

    return res.status(200).json({
      success: true,
      data: responseData,
    });
  } catch (error) {
    console.error("Error fetching day summary:", error);

    return res.status(500).json({
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to fetch day summary",
        details: process.env.NODE_ENV === "development" ? error.message : undefined,
      },
    });
  }
};

const updateDayResult = async (req, res) => {
  try {
    const { dayId } = req.params;
    const { result, evaluatedAt, totalRequired, totalCompleted, missedRules } = req.body;

    //=================================================
    // VALIDATION: Required Fields
    //=================================================
    if (!dayId) {
      return res.status(400).json({
        success: false,
        error: {
          code: "MISSING_DAY_ID",
          message: "dayId is required",
        },
      });
    }

    if (!result) {
      return res.status(400).json({
        success: false,
        error: {
          code: "MISSING_RESULT",
          message: "result is required",
        },
      });
    }

    if (!["PASS", "FAIL"].includes(result)) {
      return res.status(400).json({
        success: false,
        error: {
          code: "INVALID_RESULT",
          message: "result must be either PASS or FAIL",
        },
      });
    }

    if (!evaluatedAt) {
      return res.status(400).json({
        success: false,
        error: {
          code: "MISSING_EVALUATED_AT",
          message: "evaluatedAt is required",
        },
      });
    }

    if (totalRequired === undefined || totalRequired === null) {
      return res.status(400).json({
        success: false,
        error: {
          code: "MISSING_TOTAL_REQUIRED",
          message: "totalRequired is required",
        },
      });
    }

    if (totalCompleted === undefined || totalCompleted === null) {
      return res.status(400).json({
        success: false,
        error: {
          code: "MISSING_TOTAL_COMPLETED",
          message: "totalCompleted is required",
        },
      });
    }

    //=================================================
    // EXECUTE STORED PROCEDURE
    //=================================================
    const sqlResult = await sequelize.query(
      `EXEC USP_UPDATE_DAY_RESULT
          @DAYID = :dayId,
          @RESULT = :result,
          @EVALUATEDAT = :evaluatedAt,
          @TOTALREQUIRED = :totalRequired,
          @TOTALCOMPLETED = :totalCompleted`,
      {
        replacements: {
          dayId: parseInt(dayId),
          result: result,
          evaluatedAt: evaluatedAt,
          totalRequired: parseInt(totalRequired),
          totalCompleted: parseInt(totalCompleted),
        },
        type: QueryTypes.RAW,
      }
    );
console.log(JSON.stringify(sqlResult, null, 2));
    //=================================================
    // PARSE RESULT
    // [0] - Status (ErrorCode, Status)
    // [1] - Updated day details
    //=================================================
    const rows = sqlResult[0] || [];

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
const statusResult = rows.find(r => r.ErrorCode !== undefined);
const dayRow = rows.find(r => r.DAYID !== undefined);

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
        2: { status: 400, code: "DAY_NOT_CLOSED" },
        3: { status: 400, code: "INVALID_RESULT" },
        4: { status: 400, code: "TOTAL_MISMATCH" },
        5: { status: 400, code: "COMPLETED_MISMATCH" },
        6: { status: 400, code: "RESULT_LOGIC_ERROR" },
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
      if (statusResult.ErrorCode === 2) {
        errorResponse.error.details.currentStatus = statusResult.CurrentStatus;
      } else if (statusResult.ErrorCode === 3) {
        errorResponse.error.details.providedResult = statusResult.ProvidedResult;
      } else if (statusResult.ErrorCode === 4) {
        errorResponse.error.details.expected = statusResult.ExpectedTotal;
        errorResponse.error.details.provided = statusResult.ProvidedTotal;
      } else if (statusResult.ErrorCode === 5) {
        errorResponse.error.details.expected = statusResult.ExpectedCompleted;
        errorResponse.error.details.provided = statusResult.ProvidedCompleted;
      } else if (statusResult.ErrorCode === 6) {
        errorResponse.error.details.expectedResult = statusResult.ExpectedResult;
        errorResponse.error.details.providedResult = statusResult.ProvidedResult;
        errorResponse.error.details.completedCount = statusResult.CompletedCount;
        errorResponse.error.details.requiredCount = statusResult.RequiredCount;
      } else if (statusResult.ErrorCode === 99) {
        errorResponse.error.details.sqlErrorNumber = statusResult.SqlErrorNumber;
        errorResponse.error.details.sqlErrorLine = statusResult.SqlErrorLine;
      }

      return res.status(errorInfo.status).json(errorResponse);
    }

    //=================================================
    // BUILD SUCCESS RESPONSE
    //=================================================
    

    if (!dayRow) {
      return res.status(500).json({
        success: false,
        error: {
          code: "INCOMPLETE_DATA",
          message: "Result update succeeded but response data is incomplete",
        },
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        dayId: dayRow.DAYID,
        userId: dayRow.USERID,
        dayDate: dayRow.DAYDATE,
        dayNumber: dayRow.DAYNUMBER,
        mode: dayRow.MODE,
        status: dayRow.STATUS,
        result: dayRow.RESULT,
        totalRules: dayRow.TOTALRULES,
        completedRules: dayRow.COMPLETEDRULES,
        evaluatedAt: dayRow.EVALUATEDAT,
        closedAt: dayRow.CLOSEDAT,
        updated: true,
      },
    });
  } catch (error) {
    console.error("Error updating day result:", error);

    return res.status(500).json({
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to update day result",
        details: process.env.NODE_ENV === "development" ? error.message : undefined,
      },
    });
  }
};

const getNudgeCandidates = async (req, res) => {
  try {
    const { utcTime } = req.query;

    if (!utcTime) {
      return res.status(400).json({
        success: false,
        error: {
          code: "MISSING_UTC_TIME",
          message: "utcTime query parameter is required",
        },
      });
    }

    const result = await sequelize.query(
      `EXEC USP_GET_USERS_FOR_DAY_END_NUDGE @UTCTIME = :utcTime`,
      {
        replacements: { utcTime },
        type: QueryTypes.SELECT,
      }
    );

    console.log(`[Daily Execution] Nudge candidates found: ${result.length}`);

    return res.status(200).json({
      success: true,
      data: result.map((row) => ({
        userId: row.USERID,
        dayId: row.DAYID,
        dayNumber: row.DAYNUMBER,
        dayDate: row.DAYDATE,
        totalRules: row.TOTALRULES,
        completedRules: row.COMPLETEDRULES,
        remainingRules: row.REMAININGRULES,
      })),
    });
  } catch (error) {
    console.error("[Daily Execution] Error fetching nudge candidates:", error);
    return res.status(500).json({
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to fetch nudge candidates",
        details: process.env.NODE_ENV === "development" ? error.message : undefined,
      },
    });
  }
};

const getPreviousDayResult = async (req, res) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const userIdRaw = body.userId ?? req.query.userId;
    const currentDayDateRaw = body.currentDayDate ?? req.query.currentDayDate;

    if (userIdRaw == null || userIdRaw === "" || !currentDayDateRaw) {
      return res.status(400).json({
        success: false,
        error: {
          code: "MISSING_FIELDS",
          message:
            "userId and currentDayDate are required (JSON body on POST, or query on GET)",
        },
      });
    }

    const raw = await sequelize.query(
      `EXEC USP_GET_PREVIOUS_DAY_RESULT
        @USERID = :userId,
        @CURRENTDAYDATE = :currentDayDate`,
      {
        replacements: {
          userId: parseInt(String(userIdRaw), 10),
          currentDayDate: String(currentDayDateRaw).trim(),
        },
        type: QueryTypes.RAW,
      },
    );

    const rows = flattenExecRecordsets(raw);
    const row = pickPreviousDayDataRow(rows);

    console.log(
      `[Daily Execution][PREVIOUS_DAY_RESULT] userId=${userIdRaw} currentDayDate=${currentDayDateRaw} rowCount=${rows.length}`,
    );
    if (rows.length && !row) {
      console.warn(
        "[Daily Execution][PREVIOUS_DAY_RESULT] Could not pick data row; first row keys:",
        rows[0] ? Object.keys(rows[0]) : [],
      );
    }

    if (!row) {
      return res.status(200).json({
        success: true,
        data: null,
        message: "No previous day found",
      });
    }

    const dayId = row.DAYID ?? row.DayId;
    const dayDate = row.DAYDATE ?? row.DayDate;
    const dayNumber = row.DAYNUMBER ?? row.DayNumber;
    const resultVal = row.RESULT ?? row.Result;
    const totalRules = row.TOTALRULES ?? row.TotalRules ?? 0;
    const completedRules = row.COMPLETEDRULES ?? row.CompletedRules ?? 0;
    const mode = row.MODE ?? row.Mode;

    const payload = {
      dayId,
      dayDate,
      dayNumber,
      result: resultVal,
      totalRules: Number(totalRules) || 0,
      completedRules: Number(completedRules) || 0,
      mode,
    };

    console.log(
      `[Daily Execution][PREVIOUS_DAY_RESULT] resolved:`,
      JSON.stringify(payload),
    );

    return res.status(200).json({
      success: true,
      data: payload,
    });
  } catch (error) {
    console.error("[Daily Execution] Error fetching previous day result:", error);
    return res.status(500).json({
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to fetch previous day result",
        details: process.env.NODE_ENV === "development" ? error.message : undefined,
      },
    });
  }
};

module.exports = { createUserDay, closeDay, getDaySummary, updateDayResult, getNudgeCandidates, getPreviousDayResult };