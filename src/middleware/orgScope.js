// src/middleware/orgScope.js
// For records that only store the creating user (meetings, tickets):
// req.orgUserIds = every account of the requester's organization (Admin + members).
// SuperAdmin → null (no restriction).
import User from "../models/User.js";

export const attachOrgUsers = async (req, res, next) => {
  try {
    if (req.user.role === "SuperAdmin" || req.orgUserIds !== undefined) {
      req.orgUserIds = req.orgUserIds ?? null;
      return next();
    }
    const orgId = req.adminId;
    if (!orgId) {
      req.orgUserIds = [req.user._id];
      return next();
    }
    const members = await User.find({
      $or: [{ admin_id: orgId }, { createdBy: orgId, admin_id: null }],
    }).select("_id").lean();
    req.orgUserIds = [orgId, ...members.map((m) => m._id)];
    next();
  } catch (err) {
    next(err);
  }
};

// Mongo filter: records created by someone in my organization
export const createdInOrg = (req, field = "createdBy") =>
  req.orgUserIds ? { [field]: { $in: req.orgUserIds } } : {};
