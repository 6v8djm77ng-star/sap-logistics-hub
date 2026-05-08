/**
 * Audit Log - records changes to important entities.
 *
 * Business requirement: since runs/orders/returns can change during the day,
 * we need a trail of who changed what and when.
 *
 * Usage:
 *   await logAudit({
 *     entityType: 'DeliveryRun',
 *     entityId: 123,
 *     action: 'STATUS_CHANGE',
 *     userId: 5,
 *     oldValue: { status: 'OPEN' },
 *     newValue: { status: 'PLANNED' },
 *   });
 */
import * as db from '../db/logisticsDb.js';
import { apiLogger } from '../utils/logger.js';

const VALID_ACTIONS = ['CREATE', 'UPDATE', 'DELETE', 'STATUS_CHANGE'];

export async function logAudit({ entityType, entityId, action, userId = null, oldValue = null, newValue = null }) {
  if (!VALID_ACTIONS.includes(action)) {
    apiLogger.warn(`Invalid audit action: ${action} - skipping`);
    return;
  }

  try {
    await db.execute(
      `INSERT INTO dbo.AuditLog (EntityType, EntityId, Action, UserId, OldValue, NewValue)
       VALUES (@type, @id, @action, @user, @old, @new)`,
      {
        type: entityType,
        id: entityId,
        action,
        user: userId,
        old: oldValue ? JSON.stringify(oldValue) : null,
        new: newValue ? JSON.stringify(newValue) : null,
      }
    );
  } catch (err) {
    // Audit failure should never break the main flow
    apiLogger.error('Audit log failed', { error: err.message, entityType, entityId });
  }
}

/**
 * Fetch audit trail for an entity.
 */
export async function getAuditTrail(entityType, entityId) {
  return db.query(
    `SELECT a.AuditId, a.EntityType, a.EntityId, a.Action,
            a.OldValue, a.NewValue, a.CreatedAt,
            u.Username, u.FullName AS UserName
     FROM dbo.AuditLog a
     LEFT JOIN dbo.Users u ON u.UserId = a.UserId
     WHERE a.EntityType = @type AND a.EntityId = @id
     ORDER BY a.CreatedAt DESC`,
    { type: entityType, id: entityId }
  );
}

/**
 * Express middleware factory - auto-logs on successful response.
 * Wrap specific routes where you need automatic auditing.
 */
export function auditMiddleware({ entityType, action, getEntityId }) {
  return (req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = function (body) {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const entityId = getEntityId ? getEntityId(req, body) : body?.id;
        if (entityId) {
          // Fire and forget
          logAudit({
            entityType,
            entityId,
            action,
            userId: req.user?.sub,
            newValue: body,
          }).catch(() => {});
        }
      }
      return originalJson(body);
    };
    next();
  };
}
