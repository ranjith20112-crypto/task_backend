// MoM extras: participant list, whole-meeting recording, transcript.
// Every lookup is limited to meetings created inside the requester's organization.
import mongoose from "mongoose";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";
import Meeting from "../models/Meeting.js";
import User from "../models/User.js";
import { createdInOrg } from "../middleware/orgScope.js";
import { parseTranscript } from "../utils/transcriptParser.js";
import { fetchGoogleMeetTranscript } from "../services/googleMeetTranscriptService.js";
import { queueTranscription } from "../services/transcriptionService.js";

export const RECORDING_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../uploads/meetings"
);
fs.mkdirSync(RECORDING_DIR, { recursive: true });

export const MAX_RECORDING_SIZE = 1024 * 1024 * 1024; // 1 GB
const RECORDING_TYPES = /^(video|audio)\/(webm|mp4|ogg|mpeg|x-m4a|mp3|wav|x-wav)(;.*)?$/i;
const MAX_TRANSCRIPT_ENTRIES = 5000;

const findMeeting = async (req, res, select) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(400).json({ success: false, message: "Invalid meeting ID" });
    return null;
  }
  const q = Meeting.findOne({ _id: req.params.id, ...createdInOrg(req) });
  const meeting = await (select ? q.select(select) : q);
  if (!meeting) res.status(404).json({ success: false, message: "Meeting not found" });
  return meeting;
};

const fail = (res, err) => {
  console.error("Meeting media error:", err);
  res.status(err.status || 500).json({ success: false, message: err.status ? err.message : "Internal server error", code: err.code });
};

// ==================== GET /api/meetings/participants ====================
// Everyone in my organization (Admin + members) — for the member / action-owner pickers.
export const getParticipants = async (req, res) => {
  try {
    const filter = req.orgUserIds
      ? { _id: { $in: req.orgUserIds }, status: "Active" }
      : { role: { $ne: "SuperAdmin" }, status: "Active" };
    const users = await User.find(filter).select("name email department role").sort({ name: 1 }).lean();
    res.json({ success: true, count: users.length, data: users });
  } catch (err) {
    fail(res, err);
  }
};

// ==================== RECORDING ====================
const recordingUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, RECORDING_DIR),
    filename: (req, file, cb) => {
      const fromName = path.extname(file.originalname || "").toLowerCase();
      const ext = [".webm", ".mp4", ".m4a", ".mp3", ".ogg", ".wav"].includes(fromName)
        ? fromName
        : /mp4/i.test(file.mimetype) ? ".mp4" : /mpeg|mp3/i.test(file.mimetype) ? ".mp3" : /wav/i.test(file.mimetype) ? ".wav" : /ogg/i.test(file.mimetype) ? ".ogg" : ".webm";
      cb(null, `meeting-${Date.now()}-${crypto.randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: MAX_RECORDING_SIZE, files: 1 },
  fileFilter: (req, file, cb) => {
    // Browsers label recordings differently (codec suffixes, generic types) — accept by type OR extension
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (RECORDING_TYPES.test(file.mimetype) || [".webm", ".mp4", ".m4a", ".mp3", ".ogg", ".wav"].includes(ext)) {
      return cb(null, true);
    }
    const err = new Error("Recording must be an audio or video file (webm, mp4, mp3, ogg, wav)");
    err.status = 400;
    cb(err);
  },
}).single("recording");

export const uploadRecordingFile = (req, res, next) =>
  recordingUpload(req, res, (err) => {
    if (!err) return next();
    const message = err.code === "LIMIT_FILE_SIZE" ? "Recording is larger than 1 GB" : err.message;
    res.status(400).json({ success: false, message });
  });

const removeFile = (filename) =>
  filename ? fs.promises.unlink(path.join(RECORDING_DIR, path.basename(filename))).catch(() => {}) : null;

// POST /api/meetings/:id/recording   (multipart field "recording", optional durationSec)
export const saveRecording = async (req, res) => {
  try {
    const meeting = await findMeeting(req, res);
    if (!meeting) return removeFile(req.file?.filename);
    if (!req.file) return res.status(400).json({ success: false, message: "No recording received" });
    if (req.file.size === 0) {
      await removeFile(req.file.filename);
      return res.status(400).json({ success: false, message: "The recording is empty" });
    }

    const old = meeting.recordingFile?.filename;
    meeting.recording = true;
    meeting.recordingFile = {
      filename: req.file.filename,
      name: `${meeting.title} - recording${path.extname(req.file.filename)}`,
      size: req.file.size,
      mimetype: RECORDING_TYPES.test(req.file.mimetype)
        ? req.file.mimetype.split(";")[0]
        : ({ ".mp4": "video/mp4", ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav" }[path.extname(req.file.filename)] || "video/webm"),
      durationSec: Math.max(0, Math.round(Number(req.body.durationSec) || 0)),
      uploadedBy: req.user._id,
      uploadedAt: new Date(),
    };
    await meeting.save();
    if (old && old !== req.file.filename) await removeFile(old);

    // ⭐ Transcribe the recording automatically (all voices from the Meet tab), unless a
    //    Google / imported transcript already exists — those are kept.
    let transcribing = false;
    const existing = meeting.transcript?.entries?.length ? meeting.transcript.source : "";
    if (meeting.transcription && !["google", "import"].includes(existing)) {
      await queueTranscription(meeting._id, req.user._id);
      transcribing = true;
    }

    res.status(201).json({
      success: true,
      message: transcribing
        ? "Recording saved — the transcript is being created from it"
        : "Recording saved to this MoM",
      data: meeting.recordingFile,
      transcribing,
    });
  } catch (err) {
    await removeFile(req.file?.filename);
    fail(res, err);
  }
};

// GET /api/meetings/:id/recording  — authenticated stream (Range supported for seeking)
export const streamRecording = async (req, res) => {
  try {
    const meeting = await findMeeting(req, res, "recordingFile title");
    if (!meeting) return;
    const file = meeting.recordingFile;
    const full = file?.filename ? path.join(RECORDING_DIR, path.basename(file.filename)) : null;
    if (!full || !fs.existsSync(full)) {
      return res.status(404).json({ success: false, message: "No recording for this meeting" });
    }
    res.set("Cache-Control", "private, no-store");
    if (req.query.download === "1") return res.download(full, file.name);
    res.type(file.mimetype || "video/webm");
    return res.sendFile(full);
  } catch (err) {
    fail(res, err);
  }
};

// DELETE /api/meetings/:id/recording
export const deleteRecording = async (req, res) => {
  try {
    const meeting = await findMeeting(req, res);
    if (!meeting) return;
    const old = meeting.recordingFile?.filename;
    meeting.recordingFile = null;
    await meeting.save();
    await removeFile(old);
    res.json({ success: true, message: "Recording deleted" });
  } catch (err) {
    fail(res, err);
  }
};

// ==================== TRANSCRIPT ====================
const cleanEntries = (list) =>
  (Array.isArray(list) ? list : [])
    .map((e) => ({
      speaker: String(e?.speaker || "Speaker").trim().slice(0, 80) || "Speaker",
      text: String(e?.text || "").trim().slice(0, 5000),
      at: e?.at && !Number.isNaN(new Date(e.at).getTime()) ? new Date(e.at) : null,
      offsetSec: Number.isFinite(Number(e?.offsetSec)) && e?.offsetSec !== null ? Number(e.offsetSec) : null,
    }))
    .filter((e) => e.text);

const saveTranscript = async (req, res, meeting, entries, source, { append = false, extra = {} } = {}) => {
  const current = append && meeting.transcript?.source === source ? meeting.transcript.entries || [] : [];
  const merged = [...current, ...entries].slice(0, MAX_TRANSCRIPT_ENTRIES);
  meeting.transcription = true;
  meeting.transcript = { source, entries: merged, updatedAt: new Date(), updatedBy: req.user._id };
  Object.assign(meeting, extra);
  await meeting.save();
  return res.json({
    success: true,
    message: `Transcript saved (${merged.length} line${merged.length === 1 ? "" : "s"})`,
    data: { transcript: meeting.transcript, googleRecordingUrl: meeting.googleRecordingUrl },
  });
};

// PUT /api/meetings/:id/transcript  { entries: [...], source: "live", append?: true }
export const putTranscript = async (req, res) => {
  try {
    const meeting = await findMeeting(req, res);
    if (!meeting) return;
    const entries = cleanEntries(req.body.entries);
    const source = req.body.source === "import" ? "import" : "live";
    if (!entries.length && !req.body.append) {
      return res.status(400).json({ success: false, message: "Transcript is empty" });
    }
    return saveTranscript(req, res, meeting, entries, source, { append: Boolean(req.body.append) });
  } catch (err) {
    fail(res, err);
  }
};

// POST /api/meetings/:id/transcript/import  { text: "<file contents>" }
export const importTranscript = async (req, res) => {
  try {
    const meeting = await findMeeting(req, res);
    if (!meeting) return;
    const text = String(req.body.text || "");
    if (!text.trim()) return res.status(400).json({ success: false, message: "The transcript file is empty" });
    if (text.length > 2 * 1024 * 1024) {
      return res.status(400).json({ success: false, message: "Transcript file is larger than 2 MB" });
    }
    const entries = parseTranscript(text);
    if (!entries.length) {
      return res.status(400).json({ success: false, message: "No transcript lines were found in this file" });
    }
    return saveTranscript(req, res, meeting, entries, "import");
  } catch (err) {
    fail(res, err);
  }
};

// POST /api/meetings/:id/transcript/google  — pull from Google Meet (Workspace accounts)
export const fetchTranscriptFromGoogle = async (req, res) => {
  try {
    const meeting = await findMeeting(req, res);
    if (!meeting) return;
    const { entries, recordingUrl } = await fetchGoogleMeetTranscript(meeting.googleMeetLink, req.app.get("meetClient"));
    return saveTranscript(req, res, meeting, cleanEntries(entries), "google", {
      extra: recordingUrl ? { googleRecordingUrl: recordingUrl } : {},
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, message: err.message, code: err.code });
    fail(res, err);
  }
};

// POST /api/meetings/:id/transcript/whisper — (re)create the transcript from the recording
export const transcribeRecording = async (req, res) => {
  try {
    const meeting = await findMeeting(req, res);
    if (!meeting) return;
    if (!meeting.recordingFile?.filename) {
      return res.status(400).json({ success: false, message: "Record the meeting first — there is no recording to transcribe." });
    }
    if (["queued", "processing"].includes(meeting.transcript?.status)) {
      return res.status(409).json({ success: false, message: "This recording is already being transcribed." });
    }
    const position = await queueTranscription(meeting._id, req.user._id);
    res.status(202).json({
      success: true,
      message: position > 1 ? `Queued — ${position - 1} recording(s) ahead of this one` : "Transcription started",
      data: { status: "queued", position },
    });
  } catch (err) {
    fail(res, err);
  }
};

// GET /api/meetings/:id/transcript — current transcript + job status (for polling)
export const getTranscript = async (req, res) => {
  try {
    const meeting = await findMeeting(req, res, "transcript transcription recordingFile googleRecordingUrl");
    if (!meeting) return;
    res.json({ success: true, data: { transcript: meeting.transcript, transcription: meeting.transcription } });
  } catch (err) {
    fail(res, err);
  }
};

// DELETE /api/meetings/:id/transcript
export const clearTranscript = async (req, res) => {
  try {
    const meeting = await findMeeting(req, res);
    if (!meeting) return;
    meeting.transcript = { source: "", entries: [], status: "", error: "", updatedAt: new Date(), updatedBy: req.user._id };
    await meeting.save();
    res.json({ success: true, message: "Transcript cleared" });
  } catch (err) {
    fail(res, err);
  }
};
