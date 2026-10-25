import { createGoogleMeetEvent, resetGoogleStatusCache } from "./googleCalendarService.js";
import { sendMeetingInvitation } from "./meetingEmailService.js";

/**
 * Make sure the meeting has a REAL Google Meet link, then email the invitation.
 * A link without googleEventId was typed / randomly generated (old UI) and is replaced.
 * options.resend → send the invitation again even if it was sent before.
 */
export const createMeetAndSendInvitation = async (meeting, options = {}) => {
  let linkCreated = false;

  if (!meeting.googleMeetLink || !meeting.googleEventId) {
    const event = await createGoogleMeetEvent(meeting); // throws a clear GoogleConnectionError
    resetGoogleStatusCache();

    meeting.googleEventId = event.id;
    meeting.googleMeetLink = event.meetLink;
    linkCreated = true;

    // Save the link before attempting email delivery.
    await meeting.save();
  }

  let invitationSent = false;
  let emailWarning = null;

  if (!meeting.invitationSentAt || options.resend || linkCreated) {
    const result = await sendMeetingInvitation(meeting);

    if (result.sent) {
      meeting.invitationSentAt = new Date();
      invitationSent = true;
      if (result.failedCount) emailWarning = `${result.failedCount} invitation email(s) failed`;
    } else {
      emailWarning = result.reason || "Invitation email was not sent";
    }

    await meeting.save();
  }

  return {
    googleMeetLink: meeting.googleMeetLink,
    linkCreated,
    invitationSent,
    emailWarning,
  };
};
