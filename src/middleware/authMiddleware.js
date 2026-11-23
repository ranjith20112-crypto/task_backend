// src/middleware/authMiddleware.js
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import ApiKey, { API_KEY_PREFIX, hashApiKey } from "../models/ApiKey.js";

const READ_METHODS = ["GET", "HEAD", "OPTIONS"];

// API key: "X-API-Key: tk_..."  or  "Authorization: Bearer tk_..."
const authenticateApiKey = async (key, req, res, next) => {
  const apiKey = await ApiKey.findOne({ keyHash: hashApiKey(key) });
  if (!apiKey || apiKey.revokedAt || (apiKey.expiresAt && apiKey.expiresAt <= new Date())) {
    return res.status(401).json({ success: false, message: "Invalid, revoked or expired API key." });
  }

  if (apiKey.access === "read" && !READ_METHODS.includes(req.method)) {
    return res.status(403).json({ success: false, message: "This API key is read-only." });
  }

  const user = await User.findById(apiKey.user);
  if (!user || user.status === "Inactive") {
    return res.status(401).json({ success: false, message: "The account behind this API key is not active." });
  }

  // Don't write on every request — at most once a minute
  if (!apiKey.lastUsedAt || Date.now() - apiKey.lastUsedAt.getTime() > 60_000) {
    ApiKey.updateOne({ _id: apiKey._id }, { lastUsedAt: new Date() }).catch(() => {});
  }

  req.user = user;
  req.apiKey = apiKey;
  next();
};

export const authenticate = async (req, res, next) => {
  const header = req.headers.authorization || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : null;
  const apiKey = req.headers["x-api-key"] || (bearer?.startsWith(API_KEY_PREFIX) ? bearer : null);

  if (apiKey) {
    try {
      return await authenticateApiKey(String(apiKey), req, res, next);
    } catch (err) {
      return next(err);
    }
  }

  const token = bearer;
  if (!token) {
    return res.status(401).json({
      success: false,
      message: "No token provided. Please log in.",
    });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const userId = decoded.id || decoded._id || decoded.userId;

    // ⭐ Load FRESH user from DB — role + admin_id always current
    const user = await User.findById(userId);
    if (!user) {
      return res.status(401).json({
        success: false,
        message: "User no longer exists.",
      });
    }

    req.user = user; // full user doc → _id, role, admin_id ✅
    next();
  } catch (err) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired token.",
    });
  }
};

// Block a route for API-key callers (e.g. managing keys needs a real login)
export const requireSession = (req, res, next) => {
  if (req.apiKey) {
    return res.status(403).json({ success: false, message: "This action requires a logged-in session, not an API key." });
  }
  next();
};

export const authorize = (...roles) => (req, res, next) => {
  if (!req.user?.role || !roles.includes(req.user.role)) {
    return res.status(403).json({
      success: false,
      message: `Access denied. Requires role: ${roles.join(" or ")}`,
    });
  }
  next();
};
