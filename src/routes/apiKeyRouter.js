// src/routes/apiKeyRoutes.js — manage your own API keys (needs a real login, not a key)
import express from "express";
import { requireSession } from "../middleware/authMiddleware.js";
import { createApiKey, listApiKeys, revokeApiKey } from "../controllers/apiKeyController.js";

const router = express.Router();

router.use(requireSession);
router.get("/", listApiKeys);
router.post("/", createApiKey);
router.delete("/:id", revokeApiKey);

export default router;
