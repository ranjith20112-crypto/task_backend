import mongoose from "mongoose";

export const TASK_STATUSES = ["To Do", "In Progress", "Review", "Completed"];
export const TASK_PRIORITIES = ["Low", "Medium", "High", "Critical"];
export const RECURRENCE_INTERVALS = ["Every day", "Every week", "Every month"];

const subtaskSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    completed: { type: Boolean, default: false },
    // Who gave this subtask to the assignee (the main task's assigner, a manager…)
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    assignedByName: { type: String, default: "" },
    assignedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  { _id: true }
);

const attachmentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    size: { type: Number, default: 0 },
    url: { type: String, default: "" },
    // Stored file name on disk (uploads/tasks/<filename>) — file bytes never go in MongoDB
    filename: { type: String, default: "" },
    mimetype: { type: String, default: "" },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

// 📌 Status change history: who changed, when, from → to
const statusHistorySchema = new mongoose.Schema(
  {
    from: { type: String, default: null },
    to: { type: String, required: true, enum: TASK_STATUSES },
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    changedByName: { type: String, default: "" },
    note: { type: String, default: "" },
    changedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const taskSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, "Task name is required"], trim: true },
    referenceId: { type: String, trim: true, default: "" },
    description: { type: String, default: "" },
    department: { type: String, trim: true, default: "", index: true },

    // ⭐⭐⭐ NEW — DATA ISOLATION KEY
    admin_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
      default: null,
    },

    // ⭐⭐⭐ NEW — TASK BANK FLAG
    // When true, this task is a TEMPLATE saved in the Task Bank (not yet assigned).
    // When false (default), this is a real assigned task.
    isTaskBank: {
      type: Boolean,
      default: false,
      index: true,
    },

    // 👤 ASSIGNMENT
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    assignedAt: { type: Date, default: Date.now },

    // Tasks cloned for multi-user assignment share this id
    taskGroupId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },

    // Task Bank template this task was assigned from (if any)
    sourceTemplate: { type: mongoose.Schema.Types.ObjectId, ref: "TaskBank", default: null },

    dueDate: { type: Date },
    dueTime: { type: String, default: "" }, // "HH:mm" — shown on the calendar
    priority: { type: String, enum: TASK_PRIORITIES, default: "Medium", index: true },
    complexity: { type: Number, min: 0, max: 100, default: 0 },
    reward: { type: Number, min: 0, default: 10 },

    recurring: { type: Boolean, default: false },
    recurrenceInterval: { type: String, enum: RECURRENCE_INTERVALS, default: "Every week" },

    attachments: { type: [attachmentSchema], default: [] },
    subtasks: { type: [subtaskSchema], default: [] },

    // 📧 Which task emails were already sent (reset when deadline or assignee changes)
    notifications: {
      assignedAt: { type: Date, default: null },
      reminder3hAt: { type: Date, default: null },
      reminder1hAt: { type: Date, default: null },
      overdueAlertAt: { type: Date, default: null },
    },

    // 🔄 STATUS
    status: { type: String, enum: TASK_STATUSES, default: "To Do", index: true },
    statusHistory: { type: [statusHistorySchema], default: [] },
    // Times the assigner sent the task back from Review for rework
    reworkCount: { type: Number, default: 0 },
    // Score 1–10 the assigner gave when approving the task — added to the assignee's points
    reviewScore: { type: Number, min: 1, max: 10, default: null },
    // Points given when it was completed — taken back exactly if reopened
    pointsAwarded: { type: Number, default: 0 },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

const Task = mongoose.model("Task", taskSchema);
export default Task;
