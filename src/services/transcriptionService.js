// Queue for transcribing meeting recordings with local Whisper (one at a time).
// Result is saved on the meeting as transcript { source: "whisper", entries, status }.
import { Worker } from "node:worker_threads";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Meeting from "../models/Meeting.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const RECORDING_DIR = path.resolve(here, "../../uploads/meetings");

// Multilingual Whisper "base" (~77 MB). Override in .env, e.g. onnx-community/whisper-small
export const WHISPER_MODEL = () => process.env.WHISPER_MODEL || "onnx-community/whisper-base";
// e.g. "english", "tamil", "hindi"; empty → English
export const WHISPER_LANGUAGE = () => process.env.WHISPER_LANGUAGE || "english";

let worker = null;
let seq = 0;
const waiting = new Map();

const getWorker = () => {
  if (worker) return worker;
  worker = new Worker(path.resolve(here, "../workers/whisperWorker.js"));
  worker.unref(); // never keeps the process alive on shutdown
  worker.on("message", (msg) => {
    const p = waiting.get(msg.id);
    if (!p) return;
    waiting.delete(msg.id);
    msg.ok ? p.resolve(msg) : p.reject(new Error(msg.error));
  });
  worker.on("error", (err) => {
    for (const p of waiting.values()) p.reject(err);
    waiting.clear();
    worker = null;
  });
  worker.on("exit", () => {
    worker = null;
  });
  return worker;
};

// Default transcriber (tests replace it via setTranscriber)
let transcriber = (file) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    getWorker().postMessage({ id, file, model: WHISPER_MODEL(), language: WHISPER_LANGUAGE() });
  });

export const setTranscriber = (fn) => {
  transcriber = fn;
};

const queue = [];
let running = false;

const setStatus = (meetingId, patch) =>
  Meeting.updateOne(
    { _id: meetingId },
    { $set: Object.fromEntries(Object.entries(patch).map(([k, v]) => [`transcript.${k}`, v])) }
  );

const runNext = async () => {
  if (running) return;
  const job = queue.shift();
  if (!job) return;
  running = true;
  try {
    const meeting = await Meeting.findById(job.meetingId).select("recordingFile title");
    const file = meeting?.recordingFile?.filename ? path.join(RECORDING_DIR, path.basename(meeting.recordingFile.filename)) : null;
    if (!file || !fs.existsSync(file)) throw new Error("The recording file is missing.");

    await setStatus(job.meetingId, { status: "processing", error: "", startedAt: new Date() });
    const started = Date.now();
    const result = await transcriber(file);
    const entries = result.segments.map((s) => ({ speaker: "Recording", text: s.text, offsetSec: Math.round(s.start * 10) / 10, at: null }));
    if (!entries.length) throw new Error("No speech was found in the recording.");

    await Meeting.updateOne(
      { _id: job.meetingId },
      {
        $set: {
          transcription: true,
          "transcript.source": "whisper",
          "transcript.entries": entries.slice(0, 5000),
          "transcript.status": "done",
          "transcript.error": "",
          "transcript.updatedAt": new Date(),
          "transcript.updatedBy": job.userId || null,
        },
      }
    );
    console.log(`📝 Transcribed "${meeting.title}": ${entries.length} lines, ${Math.round(result.seconds || 0)}s audio in ${Math.round((Date.now() - started) / 1000)}s`);
  } catch (err) {
    console.error("Transcription failed:", err.message);
    await setStatus(job.meetingId, { status: "failed", error: err.message.slice(0, 500) }).catch(() => {});
  } finally {
    running = false;
    setImmediate(runNext);
  }
};

/** Put a meeting's recording in the queue. Returns the queue position (1 = next). */
export const queueTranscription = async (meetingId, userId) => {
  if (queue.some((j) => String(j.meetingId) === String(meetingId))) return queue.length;
  await setStatus(meetingId, { status: "queued", error: "" });
  queue.push({ meetingId, userId });
  setImmediate(runNext);
  return queue.length + (running ? 1 : 0);
};

// After a restart, anything that was "processing" or "queued" would wait forever → re-queue it
export const resumeInterruptedTranscriptions = async () => {
  const stuck = await Meeting.find({ "transcript.status": { $in: ["queued", "processing"] } }).select("_id").lean();
  for (const m of stuck) await queueTranscription(m._id, null);
  if (stuck.length) console.log(`📝 Re-queued ${stuck.length} interrupted transcription(s)`);
};
