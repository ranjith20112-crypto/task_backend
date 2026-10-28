import mongoose from "mongoose";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";
import Task, { TASK_STATUSES, TASK_PRIORITIES } from "../models/Task.js";
import User from "../models/User.js";
import Department from "../models/Department.js";
import { MEMBER_ROLES } from "../config/permissions.js";
import { hasPermission } from "../middleware/permissionMiddleware.js";
import { readCSV, isValidISODate } from "../utils/csv.js";
import { emitToUser } from "../socket/realtime.js";
import { parseReviewScore, scoreProfile, celebrationFor, levelFor, LEVELS } from "../services/scoreService.js";
import {
  notifyTaskAssigned,
  notifyTaskReassigned,
  notifyStatusChanged,
  notifyReviewDecision,
  notifySubtaskAssigned,
} from "../services/taskNotificationService.js";

// Fire-and-forget: emails must never delay or fail the API response
const announce = (tasks, assignerId) =>
  tasks.forEach((t) => t?.assignedTo && notifyTaskAssigned(t._id || t, assignerId));

/* ==================== FILE UPLOAD SETUP ==================== */

// Absolute path → backend/uploads/tasks (independent of the process cwd)
export const UPLOAD_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../uploads/tasks"
);
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const taskAttachmentStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `task-${Date.now()}-${crypto.randomUUID()}${ext}`);
  },
});

export const ALLOWED_ATTACHMENT_EXTENSIONS = [
  "jpg", "jpeg", "png", "gif", "webp", "pdf", "doc", "docx",
  "xls", "xlsx", "ppt", "pptx", "txt", "csv", "zip",
];
export const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10 MB
export const MAX_ATTACHMENTS_PER_REQUEST = 10;

const attachmentMulter = (field) =>
  multer({
    storage: taskAttachmentStorage,
    limits: { fileSize: MAX_ATTACHMENT_SIZE, files: MAX_ATTACHMENTS_PER_REQUEST },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname).slice(1).toLowerCase();
      if (ALLOWED_ATTACHMENT_EXTENSIONS.includes(ext)) {
        cb(null, true);
      } else {
        const err = new Error(
          `"${file.originalname}" is not a supported file type. Allowed: ${ALLOWED_ATTACHMENT_EXTENSIONS.join(", ")}`
        );
        err.status = 400;
        cb(err);
      }
    },
  }).array(field, MAX_ATTACHMENTS_PER_REQUEST);

// Turns multer errors into clean 400 JSON responses instead of the global 500.
const withUploadErrors = (upload) => (req, res, next) => {
  upload(req, res, async (err) => {
    if (!err) {
      const empty = (req.files || []).find((f) => f.size === 0);
      if (empty) {
        await discardUploads(req);
        return res.status(400).json({ success: false, message: `"${empty.originalname}" is empty` });
      }
      return next();
    }
    let message = err.message || "File upload failed";
    if (err.code === "LIMIT_FILE_SIZE") message = "Each file must be 10 MB or smaller";
    if (err.code === "LIMIT_FILE_COUNT") message = `You can upload at most ${MAX_ATTACHMENTS_PER_REQUEST} files at once`;
    if (err.code === "LIMIT_UNEXPECTED_FILE") message = "Unexpected file field";
    return res.status(400).json({ success: false, message });
  });
};

// POST /:id/attachments (field "attachments")
export const uploadTaskAttachments = withUploadErrors(attachmentMulter("attachments"));
// Create / edit task form (multipart field "files")
export const uploadTaskFiles = withUploadErrors(attachmentMulter("files"));

const toAttachment = (f, userId) => ({
  name: f.originalname,
  size: f.size,
  filename: f.filename,
  mimetype: f.mimetype,
  url: `/api/tasks/attachments/${f.filename}`,
  uploadedBy: userId,
  uploadedAt: new Date(),
});

const unlinkQuietly = (filename) =>
  fs.promises.unlink(path.join(UPLOAD_DIR, path.basename(filename))).catch(() => {});

// Remove files from disk once NO task references them (multi-assign clones share files)
const removeUnreferencedFiles = async (filenames = []) => {
  for (const filename of filenames.filter(Boolean)) {
    const stillUsed = await Task.exists({ "attachments.filename": filename });
    if (!stillUsed) await unlinkQuietly(filename);
  }
};

// Uploaded files of a request that failed validation must not stay on disk
const discardUploads = (req) => Promise.all((req.files || []).map((f) => unlinkQuietly(f.filename)));

/**
 * multipart/form-data sends every field as a string.
 * Parse JSON arrays/objects and booleans back so the JSON code path works unchanged.
 */
const normalizeBody = (req) => {
  if (!req.is("multipart/form-data")) return req.body;
  const body = { ...req.body };
  for (const [key, value] of Object.entries(body)) {
    if (typeof value !== "string") continue;
    const v = value.trim();
    if ((v.startsWith("[") && v.endsWith("]")) || (v.startsWith("{") && v.endsWith("}"))) {
      try { body[key] = JSON.parse(v); } catch { /* keep raw string */ }
    } else if (v === "true" || v === "false") {
      body[key] = v === "true";
    }
  }
  return body;
};

/* ==================== HELPERS ==================== */

class AssignError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Organization of a member account (admin_id; legacy accounts only have createdBy)
const userOrgId = (user) => user?.admin_id || user?.createdBy || null;

const orgMemberQuery = (orgId) => ({
  role: { $in: MEMBER_ROLES },
  $or: [{ admin_id: orgId }, { createdBy: orgId, admin_id: null }],
});

/**
 * Resolve a SINGLE user by ObjectId | name | email (case-insensitive).
 * ⭐ Lookup is restricted to the requester's organization, so a person with the
 *    same name in ANOTHER organization can never be picked up by mistake.
 * Throws AssignError with a user-facing message.
 */
const resolveAssignedUser = async (assignedUser, department, adminId, role) => {
  if (!assignedUser) return null;

  const input = typeof assignedUser === "object" ? assignedUser._id || assignedUser.id || assignedUser.name : assignedUser;
  const trimmed = String(input || "").trim();
  if (!trimmed) return null;

  const isSuper = role === "SuperAdmin";
  if (!isSuper && !adminId) {
    throw new AssignError("Your account is not linked to an organization", 403);
  }
  const scope = isSuper ? { role: { $in: MEMBER_ROLES } } : orgMemberQuery(adminId);

  let user = null;
  if (mongoose.Types.ObjectId.isValid(trimmed)) {
    user = await User.findOne({ _id: trimmed, ...scope }).lean();
    if (!user && (await User.exists({ _id: trimmed }))) {
      throw new AssignError("The selected user is not in your organization", 403);
    }
  }

  if (!user) {
    const byName = await User.find({
      ...scope,
      name: { $regex: new RegExp(`^${escapeRegex(trimmed)}$`, "i") },
    }).limit(5).lean();

    let candidates = byName;
    if (byName.length > 1 && department) {
      candidates = byName.filter(
        (u) => String(u.department || "").toLowerCase() === String(department).toLowerCase()
      );
    }
    if (candidates.length > 1) {
      throw new AssignError(`More than one user is named "${trimmed}". Select the user from the list instead.`);
    }
    user = candidates[0] || null;
  }

  if (!user) {
    user = await User.findOne({ ...scope, email: trimmed.toLowerCase() }).lean();
  }

  if (!user) {
    throw new AssignError(`User "${trimmed}" was not found in your organization`);
  }

  if (user.status === "Inactive") {
    throw new AssignError(`${user.name} is inactive and cannot receive tasks`);
  }

  // ⭐ Department restriction — a department task can only go to that department's people
  if (
    department &&
    user.department &&
    String(user.department).trim().toLowerCase() !== String(department).trim().toLowerCase()
  ) {
    throw new AssignError(`${user.name} is not in the "${department}" department`);
  }

  return user;
};

/**
 * Resolve MULTIPLE users at once — de-dupes by _id.
 */
const resolveAssignedUsers = async (inputs, department, adminId, role) => {
  if (!inputs || inputs.length === 0) return [];
  const resolved = [];
  for (const item of inputs) {
    const u = await resolveAssignedUser(item, department, adminId, role);
    if (u && !resolved.some((r) => String(r._id) === String(u._id))) {
      resolved.push(u);
    }
  }
  return resolved;
};

/**
 * ⭐ KEY HELPER — normalise the `assignedUser` field.
 *
 * The frontend sends the SAME field name (`assignedUser`) for both:
 *   • string  → single user      (old behaviour)
 *   • array   → multi-user        (new behaviour)
 * `assignedUsers` (array) is honoured when it holds more than one entry.
 *
 * Returns one of:
 *   { mode: "none"    }                      — explicitly unassign
 *   { mode: "single", value: "ranjith" }    — single user
 *   { mode: "multi",  values: ["a","b"] }   — multi-user
 *   { mode: "skip"    }                      — field not provided
 */
const normalizeAssignedUserInput = (assignedUser, assignedUsers) => {
  if (Array.isArray(assignedUsers) && assignedUsers.filter(Boolean).length > 1) {
    assignedUser = assignedUsers;
  }

  if (assignedUser === undefined) return { mode: "skip" };

  // Explicit unassign
  if (assignedUser === null || assignedUser === "") return { mode: "none" };

  // Array → multi (single-element arrays collapse to "single" for safety)
  if (Array.isArray(assignedUser)) {
    const cleaned = assignedUser
      .map((v) => (typeof v === "string" ? v.trim() : v))
      .filter((v) => v !== "" && v !== null && v !== undefined);

    if (cleaned.length === 0) return { mode: "none" };
    if (cleaned.length === 1) return { mode: "single", value: cleaned[0] };
    return { mode: "multi", values: cleaned };
  }

  // Plain string/ObjectId
  return { mode: "single", value: assignedUser };
};

const isOrgAdmin = (req) => ["SuperAdmin", "Admin"].includes(req.user.role);
const isSelf = (req, user) => user && String(user._id || user) === String(req.user._id);

// Assigning work to anyone other than yourself requires tasks.assign
const ensureCanAssign = (req, users, moduleId = "tasks") => {
  if (users.every((u) => isSelf(req, u))) return;
  if (!hasPermission(req, moduleId, "assign")) {
    throw new AssignError("You do not have permission to assign tasks to other users", 403);
  }
};

/**
 * Task-level authorization (on top of module permission + data scope):
 *   SuperAdmin / Admin → any task in their scope
 *   Manager            → any task in his scope (his department + his own)
 *   User               → only tasks he created; assignees may only change status
 */
const canModifyTask = (req, task) => {
  if (isOrgAdmin(req) || req.user.role === "Manager") return true;
  return Boolean(task.assignedBy) && String(task.assignedBy) === String(req.user._id);
};

const sendError = (res, error) => {
  const status = error.status || (error.name === "ValidationError" || error.name === "CastError" ? 400 : 500);
  return res.status(status).json({ success: false, message: error.message });
};

const getActor = async (req) => {
  if (req.user?.name) return { id: req.user.id, name: req.user.name };
  try {
    const user = await User.findById(req.user.id).select("name email");
    return { id: req.user.id, name: user?.name || user?.email || "Unknown" };
  } catch {
    return { id: req.user.id, name: "Unknown" };
  }
};

const shapeAttachment = (a) => ({
  name: a.name,
  size: a.size,
  filename: a.filename || "",
  mimetype: a.mimetype || "",
  url: a.filename ? `/api/tasks/attachments/${a.filename}` : a.url || "",
  uploadedAt: a.uploadedAt || null,
  downloadable: Boolean(a.filename),
});

const shapeTask = (task) => {
  const t = task.toObject ? task.toObject() : task;
  return {
    id: t._id,
    name: t.name,
    referenceId: t.referenceId,
    department: t.department,
    assignedUser: t.assignedTo?.name || "",
    assignedTo: t.assignedTo?._id || t.assignedTo || null,
    assignedBy: t.assignedBy?._id || t.assignedBy || null,
    assignedByName: t.assignedBy?.name || "",
    taskGroupId: t.taskGroupId || null,
    sourceTemplate: t.sourceTemplate || null,
    description: t.description,
    dueDate: t.dueDate ? new Date(t.dueDate).toISOString().slice(0, 10) : "",
    dueTime: t.dueTime || "",
    priority: t.priority,
    complexity: t.complexity,
    reward: t.reward,
    recurring: t.recurring,
    recurrenceInterval: t.recurrenceInterval,
    attachments: (t.attachments || []).map(shapeAttachment),
    subtasks: t.subtasks,
    isTaskBank: t.isTaskBank || false,
    status: t.status,
    statusHistory: t.statusHistory,
    reworkCount: t.reworkCount || 0,
    reviewScore: t.reviewScore ?? null,
    completedAt: t.completedAt,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
};

const populateTask = (query) =>
  query.populate("assignedTo", "name email department").populate("assignedBy", "name email");

/* ==================== GET /api/tasks  ==================== */
export const getTasks = async (req, res) => {
  try {
    const { status, priority, department, assignedTo, search } = req.query;

    const filter = { ...req.scope };
    filter.isTaskBank = { $ne: true };

    if (status && status !== "All Status") filter.status = status;
    if (priority && priority !== "All Priority") filter.priority = priority;
    if (department && department !== "All Departments") filter.department = department;
    if (assignedTo) filter.assignedTo = assignedTo;

    if (search) {
      const rx = { $regex: search, $options: "i" };
      const searchOr = [{ name: rx }, { description: rx }, { department: rx }, { referenceId: rx }];
      if (filter.$or) {
        filter.$and = [{ $or: filter.$or }, { $or: searchOr }];
        delete filter.$or;
      } else {
        filter.$or = searchOr;
      }
    }

    const tasks = await Task.find(filter)
      .populate("assignedTo", "name email department")
      .populate("assignedBy", "name email")
      .sort({ createdAt: -1 });

    res.json({ success: true, count: tasks.length, data: tasks.map(shapeTask) });
  } catch (error) {
    sendError(res, error);
  }
};

/* ==================== GET /api/tasks/:id ==================== */
export const getTaskById = async (req, res) => {
  try {
    const task = await Task.findOne({ _id: req.params.id, ...req.scope })
      .populate("assignedTo", "name email department")
      .populate("assignedBy", "name email");

    if (!task) return res.status(404).json({ success: false, message: "Task not found" });
    res.json({ success: true, data: shapeTask(task) });
  } catch (error) {
    sendError(res, error);
  }
};

/* ⭐ NEW — GET /api/tasks/group/:groupId */
export const getTasksByGroup = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.groupId)) {
      return res.status(400).json({ success: false, message: "Invalid groupId" });
    }
    const tasks = await Task.find({ taskGroupId: req.params.groupId, ...req.scope })
      .populate("assignedTo", "name email department")
      .populate("assignedBy", "name email")
      .sort({ createdAt: 1 });

    res.json({ success: true, count: tasks.length, data: tasks.map(shapeTask) });
  } catch (error) {
    sendError(res, error);
  }
};

/* ==================== POST /api/tasks  ====================
 * JSON or multipart/form-data (field "files" for attachments).
 * `assignedUser` accepts a string (single) or an array (multi).
 */
export const createTask = async (req, res) => {
  try {
    const body = normalizeBody(req);
    const {
      name, referenceId, department, description,
      dueDate, dueTime, priority, complexity, reward, recurring,
      recurrenceInterval, subtasks, status,
      assignedUser, assignedUsers,
    } = body;

    if (!name || !String(name).trim()) {
      await discardUploads(req);
      return res.status(400).json({ success: false, message: "Task name is required" });
    }

    if (priority && !TASK_PRIORITIES.includes(priority)) {
      await discardUploads(req);
      return res.status(400).json({ success: false, message: `Invalid priority. Allowed: ${TASK_PRIORITIES.join(", ")}` });
    }

    const actor = await getActor(req);
    const inputMode = normalizeAssignedUserInput(assignedUser, assignedUsers);

    // Resolve users based on input shape (org-scoped, department-checked)
    let users = [];
    try {
      if (inputMode.mode === "multi") {
        users = await resolveAssignedUsers(inputMode.values, department, req.adminId, req.user.role);
      } else if (inputMode.mode === "single") {
        const u = await resolveAssignedUser(inputMode.value, department, req.adminId, req.user.role);
        if (u) users = [u];
      }
      ensureCanAssign(req, users);
    } catch (err) {
      await discardUploads(req);
      return sendError(res, err);
    }

    if (req.user.role === "SuperAdmin" && users.length === 0) {
      await discardUploads(req);
      return res.status(400).json({
        success: false,
        message: "Select an assignee so the task belongs to an organization",
      });
    }

    const initialStatus = TASK_STATUSES.includes(status) ? status : "To Do";

    // ⭐ Attachments come ONLY from files actually uploaded with this request
    const attachments = (req.files || []).map((f) => toAttachment(f, req.user._id));

    const basePayload = {
      name: String(name).trim(),
      referenceId: referenceId || "",
      department: department || "",
      assignedBy: req.user._id,
      assignedAt: new Date(),
      isTaskBank: false,
      description: description || "",
      dueDate: dueDate || undefined,
      dueTime: dueTime || "",
      priority: priority || "Medium",
      complexity: Number(complexity) || 0,
      reward: Number(reward) || 0,
      recurring: Boolean(recurring),
      recurrenceInterval,
      attachments,
      subtasks: Array.isArray(subtasks)
        ? subtasks
            .map((s) => ({
              title: s.title || s,
              assignedBy: req.user._id,
              assignedByName: actor.name,
              assignedAt: new Date(),
            }))
            .filter((s) => s.title)
        : [],
      status: initialStatus,
    };

    // ⭐ SINGLE USER (or zero users) — old behaviour, no group
    if (users.length <= 1) {
      const taskAdminId = req.user.role === "SuperAdmin" ? userOrgId(users[0]) : req.adminId;

      const task = await Task.create({
        ...basePayload,
        assignedTo: users[0]?._id || null,
        admin_id: taskAdminId,
        taskGroupId: null,
        statusHistory: [
          { from: null, to: initialStatus, changedBy: req.user._id, changedByName: actor.name },
        ],
      });

      announce([task], req.user._id);
      const populated = await populateTask(Task.findById(task._id));

      return res.status(201).json({
        success: true,
        message: users[0] ? "Task created & assigned" : "Task created",
        data: shapeTask(populated),
      });
    }

    // ⭐ MULTI USER — clone one task per user, share taskGroupId (clones share the uploaded files)
    const groupId = new mongoose.Types.ObjectId();

    const created = await Promise.all(
      users.map(async (u) => {
        const taskAdminId = req.user.role === "SuperAdmin" ? userOrgId(u) : req.adminId;
        return Task.create({
          ...basePayload,
          assignedTo: u._id,
          admin_id: taskAdminId,
          taskGroupId: groupId,
          statusHistory: [
            { from: null, to: initialStatus, changedBy: req.user._id, changedByName: actor.name },
          ],
        });
      })
    );

    announce(created, req.user._id);
    const populated = await populateTask(Task.find({ _id: { $in: created.map((t) => t._id) } }));

    return res.status(201).json({
      success: true,
      message: `Task assigned to ${users.length} users`,
      taskGroupId: groupId,
      data: populated.map(shapeTask),
    });
  } catch (error) {
    await discardUploads(req);
    sendError(res, error);
  }
};

/* ==================== POST /api/tasks/bank  ==================== */
export const saveToTaskBank = async (req, res) => {
  try {
    const {
      name, referenceId, department, description,
      dueDate, priority, complexity, reward, recurring,
      recurrenceInterval, attachments, subtasks,
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: "Task name is required" });
    }

    if (req.user.role === "User") {
      return res.status(403).json({
        success: false,
        message: "Only Admin can save tasks to the Task Bank",
      });
    }

    let taskAdminId = req.adminId;
    if (req.user.role === "SuperAdmin" && req.body.adminId) {
      taskAdminId = req.body.adminId;
    }

    const bankTask = await Task.create({
      name: name.trim(),
      referenceId: referenceId || "",
      department: department || "",
      description: description || "",
      assignedTo: null,
      assignedBy: req.user.id,
      assignedAt: new Date(),
      admin_id: taskAdminId,
      isTaskBank: true,
      dueDate: dueDate || undefined,
      priority: priority || "Medium",
      complexity: Number(complexity) || 0,
      reward: Number(reward) || 0,
      recurring: Boolean(recurring),
      recurrenceInterval,
      attachments: Array.isArray(attachments) ? attachments : [],
      subtasks: Array.isArray(subtasks)
        ? subtasks.map((s) => ({ title: s.title || s }))
        : [],
      status: "To Do",
      statusHistory: [],
      completedAt: null,
    });

    const populated = await Task.findById(bankTask._id)
      .populate("assignedTo", "name email department")
      .populate("assignedBy", "name email");

    res.status(201).json({
      success: true,
      message: "Task saved to Task Bank",
      data: shapeTask(populated),
    });
  } catch (error) {
    sendError(res, error);
  }
};

/* ==================== GET /api/tasks/bank  ==================== */
export const getTaskBank = async (req, res) => {
  try {
    const { priority, department, search } = req.query;

    if (req.user.role === "User") {
      return res.status(403).json({
        success: false,
        message: "Only Admin can view the Task Bank",
      });
    }

    const filter = { ...req.scope, isTaskBank: true };

    if (priority && priority !== "All Priority") filter.priority = priority;
    if (department && department !== "All Departments") filter.department = department;

    if (search) {
      const rx = { $regex: search, $options: "i" };
      const searchOr = [{ name: rx }, { description: rx }, { department: rx }, { referenceId: rx }];
      if (filter.$or) {
        filter.$and = [{ $or: filter.$or }, { $or: searchOr }];
        delete filter.$or;
      } else {
        filter.$or = searchOr;
      }
    }

    const tasks = await Task.find(filter)
      .populate("assignedTo", "name email department")
      .populate("assignedBy", "name email")
      .sort({ createdAt: -1 });

    res.json({ success: true, count: tasks.length, data: tasks.map(shapeTask) });
  } catch (error) {
    sendError(res, error);
  }
};

/* ==================== PATCH /api/tasks/bank/:id/assign  ====================
 * ⭐ `assignedUser` accepts BOTH shapes (string | array) here too.
 */
export const assignFromBank = async (req, res) => {
  try {
    const {
      department, dueDate, priority, complexity, reward,
      assignedUser, // ⭐ same field — string OR array
    } = req.body;

    const task = await Task.findOne({
      _id: req.params.id,
      ...req.scope,
      isTaskBank: true,
    });

    if (!task) {
      return res.status(404).json({ success: false, message: "Task Bank item not found" });
    }

    if (req.user.role === "User") {
      return res.status(403).json({ success: false, message: "Only Admin can assign from Task Bank" });
    }

    const inputMode = normalizeAssignedUserInput(assignedUser);
    if (inputMode.mode === "skip" || inputMode.mode === "none") {
      return res.status(400).json({ success: false, message: "assignedUser is required" });
    }

    let users = [];
    if (inputMode.mode === "multi") {
      users = await resolveAssignedUsers(
        inputMode.values,
        department || task.department,
        req.adminId,
        req.user.role
      );
    } else {
      const u = await resolveAssignedUser(
        inputMode.value,
        department || task.department,
        req.adminId,
        req.user.role
      );
      if (u) users = [u];
    }

    if (users.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Cannot assign — none of the selected users belong to your organization",
      });
    }

    const actor = await getActor(req);

    const updateFields = {};
    if (department !== undefined) updateFields.department = department;
    if (dueDate !== undefined) updateFields.dueDate = dueDate || undefined;
    if (priority !== undefined) updateFields.priority = priority;
    if (complexity !== undefined) updateFields.complexity = Number(complexity) || 0;
    if (reward !== undefined) updateFields.reward = Number(reward) || 0;

    // ⭐ SINGLE — convert the bank task in place (old behaviour)
    if (users.length === 1) {
      const u = users[0];
      task.isTaskBank = false;
      task.assignedTo = u._id;
      task.assignedBy = req.user.id;
      task.assignedAt = new Date();
      Object.assign(task, updateFields);
      if (req.user.role === "SuperAdmin" && u.admin_id) task.admin_id = u.admin_id;
      task.taskGroupId = null;
      task.status = "To Do";
      task.statusHistory = [
        { from: null, to: "To Do", changedBy: req.user.id, changedByName: actor.name },
      ];
      task.completedAt = null;
      await task.save();

      const populated = await Task.findById(task._id)
        .populate("assignedTo", "name email department")
        .populate("assignedBy", "name email");

      return res.json({
        success: true,
        message: "Task assigned from Task Bank",
        data: shapeTask(populated),
      });
    }

    // ⭐ MULTI — clone the bank task N times (original stays in bank)
    const groupId = new mongoose.Types.ObjectId();
    const created = await Promise.all(
      users.map(async (u) => {
        let taskAdminId = req.adminId;
        if (req.user.role === "SuperAdmin" && u.admin_id) taskAdminId = u.admin_id;
        return Task.create({
          name: task.name,
          referenceId: task.referenceId,
          department: updateFields.department ?? task.department,
          description: task.description,
          assignedTo: u._id,
          assignedBy: req.user.id,
          assignedAt: new Date(),
          admin_id: taskAdminId,
          isTaskBank: false,
          taskGroupId: groupId,
          dueDate: updateFields.dueDate ?? task.dueDate,
          priority: updateFields.priority ?? task.priority,
          complexity: updateFields.complexity ?? task.complexity,
          reward: updateFields.reward ?? task.reward,
          recurring: task.recurring,
          recurrenceInterval: task.recurrenceInterval,
          attachments: task.attachments,
          subtasks: task.subtasks,
          status: "To Do",
          statusHistory: [
            { from: null, to: "To Do", changedBy: req.user.id, changedByName: actor.name },
          ],
          completedAt: null,
        });
      })
    );

    const populated = await Task.find({ _id: { $in: created.map((t) => t._id) } })
      .populate("assignedTo", "name email department")
      .populate("assignedBy", "name email");

    return res.json({
      success: true,
      message: `Task assigned from Task Bank to ${users.length} users`,
      taskGroupId: groupId,
      data: populated.map(shapeTask),
    });
  } catch (error) {
    sendError(res, error);
  }
};

/* ==================== DELETE /api/tasks/bank/:id  ==================== */
export const deleteFromBank = async (req, res) => {
  try {
    if (req.user.role === "User") {
      return res.status(403).json({ success: false, message: "Only Admin can delete Task Bank items" });
    }

    const task = await Task.findOneAndDelete({
      _id: req.params.id,
      ...req.scope,
      isTaskBank: true,
    });

    if (!task) {
      return res.status(404).json({ success: false, message: "Task Bank item not found" });
    }

    res.json({ success: true, message: "Task Bank item deleted" });
  } catch (error) {
    sendError(res, error);
  }
};

/* ==================== PATCH /api/tasks/:id  (edit / reassign) ====================
 * JSON or multipart/form-data (field "files" = new attachments,
 * `attachments` = list of EXISTING attachments to keep).
 * `assignedUser` accepts a string (single, "" = unassign) or an array (multi).
 */
export const updateTask = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      await discardUploads(req);
      return res.status(400).json({ success: false, message: "Invalid task ID" });
    }

    const task = await Task.findOne({ _id: req.params.id, ...req.scope, isTaskBank: { $ne: true } });
    if (!task) {
      await discardUploads(req);
      return res.status(404).json({ success: false, message: "Task not found" });
    }

    // ⭐ Task-level authorization (module permission is checked by the route)
    if (!canModifyTask(req, task)) {
      await discardUploads(req);
      return res.status(403).json({
        success: false,
        message: "Only the task creator, a Manager or an Admin can edit this task. You can still update its status.",
      });
    }

    // Who had the task before this edit (for "task reassigned" emails)
    const previousAssignee = task.assignedTo ? String(task.assignedTo) : null;

    // previous → new: reassignment notice; nobody → someone: normal assignment email
    const announceChange = () => {
      const now = task.assignedTo ? String(task.assignedTo) : null;
      if (now === previousAssignee) return;
      if (previousAssignee) notifyTaskReassigned(task._id, previousAssignee, req.user._id);
      else announce([task], req.user._id);
    };

    const body = normalizeBody(req);

    if (body.priority !== undefined && !TASK_PRIORITIES.includes(body.priority)) {
      await discardUploads(req);
      return res.status(400).json({ success: false, message: `Invalid priority. Allowed: ${TASK_PRIORITIES.join(", ")}` });
    }
    if (body.name !== undefined && !String(body.name).trim()) {
      await discardUploads(req);
      return res.status(400).json({ success: false, message: "Task name cannot be empty" });
    }

    // ⭐ Detect input mode from `assignedUser` (preferred) OR `assignedTo` (legacy alias)
    let assignedUserField = body.assignedUser;
    if (assignedUserField === undefined && body.assignedTo !== undefined) {
      assignedUserField = body.assignedTo;
    }
    const inputMode = normalizeAssignedUserInput(assignedUserField, body.assignedUsers);
    const department = body.department !== undefined ? body.department : task.department;

    let users = [];
    try {
      if (inputMode.mode === "multi") {
        users = await resolveAssignedUsers(inputMode.values, department, req.adminId, req.user.role);
      } else if (inputMode.mode === "single") {
        users = [await resolveAssignedUser(inputMode.value, department, req.adminId, req.user.role)];
      }
    } catch (err) {
      await discardUploads(req);
      return sendError(res, err);
    }

    // Sending the CURRENT assignee back (normal edit form submit) is not a reassignment
    const unchangedSingle =
      inputMode.mode === "single" && task.assignedTo && String(users[0]._id) === String(task.assignedTo);
    const reassigning =
      (inputMode.mode === "single" && !unchangedSingle) ||
      inputMode.mode === "multi" ||
      (inputMode.mode === "none" && task.assignedTo);

    if (reassigning) {
      try {
        if (inputMode.mode === "none") {
          if (!hasPermission(req, "tasks", "assign")) {
            throw new AssignError("You do not have permission to reassign tasks", 403);
          }
        } else {
          ensureCanAssign(req, users);
        }
      } catch (err) {
        await discardUploads(req);
        return sendError(res, err);
      }
    }

    const oldDeadline = `${task.dueDate ? new Date(task.dueDate).toISOString().slice(0, 10) : ""}|${task.dueTime || ""}`;

    const fields = [
      "name", "referenceId", "description", "department", "dueDate", "dueTime",
      "priority", "complexity", "reward", "recurring",
      "recurrenceInterval", "subtasks",
    ];
    fields.forEach((f) => {
      if (body[f] !== undefined) task[f] = body[f];
    });
    if (body.name !== undefined) task.name = String(body.name).trim();
    if (body.dueDate === "") task.dueDate = undefined;
    const newDeadline = `${task.dueDate ? new Date(task.dueDate).toISOString().slice(0, 10) : ""}|${task.dueTime || ""}`;
    if (newDeadline !== oldDeadline) {
      // New deadline → reminders start over
      task.set("notifications.reminder3hAt", null);
      task.set("notifications.reminder1hAt", null);
      task.set("notifications.overdueAlertAt", null);
    }
    if (Array.isArray(body.subtasks)) {
      // keep who assigned each existing subtask; new ones are assigned by the editor
      const editor = await getActor(req);
      const existing = new Map(task.subtasks.map((s) => [String(s._id), s]));
      const byTitle = new Map(task.subtasks.map((s) => [s.title, s]));
      task.subtasks = body.subtasks
        .map((s) => {
          const title = String(s.title || s || "").trim();
          const old = (s._id && existing.get(String(s._id))) || byTitle.get(title);
          return {
            ...(old ? { _id: old._id } : {}),
            title,
            completed: Boolean(s.completed ?? old?.completed),
            completedAt: old?.completedAt || null,
            assignedBy: old ? old.assignedBy : req.user._id,
            assignedByName: old ? old.assignedByName : editor.name,
            assignedAt: old ? old.assignedAt : new Date(),
          };
        })
        .filter((s) => s.title);
    }

    // ⭐ ATTACHMENTS — keep only the existing ones the client still lists, then add uploads
    const removedFiles = [];
    if (Array.isArray(body.attachments)) {
      const keep = new Set(
        body.attachments.flatMap((a) =>
          typeof a === "string" ? [a] : [a?.filename, a?.url, a?.name].filter(Boolean)
        )
      );
      task.attachments = task.attachments.filter((a) => {
        const kept = keep.has(a.filename) || keep.has(a.url) || (!a.filename && keep.has(a.name));
        if (!kept && a.filename) removedFiles.push(a.filename);
        return kept;
      });
    }
    task.attachments.push(...(req.files || []).map((f) => toAttachment(f, req.user._id)));

    // ⭐ MULTI — clone task for the extra users
    if (inputMode.mode === "multi") {
      const actor = await getActor(req);
      const groupId = task.taskGroupId || new mongoose.Types.ObjectId();

      // Repoint THIS task to the first user
      const firstChanged = String(task.assignedTo) !== String(users[0]._id);
      if (firstChanged) {
        task.notifications = { assignedAt: null, reminder3hAt: null, reminder1hAt: null, overdueAlertAt: null };
      }
      task.assignedTo = users[0]._id;
      task.assignedBy = req.user._id;
      task.assignedAt = new Date();
      task.taskGroupId = groupId;
      if (req.user.role === "SuperAdmin") task.admin_id = userOrgId(users[0]);
      await task.save();
      await removeUnreferencedFiles(removedFiles);
      if (firstChanged) announceChange();

      // Clone for remaining users
      const cloned = await Promise.all(
        users.slice(1).map(async (u) => {
          const taskAdminId = req.user.role === "SuperAdmin" ? userOrgId(u) : req.adminId;
          return Task.create({
            name: task.name,
            referenceId: task.referenceId,
            department: task.department,
            description: task.description,
            assignedTo: u._id,
            assignedBy: req.user._id,
            assignedAt: new Date(),
            admin_id: taskAdminId,
            isTaskBank: false,
            taskGroupId: groupId,
            dueDate: task.dueDate,
            dueTime: task.dueTime,
            priority: task.priority,
            complexity: task.complexity,
            reward: task.reward,
            recurring: task.recurring,
            recurrenceInterval: task.recurrenceInterval,
            attachments: task.attachments,
            subtasks: task.subtasks.map((st) => ({ title: st.title })),
            status: "To Do",
            statusHistory: [
              { from: null, to: "To Do", changedBy: req.user._id, changedByName: actor.name },
            ],
            completedAt: null,
          });
        })
      );

      announce(cloned, req.user._id);
      const populated = await populateTask(
        Task.find({ _id: { $in: [task._id, ...cloned.map((t) => t._id)] } })
      );

      return res.json({
        success: true,
        message: `Task reassigned to ${users.length} users`,
        taskGroupId: groupId,
        data: populated.map(shapeTask),
      });
    }

    // ⭐ SINGLE or NONE
    if (reassigning) {
      task.assignedBy = req.user._id;
      task.assignedAt = new Date();
      task.taskGroupId = null; // single-user assignment detaches from any previous group
      if (inputMode.mode === "none") {
        task.assignedTo = null;
      } else {
        task.assignedTo = users[0]._id;
        if (req.user.role === "SuperAdmin") task.admin_id = userOrgId(users[0]);
      }
      // New assignee → new assignment email + fresh reminders
      task.notifications = { assignedAt: null, reminder3hAt: null, reminder1hAt: null, overdueAlertAt: null };
    }

    await task.save();
    await removeUnreferencedFiles(removedFiles);
    if (reassigning) announceChange();

    const populated = await populateTask(Task.findById(task._id));

    res.json({ success: true, message: "Task updated", data: shapeTask(populated) });
  } catch (error) {
    await discardUploads(req);
    sendError(res, error);
  }
};

/* ==================== PATCH /api/tasks/:id/status  ==================== */
// Review flow:
//   • the assignee moves the task To Do → In Progress → Review
//   • only the person who ASSIGNED the task can mark it Completed (from Review),
//     giving a score 1–10 that is added to the assignee's points (they are told their new score)
//   • or the assigner sends it back from Review for rework (In Progress / To Do, with a reason)
//   • only the assigner can reopen a Completed task (the reward is taken back)
// Tasks without an assigner (old / imported) fall back to Admin / Manager.
export const isTaskAssigner = (req, task) => {
  if (task.assignedBy) return String(task.assignedBy) === String(req.user._id);
  return isOrgAdmin(req) || req.user.role === "Manager";
};

export const updateTaskStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const note = String(req.body.note || "").trim().slice(0, 1000);

    if (!status || !TASK_STATUSES.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Allowed: ${TASK_STATUSES.join(", ")}`,
      });
    }

    const task = await Task.findOne({ _id: req.params.id, ...req.scope });
    if (!task) return res.status(404).json({ success: false, message: "Task not found" });

    const isManager = canModifyTask(req, task);
    const isAssignee = task.assignedTo && String(task.assignedTo) === String(req.user.id);

    if (!isManager && !isAssignee) {
      return res.status(403).json({
        success: false,
        message: "Only the assignee, the task creator, a Manager or an Admin can update this status",
      });
    }

    const from = task.status;
    if (from === status) {
      return res.json({ success: true, message: "Status unchanged", data: shapeTask(task) });
    }

    const isAssigner = isTaskAssigner(req, task);
    const selfAssigned = task.assignedBy && task.assignedTo && String(task.assignedBy) === String(task.assignedTo);

    if (status === "Completed") {
      if (!isAssigner) {
        return res.status(403).json({
          success: false,
          code: "ASSIGNER_ONLY",
          message: "Only the person who assigned this task can mark it Completed. Move it to Review and they will check it.",
        });
      }
      if (from !== "Review" && !selfAssigned) {
        return res.status(409).json({
          success: false,
          code: "REVIEW_FIRST",
          message: "The task must be in Review before it can be marked Completed.",
        });
      }
      if (!selfAssigned && parseReviewScore(req.body.score) === null) {
        return res.status(400).json({
          success: false,
          code: "SCORE_REQUIRED",
          message: "Give the task a score from 1 to 10 to approve it.",
        });
      }
    }

    if (from === "Completed" && !isAssigner) {
      return res.status(403).json({
        success: false,
        code: "ASSIGNER_ONLY",
        message: "Only the person who assigned this task can reopen it.",
      });
    }

    // The assigner sending the work back from Review = rework
    const isRework = from === "Review" && ["To Do", "In Progress"].includes(status) && isAssigner && !selfAssigned;

    const actor = await getActor(req);

    task.status = status;
    task.statusHistory.push({
      from,
      to: status,
      changedBy: req.user.id,
      changedByName: actor.name,
      note: isRework ? `Rework requested${note ? `: ${note}` : ""}` : note,
    });

    let score = null;
    let celebration = null;
    // Points = the score (1–10) the assigner gives; your own tasks earn no points
    const reward = status === "Completed" && !selfAssigned ? parseReviewScore(req.body.score) : 0;

    if (status === "Completed") {
      task.completedAt = new Date();
      task.reviewScore = reward || null;
      task.pointsAwarded = reward;
    } else {
      task.completedAt = null;
      task.reviewScore = null;
    }
    if (isRework) task.reworkCount = (task.reworkCount || 0) + 1;

    const before = status === "Completed" && task.assignedTo ? await scoreProfile(task.assignedTo) : null;
    await task.save();

    if (status === "Completed" && task.assignedTo && reward) {
      const user = await User.findByIdAndUpdate(task.assignedTo, { $inc: { points: reward } }, { new: true }).select("points");
      score = user?.points ?? null;
      celebration = celebrationFor(before, await scoreProfile(task.assignedTo), reward);
    } else if (from === "Completed" && task.assignedTo) {
      // Reopened → the points given for completing it are taken back
      const given = task.pointsAwarded || 0;
      const user = await User.findByIdAndUpdate(task.assignedTo, { $inc: { points: -given } }, { new: true }).select("points");
      if (user && user.points < 0) await User.updateOne({ _id: user._id }, { points: 0 });
      task.pointsAwarded = 0;
      await task.save();
    }

    // Pop the "you win" screen on the assignee's open tabs (also when they completed their own task)
    if (celebration) {
      emitToUser(task.assignedTo, "task:celebrate", {
        ...celebration,
        taskId: String(task._id),
        taskName: task.name,
        approvedBy: selfAssigned ? "" : actor.name,
      });
    }

    const who = { _id: req.user._id, name: actor.name };
    // Tell the person who assigned the task who changed it (email + dashboard)
    notifyStatusChanged(task, who, from, status);
    // Tell the assignee the result of the review
    if (status === "Completed" && !selfAssigned) {
      notifyReviewDecision(task, who, { decision: "completed", reward, score, note, celebration });
    } else if (isRework) {
      notifyReviewDecision(task, who, { decision: "rework", note });
    }

    const populated = await Task.findById(task._id)
      .populate("assignedTo", "name email department")
      .populate("assignedBy", "name email");

    res.json({
      success: true,
      message:
        status === "Completed"
          ? reward
            ? `Task completed with ${reward}/10. ${populated.assignedTo?.name || "The assignee"} earned ${reward} points${score !== null ? ` (total score: ${score})` : ""}.`
            : "Task completed."
          : isRework
          ? `Sent back for rework. ${populated.assignedTo?.name || "The assignee"} has been notified.`
          : `Status updated: "${from}" → "${status}"`,
      score,
      celebration,
      // the "you win" screen is shown to the person who did the task
      celebrateFor: celebration ? String(task.assignedTo) : null,
      rework: isRework,
      data: shapeTask(populated),
    });
  } catch (error) {
    sendError(res, error);
  }
};

/* ==================== SUBTASKS (assign / tick / move / remove) ==================== */
//   POST   /api/tasks/:id/subtasks          { title }            → assigner / manager gives a subtask to this person
//   PATCH  /api/tasks/:id/subtasks/:subId   { completed }        → the assignee (or a manager) ticks it
//   PATCH  /api/tasks/:id/subtasks/:subId   { moveTo: taskId }   → manager moves it to another person of the same shared task
//   DELETE /api/tasks/:id/subtasks/:subId                        → manager removes it
const findScopedTask = async (req, res, id = req.params.id) => {
  if (!mongoose.isValidObjectId(id)) {
    res.status(400).json({ success: false, message: "Invalid task ID" });
    return null;
  }
  const task = await Task.findOne({ _id: id, ...req.scope });
  if (!task) res.status(404).json({ success: false, message: "Task not found" });
  return task;
};

const subtaskResponse = async (res, taskIds, message, status = 200) => {
  const tasks = await Task.find({ _id: { $in: taskIds } })
    .populate("assignedTo", "name email department")
    .populate("assignedBy", "name email");
  res.status(status).json({ success: true, message, data: tasks.map(shapeTask) });
};

export const addSubtask = async (req, res) => {
  try {
    const task = await findScopedTask(req, res);
    if (!task) return;
    if (!canModifyTask(req, task)) {
      return res.status(403).json({ success: false, message: "Only the person who assigned this task, a Manager or an Admin can assign subtasks" });
    }
    const title = String(req.body.title || "").trim().slice(0, 300);
    if (!title) return res.status(400).json({ success: false, message: "Subtask title is required" });

    const actor = await getActor(req);
    task.subtasks.push({
      title,
      assignedBy: req.user._id,
      assignedByName: actor.name,
      assignedAt: new Date(),
    });
    await task.save();
    notifySubtaskAssigned(task, { _id: req.user._id, name: actor.name }, title);
    await subtaskResponse(res, [task._id], `Subtask assigned to ${(await User.findById(task.assignedTo).select("name"))?.name || "the assignee"}`, 201);
  } catch (error) {
    sendError(res, error);
  }
};

export const updateSubtask = async (req, res) => {
  try {
    const task = await findScopedTask(req, res);
    if (!task) return;
    const sub = task.subtasks.id(req.params.subId);
    if (!sub) return res.status(404).json({ success: false, message: "Subtask not found" });

    const isManager = canModifyTask(req, task);
    const isAssignee = task.assignedTo && String(task.assignedTo) === String(req.user._id);

    // Move to another person of the same shared task
    if (req.body.moveTo !== undefined) {
      if (!isManager) {
        return res.status(403).json({ success: false, message: "Only the person who assigned this task, a Manager or an Admin can move subtasks" });
      }
      const target = await findScopedTask(req, res, req.body.moveTo);
      if (!target) return;
      if (!task.taskGroupId || String(target.taskGroupId) !== String(task.taskGroupId) || String(target._id) === String(task._id)) {
        return res.status(400).json({ success: false, message: "A subtask can only move to another person of the same shared task" });
      }
      const actor = await getActor(req);
      target.subtasks.push({
        title: sub.title,
        completed: false,
        assignedBy: req.user._id,
        assignedByName: actor.name,
        assignedAt: new Date(),
      });
      sub.deleteOne();
      await Promise.all([task.save(), target.save()]);
      notifySubtaskAssigned(target, { _id: req.user._id, name: actor.name }, target.subtasks[target.subtasks.length - 1].title);
      const to = await User.findById(target.assignedTo).select("name");
      return subtaskResponse(res, [task._id, target._id], `Subtask moved to ${to?.name || "the other person"}`);
    }

    if (req.body.completed !== undefined) {
      if (!isManager && !isAssignee) {
        return res.status(403).json({ success: false, message: "Only the assignee, the task creator, a Manager or an Admin can tick subtasks" });
      }
      sub.completed = Boolean(req.body.completed);
      sub.completedAt = sub.completed ? new Date() : null;
    }
    if (req.body.title !== undefined) {
      if (!isManager) return res.status(403).json({ success: false, message: "Only the task creator, a Manager or an Admin can rename subtasks" });
      const title = String(req.body.title || "").trim().slice(0, 300);
      if (!title) return res.status(400).json({ success: false, message: "Subtask title is required" });
      sub.title = title;
    }
    await task.save();
    await subtaskResponse(res, [task._id], "Subtask updated");
  } catch (error) {
    sendError(res, error);
  }
};

export const deleteSubtask = async (req, res) => {
  try {
    const task = await findScopedTask(req, res);
    if (!task) return;
    if (!canModifyTask(req, task)) {
      return res.status(403).json({ success: false, message: "Only the task creator, a Manager or an Admin can remove subtasks" });
    }
    const sub = task.subtasks.id(req.params.subId);
    if (!sub) return res.status(404).json({ success: false, message: "Subtask not found" });
    sub.deleteOne();
    await task.save();
    await subtaskResponse(res, [task._id], "Subtask removed");
  } catch (error) {
    sendError(res, error);
  }
};

/* ==================== GET /api/tasks/scoreboard  ==================== */
// My points, level and badges + the organization's leaderboard (top 10)
export const getScoreboard = async (req, res) => {
  try {
    const me = await scoreProfile(req.user._id);

    const filter = { status: "Active", role: { $ne: "SuperAdmin" } };
    if (req.user.role !== "SuperAdmin") {
      const orgId = req.user.role === "Admin" ? req.user._id : req.adminId;
      filter.$or = [{ _id: orgId }, { admin_id: orgId }];
    }
    const top = await User.find(filter).select("name department points").sort({ points: -1, name: 1 }).limit(10).lean();
    const leaderboard = top.map((u, i) => {
      const level = levelFor(u.points || 0);
      return {
        rank: i + 1,
        userId: String(u._id),
        name: u.name,
        department: u.department || "",
        points: u.points || 0,
        level: { name: level.name, icon: level.icon },
      };
    });

    res.json({ success: true, data: { me, leaderboard, levels: LEVELS } });
  } catch (error) {
    sendError(res, error);
  }
};

/* ==================== POST /api/tasks/:id/attachments  ==================== */
export const addTaskAttachments = async (req, res) => {
  try {
    const task = mongoose.Types.ObjectId.isValid(req.params.id)
      ? await Task.findOne({ _id: req.params.id, ...req.scope })
      : null;
    if (!task) {
      await discardUploads(req);
      return res.status(404).json({ success: false, message: "Task not found" });
    }

    // Creator / Manager / Admin, or the assignee (to attach deliverables)
    const isAssignee = task.assignedTo && String(task.assignedTo) === String(req.user._id);
    if (!canModifyTask(req, task) && !isAssignee) {
      await discardUploads(req);
      return res.status(403).json({ success: false, message: "You cannot add files to this task" });
    }

    if (!req.files?.length) {
      return res.status(400).json({ success: false, message: "No files received" });
    }

    const newFiles = req.files.map((f) => toAttachment(f, req.user._id));
    task.attachments.push(...newFiles);
    await task.save();

    const populated = await populateTask(Task.findById(task._id));

    res.json({
      success: true,
      message: `${newFiles.length} file(s) uploaded`,
      data: shapeTask(populated),
    });
  } catch (error) {
    await discardUploads(req);
    sendError(res, error);
  }
};

/* ==================== GET /api/tasks/attachments/:filename ====================
 * Authenticated download — the file is only served when it belongs to a task
 * inside the requester's data scope.
 */
export const downloadTaskAttachment = async (req, res) => {
  try {
    const filename = path.basename(String(req.params.filename || ""));
    const task = await Task.findOne({ ...req.scope, "attachments.filename": filename })
      .select("attachments")
      .lean();
    const file = task?.attachments.find((a) => a.filename === filename);

    if (!file) {
      return res.status(404).json({ success: false, message: "Attachment not found" });
    }

    const fullPath = path.join(UPLOAD_DIR, filename);
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ success: false, message: "The file is no longer available on the server" });
    }

    res.download(fullPath, file.name);
  } catch (error) {
    sendError(res, error);
  }
};

/* ==================== DELETE /api/tasks/:id  ==================== */
export const deleteTask = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid task ID" });
    }

    const task = await Task.findOne({ _id: req.params.id, ...req.scope, isTaskBank: { $ne: true } });
    if (!task) return res.status(404).json({ success: false, message: "Task not found" });

    // ⭐ Users may only delete tasks they created; Managers/Admins any task in scope
    if (!canModifyTask(req, task)) {
      return res.status(403).json({
        success: false,
        message: "You can only delete tasks that you created",
      });
    }

    await task.deleteOne();
    await removeUnreferencedFiles(task.attachments.map((a) => a.filename));

    res.json({ success: true, message: "Task deleted", data: { id: task._id } });
  } catch (error) {
    sendError(res, error);
  }
};

/* ==================== GET /api/tasks/stats ==================== */
export const getTaskStats = async (req, res) => {
  try {
    const scope = { ...req.scope, isTaskBank: { $ne: true } };

    const [total, todo, progress, review, completed] = await Promise.all([
      Task.countDocuments(scope),
      Task.countDocuments({ ...scope, status: "To Do" }),
      Task.countDocuments({ ...scope, status: "In Progress" }),
      Task.countDocuments({ ...scope, status: "Review" }),
      Task.countDocuments({ ...scope, status: "Completed" }),
    ]);
    res.json({ success: true, data: { total, todo, progress, review, completed } });
  } catch (error) {
    sendError(res, error);
  }
};

/* ==================== POST /api/tasks/import  ====================
 * CSV → real tasks (shown on the Task Calendar and the Tasks page).
 * ?preview=true  → validate only, nothing is saved.
 * Columns (case/spacing ignored): Title*, Date* (YYYY-MM-DD), Time (HH:mm),
 *   Department, Assignee (name or email), Status, Priority, Description, Reference ID
 */
const IMPORT_COLUMNS = {
  title: ["title", "tasktitle", "task", "taskname", "name"],
  date: ["date", "duedate", "taskdate"],
  time: ["time", "tasktime", "duetime"],
  department: ["department", "dept"],
  assignee: ["assignee", "assignedto", "assigneduser", "user", "email"],
  status: ["status"],
  priority: ["priority"],
  description: ["description", "details", "taskdescription"],
  referenceId: ["referenceid", "reference", "refid", "taskid"],
};

const IMPORT_STATUS = {
  pending: "To Do", todo: "To Do", "to do": "To Do",
  "in progress": "In Progress", inprogress: "In Progress",
  review: "Review", completed: "Completed", done: "Completed",
};

export const MAX_IMPORT_ROWS = 1000;

export const uploadImportCSV = withUploadErrors(
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => {
      if (file.originalname.toLowerCase().endsWith(".csv")) return cb(null, true);
      const err = new Error("Only .csv files can be imported");
      err.status = 400;
      cb(err);
    },
  }).single("file")
);

export const importTasks = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "No CSV file received" });
    }
    const preview = String(req.query.preview || req.body?.preview || "") === "true";

    let parsed;
    try {
      parsed = readCSV(req.file.buffer.toString("utf8"));
    } catch (err) {
      return res.status(400).json({ success: false, message: err.message });
    }

    const col = Object.fromEntries(
      Object.entries(IMPORT_COLUMNS).map(([key, names]) => [
        key,
        parsed.headers.findIndex((h) => names.includes(h)),
      ])
    );
    if (col.title === -1 || col.date === -1) {
      return res.status(400).json({
        success: false,
        message: 'The CSV must have "Title" and "Date" columns in the header row',
      });
    }
    if (parsed.rows.length === 0) {
      return res.status(400).json({ success: false, message: "The CSV has a header row but no task rows" });
    }
    if (parsed.rows.length > MAX_IMPORT_ROWS) {
      return res.status(400).json({
        success: false,
        message: `Too many rows (${parsed.rows.length}). Import at most ${MAX_IMPORT_ROWS} rows at a time.`,
      });
    }

    // Departments of the organization (validated only when the org has defined any)
    const deptFilter =
      req.user.role === "SuperAdmin" ? {} : { $or: [{ admin_id: req.adminId }, { createdBy: req.adminId }] };
    const orgDepartments = await Department.find(deptFilter).select("name").lean();
    const deptByKey = new Map(orgDepartments.map((d) => [d.name.trim().toLowerCase(), d.name]));

    const seen = new Set();
    const results = [];

    for (const { line, values } of parsed.rows) {
      const get = (key) => (col[key] >= 0 ? String(values[col[key]] ?? "").trim() : "");
      const errors = [];

      const title = get("title");
      const date = get("date");
      const time = get("time");
      const rawDept = get("department");
      const assigneeInput = get("assignee");
      const rawStatus = get("status");
      const rawPriority = get("priority");

      if (!title) errors.push("Title is required");
      if (!date) errors.push("Date is required");
      else if (!isValidISODate(date)) errors.push(`Date "${date}" must be a real date in YYYY-MM-DD format`);
      if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) errors.push(`Time "${time}" must use HH:mm (24h)`);

      let department = rawDept;
      if (rawDept && deptByKey.size > 0) {
        department = deptByKey.get(rawDept.toLowerCase());
        if (!department) errors.push(`Department "${rawDept}" does not exist`);
      }

      const status = rawStatus ? IMPORT_STATUS[rawStatus.toLowerCase()] : "To Do";
      if (!status) errors.push(`Status "${rawStatus}" is not valid (use Pending, In Progress, Review or Completed)`);

      const priority = rawPriority
        ? TASK_PRIORITIES.find((p) => p.toLowerCase() === rawPriority.toLowerCase())
        : "Medium";
      if (!priority) errors.push(`Priority "${rawPriority}" is not valid (use ${TASK_PRIORITIES.join(", ")})`);

      let assignee = null;
      if (assigneeInput) {
        try {
          assignee = await resolveAssignedUser(assigneeInput, department || "", req.adminId, req.user.role);
          ensureCanAssign(req, [assignee]);
        } catch (err) {
          errors.push(err.message);
          assignee = null;
        }
      } else if (req.user.role === "SuperAdmin") {
        errors.push("Assignee is required so the task belongs to an organization");
      }

      const data = {
        name: title,
        dueDate: date,
        dueTime: time || "",
        department: department || "",
        assignedTo: assignee?._id || null,
        assignedUser: assignee?.name || "",
        status: status || "To Do",
        priority: priority || "Medium",
        description: get("description"),
        referenceId: get("referenceId"),
        admin_id: req.user.role === "SuperAdmin" ? userOrgId(assignee) : req.adminId,
      };

      let state = errors.length ? "invalid" : "valid";

      // ⭐ Duplicates — same title + date + assignee inside this file or already in the org
      if (state === "valid") {
        const key = [title.toLowerCase(), date, String(data.assignedTo || "")].join("|");
        if (seen.has(key)) {
          state = "duplicate";
          errors.push("Duplicate of an earlier row in this file");
        } else {
          seen.add(key);
          const exists = await Task.exists({
            admin_id: data.admin_id,
            isTaskBank: { $ne: true },
            name: { $regex: new RegExp(`^${escapeRegex(title)}$`, "i") },
            dueDate: new Date(`${date}T00:00:00.000Z`),
            assignedTo: data.assignedTo,
          });
          if (exists) {
            state = "duplicate";
            errors.push("A task with the same title, date and assignee already exists");
          }
        }
      }

      results.push({ line, state, errors, data });
    }

    const valid = results.filter((r) => r.state === "valid");
    const summary = {
      total: results.length,
      valid: valid.length,
      invalid: results.filter((r) => r.state === "invalid").length,
      duplicates: results.filter((r) => r.state === "duplicate").length,
    };
    const rowsForClient = results.map(({ line, state, errors, data }) => ({
      line,
      state,
      errors,
      title: data.name,
      date: data.dueDate,
      time: data.dueTime,
      department: data.department,
      assignee: data.assignedUser,
      status: data.status,
      priority: data.priority,
    }));

    if (preview) {
      return res.json({ success: true, preview: true, summary, rows: rowsForClient });
    }

    if (valid.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid rows to import",
        summary,
        rows: rowsForClient,
      });
    }

    const actor = await getActor(req);
    const inserted = await Task.insertMany(
      valid.map(({ data }) => ({
        name: data.name,
        referenceId: data.referenceId,
        description: data.description,
        department: data.department,
        dueDate: data.dueDate,
        dueTime: data.dueTime,
        priority: data.priority,
        status: data.status,
        completedAt: data.status === "Completed" ? new Date() : null,
        assignedTo: data.assignedTo,
        assignedBy: req.user._id,
        assignedAt: new Date(),
        admin_id: data.admin_id,
        isTaskBank: false,
        statusHistory: [
          { from: null, to: data.status, changedBy: req.user._id, changedByName: actor.name, note: "Imported from CSV" },
        ],
      }))
    );

    announce(inserted, req.user._id);

    res.status(201).json({
      success: true,
      message: `${inserted.length} task(s) imported` +
        (summary.total > inserted.length ? `, ${summary.total - inserted.length} row(s) skipped` : ""),
      imported: inserted.length,
      skipped: summary.total - inserted.length,
      summary,
      rows: rowsForClient,
      first_date: valid[0]?.data.dueDate || null,
    });
  } catch (error) {
    sendError(res, error);
  }
};
