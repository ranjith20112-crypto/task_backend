import { google } from "googleapis";
import { DateTime } from "luxon";
import { randomUUID } from "node:crypto";

const timeZone = process.env.MEETING_TIME_ZONE || "Asia/Kolkata";

// Clear, user-facing reason when Google can't be used
export class GoogleConnectionError extends Error {
  constructor(message, code) {
    super(message);
    this.status = 503;
    this.code = code;
  }
}

export const explainGoogleCalendarError = (err) => {
  if (err instanceof GoogleConnectionError) return err;
  const data = err?.response?.data || {};
  const reason = `${data.error || ""} ${data.error_description || ""} ${err?.message || ""}`;
  if (/invalid_grant|expired or revoked/i.test(reason)) {
    return new GoogleConnectionError(
      "The Google connection has expired, so no Google Meet link could be created. An administrator must reconnect Google (run \"npm run google:token\" in the backend folder).",
      "GOOGLE_RECONNECT"
    );
  }
  if (/invalid_client|unauthorized_client/i.test(reason)) {
    return new GoogleConnectionError("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in .env are not valid.", "GOOGLE_CLIENT_INVALID");
  }
  if (/insufficient|scope/i.test(reason) || err?.response?.status === 403) {
    return new GoogleConnectionError(
      "The connected Google account did not allow Calendar access. Reconnect Google (npm run google:token).",
      "GOOGLE_SCOPE"
    );
  }
  return new GoogleConnectionError(`Google Calendar error: ${err?.message || "unknown error"}`, "GOOGLE_ERROR");
};

const getCalendar = () => {
  const {
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REFRESH_TOKEN,
  } = process.env;

  if (
    !GOOGLE_CLIENT_ID ||
    !GOOGLE_CLIENT_SECRET ||
    !GOOGLE_REFRESH_TOKEN
  ) {
    throw new GoogleConnectionError(
      "Google is not connected (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN missing in .env).",
      "GOOGLE_NOT_CONNECTED"
    );
  }

  const auth = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  auth.setCredentials({
    refresh_token: GOOGLE_REFRESH_TOKEN,
  });

  return google.calendar({
    version: "v3",
    auth,
  });
};

export const getMeetingStartDate = (meeting) => {
  const date = new Date(meeting.meetingDate);

  if (Number.isNaN(date.getTime())) {
    throw new Error("Invalid meeting date");
  }

  const dateString = date.toISOString().slice(0, 10);
  const startTime = meeting.startTime || "09:00";

  const start = DateTime.fromISO(
    `${dateString}T${startTime}`,
    { zone: timeZone }
  );

  if (!start.isValid) {
    throw new Error("Invalid meeting start time");
  }

  return start;
};

export const createGoogleMeetEvent = async (meeting) => {
  try {
    return await createGoogleMeetEventRaw(meeting);
  } catch (err) {
    throw explainGoogleCalendarError(err);
  }
};

// Cheap health check (no event is created): can we get an access token + read the calendar?
let statusCache = { at: 0, value: null };
export const checkGoogleConnection = async () => {
  if (statusCache.value && Date.now() - statusCache.at < 2 * 60 * 1000) return statusCache.value;
  let value;
  try {
    const calendar = getCalendar();
    // Allowed by the calendar.events scope the app requests (calendarList is not)
    await calendar.events.list({ calendarId: "primary", maxResults: 1 });
    value = { ok: true };
  } catch (err) {
    const e = explainGoogleCalendarError(err);
    value = { ok: false, code: e.code, message: e.message };
  }
  statusCache = { at: Date.now(), value };
  return value;
};
export const resetGoogleStatusCache = () => {
  statusCache = { at: 0, value: null };
};

const createGoogleMeetEventRaw = async (meeting) => {
  const calendar = getCalendar();
  const start = getMeetingStartDate(meeting);

  const end = meeting.endTime
    ? DateTime.fromISO(
        `${start.toISODate()}T${meeting.endTime}`,
        { zone: timeZone }
      )
    : start.plus({ hours: 1 });

  if (!end.isValid || end <= start) {
    throw new Error("Meeting end time must be after start time");
  }

  const attendeeEmails = [
    ...new Set(
      (meeting.attendees || [])
        .map((attendee) => attendee.email?.trim().toLowerCase())
        .filter(Boolean)
    ),
  ];

  const response = await calendar.events.insert({
    calendarId: "primary",
    conferenceDataVersion: 1,
    sendUpdates: "none",
    requestBody: {
      summary: meeting.title,
      description: meeting.agenda || "",
      start: {
        dateTime: start.toISO(),
        timeZone,
      },
      end: {
        dateTime: end.toISO(),
        timeZone,
      },
      attendees: attendeeEmails.map((email) => ({ email })),
      conferenceData: {
        createRequest: {
          requestId: randomUUID(),
          conferenceSolutionKey: {
            type: "hangoutsMeet",
          },
        },
      },
    },
  });

  let event = response.data;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const meetLink =
      event.hangoutLink ||
      event.conferenceData?.entryPoints?.find(
        (entry) => entry.entryPointType === "video"
      )?.uri;

    if (meetLink) {
      return {
        id: event.id,
        meetLink,
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));

    const refreshed = await calendar.events.get({
      calendarId: "primary",
      eventId: event.id,
    });

    event = refreshed.data;
  }

  throw new Error(
    "Google Calendar created the event, but the Meet link is not ready yet"
  );
};
