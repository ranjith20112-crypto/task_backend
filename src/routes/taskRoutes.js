import express from "express";
import {
  getTasks,
  getTaskById,
  createTask,
  updateTask,
  updateTaskStatus,
  deleteTask,
  getTaskStats,
  saveToTaskBank,
  getTaskBank,
  assignFromBank,
  deleteFromBank,
  getTasksByGroup,        // ⭐ NEW — fetch sibling tasks of a multi-assign group
  uploadTaskAttachments,  // ⭐ multer middleware (field "attachments")
  uploadTaskFiles,        // ⭐ multer middleware for create/edit form (field "files")
  addTaskAttachments,     // ⭐ handler
  downloadTaskAttachment,
  uploadImportCSV,
  importTasks,
  getScoreboard,
  addSubtask,
  updateSubtask,
  deleteSubtask,
} from "../controllers/taskController.js";
import { requirePermission, requireAnyPermission } from "../middleware/permissionMiddleware.js";

// ⭐⭐⭐ THIS MUST COME FIRST — before any router.<verb>() call
const router = express.Router();

const canView = requirePermission("tasks", "view");

// ==================== TASK BANK ROUTES (legacy isTaskBank tasks) ====================
router.get("/bank", requirePermission("taskbank", "view"), getTaskBank);
router.post("/bank", requirePermission("taskbank", "create"), saveToTaskBank);
router.patch("/bank/:id/assign", requirePermission("taskbank", "assign"), assignFromBank);
router.delete("/bank/:id", requirePermission("taskbank", "delete"), deleteFromBank);

// ==================== STATS ====================
router.get("/stats", canView, getTaskStats);
router.get("/scoreboard", getScoreboard); // own score + org leaderboard (any logged-in user)

// ==================== CSV IMPORT (Task Calendar) ====================
// CSV import — from the Tasks page (tasks.import) or the Task Calendar (calendar.import)
router.post("/import", requireAnyPermission(["tasks", "import"], ["calendar", "import"]), uploadImportCSV, importTasks);

// ==================== ATTACHMENT DOWNLOAD (authenticated + scoped) ====================
router.get("/attachments/:filename", canView, downloadTaskAttachment);

// ⭐⭐⭐ NEW — REGISTER BEFORE /:id
// Otherwise Express would treat "group" as an :id param and route it to
// getTaskById (which would then 404 because "group" isn't a valid ObjectId).
router.get("/group/:groupId", canView, getTasksByGroup);

// ==================== TASK CRUD ====================
router.get("/", canView, getTasks);
router.get("/:id", canView, getTaskById);
router.post("/", requirePermission("tasks", "create"), uploadTaskFiles, createTask);
router.patch("/:id", requirePermission("tasks", "edit"), uploadTaskFiles, updateTask);
router.put("/:id", requirePermission("tasks", "edit"), uploadTaskFiles, updateTask);
// Status changes are part of doing the work — assignees need only tasks.view
router.patch("/:id/status", canView, updateTaskStatus);
router.delete("/:id", requirePermission("tasks", "delete"), deleteTask);

// ==================== SUBTASKS ====================
// adding / moving / removing is checked in the controller (assigner, Manager, Admin);
// the assignee can tick their own subtasks
router.post("/:id/subtasks", canView, addSubtask);
router.patch("/:id/subtasks/:subId", canView, updateSubtask);
router.delete("/:id/subtasks/:subId", canView, deleteSubtask);

// ==================== ATTACHMENTS ====================
router.post("/:id/attachments", canView, uploadTaskAttachments, addTaskAttachments);

export default router;
