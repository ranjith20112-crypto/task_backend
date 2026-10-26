import express from "express";
import http from "http";
import cors from "cors";
import dotenv from "dotenv";
import morgan from "morgan";
import path from "path";
import { fileURLToPath } from "url";
import { Server } from "socket.io";

import authRoutes from "./routes/authRoutes.js";
import userRoutes from "./routes/userRoutes.js";
import departmentRoutes from "./routes/departmentRoutes.js";
import taskRoutes from "./routes/taskRoutes.js";
import taskBankRoutes from "./routes/taskBankRoutes.js";
import taskCalendarRoutes from "./routes/taskCalendar.js";
import meetingRoutes from "./routes/MeetingRoutes.js";
import chatRoutes from "./routes/chatRoutes.js";
import reportRoutes from "./routes/reportRoutes.js";
import supportRoutes from "./routes/supportRoutes.js";
import permissionRoutes from "./routes/permissionRoutes.js";
import notificationRoutes from "./routes/notificationRoutes.js";
import customRoleRoutes from "./routes/customRoleRoutes.js";

import {
  getConnectUrl,
  oauthCallback,
} from "./controllers/googleConnectController.js";

import { authorize } from "./middleware/role.js";
import { authenticate } from "./middleware/auth.js";
import { attachScope } from "./middleware/scopeMiddleware.js";
import { attachOrgUsers } from "./middleware/orgScope.js";

import {
  attachPermissions,
  permissionByMethod,
  requirePermission,
} from "./middleware/permissionMiddleware.js";

import { registerChatSocket } from "./socket/Chatsocket.js";
import { setRealtimeIO } from "./socket/realtime.js";

dotenv.config();

export const app = express();
export const server = http.createServer(app);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ==================== CORS CONFIGURATION ====================

const allowedOrigins = [
  "https://task-frontend-zeta-five.vercel.app",
  "http://localhost:5173",
  "http://localhost:3000",
  "https://task-backend-mn8a.onrender.com",
];

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests without an Origin header.
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    console.error("CORS blocked origin:", origin);
    return callback(new Error("Origin not allowed by CORS"));
  },

  methods: [
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "OPTIONS",
  ],

  allowedHeaders: [
    "Content-Type",
    "Authorization",
  ],

  credentials: true,
  optionsSuccessStatus: 204,
};

// Apply CORS before routes and authentication middleware.
app.use(cors(corsOptions));

// Explicitly handle browser preflight requests.
app.options(/.*/, cors(corsOptions));

// ==================== SOCKET.IO ====================

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: [
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
    ],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
    ],
    credentials: true,
  },
});

registerChatSocket(io);
app.set("io", io);
setRealtimeIO(io);

// ==================== GENERAL MIDDLEWARE ====================

app.use(express.json({ limit: "3mb" }));
app.use(express.urlencoded({ extended: true }));

if (process.env.NODE_ENV !== "test") {
  app.use(morgan("dev"));
}

// ==================== PUBLIC ROUTES ====================

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Task Management API is running",
    version: "1.0.0",
    endpoints: {
      auth: "/api/auth",
      users: "/api/users",
      departments: "/api/departments",
      tasks: "/api/tasks",
      taskbank: "/api/taskbank",
      taskcalendar: "/api/taskcalendar",
      meetings: "/api/meetings",
      chat: "/api/chat",
      reports: "/api/reports",
      support: "/api/support",
      permissions: "/api/permissions",
      notifications: "/api/notifications",
      customRoles: "/api/custom-roles",
    },
  });
});

// Login and other authentication routes remain public.
app.use("/api/auth", authRoutes);

// Google OAuth callback.
app.get("/oauth2callback", oauthCallback);

// ==================== PROTECTED ROUTES ====================

const protect = [
  authenticate,
  attachScope,
  attachPermissions,
];

app.use(
  "/api/permissions",
  ...protect,
  permissionRoutes
);

app.use(
  "/api/notifications",
  ...protect,
  notificationRoutes
);

app.use(
  "/api/custom-roles",
  ...protect,
  customRoleRoutes
);

app.post(
  "/api/google/connect-url",
  ...protect,
  authorize("Admin", "SuperAdmin"),
  getConnectUrl
);

app.use(
  "/api/departments",
  ...protect,
  departmentRoutes
);

app.use(
  "/api/tasks",
  ...protect,
  taskRoutes
);

app.use(
  "/api/taskbank",
  ...protect,
  taskBankRoutes
);

app.use(
  "/api/taskcalendar",
  ...protect,
  taskCalendarRoutes
);

app.use(
  "/api/meetings",
  ...protect,
  attachOrgUsers,
  permissionByMethod("communication"),
  meetingRoutes
);

app.use(
  "/api/chat",
  ...protect,
  requirePermission("chat", "view"),
  chatRoutes
);

app.use(
  "/api/support",
  ...protect,
  permissionByMethod("support"),
  supportRoutes
);

app.use(
  "/api/reports",
  ...protect,
  reportRoutes
);

// General user routes last.
app.use(
  "/api",
  ...protect,
  userRoutes
);

// ==================== 404 HANDLER ====================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
});

// ==================== GLOBAL ERROR HANDLER ====================

app.use((err, req, res, next) => {
  console.error("Global Error:", err.message);

  if (res.headersSent) {
    return next(err);
  }

  const status = err.status || err.statusCode || 500;

  res.status(status).json({
    success: false,
    message:
      status < 500
        ? err.message
        : "Something went wrong",

    error:
      process.env.NODE_ENV === "production"
        ? undefined
        : err.message,
  });
});

export default app;
