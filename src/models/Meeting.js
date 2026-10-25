
import mongoose from "mongoose";

const attendeeSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      trim: true,
      required: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: "",
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    department: {
      type: String,
      trim: true,
      default: "",
    },
  },
  { _id: false }
);

// MoM page: discussion points (checklist) and action plans with one or more owners
const pointSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    completed: { type: Boolean, default: false },
  },
  { _id: true }
);

const personSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    name: { type: String, trim: true, required: true },
    email: { type: String, trim: true, lowercase: true, default: "" },
  },
  { _id: false }
);

const actionPlanSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    owners: { type: [personSchema], default: [] },
    owner: { type: String, trim: true, default: "" }, // display text (names joined)
    dueDate: { type: Date, default: null },
    completed: { type: Boolean, default: false },
  },
  { _id: true }
);

// Whole-meeting recording made in the organizer's browser (file on disk, not in MongoDB)
const recordingFileSchema = new mongoose.Schema(
  {
    filename: { type: String, default: "" },
    name: { type: String, default: "" },
    size: { type: Number, default: 0 },
    mimetype: { type: String, default: "" },
    durationSec: { type: Number, default: 0 },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    uploadedAt: { type: Date, default: null },
  },
  { _id: false }
);

const transcriptEntrySchema = new mongoose.Schema(
  {
    speaker: { type: String, trim: true, default: "Speaker" },
    text: { type: String, trim: true, required: true },
    at: { type: Date, default: null },        // absolute time (Google / live)
    offsetSec: { type: Number, default: null }, // seconds from start (imported files)
  },
  { _id: false }
);

const transcriptSchema = new mongoose.Schema(
  {
    // google = Google Meet API, live = browser speech recognition, import = uploaded file,
    // whisper = transcribed from the meeting recording on this server
    source: { type: String, enum: ["", "google", "live", "import", "whisper"], default: "" },
    // whisper job state: "" | queued | processing | done | failed
    status: { type: String, default: "" },
    error: { type: String, default: "" },
    startedAt: { type: Date, default: null },
    entries: { type: [transcriptEntrySchema], default: [] },
    updatedAt: { type: Date, default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { _id: false }
);

const actionItemSchema = new mongoose.Schema(
  {
    task: {
      type: String,
      required: true,
      trim: true,
    },
    assignedTo: {
      type: String,
      trim: true,
      default: "",
    },
    dueDate: {
      type: Date,
      default: null,
    },
    status: {
      type: String,
      enum: ["Pending", "In Progress", "Completed"],
      default: "Pending",
    },
  },
  { timestamps: true }
);

const meetingSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    meetingDate: {
      type: Date,
      required: true,
    },
    startTime: {
      type: String,
      default: "",
    },
    endTime: {
      type: String,
      default: "",
    },
    location: {
      type: String,
      trim: true,
      default: "",
    },
    meetingType: {
      type: String,
      enum: ["Online", "Offline", "Hybrid"],
      default: "Online",
    },
    attendees: {
      type: [attendeeSchema],
      default: [],
    },
    agenda: {
      type: String,
      default: "",
    },
    discussionPoints: {
      type: String,
      default: "",
    },
    decisions: {
      type: String,
      default: "",
    },
    actionItems: {
      type: [actionItemSchema],
      default: [],
    },
    departments: {
      type: [String],
      default: [],
    },
    points: {
      type: [pointSchema],
      default: [],
    },
    actions: {
      type: [actionPlanSchema],
      default: [],
    },
    recording: {
      type: Boolean,
      default: false, // "record whole meeting" enabled for this meeting
    },
    transcription: {
      type: Boolean,
      default: false, // show / collect a transcript for this meeting
    },
    recordingFile: {
      type: recordingFileSchema,
      default: null,
    },
    googleRecordingUrl: {
      type: String,
      default: "", // Google Drive link of a Meet recording (Workspace accounts)
    },
    transcript: {
      type: transcriptSchema,
      default: () => ({}),
    },
    status: {
      type: String,
      enum: ["Scheduled", "Ongoing", "Completed", "Cancelled"],
      default: "Scheduled",
    },

    // Google Meet integration
    googleEventId: {
      type: String,
      default: "",
    },
    googleMeetLink: {
      type: String,
      default: "",
    },

    // Email tracking
    invitationSentAt: {
      type: Date,
      default: null,
    },
    reminderSentAt: {
      type: Date,
      default: null,
    },
    momEmailSentAt: {
      type: Date,
      default: null,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

const Meeting = mongoose.model("Meeting", meetingSchema);

export default Meeting;
