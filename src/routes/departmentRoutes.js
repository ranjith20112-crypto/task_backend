import express from "express";
import mongoose from "mongoose";
import Department from "../models/Department.js";
import { authenticate } from "../middleware/authMiddleware.js"; // ✅ correct name
import { requirePermission } from "../middleware/permissionMiddleware.js";

const router = express.Router();

// ⭐ Organization filter — departments belong to an Admin's org.
// Older records only have createdBy (the Admin), newer ones also have admin_id.
const orgFilter = (req) => {
  if (req.user.role === "SuperAdmin") {
    const adminId = req.query.adminId || req.body?.adminId;
    return mongoose.Types.ObjectId.isValid(adminId)
      ? { $or: [{ admin_id: adminId }, { createdBy: adminId }] }
      : {};
  }
  return { $or: [{ admin_id: req.adminId }, { createdBy: req.adminId }] };
};

// CREATE
router.post("/", authenticate, requirePermission("users", "create"), async (req, res) => {
  try {
    const { name, description } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ success: false, message: "Department name is required" });
    }

    const exists = await Department.findOne({
      ...orgFilter(req),
      name: { $regex: new RegExp(`^${name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") },
    });
    if (exists) {
      return res.status(409).json({ success: false, message: "Department already exists" });
    }

    const orgId =
      req.user.role === "SuperAdmin"
        ? (mongoose.Types.ObjectId.isValid(req.body.adminId) ? req.body.adminId : null)
        : req.adminId;

    const dept = await Department.create({
      name: name.trim(),
      description: description?.trim() || "",
      createdBy: req.user._id,
      admin_id: orgId,                 // ⭐ org key from the token, never the body (except SuperAdmin)
    });

    res.status(201).json({ success: true, data: dept });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// READ — the organization's departments (every member needs these for task forms)
router.get("/", authenticate, async (req, res) => {
  try {
    const departments = await Department.find(orgFilter(req)).sort({ createdAt: 1 });
    res.json({ success: true, data: departments });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE
router.delete("/:id", authenticate, requirePermission("users", "delete"), async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid department ID" });
    }
    const dept = await Department.findOneAndDelete({
      _id: req.params.id,
      ...orgFilter(req),
    });
    if (!dept) return res.status(404).json({ success: false, message: "Department not found" });
    res.json({ success: true, message: "Department deleted" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
