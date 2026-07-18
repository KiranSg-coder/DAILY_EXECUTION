USE [DAILY_EXECUTION]
GO
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO

/*
Fix: sleep deadline crossing midnight (e.g. target 00:30 belongs to next calendar day).
Also compares full datetime instead of HH:mm string so late-night confirmations are correct.
*/
ALTER PROCEDURE [dbo].[USP_CONFIRM_TIME_RULE]
(
    @USERID INT,
    @CHECKLISTITEMID INT,
    @CONFIRMED BIT,
    @ACTUALTIME DATETIME2
)
AS
BEGIN
    SET NOCOUNT ON;

    BEGIN TRY
        BEGIN TRANSACTION;

        DECLARE @DAYID INT;
        DECLARE @RULEID INT;
        DECLARE @DOMAINTYPE NVARCHAR(50);
        DECLARE @DESCRIPTION NVARCHAR(500);
        DECLARE @REQUIREDVALUE NVARCHAR(100);
        DECLARE @DAYSTATUS NVARCHAR(20);
        DECLARE @ISCOMPLETED BIT;
        DECLARE @TOTALRULES INT;
        DECLARE @COMPLETEDRULES INT;
        DECLARE @DAYDATE DATE;

        DECLARE @ACTUALTIMESTR NVARCHAR(5) = FORMAT(@ACTUALTIME, 'HH:mm');

        SELECT
            @DAYID = CI.DAYID,
            @RULEID = CI.RULEID,
            @DOMAINTYPE = CI.DOMAINTYPE,
            @DESCRIPTION = CI.DESCRIPTION,
            @REQUIREDVALUE = CI.REQUIREDVALUE,
            @ISCOMPLETED = CI.ISCOMPLETED
        FROM DAYCHECKLISTITEM CI
        WHERE CI.CHECKLISTITEMID = @CHECKLISTITEMID;

        IF @DAYID IS NULL
        BEGIN
            SELECT 1 AS ErrorCode, 'ITEM_NOT_FOUND' AS ErrorType, 'Checklist item not found' AS ErrorMessage;
            ROLLBACK;
            RETURN;
        END

        IF NOT EXISTS (
            SELECT 1
            FROM USERDAY
            WHERE DAYID = @DAYID
              AND USERID = @USERID
        )
        BEGIN
            SELECT 2 AS ErrorCode, 'UNAUTHORIZED' AS ErrorType, 'This checklist item does not belong to the specified user' AS ErrorMessage;
            ROLLBACK;
            RETURN;
        END

        SELECT
            @DAYSTATUS = STATUS,
            @TOTALRULES = TOTALRULES,
            @COMPLETEDRULES = COMPLETEDRULES,
            @DAYDATE = CAST(DAYDATE AS DATE)
        FROM USERDAY
        WHERE DAYID = @DAYID;

        IF @DAYSTATUS = 'CLOSED'
        BEGIN
            SELECT 3 AS ErrorCode, 'DAY_CLOSED' AS ErrorType, 'Cannot confirm time rule after day has ended' AS ErrorMessage;
            ROLLBACK;
            RETURN;
        END

        IF @ISCOMPLETED = 1
        BEGIN
            SELECT 4 AS ErrorCode, 'ALREADY_COMPLETED' AS ErrorType, 'This item is already marked as completed' AS ErrorMessage;
            ROLLBACK;
            RETURN;
        END

        IF @DOMAINTYPE != 'SLEEP' OR @REQUIREDVALUE IS NULL
        BEGIN
            SELECT 5 AS ErrorCode, 'NOT_TIME_RULE' AS ErrorType, 'This rule does not require time confirmation' AS ErrorMessage, @DOMAINTYPE AS ActualDomainType;
            ROLLBACK;
            RETURN;
        END

        IF @CONFIRMED = 0
        BEGIN
            SELECT 6 AS ErrorCode, 'USER_DENIED' AS ErrorType, 'User indicated they did not complete the rule on time' AS ErrorMessage;
            ROLLBACK;
            RETURN;
        END

        DECLARE @ONTIME BIT = 0;
        DECLARE @MINUTESDIFF INT;
        DECLARE @RULETIME TIME(0) = TRY_CONVERT(TIME(0), @REQUIREDVALUE);
        DECLARE @BASEDATE DATE = ISNULL(@DAYDATE, CAST(@ACTUALTIME AS DATE));
        DECLARE @DEADLINEDATETIME DATETIME2;

        IF @RULETIME IS NULL
        BEGIN
            SELECT 5 AS ErrorCode, 'NOT_TIME_RULE' AS ErrorType, 'Invalid target time format in REQUIREDVALUE' AS ErrorMessage, @REQUIREDVALUE AS ActualDomainType;
            ROLLBACK;
            RETURN;
        END

        SET @DEADLINEDATETIME = DATEADD(SECOND, DATEDIFF(SECOND, CAST('00:00:00' AS TIME(0)), @RULETIME), CAST(@BASEDATE AS DATETIME2));

        -- Sleep deadlines like 00:30 belong to the NEXT day of the current UserDay.
        IF @RULETIME < CAST('12:00:00' AS TIME(0))
            SET @DEADLINEDATETIME = DATEADD(DAY, 1, @DEADLINEDATETIME);

        IF @ACTUALTIME <= @DEADLINEDATETIME
        BEGIN
            SET @ONTIME = 1;
            SET @MINUTESDIFF = DATEDIFF(MINUTE, @ACTUALTIME, @DEADLINEDATETIME);
        END
        ELSE
        BEGIN
            SET @ONTIME = 0;
            SET @MINUTESDIFF = DATEDIFF(MINUTE, @DEADLINEDATETIME, @ACTUALTIME);

            SELECT
                7 AS ErrorCode,
                'PAST_DEADLINE' AS ErrorType,
                'Sleep rule deadline was ' + @REQUIREDVALUE + '. Current time is ' + FORMAT(@ACTUALTIME, 'HH:mm') + '.' AS ErrorMessage,
                @REQUIREDVALUE AS DeadlineTime,
                FORMAT(@ACTUALTIME, 'HH:mm') AS ActualTime,
                @MINUTESDIFF AS MinutesLate,
                @DEADLINEDATETIME AS DeadlineAt,
                @ACTUALTIME AS ActualAt;
            ROLLBACK;
            RETURN;
        END

        UPDATE DAYCHECKLISTITEM
        SET
            ISCOMPLETED = 1,
            COMPLETEDAT = @ACTUALTIME,
            COMPLETIONSOURCE = 'TIME_CONFIRMATION',
            COMPLETEDVALUE = FORMAT(@ACTUALTIME, 'HH:mm')
        WHERE CHECKLISTITEMID = @CHECKLISTITEMID;

        UPDATE USERDAY
        SET
            COMPLETEDRULES = COMPLETEDRULES + 1,
            UPDATEDDATE = SYSUTCDATETIME()
        WHERE DAYID = @DAYID;

        SELECT @COMPLETEDRULES = COMPLETEDRULES
        FROM USERDAY
        WHERE DAYID = @DAYID;

        COMMIT TRANSACTION;

        SELECT 0 AS ErrorCode, 'SUCCESS' AS Status;

        SELECT
            CI.CHECKLISTITEMID,
            CI.RULEID,
            CI.DESCRIPTION,
            CI.DOMAINTYPE,
            CI.REQUIREDVALUE AS TARGETTIME,
            CI.COMPLETEDVALUE AS ACTUALTIME,
            CI.ISCOMPLETED,
            CI.COMPLETEDAT,
            CI.COMPLETIONSOURCE,
            @ONTIME AS ONTIME,
            @MINUTESDIFF AS MINUTESDIFF
        FROM DAYCHECKLISTITEM CI
        WHERE CI.CHECKLISTITEMID = @CHECKLISTITEMID;

        SELECT
            @TOTALRULES AS TotalRules,
            @COMPLETEDRULES AS CompletedRules,
            (@TOTALRULES - @COMPLETEDRULES) AS RemainingRules;

    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0
            ROLLBACK TRANSACTION;

        SELECT
            99 AS ErrorCode,
            'INTERNAL_ERROR' AS ErrorType,
            ERROR_MESSAGE() AS ErrorMessage,
            ERROR_NUMBER() AS SqlErrorNumber,
            ERROR_LINE() AS SqlErrorLine;
    END CATCH
END
GO
