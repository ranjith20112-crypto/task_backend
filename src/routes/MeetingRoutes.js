
import express from "express";

import { authenticate } from "../middleware/authMiddleware.js";

import {
  createMeeting,
  getMeetings,
  getMeetingById,
  updateMeeting,
  deleteMeeting,
  resendMeetingInvitation,
  resendMeetingReminder,
  generateMOM,
  getIntegrationStatus,
} from "../controllers/MeetingController.js";
import {
  getParticipants,
  uploadRecordingFile,
  saveRecording,
  streamRecording,
  deleteRecording,
  putTranscript,
  importTranscript,
  fetchTranscriptFromGoogle,
  clearTranscript,
  transcribeRecording,
  getTranscript,
} from "../controllers/meetingMediaController.js";

const router = express.Router();

// All meeting endpoints require a valid JWT.
router.use(authenticate);

// Org members for the member / action-owner pickers (BEFORE "/:id")
router.get("/participants", getParticipants);
router.get("/integration-status", getIntegrationStatus);

// Meeting CRUD
router.post("/", createMeeting);
router.get("/", getMeetings);
router.get("/:id", getMeetingById);
router.put("/:id", updateMeeting);
router.delete("/:id", deleteMeeting);

// Meeting emails and MOM
router.post("/:id/send-invitation", resendMeetingInvitation);
router.post("/:id/send-reminder", resendMeetingReminder);
router.post("/:id/send-mom", generateMOM);

// Whole-meeting recording (recorded in the organizer's browser)
router.post("/:id/recording", uploadRecordingFile, saveRecording);
router.get("/:id/recording", streamRecording);
router.delete("/:id/recording", deleteRecording);

// Transcript shown on the MoM card
router.get("/:id/transcript", getTranscript);
router.put("/:id/transcript", putTranscript);
router.post("/:id/transcript/whisper", transcribeRecording);
router.post("/:id/transcript/import", importTranscript);
router.post("/:id/transcript/google", fetchTranscriptFromGoogle);
router.delete("/:id/transcript", clearTranscript);

export default router;
