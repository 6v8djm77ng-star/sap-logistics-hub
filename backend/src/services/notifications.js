/**
 * Notification dispatcher - sends email/SMS based on alert subscriptions.
 *
 * All sends are logged to NotificationLog for audit.
 * SMS provider is pluggable (defaults to stub - plug in Twilio/019/inforu).
 */
import nodemailer from 'nodemailer';
import * as db from '../db/logisticsDb.js';
import { env } from '../config/env.js';
import { apiLogger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Email transport - lazy init
// ---------------------------------------------------------------------------
let emailTransporter = null;

function getEmailTransporter() {
  if (emailTransporter) return emailTransporter;
  if (!env.SMTP_HOST) {
    apiLogger.warn('[notifications] SMTP not configured - emails will be logged only');
    return null;
  }
  emailTransporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT || 587,
    secure: env.SMTP_SECURE || false,
    auth: env.SMTP_USER ? {
      user: env.SMTP_USER,
      pass: env.SMTP_PASSWORD,
    } : undefined,
  });
  return emailTransporter;
}

// ---------------------------------------------------------------------------
// SMS transport - stub for now
// ---------------------------------------------------------------------------
async function sendSmsViaProvider(phone, message) {
  // TODO: plug in Twilio / 019 / inforu
  // For now, just log
  apiLogger.info('[SMS STUB]', { phone, message });

  if (env.SMS_PROVIDER === 'twilio') {
    // const twilio = (await import('twilio')).default;
    // const client = twilio(env.TWILIO_SID, env.TWILIO_TOKEN);
    // return client.messages.create({ to: phone, from: env.TWILIO_FROM, body: message });
  }
  return { provider: 'stub', success: true };
}

// ---------------------------------------------------------------------------
// Send helpers
// ---------------------------------------------------------------------------

async function logNotification({ eventType, channel, recipient, subject, body, entity, status, error }) {
  await db.execute(
    `INSERT INTO dbo.NotificationLog
       (EventType, Channel, Recipient, Subject, Body,
        RelatedEntityType, RelatedEntityId, Status, ErrorMessage, SentAt)
     VALUES (@event, @channel, @recipient, @subject, @body,
             @entityType, @entityId, @status, @error,
             CASE WHEN @status = 'SENT' THEN SYSUTCDATETIME() ELSE NULL END)`,
    {
      event: eventType,
      channel,
      recipient,
      subject: subject || null,
      body: body || null,
      entityType: entity?.type || null,
      entityId: entity?.id || null,
      status,
      error: error || null,
    }
  );
}

export async function sendEmail({ to, subject, html, text, eventType, entity }) {
  if (!to) return { skipped: true };

  const transporter = getEmailTransporter();
  if (!transporter) {
    await logNotification({
      eventType, channel: 'EMAIL', recipient: to, subject, body: html || text,
      entity, status: 'QUEUED', error: 'SMTP not configured',
    });
    return { skipped: true, reason: 'no-smtp' };
  }

  try {
    const info = await transporter.sendMail({
      from: env.SMTP_FROM || '"SAP Logistics Hub" <noreply@localhost>',
      to,
      subject,
      text,
      html,
    });
    await logNotification({
      eventType, channel: 'EMAIL', recipient: to, subject, body: html || text,
      entity, status: 'SENT',
    });
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    apiLogger.error('[email] send failed', { to, error: err.message });
    await logNotification({
      eventType, channel: 'EMAIL', recipient: to, subject, body: html || text,
      entity, status: 'FAILED', error: err.message.slice(0, 500),
    });
    return { sent: false, error: err.message };
  }
}

export async function sendSms({ to, message, eventType, entity }) {
  if (!to) return { skipped: true };
  try {
    await sendSmsViaProvider(to, message);
    await logNotification({
      eventType, channel: 'SMS', recipient: to, body: message,
      entity, status: 'SENT',
    });
    return { sent: true };
  } catch (err) {
    await logNotification({
      eventType, channel: 'SMS', recipient: to, body: message,
      entity, status: 'FAILED', error: err.message.slice(0, 500),
    });
    return { sent: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Subscription-based dispatch
// ---------------------------------------------------------------------------

export async function getSubscribers(eventType) {
  return db.query(
    `SELECT u.UserId, u.Username, u.FullName, u.Email, u.Phone,
            s.Channel, s.Config
     FROM dbo.AlertSubscriptions s
     INNER JOIN dbo.Users u ON u.UserId = s.UserId
     WHERE s.EventType = @event
       AND s.IsActive = 1
       AND u.IsActive = 1`,
    { event: eventType }
  );
}

/**
 * Notify all subscribers to a specific event type.
 * payload = { subject, html, text, smsMessage, entity }
 */
export async function notifyEvent(eventType, payload) {
  const subscribers = await getSubscribers(eventType);
  if (subscribers.length === 0) return { sent: 0 };

  const results = await Promise.all(subscribers.map(async (sub) => {
    if (sub.Channel === 'EMAIL' && sub.Email) {
      return sendEmail({
        to: sub.Email,
        subject: payload.subject,
        html: payload.html,
        text: payload.text,
        eventType,
        entity: payload.entity,
      });
    }
    if (sub.Channel === 'SMS' && sub.Phone) {
      return sendSms({
        to: sub.Phone,
        message: payload.smsMessage || payload.text,
        eventType,
        entity: payload.entity,
      });
    }
    return { skipped: true };
  }));

  return {
    sent: results.filter((r) => r.sent).length,
    failed: results.filter((r) => r.error).length,
  };
}
