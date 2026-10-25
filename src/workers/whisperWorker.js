// Runs in a worker thread: decode a recording with ffmpeg and transcribe it with
// Whisper (local, no API key — the same approach as Meetily). Keeps the API responsive.
import { parentPort } from "node:worker_threads";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ffmpegPath from "ffmpeg-static";
import { pipeline, env } from "@huggingface/transformers";

env.cacheDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../models");

let asr = null;
let loadedModel = "";

const decode = (file) =>
  new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, ["-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "pipe:1"]);
    const chunks = [];
    let err = "";
    ff.stdout.on("data", (c) => chunks.push(c));
    ff.stderr.on("data", (d) => (err += d));
    ff.on("error", reject);
    ff.on("close", (code) => {
      if (code !== 0) return reject(new Error(`Could not read the recording audio (${err.trim().split("\n").pop() || code})`));
      const buf = Buffer.concat(chunks);
      resolve(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4)));
    });
  });

parentPort.on("message", async ({ id, file, model, language }) => {
  try {
    const audio = await decode(file);
    const seconds = audio.length / 16000;
    if (seconds < 0.5) throw new Error("The recording has no audio track.");

    let peak = 0;
    for (let i = 0; i < audio.length; i += 160) peak = Math.max(peak, Math.abs(audio[i]));
    if (peak < 0.003) {
      throw new Error('The recording is silent. When recording, pick the Google Meet tab and tick "Also share tab audio".');
    }

    if (!asr || loadedModel !== model) {
      asr = await pipeline("automatic-speech-recognition", model, { dtype: "q8" });
      loadedModel = model;
    }
    const out = await asr(audio, {
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: true,
      task: "transcribe",
      ...(language ? { language } : {}),
    });
    const segments = (out.chunks || [{ timestamp: [0, seconds], text: out.text }])
      .map((c) => ({ text: String(c.text || "").trim(), start: Array.isArray(c.timestamp) ? c.timestamp[0] ?? 0 : 0 }))
      .filter((c) => c.text && !/^\[?(music|silence|blank_audio)\]?$/i.test(c.text));
    parentPort.postMessage({ id, ok: true, seconds, segments });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: err.message || String(err) });
  }
});
