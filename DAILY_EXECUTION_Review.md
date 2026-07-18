# Daily Execution Service & Database — Review

**Reviewed:** DAILY_EXECUTION microservice + DAILY_EXECUTION MSSQL database and stored procedures  
**Aligned to:** P-OS BRD (§4.1, FR-013–FR-022, BR-001–BR-003), P-OS Complete Screens Flow (daily checklist, proof, reflection, verdict)

---

## 1. Service Overview

| Item | Value |
|------|--------|
| **Stack** | Node.js, Express, Sequelize, MSSQL |
| **Default port** | 5001 (was 3001; changed to avoid conflict with other services) |
| **Gateway path** | `/daily` → pathRewrite to `` (e.g. `GET /daily/day/today?userId=1` → Daily Execution `GET /day/today?userId=1`) |

**Route summary**

| Prefix | Purpose |
|--------|---------|
| **/day** | User-facing: today dashboard, complete item, learning proof, reflection, confirm time rule (sleep), get day by date, history |
| **/internal** | Scheduler / back-end: create user day, close day, get day summary, update day result |

---

## 2. Database Schema — Alignment with BRD

### 2.1 Tables (create order for FKs)

1. **USERDAY** — One row per user per calendar day. DAYID, USERID, RULESETID, VERSIONNUMBER, DAYDATE, DAYNUMBER, MODE (STANDARD/MINIMUM), STATUS (OPEN/CLOSED), RESULT (PASS/FAIL/PENDING), TOTALRULES, COMPLETEDRULES, EVALUATEDAT, MINIMUMMODEREASON, STARTEDAT, CLOSEDAT. Unique (USERID, DAYDATE).  
   **BRD:** FR-013 (day number, mode, checklist), FR-019 (day close, verdict), BR-001 (binary Pass/Incomplete). ✓

2. **DAYCHECKLISTITEM** — One row per rule per day. FK USERDAY; RULEID, DESCRIPTION, DOMAINTYPE, REQUIREDVALUE, COMPLETEDVALUE, ISCOMPLETED, COMPLETEDAT, COMPLETIONSOURCE, PROOFID (FK LEARNINGPROOF), REFLECTIONID (FK DAILYREFLECTION), ALLOWEDPROOFTYPES, REFLECTIONTIMING (MORNING/EVENING/BOTH).  
   **BRD:** FR-015 (Body/Fuel/Sleep tap complete), FR-016 (Learning proof), FR-017 (Reflection 3 questions), FR-018 (Sleep confirm at/after target). ✓

3. **LEARNINGPROOF** — FK USERDAY. DESCRIPTIONTEXT, PROOFTYPES (proof type ID stored), ATTACHMENTURL, DURATIONMINUTES, SUBMITTEDAT.  
   **BRD:** FR-016 (1–3 sentence description, proof type from onboarding). ✓

4. **DAILYREFLECTION** — FK USERDAY. RULEID, WHATHAPPENED, WHATBLOCKED, PLANFORTOMORROW, CREATEDAT.  
   **BRD:** FR-017 (same 3 questions daily). ✓

**Cross-database:** DAYCHECKLISTITEM and several SPs reference **RULE_MANAGEMENT.dbo** (DOMAIN_MASTER, PROOF_TYPE_MASTER). Ensure both databases are on the same server (or linked server) and that the DAILY_EXECUTION DB user has SELECT on RULE_MANAGEMENT.

**Terminology (BR-002):** BRD says use "Incomplete" not "Fail". The schema and SPs use RESULT = 'PASS' | 'FAIL'. Keep PASS/FAIL in DB; in API responses and UI map FAIL → "Incomplete" so user-facing copy matches BR-002.

---

## 3. Stored Procedures — Summary

| SP | Purpose | BRD / flow |
|----|---------|-------------|
| **USP_GET_TODAY_DASHBOARD** | Day + checklist + proofs + reflections + week summary (if closed) + proof type master. Uses RULE_MANAGEMENT for DOMAIN_MASTER, RULE_SET, PROOF_TYPE_MASTER. | Morning view (FR-013). |
| **USP_GET_DAY_BY_DATE** | Day + checklist + learning proofs + reflections for a given date. | Get specific day (e.g. verdict view). |
| **USP_GET_DAY_SUMMARY** | Day + checklist + completed/missed rule IDs + proofs + reflections by DAYID. | Verdict / summary. |
| **USP_GET_DAY_HISTORY** | Paginated closed days, pass rate, pattern string, most missed rule, always completed rule. | Weekly view (FR-027). |
| **USP_COMPLETE_CHECKLIST_ITEM** | Mark non-Learning, non-Reflection, non–proof-required item complete. Rejects if day closed, already completed, or Learning/Reflection (directs to proof/reflection endpoints). | Body/Fuel tap complete (FR-015). |
| **USP_CONFIRM_TIME_RULE** | Sleep (time-based) confirm: user confirms at/after target time; validates not past deadline, then marks complete. | Sleep "In bed now?" (FR-018). |
| **USP_SUBMIT_LEARNING_PROOF** | Validate proof type allowed, description length (≥20), duration 1–600 min; insert LEARNINGPROOF, update checklist item and USERDAY.COMPLETEDRULES. | Learning proof (FR-016). |
| **USP_SUBMIT_DAILY_REFLECTION** | Validate all 3 fields, min length 10 each; insert DAILYREFLECTION, link to checklist item, update completed count. | Reflection 3 questions (FR-017). |
| **USP_CREATE_USER_DAY** | Create USERDAY + DAYCHECKLISTITEM from rules JSON. Validates mode (STANDARD 3–5 rules, MINIMUM exactly 2), no duplicate day. | Scheduler: new day at day start. |
| **USP_CLOSE_DAY** | Set STATUS=CLOSED, RESULT=PASS if COMPLETEDRULES=TOTALRULES else FAIL, CLOSEDAT, EVALUATEDAT. Returns day + incomplete items. | Day close at boundary (FR-019). |
| **USP_UPDATE_DAY_RESULT** | Optional: set RESULT and EVALUATEDAT on already-closed day (with validation). | Audit/correction if ever needed. |

**No retroactive completion:** USP_COMPLETE_CHECKLIST_ITEM, USP_CONFIRM_TIME_RULE, USP_SUBMIT_LEARNING_PROOF, USP_SUBMIT_DAILY_REFLECTION all reject when day is CLOSED. Aligns with BR-003 and FR-021.

---

## 4. Service Code — Strengths

- **SP usage:** All persistence via stored procedures; controllers build params and parse multiple result sets (RAW). Clear separation.
- **Validation:** Controllers validate userId, dayId, body fields before calling SPs; SPs add server-side checks (day belongs to user, day open, not already completed).
- **Learning:** Proof type validated against rule’s ALLOWEDPROOFTYPES; description length and duration validated in SP.
- **Reflection:** All three questions required; min length enforced in SP.
- **Sleep:** Confirm-time flow uses USP_CONFIRM_TIME_RULE; deadline check in SP.
- **Error handling:** SP error codes mapped to HTTP status and error response shape.

---

## 5. Gaps / Recommendations

### 5.1 Configuration

- **database.js:** Credentials and host are hardcoded. Move to env (e.g. `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`).

### 5.2 RESULT terminology (BR-002)

- DB and SPs use **FAIL**. BRD requires user-facing term **Incomplete**. In API responses (e.g. getTodayDashboard, getDayHistory, closeDay), map `result: 'FAIL'` → `result: 'Incomplete'` (or add a field `resultDisplay: 'Incomplete'`) so clients and notifications use "Incomplete" only.

### 5.3 USP_GET_TODAY_DASHBOARD result sets

- The SP returns **multiple result sets** (day row, checklist, proofs, reflections, week summary, proof type master). With Sequelize RAW, `result` is an array of result sets; `result[0]` may be the first set. The controller parses a single flat `result[0]` and splits by column presence (DAYNUMBER, CHECKLISTITEMID, PROOFTYPEID). Confirm that Sequelize RAW returns the first result set as a single array of rows and that the SP’s result set order matches the controller’s expectations (e.g. proof type master in a later set may need to be `result[5]` or similar). If the SP returns 7 separate SELECTs, RAW may give `result = [rows1, rows2, ...]`; then day = result[0], checklist = result[1], etc. Verify and document.

### 5.4 Internal routes and gateway

- **/internal/** (create day, close day, summary, update result) is for **Scheduler** and **Discipline Rule Engine**, not for end-user clients. The gateway proxies `/daily` including `/daily/internal/*`. Restrict internal routes to server-side callers (e.g. API key or network policy) or document that clients must not call them.

### 5.5 USERID source

- Endpoints take userId from query or body. When called via the gateway, ensure the authenticated user cannot act for another user: either require `userId` to match `req.user.userId` (gateway middleware) or have the service resolve userId from the token/session and ignore client-supplied userId for authorization.

### 5.6 Cross-database dependency

- DAILY_EXECUTION SPs reference **RULE_MANAGEMENT.dbo** (DOMAIN_MASTER, PROOF_TYPE_MASTER, RULE_SET). Both DBs must be accessible from the same SQL connection (or use linked server). Document this dependency for deployment.

---

## 6. API Gateway Integration

**Done:**

- **Proxy:** Requests to `/daily/*` are forwarded to Daily Execution service (default `http://localhost:5001`) with `pathRewrite: { "^/daily": "" }`.
- **Examples:**
  - `GET /daily/day/today?userId=1` → Daily Execution `GET /day/today?userId=1`
  - `POST /daily/day/complete-item` (body: userId, checklistItemId, completionSource, completedAt) → `POST /day/complete-item`
  - `POST /daily/day/learning-proof` (body: userId, dayId, ruleId, descriptionText, proofTypeCode, durationMinutes, …) → `POST /day/learning-proof`
  - `POST /daily/day/reflection` (body: userId, dayId, ruleId, whatHappened, whatBlocked, planForTomorrow) → `POST /day/reflection`
  - `POST /daily/day/confirm-time-rule` (body: userId, checklistItemId, confirmed, actualTime) → `POST /day/confirm-time-rule`
  - `GET /daily/day/day/2026-03-14?userId=1` → `GET /day/day/2026-03-14?userId=1`
  - `GET /daily/day/history?userId=1&page=1&limit=7` → `GET /day/history?userId=1&page=1&limit=7`
  - `POST /daily/internal/day/create` (body: userId, ruleSetId, versionNumber, dayDate, dayNumber, mode, startedAt, rules, minimumModeReason) → `POST /internal/day/create`
  - `POST /daily/internal/day/close` (body: dayId, closedAt) → `POST /internal/day/close`
  - `GET /daily/internal/day/:dayId/summary` → `GET /internal/day/:dayId/summary`
  - `POST /daily/internal/day/:dayId/result` (body: result, evaluatedAt, totalRequired, totalCompleted) → `POST /internal/day/:dayId/result`

**Port:** Daily Execution runs on **5001** by default. Set `PORT=5001` in its `.env` if needed.

**Auth:** Gateway JWT and session middleware run before the proxy. Clients must send valid token; optionally enforce `userId` from token for `/daily/day/*`.

---

## 7. BRD / Flow Checklist

| BRD / flow item | Where it’s covered |
|-----------------|--------------------|
| Morning: day number, mode, checklist (FR-013) | USP_GET_TODAY_DASHBOARD; USERDAY.DAYNUMBER, MODE; DAYCHECKLISTITEM. |
| Body/Fuel/Sleep (no proof) tap complete (FR-015) | USP_COMPLETE_CHECKLIST_ITEM (non-Learning, non-Reflection); USP_CONFIRM_TIME_RULE (Sleep). |
| Learning: proof required (FR-016) | USP_SUBMIT_LEARNING_PROOF; DAYCHECKLISTITEM.ALLOWEDPROOFTYPES; LEARNINGPROOF. |
| Reflection: same 3 questions (FR-017) | DAILYREFLECTION (WHATHAPPENED, WHATBLOCKED, PLANFORTOMORROW); USP_SUBMIT_DAILY_REFLECTION. |
| Sleep: confirm at/after target (FR-018) | USP_CONFIRM_TIME_RULE; REQUIREDVALUE as deadline. |
| Day close at boundary, verdict (FR-019) | USP_CLOSE_DAY; RESULT = PASS/FAIL from COMPLETEDRULES vs TOTALRULES. |
| No completion after close (FR-021, BR-003) | All completion SPs check STATUS = 'OPEN'. |
| Verdict: Pass/Incomplete, week, neutral (FR-020) | USP_CLOSE_DAY returns day + incomplete items; map FAIL → Incomplete in API. |
| Weekly view: pass rate, most missed, always completed (FR-027) | USP_GET_DAY_HISTORY. |

---

## 8. Next Steps

1. Move DB config to env.
2. Map RESULT `FAIL` → `Incomplete` in API responses (BR-002).
3. Verify and document USP_GET_TODAY_DASHBOARD result set order and controller parsing (multiple result sets vs single flat array).
4. Enforce userId from token for `/daily/day/*` at gateway or service.
5. Restrict or document `/daily/internal/*` as server-to-server only.
6. Document RULE_MANAGEMENT cross-database dependency for deployment.
7. Add integration tests: create day → complete item → submit proof → submit reflection → close day → get history.

---

*End of Daily Execution review. Service is integrated at `/daily` and ready for use by the app and by Scheduler/Discipline Rule Engine.*
