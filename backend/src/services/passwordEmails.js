/**
 * Password-reset email dispatcher.
 *
 * Standalone wrapper around nodemailer with a hard log-only fallback when
 * SMTP isn't configured — this is essential for the pilot phase where
 * SMTP credentials may not be in .env yet. The reset flow never fails
 * because of email; instead the link is printed to pm2 logs in a bold
 * format the admin can copy and forward by hand (e.g. WhatsApp).
 *
 * PRODUCTION REQUIREMENT — set SMTP_HOST / SMTP_USER / SMTP_PASSWORD in
 * .env once a real provider (Gmail App Password, SendGrid, etc.) is
 * available. No code change is needed when those vars are populated;
 * this module will pick them up on next restart.
 */
import nodemailer from 'nodemailer';

let transporter = null;
let transporterTriedOnce = false;

function getTransporter() {
  if (transporter || transporterTriedOnce) return transporter;
  transporterTriedOnce = true;
  const host = process.env.SMTP_HOST;
  if (!host) {
    console.warn('[passwordEmails] SMTP_HOST not set — using log-only mode. Production needs real SMTP.');
    return null;
  }
  transporter = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: String(process.env.SMTP_SECURE) === 'true',
    auth: process.env.SMTP_USER ? {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASSWORD,
    } : undefined,
  });
  return transporter;
}

function buildResetEmailHtml({ userName, resetLink }) {
  return `
<!doctype html>
<html lang="he" dir="rtl">
  <body style="font-family: -apple-system, Heebo, Arial, sans-serif; max-width: 520px; margin: 24px auto; padding: 24px; background: #f9fafb;">
    <div style="background: white; border: 1px solid #e5e7eb; border-radius: 12px; padding: 24px;">
      <h2 style="color: #1f2937; margin-top: 0;">איפוס סיסמה — SAP Logistics Hub</h2>
      <p style="color: #374151;">שלום ${userName || ''},</p>
      <p style="color: #374151;">קיבלנו בקשה לאפס את הסיסמה שלך.</p>
      <p style="color: #374151;">לחיצה על הקישור תוביל למסך קביעת סיסמה חדשה. הקישור תקף ל-30 דקות וניתן לשימוש פעם אחת בלבד.</p>
      <p style="margin: 24px 0;">
        <a href="${resetLink}" style="background: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: bold;">קביעת סיסמה חדשה</a>
      </p>
      <p style="color: #6b7280; font-size: 12px;">אם לא ביקשת את האיפוס — ניתן להתעלם מהמייל הזה. הסיסמה הקיימת תישאר בתוקף.</p>
      <p style="color: #9ca3af; font-size: 11px; word-break: break-all;">${resetLink}</p>
    </div>
  </body>
</html>`;
}

/**
 * Sends a password reset email. Always resolves (never throws) so the
 * forgot-password endpoint stays anti-enumeration-safe and the UI never
 * sees a 5xx from a missing SMTP config.
 *
 * Returns: { delivered: true|false, mode: 'smtp'|'log' }
 */
export async function sendPasswordResetEmail({ toEmail, userName, resetLink }) {
  const tx = getTransporter();
  if (!tx) {
    console.log(
      `\n=========================================================\n` +
      `  🔑 PASSWORD RESET LINK (no SMTP — copy to user manually)\n` +
      `  to:    ${toEmail}\n` +
      `  user:  ${userName || '(unknown)'}\n` +
      `  link:  ${resetLink}\n` +
      `  TTL:   30 minutes, single-use\n` +
      `=========================================================\n`,
    );
    return { delivered: false, mode: 'log' };
  }
  try {
    await tx.sendMail({
      from: process.env.SMTP_FROM || `SAP Logistics Hub <no-reply@oig.co.il>`,
      to: toEmail,
      subject: 'איפוס סיסמה — SAP Logistics Hub',
      html: buildResetEmailHtml({ userName, resetLink }),
      text: `שלום ${userName || ''},\n\nקישור איפוס: ${resetLink}\n\nתקף 30 דקות, חד-פעמי.`,
    });
    return { delivered: true, mode: 'smtp' };
  } catch (err) {
    console.error('[passwordEmails] send failed, falling back to log:', err.message);
    console.log(`🔑 RESET LINK (smtp failed) for ${toEmail}: ${resetLink}`);
    return { delivered: false, mode: 'log' };
  }
}
