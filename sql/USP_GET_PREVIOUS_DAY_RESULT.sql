-- Run this on DAILY_EXECUTION so /internal/day/previous-result (GET query or POST JSON) returns rule counts for notifications.
-- Without TOTALRULES / COMPLETEDRULES in the result set, the API defaults them to 0.

USE [DAILY_EXECUTION];
GO

SET ANSI_NULLS ON;
GO
SET QUOTED_IDENTIFIER ON;
GO

ALTER PROCEDURE [dbo].[USP_GET_PREVIOUS_DAY_RESULT]
(
    @USERID INT,
    @CURRENTDAYDATE DATE
)
AS
BEGIN
    SET NOCOUNT ON;

    SELECT TOP 1
        DAYID,
        DAYDATE,
        DAYNUMBER,
        MODE,
        RESULT,
        TOTALRULES,
        COMPLETEDRULES
    FROM USERDAY
    WHERE USERID = @USERID
      AND DAYDATE < @CURRENTDAYDATE
      AND STATUS = 'CLOSED'
    ORDER BY DAYDATE DESC;
END
GO
