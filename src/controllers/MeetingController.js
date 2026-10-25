
import mongoose from "mongoose";
import Meeting from "../models/Meeting.js";
import { createdInOrg } from "../middleware/orgScope.js";
import { checkGoogleConnection } from "../services/googleCalendarService.js";
import {
  createMeetAndSendInvitation,
} from "../services/meetingNotificationService.js";
import {
  sendMeetingReminder,
  sendMomEmail,
} from "../services/meetingEmailService.js";

const getUserId = (req) =>
  req.user?.id || req.user?._id || req.user?.userId;

const handleError = (res, error) => {
  console.error("Meeting error:", error);

  if (error.name === "ValidationError" || error.name === "CastError") {
    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }

  return res.status(500).json({
    success: false,
    message: "Internal server error",
  });
};

// CREATE MEETING + GOOGLE MEET + INVITATION
export const createMeeting = async (req, res) => {
  try {
    const userId = getUserId(req);

    if (!userId || !mongoose.isValidObjectId(userId)) {
      return res.status(401).json({
        success: false,
        message: "Invalid authenticated user",
      });
    }

    const { title, meetingDate } = req.body;

    if (!title?.trim() || !meetingDate) {
      return res.status(400).json({
        success: false,
        message: "Meeting title and meeting date are required",
      });
    }

    // Recording / transcript are written only by their own endpoints
    // googleMeetLink / googleEventId come ONLY from Google (a typed or random link would
    // stop the real Meet from being created and can never have a transcript)
    const { recordingFile, transcript, googleRecordingUrl, googleMeetLink, googleEventId, ...fields } = req.body;

    const meeting = await Meeting.create({
      ...fields,
      title: title.trim(),
      createdBy: userId,
    });

    let integration = {
      googleMeetLink: "",
      invitationSent: false,
      warning: null,
    };

    if (meeting.meetingType !== "Offline") {
      try {
        const result = await createMeetAndSendInvitation(meeting);

        integration = {
          googleMeetLink: result.googleMeetLink || "",
          invitationSent: result.invitationSent || false,
          warning: result.emailWarning || null,
        };
      } catch (error) {
        console.error("Meeting integration failed:", error.message);

        integration.warning = error.message;
        integration.code = error.code || null;
      }
    }

    return res.status(201).json({
      success: true,
      message: "Meeting created successfully",
      data: meeting,
      integration,
    });
  } catch (error) {
    return handleError(res, error);
  }
};

// GET ALL MEETINGS
export const getMeetings = async (req, res) => {
  try {
    // ⭐ Organization isolation — only meetings created inside my organization
    const meetings = await Meeting.find(createdInOrg(req))
      .populate("createdBy", "name email")
      .sort({ meetingDate: -1, createdAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      count: meetings.length,
      data: meetings,
    });
  } catch (error) {
    return handleError(res, error);
  }
};

// GET SINGLE MEETING
export const getMeetingById = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid meeting ID",
      });
    }

    const meeting = await Meeting.findOne({ _id: req.params.id, ...createdInOrg(req) })
      .populate("createdBy", "name email");

    if (!meeting) {
      return res.status(404).json({
        success: false,
        message: "Meeting not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: meeting,
    });
  } catch (error) {
    return handleError(res, error);
  }
};

// UPDATE MEETING
export const updateMeeting = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid meeting ID",
      });
    }

    const updates = { ...req.body };

    delete updates.createdBy;
    delete updates._id;
    delete updates.googleEventId;
    delete updates.googleMeetLink;
    delete updates.invitationSentAt;
    delete updates.reminderSentAt;
    delete updates.momEmailSentAt;
    // Managed by the recording / transcript endpoints only
    delete updates.recordingFile;
    delete updates.transcript;
    delete updates.googleRecordingUrl;

    const meeting = await Meeting.findOneAndUpdate(
      { _id: req.params.id, ...createdInOrg(req) },
      { $set: updates },
      { new: true, runValidators: true }
    );

    if (!meeting) {
      return res.status(404).json({
        success: false,
        message: "Meeting not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Meeting updated successfully",
      data: meeting,
    });
  } catch (error) {
    return handleError(res, error);
  }
};

// DELETE MEETING
export const deleteMeeting = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid meeting ID",
      });
    }

    const meeting = await Meeting.findOneAndDelete({ _id: req.params.id, ...createdInOrg(req) });

    if (!meeting) {
      return res.status(404).json({
        success: false,
        message: "Meeting not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Meeting deleted successfully",
    });
  } catch (error) {
    return handleError(res, error);
  }
};

// RESEND MEETING INVITATION
export const resendMeetingInvitation = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid meeting ID",
      });
    }

    const meeting = await Meeting.findOne({ _id: req.params.id, ...createdInOrg(req) });

    if (!meeting) {
      return res.status(404).json({
        success: false,
        message: "Meeting not found",
      });
    }

    if (meeting.meetingType === "Offline") {
      meeting.meetingType = "Online"; // asking for a link means it is (also) online
    }

    let result;
    try {
      result = await createMeetAndSendInvitation(meeting, { resend: true });
    } catch (error) {
      // Google problems → tell the user exactly what to do (not a generic 500)
      if (error.status) {
        return res.status(error.status).json({ success: false, message: error.message, code: error.code });
      }
      throw error;
    }

    const parts = [
      result.linkCreated ? "Google Meet link created" : "Google Meet link ready",
      result.invitationSent ? "invitation emailed to the members" : `invitation NOT sent (${result.emailWarning})`,
    ];

    return res.status(200).json({
      success: true,
      message: parts.join(", ") + ".",
      data: {
        meetingId: meeting._id,
        googleMeetLink: result.googleMeetLink,
        invitationSent: result.invitationSent,
        warning: result.emailWarning || null,
        meeting,
      },
    });
  } catch (error) {
    return handleError(res, error);
  }
};

// SEND REMINDER MANUALLY
export const resendMeetingReminder = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid meeting ID",
      });
    }

    const meeting = await Meeting.findOne({ _id: req.params.id, ...createdInOrg(req) });

    if (!meeting) {
      return res.status(404).json({
        success: false,
        message: "Meeting not found",
      });
    }

    const result = await sendMeetingReminder(meeting);

    if (!result.sent) {
      return res.status(400).json({
        success: false,
        message: result.reason || "Reminder email was not sent",
      });
    }

    meeting.reminderSentAt = new Date();
    await meeting.save();

    return res.status(200).json({
      success: true,
      message: "Reminder email sent successfully",
      sentCount: result.sentCount,
    });
  } catch (error) {
    return handleError(res, error);
  }
};

// SEND MINUTES OF MEETING (MOM)
export const generateMOM = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid meeting ID",
      });
    }

    const meeting = await Meeting.findOne({ _id: req.params.id, ...createdInOrg(req) });

    if (!meeting) {
      return res.status(404).json({
        success: false,
        message: "Meeting not found",
      });
    }

    const result = await sendMomEmail(meeting);

    if (!result.sent) {
      return res.status(400).json({
        success: false,
        message: result.reason || "MOM email was not sent",
      });
    }

    meeting.momEmailSentAt = new Date();
    await meeting.save();

    return res.status(200).json({
      success: true,
      message: "MOM email sent successfully",
      sentCount: result.sentCount,
    });
  } catch (error) {
    return handleError(res, error);
  }
};


// GET /api/meetings/integration-status — is Google Meet / invitation email usable right now?
export const getIntegrationStatus = async (req, res) => {
  try {
    const google = await checkGoogleConnection();
    const email = process.env.SMTP_USER && process.env.SMTP_PASS
      ? { ok: true }
      : { ok: false, message: "Email (SMTP) is not configured in .env — invitations cannot be sent." };
    res.json({ success: true, data: { google, email } });
  } catch (error) {
    return handleError(res, error);
  }
};
