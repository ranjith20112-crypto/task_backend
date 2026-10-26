// Account emails: verification (with one-time password reveal link) and
// forgot-password notifications to the responsible administrator.
import nodemailer from "nodemailer";

const isTest = process.env.NODE_ENV === "test";

// In tests nothing leaves the machine — messages are captured in sentMessages.
export const sentMessages = [];

// SMTP_USER / SMTP_PASS = Brevo login + SMTP key (authentication ONLY)
const smtpUser = () => process.env.SMTP_USER?.trim();
const smtpPass = () => process.env.SMTP_PASS?.trim().replace(/\s+/g, "");

// FIX: the "From" address must be a sender verified in Brevo (MAIL_FROM),
// never the SMTP login (xxxx@smtp-brevo.com) — Brevo rejects that.
const mailFrom = () => process.env.MAIL_FROM?.trim();

let transporter = null;
const getTransporter = () => {
  if (isTest) return nodemailer.createTransport({ jsonTransport: true });
  if (!transporter) {
    // Render free blocks 25/465/587 — use 2525 with Brevo
    const port = Number(process.env.SMTP_PORT || 2525);
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || "smtp-relay.brevo.com",
      port,
      secure: port === 465, // false for 2525/587 (STARTTLS)
      auth: { user: smtpUser(), pass: smtpPass() },
      connectionTimeout: 15000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
    });

    // One-time startup check — shows in Render logs
    transporter.verify((err) => {
      if (err) console.error("[accountEmail] SMTP connection failed:", err.code, err.message);
      else console.log(`[accountEmail] SMTP ready (${process.env.SMTP_HOST}:${port}), from ${mailFrom()}`);
    });
  }
  return transporter;
};

export const frontendUrl = () =>
  (process.env.FRONTEND_URL || "https://task-frontend-zeta-five.vercel.app").replace(/\/$/, "");

export const escapeHtml = (value = "") =>
  String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const layout = (title, body) => `
<div style="background:#F2F8FA;padding:32px 12px;font-family:Segoe UI,Arial,sans-serif;color:#123B5D">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #D5E7EE">
    <div style="background:linear-gradient(135deg,#063b46,#0b8f87);padding:22px 26px;color:#fff">
      <div style="font-size:12px;letter-spacing:2px;opacity:.8">TASK SPHERE</div>
      <div style="font-size:20px;font-weight:700;margin-top:4px">${escapeHtml(title)}</div>
    </div>
    <div style="padding:24px 26px;font-size:14px;line-height:1.6">${body}</div>
  </div>
</div>`;

export const button = (href, label) =>
  `<p style="margin:22px 0"><a href="${href}" style="background:#16A6B8;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:700;display:inline-block">${escapeHtml(label)}</a></p>`;

export const send = async ({ to, subject, text, html }) => {
  if (!isTest && (!smtpUser() || !smtpPass())) {
    console.warn(`[accountEmail] SMTP not configured — "${subject}" to ${to} not sent`);
    return { sent: false, reason: "Email server (SMTP) is not configured" };
  }

  if (!isTest && !mailFrom()) {
    console.warn(`[accountEmail] MAIL_FROM not set — "${subject}" to ${to} not sent`);
    return { sent: false, reason: "Sender address (MAIL_FROM) is not configured" };
  }

  try {
    const info = await getTransporter().sendMail({
      from: `"Task Sphere" <${mailFrom() || "no-reply@tasksphere.local"}>`,
      to,
      subject,
      text,
      html,
    });
    if (isTest) sentMessages.push({ to, subject, text });
    else console.log(`[accountEmail] "${subject}" to ${to} accepted:`, info.messageId, info.response);
    return { sent: true };
  } catch (err) {
    console.error(`[accountEmail] "${subject}" to ${to} failed:`, err.code, err.responseCode, err.message);
    return { sent: false, reason: "The email could not be delivered" };
  }
};

// reason: "welcome" (new account) | "reset" (admin set a new password)
export const sendVerificationEmail = (user, token, reason = "welcome") => {
  const link = `${frontendUrl()}/verify-email/${token}`;
  const isReset = reason === "reset";
  const subject = isReset ? "Your password was reset — verify to view it" : "Verify your email to activate your account";
  const intro = isReset
    ? "Your administrator has set a new password for your account."
    : "An administrator has created an account for you.";
  const text = `Hi ${user.name},

${intro}
Open this link to verify your email. Your password will be shown ONCE, for 30 seconds:
${link}

The link expires in 24 hours and works only once. If you did not expect this email, ignore it.`;
  const html = layout(isReset ? "Password reset" : "Welcome aboard", `
    <p>Hi <strong>${escapeHtml(user.name)}</strong>,</p>
    <p>${intro} Verify your email address (<strong>${escapeHtml(user.email)}</strong>) to continue.</p>
    ${button(link, isReset ? "Verify & view new password" : "Verify email & view password")}
    <p style="color:#6E8799;font-size:12px">For your security the password is not included in this email.
    After verification it is shown <strong>once, for 30 seconds</strong>, then destroyed.
    This link expires in 24 hours and can be used only once.</p>`);
  return send({ to: user.email, subject, text, html });
};

export const sendResetRequestNotification = (admin, requester) => {
  const link = `${frontendUrl()}/dashboard/users`;
  const subject = `Password reset requested by ${requester.name}`;
  const text = `Hi ${admin.name},

${requester.name} (${requester.email}) forgot their password and asked for a reset.
Open the Users page to set a new password: ${link}

The user will receive a verification email to view the new password.`;
  const html = layout("Password reset request", `
    <p>Hi <strong>${escapeHtml(admin.name)}</strong>,</p>
    <p><strong>${escapeHtml(requester.name)}</strong> (${escapeHtml(requester.email)}) forgot their password and requested a reset.</p>
    ${button(link, "Open Users page")}
    <p style="color:#6E8799;font-size:12px">Set a new password from the request list. The user then receives a one-time verification link to view it.</p>`);
  return send({ to: admin.email, subject, text, html });
};
