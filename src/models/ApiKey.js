// src/models/ApiKey.js
// Long-lived API keys for integrations / third parties.
// A key acts AS the user who owns it — same role, scope and permissions.
// Only a SHA-256 hash is stored; the plain key is shown once at creation.
import mongoose from "mongoose";
import crypto from "crypto";

export const API_KEY_PREFIX = "tk_";

export const hashApiKey = (key) => crypto.createHash("sha256").update(key).digest("hex");

export const generateApiKey = () => API_KEY_PREFIX + crypto.randomBytes(32).toString("base64url");

const apiKeySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Key name is required"],
      trim: true,
      maxlength: [80, "Key name must be at most 80 characters"],
    },
    keyHash: { type: String, required: true, unique: true, select: false },
    // First characters of the key, so people can recognise it in a list
    prefix: { type: String, required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    // "read" → GET/HEAD only · "full" → everything the owner can do
    access: { type: String, enum: ["read", "full"], default: "read" },
    expiresAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    lastUsedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

apiKeySchema.methods.toSafeJSON = function () {
  return {
    _id: this._id,
    name: this.name,
    prefix: this.prefix,
    access: this.access,
    expiresAt: this.expiresAt,
    revokedAt: this.revokedAt,
    lastUsedAt: this.lastUsedAt,
    createdAt: this.createdAt,
    active: !this.revokedAt && (!this.expiresAt || this.expiresAt > new Date()),
  };
};

export default mongoose.models.ApiKey || mongoose.model("ApiKey", apiKeySchema);
