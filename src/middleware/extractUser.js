const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY;

const extractUser = (req, res, next) => {
  const serviceKey = req.headers["x-service-key"];

  if (INTERNAL_SERVICE_KEY && serviceKey === INTERNAL_SERVICE_KEY) {
    req.isInternal = true;
    const fallbackId = req.query.userId || req.body?.userId;
    if (fallbackId) req.userId = parseInt(fallbackId, 10);
    return next();
  }

  const headerUserId = req.headers["x-user-id"];
  if (!headerUserId) {
    return res.status(401).json({
      success: false,
      error: { code: "UNAUTHORIZED", message: "Missing user context" },
    });
  }

  req.userId = parseInt(headerUserId, 10);
  next();
};

module.exports = extractUser;
