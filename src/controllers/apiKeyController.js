// src/controllers/apiKeyController.js
// Users manage their own API keys. A key acts as its owner.
import mongoose from "mongoose";
import ApiKey, { generateApiKey, hashApiKey } from "../models/ApiKey.js";

const MAX_ACTIVE_KEYS = 20;

// POST /api/api-keys   { name, access?: "read"|"full", expiresInDays? }
export const createApiKey = async (req, res, next) => {
  try {
    const { name, access = "read", expiresInDays } = req.body || {};
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ success: false, message: "name is required" });
    }
    if (!["read", "full"].includes(access)) {
      return res.status(400).json({ success: false, message: 'access must be "read" or "full"' });
    }
    let expiresAt = null;
    if (expiresInDays !== undefined && expiresInDays !== null) {
      const days = Number(expiresInDays);
      if (!Number.isFinite(days) || days <= 0 || days > 3650) {
        return res.status(400).json({ success: false, message: "expiresInDays must be between 1 and 3650" });
      }
      expiresAt = new Date(Date.now() + days * 86_400_000);
    }

    const activeCount = await ApiKey.countDocuments({ user: req.user._id, revokedAt: null });
    if (activeCount >= MAX_ACTIVE_KEYS) {
      return res.status(400).json({ success: false, message: `You can have at most ${MAX_ACTIVE_KEYS} keys. Revoke one first.` });
    }

    const key = generateApiKey();
    const doc = await ApiKey.create({
      name: name.trim(),
      keyHash: hashApiKey(key),
      prefix: key.slice(0, 10),
      user: req.user._id,
      access,
      expiresAt,
    });

    res.status(201).json({
      success: true,
      message: "API key created. Copy it now — it will not be shown again.",
      data: { ...doc.toSafeJSON(), key },
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/api-keys
export const listApiKeys = async (req, res, next) => {
  try {
    const keys = await ApiKey.find({ user: req.user._id }).sort({ createdAt: -1 });
    res.json({ success: true, data: keys.map((k) => k.toSafeJSON()) });
  } catch (err) {
    next(err);
  }
};

// DELETE /api/api-keys/:id   (revoke)
export const revokeApiKey = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ success: false, message: "API key not found" });
    }
    const key = await ApiKey.findOne({ _id: req.params.id, user: req.user._id });
    if (!key) return res.status(404).json({ success: false, message: "API key not found" });
    if (!key.revokedAt) {
      key.revokedAt = new Date();
      await key.save();
    }
    res.json({ success: true, message: "API key revoked", data: key.toSafeJSON() });
  } catch (err) {
    next(err);
  }
};
