import express from "express";
import {
  getChatUsers,
  getChatDepartments,
  createPrivateConversation,
  createDepartmentConversation,
  getConversations,
  getMessages,
  sendMessage,
} from "../controllers/chatController.js";
import {
  createGroup,
  updateGroup,
  leaveGroup,
  chatUpload,
  downloadChatAttachment,
} from "../controllers/chatGroupController.js";
import { requirePermission, hasPermission } from "../middleware/permissionMiddleware.js";

const router = express.Router();
// chat.view is required for everything (checked where the router is mounted)

router.get("/users", getChatUsers);
router.get("/departments", getChatDepartments);
router.get("/conversations", getConversations);

router.post("/private", requirePermission("chat", "send"), createPrivateConversation);
router.post("/department", requirePermission("chat", "send"), createDepartmentConversation);

// Groups
router.post("/groups", requirePermission("chat", "create_group"), createGroup);
router.patch("/groups/:id", requirePermission("chat", "manage_members"), updateGroup);
router.post("/groups/:id/leave", leaveGroup);

// Attachments (download / view)
router.get("/attachments/:filename", requirePermission("chat", "download"), downloadChatAttachment);

router.get("/:conversationId/messages", getMessages);
router.post(
  "/:conversationId/messages",
  requirePermission("chat", "send"),
  // Files need chat.upload as well (checked before anything is stored)
  (req, res, next) => {
    if (req.is("multipart/form-data") && !hasPermission(req, "chat", "upload")) {
      return res.status(403).json({ success: false, message: "Access denied. Missing permission: chat.upload" });
    }
    next();
  },
  chatUpload,
  sendMessage
);

export default router;
