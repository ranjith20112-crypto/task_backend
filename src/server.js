import mongoose from "mongoose";
import dotenv from "dotenv";
import { server } from "./app.js";
import { startMeetingReminderJob } from "./jobs/meetingReminderJob.js";
import { startTaskReminderJob } from "./jobs/taskReminderJob.js";
import { startChatExpiryJob } from "./jobs/chatExpiryJob.js";
import { resumeInterruptedTranscriptions } from "./services/transcriptionService.js";

dotenv.config();

// ==================== START SERVER ====================
const PORT = process.env.PORT || 5000;

if (!process.env.MONGO_URI) {
  console.error("❌ MONGO_URI is missing from .env");
  process.exit(1);
}

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log("✅ MongoDB connected");

    server.listen(PORT, () => {
      console.log(`✅ Server running on http://localhost:${PORT}`);
      console.log("✅ Socket.IO initialized");
      console.log("✅ Chat REST routes registered at /api/chat");
      console.log("✅ Task attachments: GET /api/tasks/attachments/:filename (authenticated)");

      startMeetingReminderJob();
      startTaskReminderJob();
      startChatExpiryJob();
      resumeInterruptedTranscriptions().catch((e) => console.error("Transcription resume failed:", e.message));
    });
  })
  .catch((error) => {
    console.error("❌ MongoDB connection failed:", error.message);
    process.exit(1);
  });
